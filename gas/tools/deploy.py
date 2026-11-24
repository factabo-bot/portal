"""ポータルのGASを送り、Webアプリの配備を更新する。初回はプロジェクトと配備を作り .local.json に残す。
pdf2md-gas/tools/deploy.py と同じ流れ。"""
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOCAL = ROOT / ".local.json"
CLASP = str(pathlib.Path(os.environ["LOCALAPPDATA"]) / "Programs" / "node" / "clasp.cmd")


def clasp(*args):
    r = subprocess.run([CLASP, *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    out = (r.stdout or "") + (r.stderr or "")
    if r.returncode != 0:
        sys.exit("clasp " + " ".join(args) + " に失敗:\n" + out)
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    cfg = json.loads(LOCAL.read_text(encoding="utf-8")) if LOCAL.exists() else {}
    if not cfg.get("token"):
        cfg["token"] = (ROOT / ".token").read_text(encoding="utf-8").strip()
    if not (ROOT / ".clasp.json").exists():
        print(clasp("create", "--type", "standalone", "--title", "自分用ポータル窓口", "--rootDir", "src").strip())
    (ROOT / "src" / "Secret.js").write_text(
        "// ポータルの合言葉。tools/deploy.py が .local.json から書き出す\n"
        f"var WEBAPP_TOKEN = '{cfg['token']}';\n", encoding="utf-8")
    print(clasp("push", "--force").strip().splitlines()[-1])
    if cfg.get("deploymentId"):
        print(clasp("update-deployment", cfg["deploymentId"], "--description", "auto").strip())
    else:
        out = clasp("create-deployment", "--description", "auto")
        m = re.search(r"(AKfy[\w-]+)", out)
        if not m:
            sys.exit("配備IDを読み取れない:\n" + out)
        cfg["deploymentId"] = m.group(1)
        cfg["url"] = f"https://script.google.com/macros/s/{m.group(1)}/exec"
        print("配備を作成:", cfg["deploymentId"])
    LOCAL.write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    with urllib.request.urlopen(cfg["url"] + "?action=ping", timeout=60) as r:
        print("ping:", r.read().decode("utf-8")[:200])


if __name__ == "__main__":
    main()
