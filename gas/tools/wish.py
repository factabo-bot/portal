"""やりたいことを窓口に足す・見る・片づける（Claude が会話の中から使う道具）。
  python tools/wish.py add "ノートPCを買いたい" [--at 2026-11-24]
  python tools/wish.py list [--all]
  python tools/wish.py done <id> | drop <id> [--note 理由] | open <id>
  python tools/wish.py progress <id> --stage 進んでいる --line "今の状況" --tasks "済:候補を絞る|途中:機種を決める|未:買う"
    （伴走のセッションから、その場で見立てを書き換える。関係セッションの記録は残す）
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
            tasks = []
            for part in a.tasks.split("|"):
                s, _, t = part.partition(":")
                tasks.append({"t": t.strip(), "s": s.strip()})
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
