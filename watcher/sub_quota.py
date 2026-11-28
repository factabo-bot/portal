"""main・sub の使用量を、公式の利用枠の窓口（api/oauth/usage）から取る。
main＝~/.claude（VS Code の CLI のログイン）。11/28 までは AI進捗モニターの collector を借りていたが、モニターは廃止した。
sub（デスクトップアプリのアカウント）は次のとおり。
デスクトップアプリのログインは外から使えないので、CLI を別の置き場（~/.claude-sub、CLAUDE_CONFIG_DIR）で
sub にログインしておき、そのログイン情報で問い合わせる（main と同じ窓口）。
置き場はPCの中だけ（ドライブ・git に入れない）。ログインが無いPCでは None を返し、見回り役は推定に戻る。"""
import datetime as dt
import json
import os
import pathlib
import subprocess
import time
import urllib.request

SUB = pathlib.Path.home() / ".claude-sub"
MAIN = pathlib.Path.home() / ".claude"
NOWIN = 0x08000000   # CREATE_NO_WINDOW（pythonw から呼ぶと黒い窓が出るため）


def _token(d):
    try:
        c = json.loads((d / ".credentials.json").read_text(encoding="utf-8")).get("claudeAiOauth", {})
        return c.get("accessToken"), (c.get("expiresAt") or 0) / 1000
    except Exception:  # noqa: BLE001
        return None, 0


def _claude(d, args, timeout):
    env = dict(os.environ, CLAUDE_CONFIG_DIR=str(d))
    subprocess.run(["claude", *args], env=env, cwd=str(d), timeout=timeout, capture_output=True,
                   creationflags=NOWIN, shell=False)


def _refresh(d, now):
    """期限が近いトークンを CLI に更新させる。まず軽い auth status、だめなら1時間に1回だけ最小の問い合わせ"""
    _claude(d, ["auth", "status"], 60)
    tok, exp = _token(d)
    if tok and exp - now > 600:
        return
    try:
        st = json.loads((d / ".portal_refresh.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        st = {}
    if now - st.get("ping", 0) < 3600:
        return
    (d / ".portal_refresh.json").write_text(json.dumps({"ping": now}), encoding="utf-8")
    _claude(d, ["-p", "ok", "--model", "haiku", "--no-session-persistence", "--max-turns", "1"], 120)


def fetch(now=None, d=SUB):
    """{"fh","sd","fhReset","sdReset"} か None。d＝ログインの置き場（SUB か MAIN）"""
    now = now or time.time()
    CACHE = d / ".portal_quota_cache.json"
    if not (d / ".credentials.json").exists():
        return None
    try:
        c = json.loads(CACHE.read_text(encoding="utf-8"))
        # 5分に1回だけ問い合わせる（使用量の窓口は回数が多いと429で断り、VS Code側の表示まで出なくなった 11/28）。
        # 断られたら15分は問い合わせず、前の値を使う
        if now - c.get("at", 0) < 300 or now < c.get("wait", 0):
            return c.get("q")
    except Exception:  # noqa: BLE001
        pass
    tok, exp = _token(d)
    if not tok or exp - now < 600:
        _refresh(d, now)
        tok, exp = _token(d)
    if not tok or exp <= now:
        return None
    req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage",
                                 headers={"Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20"})
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            raw = json.loads(r.read().decode("utf-8"))
    except Exception:
        try:
            c = json.loads(CACHE.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            c = {}
        c["wait"] = now + 900
        CACHE.write_text(json.dumps(c), encoding="utf-8")
        return c.get("q") if now - c.get("at", 0) < 3600 else None


    def ts(v):
        try:
            return dt.datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp() if v else None
        except Exception:  # noqa: BLE001
            return None
    fh, sd = raw.get("five_hour") or {}, raw.get("seven_day") or {}
    q = {"fh": round(float(fh.get("utilization", 0))), "sd": round(float(sd.get("utilization", 0))),
         "fhReset": ts(fh.get("resets_at")), "sdReset": ts(sd.get("resets_at"))}
    CACHE.write_text(json.dumps({"at": now, "q": q}), encoding="utf-8")
    return q


if __name__ == "__main__":
    print("main", fetch(d=MAIN))
    print("sub", fetch())
