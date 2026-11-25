"""前の会話を、新しい会話で引き継ぐための材料を出す（ポータルの「新しい会話で続ける」から使う）。
  python watcher/handoff.py <記録のIDの頭8文字以上 または local_…>
出すもの：前の会話の名前・アプリ・場所・最後の時刻、要約（watcher/summaries）、最後のやり取り（道具の出力は含まない）
前の会話には何も書き込まない。
"""
import datetime
import json
import pathlib
import re
import sys
import time

import session_watch as w

LAST_CHARS = 9000     # 最後のやり取りの合計
ONE_CHARS = 2500      # 1つの発言


def find(key):
    if key.startswith("local_"):
        for p in w.DESKTOP_SESSIONS.glob(f"*/*/{key}.json"):
            key = json.loads(p.read_text(encoding="utf-8")).get("cliSessionId") or key
    if not re.fullmatch(r"[0-9a-fA-F-]{8,36}", key):
        sys.exit("会話のIDの形が違う: " + key)
    hits = list(w.PROJECTS.glob(f"*/{key}*.jsonl"))
    if len(hits) != 1:
        sys.exit(f"記録が{'見つからない' if not hits else '複数ある'}: {key}")
    return hits[0]


def talk(path):
    """本人とClaudeの文章だけを古い順に"""
    out = []
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("isSidechain") or d.get("isMeta"):
                continue
            if d.get("type") == "user" and not w.is_human_prompt(d):
                continue
            if d.get("type") not in ("user", "assistant"):
                continue
            t = re.sub(r"<(system-reminder|ide_opened_file|ide_selection)[^>]*>.*?</\1>", "", w.text_of(d.get("message")), flags=re.S).strip()
            if not t:
                continue
            who = "本人" if d["type"] == "user" else "Claude"
            if out and out[-1][0] == who == "Claude":
                out[-1][1] += "\n" + t
            else:
                out.append([who, t])
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    path = find(sys.argv[1])
    title, entry, cwd, last, _, _, _ = w.read_session(path)
    at = w.ts(last) if last else 0
    print(f"# 前の会話：{title or '（名前なし）'}")
    print(f"- アプリ：{w.APPS.get(entry, entry)}／作業していた場所：{cwd}")
    print(f"- 最後のやり取り：{datetime.datetime.fromtimestamp(at):%Y-%m-%d %H:%M}／記録：{path}")
    if w.live_status().get(path.stem) == "busy" or time.time() - at < 120:
        print("- 注意：前の会話は今も動いているかもしれない。同じファイルを直す前に本人に確かめる")
    s = w.HERE / "summaries" / (path.stem + ".json")
    if s.exists():
        d = json.loads(s.read_text(encoding="utf-8"))
        if d.get("summary"):
            print("\n## 要約" + ("（途中まで）" if d.get("more") else ""))
            print(json.dumps(d["summary"], ensure_ascii=False, indent=1))
    print("\n## 最後のやり取り（古い順）")
    picked, total = [], 0
    for who, t in reversed(talk(path)):
        t = t if len(t) <= ONE_CHARS else t[:ONE_CHARS // 2] + "\n…（中略）…\n" + t[-ONE_CHARS // 2:]
        if picked and total + len(t) > LAST_CHARS:
            break
        picked.append((who, t))
        total += len(t)
    for who, t in reversed(picked):
        print(f"\n【{who}】\n{t}")


if __name__ == "__main__":
    main()
