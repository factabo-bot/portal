"""会話の記録を2台のPCで写し合う（どちらのPCからでも続きを開けるように）。

- 対象：~/.claude/projects のうち G: ドライブの作業フォルダ（obsidian など、2台で同じパス＝同じ記録フォルダ名）の会話
- 置き場：G:/マイドライブ/_claude共有/sessions/<記録フォルダ名>/<記録のID>.jsonl（Google ドライブが2台へ配る）
- 記録は後ろに書き足すだけのファイルなので、「片方がもう片方の頭と同じ」ときだけ、足りない後ろを足す。
  両方で別々に書き足して食い違ったら、どちらも触らずログに残す（上書きで会話を消さない）
- 合言葉・鍵が入った記録は写さない（ドライブを見られても漏れないように）。~/projects の下の .local.json の値と、
  鍵らしい形（sk-ant- など）を探す。見つかった会話は blocked.json に残し、以後写さない（一覧でも「ほかのPCで開ける」を付けない）
- 相手のPCから取り込んだ記録は pulled.json に大きさを残す。大きさがそのまま＝最後に話したのは相手のPC
  → このPCのセッション一覧には出さない（相手のPCが出す）。このPCで続きを話して大きくなったら、このPCが出す
"""
import json
import os
import pathlib
import re
import time

HERE = pathlib.Path(__file__).resolve().parent
PROJECTS = pathlib.Path.home() / ".claude" / "projects"
SHARED = pathlib.Path("G:/マイドライブ/_claude共有/sessions")
PULLED = HERE / "pulled.json"     # 記録のID → 取り込んだときの大きさ（PCの中だけ・git 管理外）
WINDOW_H = 72                     # これより古い記録は写さない
BLOCKED = HERE / "blocked.json"   # 合言葉が入っていて写さない会話のID（PCの中だけ・git 管理外）
KEEP_DAYS = 14                    # 置き場の古い写しはこれで捨てる
QUIET_S = 5                       # 書き込み中の記録は触らない


def in_scope(projdir):
    """2台で同じパスになる作業フォルダだけ（G: ドライブ）。デスクトップの一時フォルダなどはPCごとに違う"""
    return projdir.startswith("G-")


# 鍵らしい形：Anthropic・GitHub のトークン、秘密鍵
KEY_RE = re.compile(rb"sk-ant-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----")


def secrets():
    """自作プログラムの合言葉（~/projects の下の .local.json の文字列の値で、16文字以上の物）"""
    out = set()
    for p in list((pathlib.Path.home() / "projects").glob("*/.local.json")) + list((pathlib.Path.home() / "projects").glob("*/*/.local.json")):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for v in (d.values() if isinstance(d, dict) else []):
            if isinstance(v, str) and len(v) >= 16 and not v.startswith("http"):
                out.add(v.encode("utf-8"))
    return out


def has_secret(path, start, end, sec):
    with path.open("rb") as f:
        f.seek(start)
        b = f.read(end - start)
    return bool(KEY_RE.search(b)) or any(x in b for x in sec)


def load_blocked():
    try:
        return set(json.loads(BLOCKED.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return set()


def is_blocked(sid):
    return sid in load_blocked()


def load_pulled():
    try:
        return json.loads(PULLED.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def last_nl(path, size):
    """size までのうち最後の改行の直後の位置（書きかけの行は写さない）"""
    with path.open("rb") as f:
        pos = size
        while pos > 0:
            step = min(65536, pos)
            f.seek(pos - step)
            chunk = f.read(step)
            i = chunk.rfind(b"\n")
            if i >= 0:
                return pos - step + i + 1
            pos -= step
    return 0


def same_head(a, b, n):
    """a と b の先頭 n バイトが同じか"""
    with a.open("rb") as fa, b.open("rb") as fb:
        left = n
        while left > 0:
            k = min(1 << 20, left)
            if fa.read(k) != fb.read(k):
                return False
            left -= k
    return True


def append_tail(src, dst, start, end):
    """src の start〜end を dst の後ろに足す（dst の長さは start と同じ前提）"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    with src.open("rb") as fs, dst.open("ab") as fd:
        fs.seek(start)
        left = end - start
        while left > 0:
            b = fs.read(min(1 << 20, left))
            if not b:
                break
            fd.write(b)
            left -= len(b)


def run(live=None, log=print):
    """1回分。live＝このPCで動いている claude の状態 {記録のID: 状態}（動いている会話には相手の分を足さない）"""
    if not SHARED.parent.exists():      # ドライブがまだ見えていない
        return
    live = live or {}
    now = time.time()
    pulled = load_pulled()
    blocked = load_blocked()
    nblocked = len(blocked)
    sec = None
    changed = False
    ids = {}
    for root, side in ((PROJECTS, "l"), (SHARED, "d")):
        if not root.exists():
            continue
        for p in root.glob("*/*.jsonl"):
            if not in_scope(p.parent.name):
                continue
            try:
                age = now - p.stat().st_mtime
            except OSError:
                continue
            if side == "d" and age > KEEP_DAYS * 86400:
                try:
                    p.unlink()
                except OSError:
                    pass
                continue
            if age > WINDOW_H * 3600:
                continue
            ids.setdefault((p.parent.name, p.name), set()).add(side)
    for (proj, name) in ids:
        loc, drv = PROJECTS / proj / name, SHARED / proj / name
        sid = name[:-6]
        if sid in blocked:
            continue
        try:
            ls = loc.stat().st_size if loc.exists() else -1
            ds = drv.stat().st_size if drv.exists() else -1
            if ls >= 0 and now - loc.stat().st_mtime < QUIET_S:
                continue
            if ds >= 0 and now - drv.stat().st_mtime < QUIET_S:
                continue
            if ls == ds:
                continue
            if ls > ds:          # このPCの方が先へ進んでいる → 置き場へ足す
                if ds > 0 and not same_head(loc, drv, ds):
                    log(f"sync: {sid[:8]} は2台で別々に続いている（どちらも触らない）")
                    continue
                end = last_nl(loc, ls)
                if end > max(ds, 0):
                    if sec is None:
                        sec = secrets()
                    if has_secret(loc, max(ds, 0), end, sec):
                        blocked.add(sid)
                        log(f"sync: {sid[:8]} に合言葉・鍵が入っているので写さない")
                        continue
                    append_tail(loc, drv, max(ds, 0), end)
            else:                # 相手のPCの方が先へ進んでいる → このPCへ足す
                if live.get(sid) == "busy":
                    continue
                if ls > 0 and not same_head(loc, drv, ls):
                    log(f"sync: {sid[:8]} は2台で別々に続いている（どちらも触らない）")
                    continue
                end = last_nl(drv, ds)
                if end > max(ls, 0):
                    append_tail(drv, loc, max(ls, 0), end)
                    pulled[sid] = end
                    changed = True
        except OSError as e:
            log(f"sync error {sid[:8]}: {e!r}"[:300])
    # 古くなった印は捨てる
    keep = {n[:-6] for (_, n) in ids}
    for k in list(pulled):
        if k not in keep:
            del pulled[k]
            changed = True
    if len(blocked) != nblocked:
        BLOCKED.write_text(json.dumps(sorted(blocked)), encoding="utf-8")
    if changed:
        PULLED.write_text(json.dumps(pulled), encoding="utf-8")


def from_other_pc(sid, size):
    """最後に話したのが相手のPCか（取り込んだときから大きさが変わっていない）"""
    return load_pulled().get(sid) == size


if __name__ == "__main__":
    run()
