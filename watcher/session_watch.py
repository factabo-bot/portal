"""Claude Code のセッションを見回り、「誰の番か」をポータルの窓口へ送る。

- 読む場所：~/.claude/projects/*/*.jsonl（VS Code もデスクトップアプリも同じ場所に書く）
- アカウントの見分け：記録の entrypoint（claude-vscode / claude-desktop）
- 送るもの（最小限）：セッション名・状態・最終更新・アプリ・フォルダ名・最後の問いかけの冒頭（伏せ字処理済み）
  会話の本文や作業場所のフルパスは送らない
- 書き込み用の合言葉は ../gas/.local.json の pushToken（git 管理外）
- 前回と同じ内容なら送らない（state.json に要約のハッシュだけ残す）
タスクスケジューラから pythonw で動かす前提。pythonw では sys.stdout が None なので print しない。
"""
import hashlib
import json
import os
import pathlib
import re
import socket
import sys
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
CFG = HERE.parent / "gas" / ".local.json"
STATE = HERE / "state.json"
LOG = HERE / "run.log"
PROJECTS = pathlib.Path.home() / ".claude" / "projects"
DESKTOP_SESSIONS = pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "Claude-Data" / "claude_pzs8sxrjxfjjc" / "claude-code-sessions"
ACCOUNTS = HERE / "accounts.json"   # アカウントのIDと表示名（git 管理外）

LOOKBACK_H = 48          # これより古いセッションは出さない
MAX_SESSIONS = 20
WORKING_GRACE_S = 180    # ツール実行中のまま、これ以上動きがなければ「止まっている（許可待ちかも）」
SNIPPET_LEN = 40
APPS = {"claude-vscode": "VS Code", "claude-desktop": "デスクトップ"}


def log(msg):
    with LOG.open("a", encoding="utf-8") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    # 大きくなりすぎないように末尾だけ残す
    if LOG.stat().st_size > 200_000:
        LOG.write_text("".join(LOG.read_text(encoding="utf-8").splitlines(True)[-500:]), encoding="utf-8")


def mask(s):
    s = re.sub(r"[\w.+-]+@[\w-]+\.[\w.-]+", "＊", s)               # メール
    s = re.sub(r"https?://\S+", "＊", s)                             # URL
    s = re.sub(r"\b[A-Za-z0-9_-]{24,}\b", "＊", s)                   # 鍵・IDらしき長い文字列
    s = re.sub(r"\d[\d -]{6,}\d", "＊", s)                           # 電話・口座など長い数字
    return s


def text_of(msg):
    c = (msg or {}).get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
    return ""


def tool_names(msg):
    c = (msg or {}).get("content")
    if not isinstance(c, list):
        return []
    return [x.get("name", "") for x in c if isinstance(x, dict) and x.get("type") == "tool_use"]


def is_human_prompt(d):
    if d.get("type") != "user" or d.get("isMeta"):
        return False
    c = (d.get("message") or {}).get("content")
    if isinstance(c, list):
        return not any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c)
    return True


def read_session(path):
    title = ""
    owner = ""
    bridge = ""
    entry = ""
    cwd = ""
    last = None          # 最後の user / assistant（サブエージェントは除く）
    last_text = ""       # 最後のアシスタントの文章
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            t = d.get("type")
            if t == "custom-title":
                title = d.get("customTitle") or title
            elif t == "ai-title" and not title.startswith("\0"):
                title = d.get("aiTitle") or title
            if t == "bridge-session":
                bridge = d.get("bridgeSessionId") or bridge
                owner = d.get("ownerAccountUuid") or owner
            elif t == "session-owner":
                owner = d.get("accountUuid") or owner
            if d.get("entrypoint"):
                entry = d["entrypoint"]
            if d.get("cwd"):
                cwd = d["cwd"]
            if t in ("user", "assistant") and not d.get("isSidechain"):
                if t == "user" and d.get("isMeta"):
                    continue
                last = d
                if t == "assistant":
                    tx = text_of(d.get("message")).strip()
                    if tx:
                        last_text = tx
    return title, entry, cwd, last, last_text, owner, bridge


def desktop_index():
    """デスクトップアプリの管理ファイルから、記録のID → (アプリ内のID, アーカイブ済みか, アカウント)"""
    idx = {}
    if not DESKTOP_SESSIONS.exists():
        return idx
    now = time.time()
    for p in DESKTOP_SESSIONS.glob("*/*/local_*.json"):
        try:
            if now - p.stat().st_mtime > (LOOKBACK_H + 24) * 3600:
                continue
            d = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        cli = d.get("cliSessionId")
        if cli:
            idx[cli] = (d.get("sessionId", ""), bool(d.get("isArchived")), p.parent.parent.name)
    return idx


