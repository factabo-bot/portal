"""Claude Code のセッションを見回り、「誰の番か」をポータルの窓口へ送る。

- 読む場所：~/.claude/projects/*/*.jsonl（VS Code もデスクトップアプリも同じ場所に書く）
- アカウントの見分け：記録の entrypoint（claude-vscode / claude-desktop）
- 送るもの（最小限）：セッション名・状態・最終更新・アプリ・フォルダ名・最後の問いかけの冒頭（伏せ字処理済み）
  会話の本文や作業場所のフルパスは送らない
- 書き込み用の合言葉は ../gas/.local.json の pushToken（git 管理外）
- 時刻は「最後の会話の時刻」を使う。ファイルの更新時刻は、開いただけ・アプリの起動でも新しくなるので使わない
- 質問のあとに本人がその会話を開いていれば seen を付ける（デスクトップのみ。VS Code は開いた時刻の記録がない）
- 前回と同じ内容なら送らない（state.json に要約のハッシュだけ残す）
タスクスケジューラから pythonw で動かす前提。pythonw では sys.stdout が None なので print しない。
"""
import datetime
import hashlib
import json
import os
import pathlib
import re
import socket
import sys
import time
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import session_sync  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
CFG = HERE.parent / "gas" / ".local.json"
STATE = HERE / "state.json"
LOG = HERE / "run.log"
CACHE = HERE / "parse_cache.json"    # 読み取り済みの記録（PCの中だけ・git 管理外）
LIVE = pathlib.Path.home() / ".claude" / "sessions"   # 動いている claude の一覧（pid ごと）
PROJECTS = pathlib.Path.home() / ".claude" / "projects"
DESKTOP_SESSIONS = pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "Claude-Data" / "claude_pzs8sxrjxfjjc" / "claude-code-sessions"
ACCOUNTS = HERE / "accounts.json"   # アカウントのIDと表示名（git 管理外）

VOICE = pathlib.Path("G:/マイドライブ/obsidian/00_Inbox/_voice")   # 作業記録の音声を置く場所
AUDIO = {".m4a", ".mp3", ".wav", ".aac", ".ogg", ".opus", ".flac", ".amr", ".3gp"}

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


def ts(d):
    try:
        return datetime.datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00")).timestamp()
    except (KeyError, ValueError, AttributeError):
        return 0


def facts(path, cache):
    """記録1つから要る物だけ取り出す。前回から変わっていない記録は読み直さない"""
    st = path.stat()
    key = f"{st.st_mtime_ns}:{st.st_size}"
    hit = cache.get(path.stem)
    if hit and hit.get("key") == key:
        return hit
    title, entry, cwd, last, last_text, owner, bridge = read_session(path)
    msg = (last or {}).get("message") or {}
    return {"key": key, "title": title, "entry": entry, "cwd": cwd, "owner": owner, "bridge": bridge,
            "type": (last or {}).get("type", ""), "at": ts(last) if last else 0, "tools": tool_names(msg),
            "stop": msg.get("stop_reason") or "", "interrupted": text_of(msg).startswith("[Request interrupted"),
            "tail": last_text[-300:], "q": snippet(last_text)}


def live_status():
    """動いている claude の状態。記録のID → idle / busy など"""
    out = {}
    for p in LIVE.glob("*.json"):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if d.get("sessionId"):
            out[d["sessionId"]] = d.get("status") or ""
    return out


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
    """デスクトップアプリの管理ファイルから、記録のID → (アプリ内のID, アーカイブ済みか, アカウント, 最後に開いた時刻, スマホ用のID)"""
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
            idx[cli] = (d.get("sessionId", ""), bool(d.get("isArchived")), p.parent.parent.name,
                        (d.get("lastFocusedAt") or 0) / 1000, (d.get("bridgeSessionIds") or [""])[-1])
    return idx


def account_label(uuid, accounts):
    if not uuid:
        return ""
    if uuid not in accounts:
        accounts[uuid] = "アカウント" + "ABCDEFGH"[len(accounts) % 8]
        ACCOUNTS.write_text(json.dumps(accounts, ensure_ascii=False, indent=1), encoding="utf-8")
    return accounts[uuid]


