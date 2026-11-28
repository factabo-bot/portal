"""Claude のセッションを、ひと区切りごとに要約して PC の中に置く（やりたいことの見立ての材料）。

- 見回り役（session_watch.py、5分おき）の最後に呼ばれる。1回に最大3件
- 対象：VS Code・デスクトップのセッションで、7日以内に動き、最後の動きから10分以上たった（＝ひと区切りついた）もの
- 差分だけ読む：前回の要約＋その後に増えたやり取り（人の入力と Claude の文章。ツールの中身は読まない）を渡して書き足させる
  長いセッションは 15,000 字ずつ順に読み進める（頭と最後だけ読むと途中の決定を落とすため）
- 要約は watcher/summaries/<記録ID>.json。PC の外（窓口・公開リポジトリ）には出さない
- claude -p は --no-session-persistence（要約役の会話を記録に残さない）・道具なし
"""
import json
import pathlib
import re
import subprocess
import time

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "summaries"
WORKDIR = HERE / "_llm"
PROJECTS = pathlib.Path.home() / ".claude" / "projects"
CLAUDE = str(pathlib.Path.home() / ".local" / "bin" / "claude.exe")
APPS = {"claude-vscode": "VS Code", "claude-desktop": "デスクトップ"}
LOOKBACK_S = 7 * 86400
IDLE_S = 600          # 区切り：最後が Claude の返事で終わり、10分書き込みがない
STUCK_S = 3600        # ツールの途中で止まったまま1時間たったら、そこまでを要約する
CHUNK = 15000
MODEL = "haiku"


def _text(msg):
    c = (msg or {}).get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
    return ""


def _clean(s, n):
    s = re.sub(r"<(system-reminder|ide_[a-z_]+|command-[a-z-]+|local-command-[a-z-]+)>.*?</\1>", " ", s, flags=re.S)
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[:n] + "…"


def _meta(path):
    """名前・起動元・作業場所（全体をざっと見る）"""
    title, entry, cwd = "", "", ""
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            if '"custom-title"' in line or '"ai-title"' in line or '"entrypoint"' in line or ('"cwd"' in line and not cwd):
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                title = d.get("customTitle") or d.get("aiTitle") or title
                entry = d.get("entrypoint") or entry
                cwd = cwd or d.get("cwd", "")
    return title, entry, cwd


def _excerpt(path, start):
    """start 行目から、人の入力と Claude の文章を CHUNK 字まで。戻り値：(本文, 読み終えた行数, 全行数)"""
    parts, size, end = [], 0, start
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    for i in range(start, len(lines)):
        end = i + 1
        try:
            d = json.loads(lines[i])
        except ValueError:
            continue
        if d.get("isSidechain") or d.get("isMeta"):
            continue
        t = d.get("type")
        if t == "user":
            c = (d.get("message") or {}).get("content")
            if isinstance(c, list) and any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c):
                continue
            s = _clean(_text(d.get("message")), 1200)
            who = "人"
        elif t == "assistant":
            s = _clean(_text(d.get("message")), 1500)
            who = "Claude"
        else:
            continue
        if not s:
            continue
        piece = f"【{who}】{s}"
        if size + len(piece) > CHUNK and parts:
            end = i       # この行は次の回に
            break
        parts.append(piece)
        size += len(piece)
    return "\n".join(parts), end, len(lines)


PROMPT = """あなたは Claude との作業セッションの記録係です。道具は使わず、下の材料だけで答えてください。

# セッション名
{title}

# これまでの要約（無ければ null）
{prev}

# その後のやり取り（人＝本人、Claude＝アシスタント。{part}）
{body}

# 答え方
これまでの要約に今回のやり取りを反映した、新しい要約を次の JSON だけで出力する（前置き・コードブロック記号は不要）。
{{"doing": "このセッションで何をしているか（60字以内）",
 "decided": ["決まったこと・本人が決めたこと（1つ60字以内、最大10個。古くても有効なものは残す）"],
 "remaining": ["まだ残っていること（最大8個）"],
 "waiting": [{{"what": "待っていること", "until": "何が起きたら次に進むか"}}],
 "next": "次の一歩（60字以内。無ければ空）"}}
- 事実だけ。推測で埋めない。取り消された決定は消す
- 金額・型番・日付など、後で判断に使う具体的な値は残す。人名・住所・口座などの個人情報は書かない
"""


