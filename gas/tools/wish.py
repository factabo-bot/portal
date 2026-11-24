"""やりたいことを窓口に足す・見る・片づける（Claude が会話の中から使う道具）。
  python tools/wish.py add "ノートPCを買いたい" [--at 2026-11-24]
  python tools/wish.py list [--all]
  python tools/wish.py done <id> | drop <id> [--note 理由] | open <id>
  python tools/wish.py progress <id> --stage 進んでいる --line "今の状況" --tasks "済:候補を絞る|待ち:価格を待つ|未:買う" [--note 根拠]
    （伴走のセッションから、その場で見立てを書き換える。新しく足した・状態を変えた作業には「人が決めた」印が付き、
      毎朝の見立て役はそこを変えない。--unpin で印を外して見立て役に任せる。関係セッションの記録は残す）
"""
import argparse
import json
import pathlib
import sys
import urllib.request

CFG = json.loads((pathlib.Path(__file__).resolve().parent.parent / ".local.json").read_text(encoding="utf-8"))


def post(body, key=None):
    body = dict(body, key=key or CFG["token"])
    req = urllib.request.Request(CFG["url"], data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                 headers={"Content-Type": "text/plain;charset=utf-8"})
    with urllib.request.urlopen(req, timeout=90) as r:
        res = json.loads(r.read().decode("utf-8"))
    if not res.get("ok"):
        sys.exit(f"失敗: {res}")
    return res


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["add", "list", "done", "drop", "open", "progress"])
    ap.add_argument("--stage")
    ap.add_argument("--line")
    ap.add_argument("--tasks")
    ap.add_argument("arg", nargs="?")
    ap.add_argument("--at")
    ap.add_argument("--note")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--unpin", action="store_true", help="progress で「人が決めた」印を外す")
    a = ap.parse_args()
    if a.cmd == "add":
        w = post({"type": "wishAdd", "text": a.arg, "at": a.at})["wish"]
        print("追加:", w["id"], w["at"], w["text"])
    elif a.cmd == "list":
        for w in post({"type": "get"})["wishes"]:
            if a.all or w["state"] == "open":
                print(w["id"], w["state"], w["at"], w["text"], ("／" + w["note"]) if w.get("note") else "")
    elif a.cmd == "progress":
        cur = next((w for w in post({"type": "get"})["wishes"] if w["id"] == a.arg), None)
        if not cur:
            sys.exit("そのIDのやりたいことが無い")
        old = cur.get("progress") or {}
        tasks = old.get("tasks", [])
        if a.tasks:
            # 同じ作業名なら「続き」のリンク（app・open・ref）を引き継ぐ。新しい作業には最新の関係セッションを付ける
            keep = {t["t"]: t for t in tasks}
            linked = [s for s in old.get("sessions", []) if s.get("open")]
            latest = max(linked, key=lambda s: s.get("d", ""), default=None)
            tasks = []
            for part in a.tasks.split("|"):
                s, _, t = part.partition(":")
                item = {"t": t.strip(), "s": s.strip()}
                if item["s"] not in ("済", "途中", "待ち", "未"):
                    sys.exit(f"状態は 済・途中・待ち・未 のどれか: {part}")
                before = keep.get(item["t"])
                src = before or latest
                if src and src.get("open"):
                    item.update({k: src[k] for k in ("app", "open", "ref") if k in src})
                # 人（本人・伴走のセッション）が新しく足した／状態を変えた作業は「人が決めた」印。見立て役は変えない
                if before is None or before.get("s") != item["s"] or before.get("by") == "人":
                    item["by"] = "人"
                    item["basis"] = (a.note or (before or {}).get("basis") or "本人・伴走で決めた")[:80]
                elif before.get("basis"):
                    item["basis"] = before["basis"]
                tasks.append(item)
        if a.unpin:   # 「人が決めた」印を全部外して、見立て役に任せる
            for t in tasks:
                t.pop("by", None)
        item = {"id": a.arg, "stage": a.stage or old.get("stage", "未着手"), "line": a.line if a.line is not None else old.get("line", ""),
                "tasks": tasks, "sessions": old.get("sessions", [])}
        print(post({"type": "wishProgress", "items": [item]}, CFG["pushToken"]))
    else:
        body = {"type": "wishUpdate", "id": a.arg, "state": a.cmd}
        if a.note is not None:
            body["note"] = a.note
        w = post(body)["wish"]
        print("更新:", w["id"], w["state"], w["text"])


if __name__ == "__main__":
    main()
