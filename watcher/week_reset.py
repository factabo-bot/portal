"""デスクトップ（sub）の7日枠が戻る時刻の推定。
アプリの使用量の記録（plan-usage-history.json）は出来事のときしか書かれず、回復時刻が入っていない。
7日枠は毎週同じ曜日・時刻に戻るので、記録の並びから「この間に戻った（大きく下がった）」「この間には戻っていない（下がっていない）」を
1週間の中の分単位に重ねて、戻る時刻の幅を絞る。"""
import time

WEEK = 7 * 86400
STEP = 60


def window(samples, org):
    """戻る時刻の幅 (週の中の秒の始まり, 終わり)。分からなければ None"""
    s = sorted((x["t"] / 1000 if x["t"] > 1e12 else x["t"], x["u"].get("sd", 0)) for x in samples if x.get("org") == org)
    ok = [True] * (WEEK // STEP)
    hit = False

    def mark(a, b, inside):
        n = len(ok)
        ia, ib = int(a % WEEK) // STEP, int(b % WEEK) // STEP
        span = (ib - ia) % n if b - a < WEEK else n
        cover = {(ia + k) % n for k in range(span + 1)}
        for i in range(n):
            if (i in cover) != inside:
                ok[i] = False

    for (ta, sa), (tb, sb) in zip(s, s[1:]):
        if tb - ta >= WEEK:
            continue
        if sa - sb >= 20:          # 大きく下がった＝この間に戻った
            mark(ta, tb, True); hit = True
        elif sb >= sa:             # 下がっていない＝この間には戻っていない（端は含めない）
            mark(ta + STEP, tb - STEP, False)
    if not hit or not any(ok):
        return None
    # 連続した塊の最初と最後（週の端をまたぐ場合も考える）
    n = len(ok)
    idx = [i for i in range(n) if ok[i]]
    start = next((i for i in idx if not ok[(i - 1) % n]), idx[0])
    end = start
    while ok[(end + 1) % n] and (end + 1) % n != start:
        end = (end + 1) % n
    return start * STEP, (end + 1) * STEP


def next_reset(samples, org, now=None):
    """次に戻る時刻の幅 (始まり, 終わり) を実際の時刻で。分からなければ None"""
    now = now or time.time()
    w = window(samples, org)
    if not w:
        return None
    base = now - now % WEEK
    a, b = base + w[0], base + w[1] + (WEEK if w[1] <= w[0] else 0)
    while b <= now:
        a += WEEK; b += WEEK
    return int(a), int(b)


if __name__ == "__main__":
    import json, os, pathlib
    p = pathlib.Path(os.environ["LOCALAPPDATA"]) / "Claude-Data" / "claude_pzs8sxrjxfjjc" / "plan-usage-history.json"
    sm = json.loads(p.read_text(encoding="utf-8"))["samples"]
    org = sm[-1]["org"]
    r = next_reset(sm, org)
    f = lambda t: time.strftime("%m/%d %a %H:%M", time.localtime(t))
    print(r and (f(r[0]), f(r[1])))