def account_label(uuid, accounts):
    if not uuid:
        return ""
    if uuid not in accounts:
        accounts[uuid] = "アカウント" + "ABCDEFGH"[len(accounts) % 8]
        ACCOUNTS.write_text(json.dumps(accounts, ensure_ascii=False, indent=1), encoding="utf-8")
    return accounts[uuid]


def judge(last, last_text, age_s):
    """状態：ask（質問あり）/ done（返事待ち）/ work（作業中）/ stuck（止まっている）"""
    if last is None:
        return None
    msg = last.get("message") or {}
    if last["type"] == "assistant":
        names = tool_names(msg)
        if any(n in ("AskUserQuestion", "ExitPlanMode") for n in names):
            return "ask"
        if msg.get("stop_reason") == "tool_use" or names:
            return "work" if age_s < WORKING_GRACE_S else "stuck"
        tail = last_text[-300:]
        return "ask" if re.search(r"[?？]", tail) else "done"
    # 最後が user（人の入力 or ツールの結果）＝ Claude の番
    return "work" if age_s < WORKING_GRACE_S * 2 else "stuck"


def snippet(last_text):
    if not last_text:
        return ""
    # 最後の「？」を含む文を優先、なければ最後の段落の頭
    qs = re.findall(r"[^。\n?？]*[?？]", last_text)
    s = qs[-1] if qs else last_text.strip().split("\n")[-1]
    s = re.sub(r"[*`#>|\[\]]", "", s).strip()
    s = mask(s)
    return s[:SNIPPET_LEN] + ("…" if len(s) > SNIPPET_LEN else "")


def collect():
    now = time.time()
    out = []
    didx = desktop_index()
    accounts = json.loads(ACCOUNTS.read_text(encoding="utf-8")) if ACCOUNTS.exists() else {}
    for p in PROJECTS.glob("*/*.jsonl"):
        try:
            mt = p.stat().st_mtime
        except OSError:
            continue
        if now - mt > LOOKBACK_H * 3600:
            continue
        title, entry, cwd, last, last_text, owner, bridge = read_session(p)
        if entry not in APPS:          # sdk-cli（自動実行など）は出さない
            continue
        dinfo = didx.get(p.stem)
        if dinfo and dinfo[1]:         # デスクトップでアーカイブ済み
            continue
        st = judge(last, last_text, now - mt)
        if not st:
            continue
        out.append({
            "id": p.stem[:8],
            "title": mask(title or "（名前なし）")[:60],
            "app": APPS[entry],
            "folder": mask(pathlib.PurePath(cwd).name)[:30] if cwd else "",
            "state": st,
            "at": int(mt),
            "q": snippet(last_text) if st == "ask" else "",
            "acct": account_label(owner or (dinfo[2] if dinfo else ""), accounts),
            # 飛び先：VS Code は記録のID、デスクトップはアプリ内のID、ブラウザはリモート接続のID
            "open": (dinfo[0] if dinfo else "") if entry == "claude-desktop" else p.stem,
            "rc": bridge.split("_", 1)[1] if "_" in bridge else "",
        })
    out.sort(key=lambda s: -s["at"])
    return out[:MAX_SESSIONS]


def main():
    cfg = json.loads(CFG.read_text(encoding="utf-8"))
    sessions = collect()
    digest = hashlib.sha256(json.dumps(sessions, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    prev = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    # 変化がなくても1時間に1回は送る（ポータル側で「最終更新」が古くならないように）
    if prev.get("digest") == digest and time.time() - prev.get("sent", 0) < 3600 and "--force" not in sys.argv:
        return
    body = json.dumps({"key": cfg["pushToken"], "type": "pushSessions", "host": socket.gethostname()[:30],
                       "sessions": sessions}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(cfg["url"], data=body, headers={"Content-Type": "text/plain;charset=utf-8"})
    with urllib.request.urlopen(req, timeout=90) as r:
        res = json.loads(r.read().decode("utf-8"))
    if not res.get("ok"):
        raise RuntimeError(res)
    STATE.write_text(json.dumps({"digest": digest, "sent": time.time()}), encoding="utf-8")
    log(f"sent {len(sessions)} sessions")


if __name__ == "__main__":
    try:
        if "--dry" in sys.argv:
            sys.stdout.reconfigure(encoding="utf-8")
            print(json.dumps(collect(), ensure_ascii=False, indent=1))
        else:
            main()
    except Exception as e:  # noqa: BLE001
        log("error: " + repr(e)[:300])
        raise
