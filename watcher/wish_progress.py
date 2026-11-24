"""やりたいことの進み具合を、最近の Claude セッションから Claude（claude -p）に見立ててもらい、窓口へ送る。

- 1日1回（タスク「PortalWishProgress」）。新しいセッションも新しいやりたいことも無ければ LLM を呼ばない
- 渡すもの：やりたいこと（未完のもの）と前回の見立て、前回から動いたセッションの要点
  （名前・日付・最初の頼みごとの頭・最後の返事の頭）、記憶の索引 MEMORY.md
- 返すもの：段階・一言・関係するセッション名だけ（会話の本文は送らない）
- 「かなったかも」でも自動で「やった」には移さない（決めるのは本人）
- claude -p は空のフォルダ（_llm）で動かす。作られる記録は sdk-cli なので、セッション欄には出ない
"""
import json
import pathlib
import re
import subprocess
import sys
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
CFG = json.loads((HERE.parent / "gas" / ".local.json").read_text(encoding="utf-8"))
STATE = HERE / "wish_state.json"
LOG = HERE / "run.log"
WORKDIR = HERE / "_llm"
PROJECTS = pathlib.Path.home() / ".claude" / "projects"
MEMORY_INDEX = PROJECTS / "g---------obsidian" / "memory" / "MEMORY.md"
FIRST_LOOKBACK_D = 45
APPS = {"claude-vscode": "VS Code", "claude-desktop": "デスクトップ"}
STAGES = ["未着手", "考え中", "進んでいる", "ほぼできた", "かなったかも"]


def log(msg):
    with LOG.open("a", encoding="utf-8") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + "[wish] " + msg + "\n")


def post(body, key):
    req = urllib.request.Request(CFG["url"], data=json.dumps(dict(body, key=key), ensure_ascii=False).encode("utf-8"),
                                 headers={"Content-Type": "text/plain;charset=utf-8"})
    with urllib.request.urlopen(req, timeout=120) as r:
        res = json.loads(r.read().decode("utf-8"))
    if not res.get("ok"):
        raise RuntimeError(res)
    return res


def text_of(msg):
    c = (msg or {}).get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
    return ""


def clean(s, n):
    s = re.sub(r"<[^>]{1,200}>", " ", s)            # system-reminder などのタグ
    s = re.sub(r"\s+", " ", s).strip()
    return s[:n]


def digest(path):
    title, entry, first, last = "", "", "", ""
    t0 = None
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            t = d.get("type")
            if t == "custom-title":
                title = d.get("customTitle") or title
            elif t == "ai-title":
                title = d.get("aiTitle") or title
            if d.get("entrypoint"):
                entry = d["entrypoint"]
            if d.get("isSidechain"):
                continue
            if t == "user" and not d.get("isMeta") and not first:
                c = (d.get("message") or {}).get("content")
                if isinstance(c, str) or (isinstance(c, list) and not any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c)):
                    tx = clean(text_of(d.get("message")), 150)
                    if tx and not tx.startswith("Caveat"):
                        first = tx
                        t0 = d.get("timestamp")
            elif t == "assistant":
                tx = text_of(d.get("message")).strip()
                if tx:
                    last = clean(tx, 160)
    if entry not in APPS:
        return None
    return {"title": title or "（名前なし）", "app": APPS[entry], "start": (t0 or "")[:10],
            "end": time.strftime("%Y-%m-%d", time.localtime(path.stat().st_mtime)),
            "first": first, "last": last}


def main():
    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    since = state.get("last_run", time.time() - FIRST_LOOKBACK_D * 86400) - 86400
    wishes = [w for w in post({"type": "get"}, CFG["token"])["wishes"] if w["state"] == "open"]
    if not wishes:
        return
    sessions = []
    for p in PROJECTS.glob("*/*.jsonl"):
        try:
            if p.stat().st_mtime < since:
                continue
        except OSError:
            continue
        d = digest(p)
        if d:
            sessions.append(d)
    sessions.sort(key=lambda s: s["end"])
    new_wish = any("progress" not in w for w in wishes)
    if not sessions and not new_wish and "--force" not in sys.argv:
        state["last_run"] = time.time()
        STATE.write_text(json.dumps(state), encoding="utf-8")
        return

    memory = MEMORY_INDEX.read_text(encoding="utf-8") if MEMORY_INDEX.exists() else ""
    wl = [{"id": w["id"], "text": w["text"], "思った日": w["at"], "前回の見立て": w.get("progress")} for w in wishes]
    prompt = f"""あなたは本人の「やりたいこと」の進み具合を見立てる係です。道具は使わず、下の材料だけで答えてください。

# やりたいこと（前回の見立てがあれば、それを今回の材料で更新する）
{json.dumps(wl, ensure_ascii=False, indent=1)}

# 前回以降に動いた Claude とのセッション（名前・期間・最初の頼みごとの頭・最後の返事の頭）
{json.dumps(sessions, ensure_ascii=False)}

# 本人の記憶の索引（決まったこと・進行中のことの一覧。日付つき）
{memory}

# 答え方
やりたいことごとに、次の形の JSON 配列だけを出力する（前置き・説明・コードブロック記号は不要）。
[{{"id": "…", "stage": "未着手|考え中|進んでいる|ほぼできた|かなったかも", "line": "今どこまで来ているかを40字以内の日本語で", "sessions": [{{"t": "関係するセッション名", "d": "最後の日付 YYYY-MM-DD"}}]}}]
- stage は5つのどれか。材料に何も無ければ「未着手」。前回の見立てより後退させるのは、材料に根拠があるときだけ
- 「かなったかも」は、買った・完成した・決めて終えた等が材料にはっきりあるときだけ
- line は事実だけ。金額・人名・住所などの細かい個人情報は書かない
- sessions は関係が明らかなものだけ、最大5件。無ければ空配列（前回の見立ての sessions は引き継いでよい）
"""
    WORKDIR.mkdir(exist_ok=True)
    claude = str(pathlib.Path.home() / ".local" / "bin" / "claude.exe")
    r = subprocess.run([claude, "-p", "--model", "sonnet"], input=prompt, cwd=WORKDIR,
                       capture_output=True, text=True, encoding="utf-8", timeout=900)
    out = r.stdout or ""
    m = re.search(r"\[.*\]", out, re.S)
    if r.returncode != 0 or not m:
        raise RuntimeError(f"claude -p の返事を読めない rc={r.returncode} {out[:200]} {r.stderr[:200]}")
    items = json.loads(m.group(0))
    ids = {w["id"] for w in wishes}
    items = [it for it in items if it.get("id") in ids and it.get("stage") in STAGES]
    res = post({"type": "wishProgress", "items": items}, CFG["pushToken"])
    state["last_run"] = time.time()
    STATE.write_text(json.dumps(state), encoding="utf-8")
    log(f"progress {res.get('updated')} wishes from {len(sessions)} sessions")
    if "--show" in sys.argv:
        sys.stdout.reconfigure(encoding="utf-8")
        print(json.dumps(items, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        log("error: " + repr(e)[:300])
        raise
