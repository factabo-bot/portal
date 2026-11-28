"""見回り役が裏で Claude（claude -p）を呼ぶときの行き先を、main・sub の残りで決める（11/28 本人「mainは使い切らないように」）。

- 使用量は見回り役（session_watch.py、1分おき）が quota_last.json に残した値を使う（ここでは問い合わせない＝429対策）
- 決まり：
  1. sub に CLI でログイン済み（~/.claude-sub）で、sub の5時間枠 SUB_FH 未満・7日枠 SUB_SD 未満 → sub
  2. そうでなければ main の5時間枠 MAIN_FH 未満・7日枠 MAIN_SD 未満 → main（本人の作業の分を残すため低めの線）
  3. どちらも無理 → 見送り（要約は次の回に差分から追いつく。見立ては次の起動でやり直す）
  使用量が分からない（20分より古い・無い）ときは、sub にログインがあれば sub、無ければ main
- sub で失敗したら（ログイン切れなど）、main が線の内側なら main でやり直す
"""
import json
import os
import pathlib
import subprocess
import time

HERE = pathlib.Path(__file__).resolve().parent
LAST = HERE / "quota_last.json"          # 見回り役が書く {"at": 秒, "q": {"vscode": {...}, "desktop": {...}}}（PCの中だけ）
SUB_DIR = pathlib.Path.home() / ".claude-sub"
CLAUDE = str(pathlib.Path.home() / ".local" / "bin" / "claude.exe")
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)

SUB_FH, SUB_SD = 80, 90
MAIN_FH, MAIN_SD = 60, 80


def save(q):
    """見回り役が呼ぶ"""
    try:
        LAST.write_text(json.dumps({"at": time.time(), "q": q}), encoding="utf-8")
    except OSError:
        pass


def _quota():
    try:
        d = json.loads(LAST.read_text(encoding="utf-8"))
        if time.time() - d.get("at", 0) < 1200:
            return d.get("q") or {}
    except (OSError, ValueError):
        pass
    return None


def candidates():
    """試す順の [("sub"|"main", 理由)]。空なら見送り"""
    q = _quota()
    has_sub = (SUB_DIR / ".credentials.json").exists()
    if q is None:
        return [("sub", "使用量不明")] * has_sub + [("main", "使用量不明")]
    out = []
    s, m = q.get("desktop"), q.get("vscode")
    if has_sub and s and not s.get("est") and s["fh"] < SUB_FH and s["sd"] < SUB_SD:
        out.append(("sub", f"sub 5時間{s['fh']}%・7日{s['sd']}%"))
    if m and m["fh"] < MAIN_FH and m["sd"] < MAIN_SD:
        out.append(("main", f"main 5時間{m['fh']}%・7日{m['sd']}%"))
    elif not m and not out:
        out.append(("main", "main の使用量不明"))
    return out


def run(args, input, cwd, timeout, log=print):
    """claude を余裕のある方で動かす。返り値は (CompletedProcess, 使った方)。どちらも無理なら (None, None)"""
    cands = candidates()
    if not cands:
        return None, None
    r = None
    for who, why in cands:
        env = dict(os.environ)
        if who == "sub":
            env["CLAUDE_CONFIG_DIR"] = str(SUB_DIR)
        else:
            env.pop("CLAUDE_CONFIG_DIR", None)
        r = subprocess.run([CLAUDE, *args], input=input, cwd=cwd, env=env, capture_output=True, text=True,
                           encoding="utf-8", timeout=timeout, creationflags=NOWIN)
        if r.returncode == 0:
            return r, who
        log(f"llm: {who} で失敗（{why}） rc={r.returncode} {(r.stderr or r.stdout or '')[:120]}")
    return r, cands[-1][0]
