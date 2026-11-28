"""やりたいことの進み具合を、最近の Claude セッションから Claude（claude -p）に見立ててもらい、窓口へ送る。

- 1日1回（タスク「PortalWishProgress」）。新しいセッションも新しいやりたいことも無ければ LLM を呼ばない
- 渡すもの：やりたいこと（未完のもの）と前回の見立て、前回から動いたセッションの要点
  （名前・日付・最初の頼みごとの頭・最後の返事の頭）、記憶の索引 MEMORY.md
- 返すもの：段階・一言・関係するセッション名だけ（会話の本文は送らない）
- 「かなったかも」でも自動で「やった」には移さない（決めるのは本人）
- claude -p は空のフォルダ（_llm）で動かす。作られる記録は sdk-cli なので、セッション欄には出ない
"""
import json
import os
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
    return {"ref": path.stem[:8], "title": title or "（名前なし）", "app": APPS[entry], "start": (t0 or "")[:10],
            "end": time.strftime("%Y-%m-%d", time.localtime(path.stat().st_mtime)),
            "first": first, "last": last}


DESKTOP_SESSIONS = pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "Claude-Data" / "claude_pzs8sxrjxfjjc" / "claude-code-sessions"


def ref_map():
    """セッションの短い印（記録のIDの頭8文字）→ 開くための情報。古いセッションも含めて全部"""
    desk = {}
    for p in DESKTOP_SESSIONS.glob("*/*/local_*.json"):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if d.get("cliSessionId") and not d.get("isArchived"):
            desk[d["cliSessionId"]] = d.get("sessionId", "")
    m = {}
    for p in PROJECTS.glob("*/*.jsonl"):
        if p.stem in desk:
            m[p.stem[:8]] = {"app": "デスクトップ", "open": desk[p.stem]}
        else:
            m[p.stem[:8]] = {"app": "VS Code", "open": p.stem}
    return m


def attach(items, refs):
    """見立ての ref を、開くための app・open に置き換える（知らない ref は捨てる）"""
    for it in items:
        for k in ("tasks", "sessions"):
            for x in it.get(k) or []:
                ref0 = str(x.pop("ref", "") or "")[:8]
                had = {k2: x.pop(k2) for k2 in ("app", "open") if k2 in x}
                r = refs.get(ref0)
                if not r and had.get("open"):   # 人が決めた作業などで、元のリンクを持っているとき
                    x.update(had)
                if r:
                    x.update(r)
                    x["ref"] = ref0   # 次回の見立てに引き継ぐための印
    return items


MEMORY_DIR = MEMORY_INDEX.parent
SUMMARY_DIR = HERE / "summaries"
TASK_STATES = ["済", "途中", "待ち", "未"]


def enforce(items, wishes):
    """根拠のない状態は「未」に戻す。人が決めた作業（by=人）は変えず、見立ての意見は hint に回す"""
    prev = {w["id"]: (w.get("progress") or {}) for w in wishes}
    for it in items:
        tasks = []
        for t in it.get("tasks") or []:
            t["s"] = t.get("s") if t.get("s") in TASK_STATES else "未"
            if t["s"] != "未" and not str(t.get("basis") or "").strip():
                t["s"] = "未"
            tasks.append(t)
        pinned = [t for t in (prev.get(it["id"], {}).get("tasks") or []) if t.get("by") == "人"]
        for pt in pinned:
            cur = next((t for t in tasks if t.get("t") == pt["t"]), None)
            if cur is None:   # 見立てが落とした人の作業は元の位置に戻す
                keep = dict(pt)
                old = prev[it["id"]].get("tasks") or []
                pos = min(old.index(pt), len(tasks))
                tasks.insert(pos, keep)
                continue
            if cur["s"] != pt["s"]:
                cur["hint"] = f"{cur['s']}かも：{cur.get('basis', '')}"[:60]
            else:
                cur.pop("hint", None)
            for k in ("s", "by", "basis"):
                if k in pt:
                    cur[k] = pt[k]
                else:
                    cur.pop(k, None) if k != "s" else None
            for k in ("app", "open", "ref"):
                if k in pt and not cur.get(k):
                    cur[k] = pt[k]
        it["tasks"] = tasks
    return items