def _turn_ended(path):
    """最後の人／Claude の記録が「Claude の返事で終わっている」か（セッション欄の誰の番の判定と同じ考え方）"""
    last = None
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            if '"type":"user"' not in line and '"type":"assistant"' not in line and '"type": "user"' not in line and '"type": "assistant"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("isSidechain") or d.get("isMeta") or d.get("type") not in ("user", "assistant"):
                continue
            last = d
    if not last or last["type"] != "assistant":
        return False
    msg = last.get("message") or {}
    names = [x.get("name") for x in (msg.get("content") or []) if isinstance(x, dict) and x.get("type") == "tool_use"]
    if any(n in ("AskUserQuestion", "ExitPlanMode") for n in names):
        return True          # 本人への質問で止まっている＝区切り
    return msg.get("stop_reason") == "end_turn" and not names


def _due(now):
    out = []
    for p in PROJECTS.glob("*/*.jsonl"):
        try:
            st = p.stat()
        except OSError:
            continue
        idle = now - st.st_mtime
        if idle > LOOKBACK_S or idle < IDLE_S:
            continue
        sfile = OUT / (p.stem + ".json")
        prev = json.loads(sfile.read_text(encoding="utf-8")) if sfile.exists() else None
        if prev and prev.get("mtime", 0) >= st.st_mtime and not prev.get("more"):
            continue
        if idle < STUCK_S and not (prev or {}).get("more") and not _turn_ended(p):
            continue         # Claude が作業の途中（ツールの実行中など）。区切りではない
        out.append((st.st_mtime, p, prev))
    out.sort(key=lambda x: -x[0])
    return out


def summarize_one(p, prev):
    title, entry, cwd = _meta(p)
    if entry not in APPS or pathlib.PurePath(cwd or ".").name == "_llm":
        # 対象外も「見た」印だけ残して、次から飛ばす
        OUT.mkdir(exist_ok=True)
        (OUT / (p.stem + ".json")).write_text(json.dumps({"skip": True, "mtime": p.stat().st_mtime}), encoding="utf-8")
        return None
    start = (prev or {}).get("lines", 0)
    body, end, total = _excerpt(p, start)
    mtime = p.stat().st_mtime
    rec = dict(prev or {})
    rec.update({"sid": p.stem, "title": title, "app": APPS[entry], "folder": pathlib.PurePath(cwd).name if cwd else "",
                "lines": end, "mtime": mtime, "more": end < total})
    if body.strip():
        part = f"{start + 1}〜{end}行目／全{total}行" + ("。まだ続きがある" if end < total else "")
        prompt = PROMPT.format(title=title or "（名前なし）", prev=json.dumps((prev or {}).get("summary"), ensure_ascii=False),
                               part=part, body=body)
        WORKDIR.mkdir(exist_ok=True)
        import llm_route   # main・sub の余裕がある方で（main を使い切らないように）
        r, _ = llm_route.run(["-p", "--model", MODEL, "--no-session-persistence", "--tools", ""],
                             prompt, WORKDIR, 300)
        if r is None:
            return None
        m = re.search(r"\{.*\}", r.stdout or "", re.S)
        if r.returncode != 0 or not m:
            raise RuntimeError(f"要約できない {p.stem[:8]} rc={r.returncode} {(r.stdout or '')[:120]} {(r.stderr or '')[:120]}")
        rec["summary"] = json.loads(m.group(0))
        rec["updated"] = time.strftime("%Y-%m-%d %H:%M")
    OUT.mkdir(exist_ok=True)
    (OUT / (p.stem + ".json")).write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    return rec


def run(max_n=3, log=print):
    now = time.time()
    done = 0
    import llm_route
    if not llm_route.candidates():      # main・sub とも枠に余裕がない → 見送り（次の回に差分から追いつく）
        return 0
    for _, p, prev in _due(now):
        if done >= max_n:
            break
        try:
            rec = summarize_one(p, prev)
        except Exception as e:  # noqa: BLE001
            log("summary error: " + repr(e)[:200])
            continue
        if rec is not None:
            done += 1
            log(f"summary {p.stem[:8]} lines={rec['lines']}{' (続きあり)' if rec.get('more') else ''}")
    return done


def load_all():
    """要約の一覧（見立て役が使う）"""
    out = {}
    for f in OUT.glob("*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except ValueError:
            continue
        if d.get("summary"):
            out[f.stem] = d
    return out


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) > 2 and sys.argv[1] == "one":
        p = next(PROJECTS.glob(f"*/{sys.argv[2]}*.jsonl"))
        sfile = OUT / (p.stem + ".json")
        prev = json.loads(sfile.read_text(encoding="utf-8")) if sfile.exists() else None
        rec = summarize_one(p, prev)
        print(json.dumps(rec, ensure_ascii=False, indent=1))
    else:
        print(run(int(sys.argv[1]) if len(sys.argv) > 1 else 3))
