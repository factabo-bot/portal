"""ポータルの「研修の作業記録」メモを読む・印を付ける（作業記録を作るときに Claude が使う道具）。
  python tools/memo.py list [YYYY-MM-DD] [--all]     まだ記録にしていないメモ（--all で記録済みも）
  python tools/memo.py done <id> [<id> …]            作業記録のファイルに入れた印（保存できたあとだけ）
  python tools/memo.py open <id> [<id> …]            印を外す
"""
import json
import pathlib
import sys

from wish import post


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    a = sys.argv[1:]
    if not a or a[0] not in ("list", "done", "open"):
        sys.exit(__doc__)
    if a[0] == "list":
        day = next((x for x in a[1:] if x[:2] == "20"), "")
        ms = [m for m in post({"type": "memoList"})["memos"]
              if (not day or m["date"] == day) and ("--all" in a or not m.get("done"))]
        for m in ms:
            print(f"[{m['id']}] {m['date']}{'（記録済み）' if m.get('done') else ''}\n{m['t']}\n")
        if not ms:
            print("メモなし")
    else:
        if not a[1:]:
            sys.exit("ID が要る")
        print("印を付けた:", post({"type": "memoMark", "ids": a[1:], "to": a[0]})["marked"], "件")


if __name__ == "__main__":
    main()
