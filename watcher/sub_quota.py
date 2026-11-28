"""sub（デスクトップアプリのアカウント）の使用量を、公式の利用枠の窓口から取る。
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

DIR = pathlib.Path.home() / ".claude-sub"
CREDS = DIR / ".credentials.json"
CACHE = DIR / ".quota_cache.json"
STATE = DIR / ".refresh_state.json"
NOWIN = 0x08000000   # CREATE_NO_WINDOW（pythonw から呼ぶと黒い窓が出るため）


def _token():
    try:
        c = json.loads(CREDS.read_text(encoding="utf-8")).get("claudeAiOauth", {})
        return c.get("accessToken"), (c.get("expiresAt") or 0) / 1000
    except Exception:  # noqa: BLE001
        return None, 0


def _claude(args, timeout):
    env = dict(os.environ, CLAUDE_CONFIG_DIR=str(DIR))
    subprocess.run(["claude", *args], env=env, cwd=str(DIR), timeout=timeout, capture_output=True,
                   creationflags=NOWIN, shell=False)


def _refresh(now):
    """期限が近いトークンを CLI に更新させる。まず軽い auth status、だめなら1時間に1回だけ最小の問い合わせ"""
    _claude(["auth", "status"], 60)
    tok, exp = _token()
    if tok and exp - now > 600:
        return
    try:
        st = json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        st = {}
    if now - st.get("ping", 0) < 3600:
        return
    STATE.write_text(json.dumps({"ping": now}), encoding="utf-8")
    _claude(["-p", "ok", "--model", "haiku", "--no-session-persistence", "--max-turns", "1"], 120)


def fetch(now=None):
    """{"fh","sd","fhReset","sdReset"} か None"""
    now = now or time.time()
    if not CREDS.exists():
        return None
    try:
        c = json.loads(CACHE.read_text(encoding="utf-8"))
        if now - c.get("at", 0) < 60:
            return c.get("q")
    except Exception:  # noqa: BLE001
        pass
    tok, exp = _token()
    if not tok or exp - now < 600:
        _refresh(now)
        tok, exp = _token()
    if not tok or exp <= now:
        return None
    req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage",
                                 headers={"Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20"})
    with urllib.request.urlopen(req, timeout=6) as r:
        raw = json.loads(r.read().decode("utf-8"))

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
    print(fetch())