def judge(f, age_s, live):
    """状態：ask（質問あり）/ done（返事待ち）/ work（作業中）/ stuck（止まっている）"""
    if not f["type"]:
        return None
    if f["type"] == "assistant":
        if any(n in ("AskUserQuestion", "ExitPlanMode") for n in f["tools"]):
            return "ask"
        if not (f["stop"] == "tool_use" or f["tools"]):
            return "ask" if re.search(r"[?？]", f["tail"]) else "done"
        grace = WORKING_GRACE_S
    else:                       # 最後が user（人の入力 or ツールの結果）＝ Claude の番
        grace = WORKING_GRACE_S * 2
    # 途中で終わっている。本人が止めた・もう待機に戻っているなら、誰も待っていない
    if f["interrupted"] or (live == "idle" and age_s > 30):
        return "done"
    return "work" if age_s < grace else "stuck"


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
    live = live_status()
    accounts = json.loads(ACCOUNTS.read_text(encoding="utf-8")) if ACCOUNTS.exists() else {}
    try:
        cache = json.loads(CACHE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cache = {}
    fresh = {}
    for p in PROJECTS.glob("*/*.jsonl"):
        try:
            if now - p.stat().st_mtime > LOOKBACK_H * 3600:   # 更新がなければ会話もない（ふるい分けだけに使う）
                continue
            f = fresh[p.stem] = facts(p, cache)
        except OSError:
            continue
        if now - f["at"] > LOOKBACK_H * 3600:
            continue
        if f["entry"] not in APPS:          # sdk-cli（自動実行など）は出さない
            continue
        if f["cwd"] and pathlib.PurePath(f["cwd"]).name == "_llm":   # やりたいことの見立て役（claude -p）
            continue
        blk = session_sync.in_scope(p.parent.name) and session_sync.is_blocked(p.stem)
        sync = session_sync.in_scope(p.parent.name) and not blk
        if sync and session_sync.from_other_pc(p.stem, p.stat().st_size):   # 最後に話したのは相手のPC（相手が出す）
            continue
        dinfo = didx.get(p.stem)
        if f["entry"] != "claude-desktop":   # VS Code に切り替えた会話は、デスクトップ側の印（アーカイブ・開いた時刻）を使わない
            dinfo = None
        if dinfo and dinfo[1]:         # デスクトップでアーカイブ済み
            continue
        st = judge(f, now - f["at"], live.get(p.stem, ""))
        if not st:
            continue
        s = {
            "id": p.stem[:8],
            "title": mask(f["title"] or "（名前なし）")[:60],
            "app": APPS[f["entry"]],
            "folder": mask(pathlib.PurePath(f["cwd"]).name)[:30] if f["cwd"] else "",
            "state": st,
            "at": int(f["at"]),
            "q": f["q"] if st == "ask" else "",
            # デスクトップの会話は、アプリの管理フォルダのアカウントが正（11/24 実測。記録の中の持ち主は CLI のログインが写ることがある）
            "acct": account_label((dinfo[2] if dinfo else "") if f["entry"] == "claude-desktop" else f["owner"], accounts),
            # 飛び先：VS Code は記録のID、デスクトップはアプリ内のID、ブラウザはリモート接続のID
            "open": (dinfo[0] if dinfo else "") if f["entry"] == "claude-desktop" else p.stem,
            "rc": f["bridge"].split("_", 1)[1] if "_" in f["bridge"] else "",
        }
        if sync:
            s["sy"] = 1                # 2台で写し合っている＝どちらのPCからでも開ける
        elif blk:
            s["bk"] = 1                # 合言葉・鍵が入っていて写していない＝このPCでしか開けない（画面で理由を出す）
        if f["entry"] == "claude-desktop":
            s["cli"] = p.stem          # もう片方（VS Code）で開くための記録のID
            # スマホ用のIDもアプリの管理情報が正（切り替えた会話の記録には、前のアプリのIDが残る）
            b = dinfo[4] if dinfo else ""
            s["rc"] = b.split("_", 1)[1] if "_" in b else ""
        if st == "ask" and dinfo and dinfo[3] > f["at"] + 5:   # 質問のあとに本人が開いた（返事はまだ）
            s["seen"] = 1
        out.append(s)
    CACHE.write_text(json.dumps(fresh, ensure_ascii=False), encoding="utf-8")
    out.sort(key=lambda s: -s["at"])
    return out[:MAX_SESSIONS]


def quotas():
    """2つのアプリ（＝2つのアカウント）の使用量。5時間枠 fh・7日枠 sd（%）。新しく開くセッションの行き先を決めるのに使う"""
    now = time.time()
    out = {}
    # VS Code（CLI のログイン）：AI進捗モニターと同じ公式の利用枠。モニターの1分キャッシュがあれば使う
    try:
        sys.path.insert(0, str(pathlib.Path.home() / "projects" / "ai-session-monitor"))
        import collector  # noqa: E402
        # main も5分に1回だけ（collector は1分で問い合わせ直す。VS Code 拡張も同じ窓口を使うので、こちらは控えめに）
        mc = pathlib.Path.home() / ".claude" / ".quota_cache.json"
        try:
            age = now - json.loads(mc.read_text(encoding="utf-8")).get("at", 0)
        except Exception:  # noqa: BLE001
            age = 1e9
        q = collector.fetch_claude_quota(pathlib.Path.home(), now if age >= 300 else now - age)
        if q:
            out["vscode"] = {"fh": round(q["primary"]["used_percent"]), "sd": round(q["secondary"]["used_percent"]),
                             "at": int(now), "fhReset": q["primary"].get("resets_at"),
                             "sdReset": q["secondary"].get("resets_at"), "est": False}
    except Exception as e:  # noqa: BLE001
        log("quota vscode: " + repr(e)[:120])
    # デスクトップ（sub）：~/.claude-sub に CLI で sub にログインしてあれば公式の値（sub_quota.py）
    try:
        import sub_quota
        q = sub_quota.fetch(now)
        if q:
            out["desktop"] = dict(q, at=int(now), est=False)
            return out
    except Exception as e:  # noqa: BLE001
        log("quota sub: " + repr(e)[:120])
    # ログインが無い・取れないときは、アプリが出来事のたびに書く記録の最後の値に、その後の会話のトークン量を足して推定する（usage_est.py）
    try:
        hp = pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "Claude-Data" / "claude_pzs8sxrjxfjjc" / "plan-usage-history.json"
        sm = json.loads(hp.read_text(encoding="utf-8"))["samples"]
        if sm:
            last = sm[-1]
            t = last["t"] / 1000 if last["t"] > 1e12 else last["t"]
            import usage_est
            e = usage_est.estimate(t, last["u"].get("fh", 0), last["u"].get("sd", 0), now)
            out["desktop"] = dict(e, at=int(now), est=True)
            import week_reset   # 7日枠の戻る時刻は記録に無いので、過去に下がった時期から幅で推定
            w = week_reset.next_reset(sm, last.get("org"), now)
            if w:
                out["desktop"].update(sdReset=w[0], sdResetEnd=w[1])
    except Exception as e:  # noqa: BLE001
        log("quota desktop: " + repr(e)[:120])
    return out


def voices():
    """まだ文字起こししていない音声の数 {録音日: 件数}（中身は読まない）"""
    out = {}
    try:
        for p in VOICE.iterdir():
            if p.suffix.lower() not in AUDIO:
                continue
            m = re.search(r"(?<!\d)(\d{2})(\d{2})(\d{2})_\d{6}", p.name)      # 音声 261125_130102.m4a
            day = f"20{m[1]}-{m[2]}-{m[3]}" if m else time.strftime("%Y-%m-%d", time.localtime(p.stat().st_mtime))
            out[day] = out.get(day, 0) + 1
    except OSError:      # ドライブがまだ見えていない
        pass
    return out


def summarize_on():
    try:
        return json.loads(CFG.read_text(encoding="utf-8")).get("summarize", True) is not False
    except Exception:  # noqa: BLE001
        return False


def git_pull():
    """git pull --ff-only。失敗しても見回りは止めず、ログに残すだけ"""
    import shutil
    import subprocess
    git = shutil.which("git") or r"C:\Program Files\Git\cmd\git.exe"
    try:
        r = subprocess.run([git, "-C", str(HERE.parent), "pull", "--ff-only", "-q"], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=90,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if r.returncode != 0:
            log("git pull error: " + (r.stderr or r.stdout).strip()[:300])
    except Exception as e:  # noqa: BLE001
        log("git pull error: " + repr(e)[:300])


def main():
    cfg = json.loads(CFG.read_text(encoding="utf-8"))
    try:                               # 会話の記録をもう1台と写し合う（session_sync.py）
        session_sync.run(live_status(), log=log)
    except Exception as e:  # noqa: BLE001
        log("sync error: " + repr(e)[:300])
    sessions = collect()
    q = quotas()
    try:                               # 裏で Claude を呼ぶときの行き先決め（llm_route.py）に使う。問い合わせは増やさない
        import llm_route
        llm_route.save(q)
    except Exception as e:  # noqa: BLE001
        log("quota save: " + repr(e)[:120])
    v = voices()
    coarse = {k: (v["fh"] // 5, v["sd"] // 5) for k, v in q.items()}   # 5%刻みで変わったら送り直す
    digest = hashlib.sha256(json.dumps([sessions, coarse, v], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    prev = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    # 変化がなくても1時間に1回は送る（ポータル側で「最終更新」が古くならないように）
    if prev.get("digest") == digest and time.time() - prev.get("sent", 0) < 3600 and "--force" not in sys.argv:
        return
    body = json.dumps({"key": cfg["pushToken"], "type": "pushSessions", "host": socket.gethostname()[:30],
                       "sessions": sessions, "quota": q, "voice": v}, ensure_ascii=False).encode("utf-8")
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
    # 10分に1回、最新のコードをもらう（2台のどちらで直しても、もう片方が古いまま動き続けないように）
    if "--dry" not in sys.argv and time.localtime().tm_min % 10 == 0:
        git_pull()
    # ひと区切りついたセッションを要約する（やりたいことの見立ての材料。1回に最大3件）
    # 見回りは1分おき、要約は5分に1回。家のPCだけで動かす（.local.json に "summarize": false があれば飛ばす）
    if "--dry" not in sys.argv and time.localtime().tm_min % 5 == 0 and summarize_on():
        try:
            import summarize
            summarize.run(3, log=log)
        except Exception as e:  # noqa: BLE001
            log("summary error: " + repr(e)[:300])