def main():
    import summarize
    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    last = state.get("last_run", time.time() - FIRST_LOOKBACK_D * 86400)
    wishes = [w for w in post({"type": "get"}, CFG["token"])["wishes"] if w["state"] == "open"]
    if not wishes:
        return
    sums = summarize.load_all()
    # 材料1：やりたいことに結び付いたセッションの要約
    linked = {}
    for w in wishes:
        pr = w.get("progress") or {}
        refs = {x.get("ref") for x in (pr.get("sessions") or []) + (pr.get("tasks") or []) if x.get("ref")}
        linked[w["id"]] = [{"ref": k[:8], "title": v.get("title"), "summary": v["summary"]}
                           for k, v in sums.items() if k[:8] in refs]
    # 材料2：前回以降に要約が更新されたセッション
    recent = [{"ref": k[:8], "title": v.get("title"), "app": v.get("app"), "folder": v.get("folder"),
               "updated": v.get("updated"), "summary": v["summary"]}
              for k, v in sums.items() if v.get("mtime", 0) >= last - 86400]
    recent.sort(key=lambda r: r["updated"] or "")
    new_wish = any("progress" not in w for w in wishes)
    if not recent and not new_wish and "--force" not in sys.argv:
        state["last_run"] = time.time()
        STATE.write_text(json.dumps(state), encoding="utf-8")
        return
    wl = [{"id": w["id"], "text": w["text"], "思った日": w["at"], "前回の見立て": w.get("progress"),
           "結び付いたセッションの要約": linked[w["id"]]} for w in wishes]
    prompt = f"""あなたは本人の「やりたいこと」の進み具合を見立てる係です。

# 使ってよい材料
- 下のやりたいこと（前回の見立てと、結び付いたセッションの要約つき）と、最近のセッションの要約
- 本人の記憶：{MEMORY_DIR}（MEMORY.md が索引、各 .md が本文）。Read・Grep・Glob で読んでよい
  **やりたいことに関係しそうな記憶は、索引の1行で判断せず必ず本文を読む**（決め方・待ち条件・取り消しは本文にある）
- セッションの要約の元：{SUMMARY_DIR}（記録IDの .json）。必要なら読んでよい
- これ以外は読まない。書き込み・外への通信はしない

# やりたいこと
{json.dumps(wl, ensure_ascii=False)}

# 前回以降に要約が更新されたセッション（ref＝印）
{json.dumps(recent, ensure_ascii=False)}

# 答え方
やりたいことごとに、次の形の JSON 配列だけを最後に出力する（前置き・コードブロック記号は不要）。
[{{"id": "…", "stage": "未着手|考え中|進んでいる|ほぼできた|かなったかも", "line": "今どこまで来ているか（40字以内）",
  "tasks": [{{"t": "作業（20字以内）", "s": "済|途中|待ち|未", "basis": "根拠にした材料（記憶ファイル名かセッションの ref と、その中身を一言。40字以内）", "ref": "その作業を進めていたセッションの ref（無ければ空）"}}],
  "sessions": [{{"ref": "…", "t": "セッション名", "d": "YYYY-MM-DD"}}],
  "sources": ["根拠にした記憶ファイル名やセッションの ref"]}}]
- 作業は、やりたいことを1つのプロジェクトとして、かなえるまでに要る作業。数の上限はない。1〜数回で終わる大きさ、進める順
- 状態：済＝終えた根拠がある／途中＝手を付けた根拠がある／待ち＝外の出来事や人の返事を待っている（何を待つかを basis に）／未＝それ以外
  **済・途中・待ちには必ず basis を書く。根拠が無ければ「未」**。推測で途中にしない
- 前回の作業は、言い回しと並びを引き継ぐ。足す・分け直すのは材料ではっきりしたときだけ
- by が「人」の作業は本人が決めたもの。t と s を変えずにそのまま出す（違うと思えば basis に理由を書くだけ）
- stage は作業の進み具合と合わせる。「かなったかも」は、買った・完成した等が材料にはっきりあるときだけ
- line・basis は事実だけ。金額の細部・人名・住所は書かない
"""
    WORKDIR.mkdir(exist_ok=True)
    claude = str(pathlib.Path.home() / ".local" / "bin" / "claude.exe")
    r = subprocess.run([claude, "-p", "--model", "opus", "--no-session-persistence",
                        "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob",
                        "--add-dir", str(MEMORY_DIR), "--add-dir", str(SUMMARY_DIR)],
                       input=prompt, cwd=WORKDIR, capture_output=True, text=True, encoding="utf-8", timeout=1200,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))  # 黒い画面を出さない
    out = r.stdout or ""
    m = re.search(r"\[\s*\{.*\}\s*\]", out, re.S)
    if r.returncode != 0 or not m:
        raise RuntimeError(f"claude -p の返事を読めない rc={r.returncode} {out[-300:]} {r.stderr[:200]}")
    items = json.loads(m.group(0))
    ids = {w["id"] for w in wishes}
    items = [it for it in items if it.get("id") in ids and it.get("stage") in STAGES]
    items = enforce(items, wishes)
    items = attach(items, ref_map())
    res = post({"type": "wishProgress", "items": items}, CFG["pushToken"])
    state["last_run"] = time.time()
    STATE.write_text(json.dumps(state), encoding="utf-8")
    log(f"progress {res.get('updated')} wishes from {len(recent)} summaries")
    if "--show" in sys.argv:
        sys.stdout.reconfigure(encoding="utf-8")
        print(json.dumps(items, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        log("error: " + repr(e)[:300])
        raise
