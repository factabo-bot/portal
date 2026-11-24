"""デスクトップアプリ（アカウントB）の今の使用量を、会話記録のトークン量から推定する。

アプリの記録（plan-usage-history.json）は出来事の時にしか書かれず、今の値が分からないため。
- 重み＝トークンの種類ごとの単価（入力1・キャッシュ書き込み1.25/2・キャッシュ読み0.1・出力5）×モデルの単価
- 5時間枠いっぱい＝約72（11/24に3回分で確かめた：Bの上限到達 74.1・71.7、Aの96%＝69.3）
- 5時間枠いっぱい＝7日枠の13%（Bの 55→68、27→40）
- 枠の始まり＝前の枠が終わったあとの最初のやり取り（10分単位に切り下げ）、5時間で終わる
このPCの会話だけを数える。スマホやブラウザで使った分は入らないので、低めに出ることがある。
"""
import datetime
import json
import pathlib
import time

HERE = pathlib.Path(__file__).resolve().parent
CACHE = HERE / "usage_cache.json"     # PCの中だけ・git 管理外
PROJECTS = pathlib.Path.home() / ".claude" / "projects"
FULL_5H = 72.0
FULL_5H_AS_7D = 13.0
WINDOW = 5 * 3600
PRICE = {"opus": 5, "sonnet": 3, "haiku": 1, "fable": 10}
KEEP_H = 36                            # 枠の始まりを追うのに要る長さ


def _rows(path, entry):
    out = {}
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            if '"usage"' not in line:
                continue
            try:
                d = json.loads(line)
                if d.get("type") != "assistant" or d.get("entrypoint") != entry:
                    continue
                m = d["message"]
                u = m.get("usage") or {}
                t = datetime.datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00")).timestamp()
                price = next((v for k, v in PRICE.items() if k in (m.get("model") or "")), 0)
                cw = u.get("cache_creation") or {}
                w1 = cw.get("ephemeral_1h_input_tokens", 0)
                w5 = cw.get("ephemeral_5m_input_tokens", 0) if cw else u.get("cache_creation_input_tokens", 0)
                c = (u.get("input_tokens", 0) + 1.25 * w5 + 2 * w1 + 0.1 * u.get("cache_read_input_tokens", 0)
                     + 5 * u.get("output_tokens", 0)) * price / 1e6
                if c:
                    out[m["id"]] = [t, round(c, 5)]
            except (ValueError, KeyError, TypeError, AttributeError):
                continue
    return out


def usage_rows(since, entry="claude-desktop", cache_path=CACHE):
    """since 以降のやり取り [(時刻, 重み)]。サブエージェントの記録も含む"""
    try:
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cache = {}
    fresh, rows = {}, {}
    for p in PROJECTS.rglob("*.jsonl"):
        try:
            st = p.stat()
            if st.st_mtime < since:
                continue
            k, key = str(p), f"{st.st_mtime_ns}:{st.st_size}"
            hit = cache.get(k)
            rec = hit if hit and hit["key"] == key else {"key": key, "rows": {
                i: r for i, r in _rows(p, entry).items() if r[0] >= since}}
        except OSError:
            continue
        fresh[k] = rec
        rows.update(rec["rows"])
    cache_path.write_text(json.dumps(fresh), encoding="utf-8")
    return sorted((t, c) for t, c in rows.values() if t >= since)


def current_window(rows, now):
    """今の5時間枠の（始まり, 使った割合%）。枠が終わっていれば (None, 0)"""
    start, used = None, 0.0
    for t, c in rows:
        if start is None or t >= start + WINDOW:
            start, used = t - t % 600, 0.0
        used += c
    if start is None or now >= start + WINDOW:
        return None, 0.0
    return start, used / FULL_5H * 100


def estimate(sample_t, sample_fh, sample_sd, now=None):
    """アプリの最後の記録（時刻・5時間枠・7日枠）に、その後のやり取りを足した推定"""
    now = now or time.time()
    rows = usage_rows(min(sample_t, now - KEEP_H * 3600) if now - sample_t < 7 * 86400 else now - KEEP_H * 3600)
    start, fh = current_window(rows, now)
    after = sum(c for t, c in rows if t > sample_t) / FULL_5H
    if start is not None and sample_t >= start:      # 記録が今の枠の中なら、記録の値を下回らせない
        fh = max(fh, sample_fh + after * 100)
    return {"fh": min(100, round(fh)), "sd": min(100, round(sample_sd + after * FULL_5H_AS_7D)),
            "fhReset": int(start + WINDOW) if start else 0}


if __name__ == "__main__":      # 確かめ用：VS Code（A）で推定し、公式の値と比べる
    n = time.time()
    r = usage_rows(n - KEEP_H * 3600, "claude-vscode", HERE / "usage_cache_test.json")
    s, f = current_window(r, n)
    print("VS Code 推定", round(f, 1), "% 枠の始まり", s and time.strftime("%H:%M", time.localtime(s)))
    (HERE / "usage_cache_test.json").unlink()
