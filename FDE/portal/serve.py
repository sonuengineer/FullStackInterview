"""FDE portal -- local mode.

Usage:  double-click FDE/start-portal.bat   (or: python portal/serve.py)

Opens http://127.0.0.1:8766/portal/ . On start it runs `git pull` so you see what you
did on the other PC, and rebuilds portal/plan.json. Ticks are saved to FDE/progress.json.
Private data (notes, reviews, applications, mocks) arrives already encrypted by the
browser and is stored as FDE/private.enc.json -- this server never sees the password.

"Save to GitHub" commits ONLY files inside FDE/ and pushes the FullStackInterview repo.
Only listens on 127.0.0.1, so nobody else on the network can reach it.
"""
import datetime as dt
import functools
import json
import re
import subprocess
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import plan as planmod

HOST, PORT = "127.0.0.1", 8766
FDE = planmod.FDE
STATE_FILE = FDE / "progress.json"
PRIVATE_FILE = FDE / "private.enc.json"
LOCK = threading.Lock()
MAX_BODY = 4 * 1024 * 1024


def blank_state():
    return {
        "settings": {"track": "slow", "start": "2026-10-12", "switches": []},
        "done": {},        # id -> {"d": date, "p": proof}
        "minutes": {},     # date -> minutes logged that day
        "rest": [],        # dates a rest token was used
        "drills": {},      # week key -> date the weekly FDE drill was done
        "reviews": {},     # week key -> date the weekly review was written (text is private)
        "quiz": [],        # {"d", "id", "pts", "max", "graded"}
        "apps": {},        # week key -> applications sent (company names are private)
        "mocks": [],       # dates of mock interviews (scores are private)
        "firstInterview": None,
    }


TYPES = {"settings": dict, "done": dict, "minutes": dict, "rest": list, "drills": dict,
         "reviews": dict, "quiz": list, "apps": dict, "mocks": list}


def load_state():
    state = blank_state()
    if STATE_FILE.exists():
        try:
            data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise SystemExit(f"progress.json is not valid JSON ({e}). If a git merge left conflict markers in it, fix them first.")
        for k in state:
            if k in data:
                state[k] = data[k]
    return state


def save_state(state):
    # sorted keys + indent -> line-based diffs, so a git conflict between the 2 PCs is easy to resolve
    STATE_FILE.write_text(json.dumps(state, indent=1, sort_keys=True, ensure_ascii=True) + "\n", encoding="utf-8")


def clean_state(data):
    state = blank_state()
    for k, typ in TYPES.items():
        if isinstance(data.get(k), typ):
            state[k] = data[k]
    fi = data.get("firstInterview")
    state["firstInterview"] = fi if isinstance(fi, str) and re.fullmatch(r"\d{4}-\d\d-\d\d", fi) else None
    s = state["settings"]
    if s.get("track") not in ("fast", "slow"):
        s["track"] = "slow"
    if not re.fullmatch(r"\d{4}-\d\d-\d\d", str(s.get("start", ""))):
        s["start"] = "2026-10-12"
    return state


def clean_private(data):
    keys = {"v", "kdf", "iterations", "salt", "iv", "ct"}
    if not isinstance(data, dict) or set(data) != keys:
        return None
    if not all(isinstance(data[k], str) and re.fullmatch(r"[A-Za-z0-9+/=]*", data[k]) for k in ("salt", "iv", "ct")):
        return None
    return data


def git(*args):
    r = subprocess.run(["git", *args], cwd=FDE, capture_output=True, text=True, timeout=120)
    return r.returncode, (r.stdout + r.stderr).strip()


def git_status():
    code, out = git("status", "--porcelain", "--", ".")
    if code != 0:
        return {"ok": False, "text": "Not a git repo or git not installed."}
    return {"ok": True, "dirty": bool(out.strip()),
            "text": "Unsaved changes in FDE/" if out.strip() else "Everything saved to GitHub"}


def do_pull():
    code, out = git("pull", "--ff-only")
    if code == 0:
        return {"ok": True, "text": "Up to date with GitHub." if "Already up to date" in out else "Pulled latest from GitHub."}
    if "local changes" in out or "overwritten" in out:
        return {"ok": False, "text": "You have unsaved changes on this PC. Click 'Save to GitHub' first, then 'Get latest'."}
    if "Not possible to fast-forward" in out or "diverg" in out:
        return {"ok": False, "text": "This PC and GitHub both have new commits. Run `git pull` in a terminal and fix the conflict (or ask Claude)."}
    return {"ok": False, "text": "git pull failed: " + out[-300:]}


def do_push():
    _, ahead = git("rev-list", "--count", "@{u}..HEAD")
    git("add", "--", ".")
    code, out = git("commit", "-m", "FDE progress " + dt.date.today().isoformat(), "--", ".")
    if code != 0 and "nothing to commit" not in out and "no changes added" not in out:
        return {"ok": False, "text": "git commit failed: " + out[-300:]}
    code, out = git("push")
    if code == 0:
        extra = f" (also pushed {ahead} other local commit(s) that were waiting)" if ahead.isdigit() and int(ahead) > 0 else ""
        return {"ok": True, "text": "Saved to GitHub." + extra}
    if "rejected" in out or "fetch first" in out:
        return {"ok": False, "text": "GitHub has newer changes from the other PC. Click 'Get latest', then save again."}
    return {"ok": False, "text": "git push failed: " + out[-300:]}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/portal/")
            self.end_headers()
            return
        if self.path == "/api/data":
            with LOCK:
                private = json.loads(PRIVATE_FILE.read_text(encoding="utf-8")) if PRIVATE_FILE.exists() else None
                return self.send_json({"local": True, "state": load_state(), "private": private, "git": git_status()})
        super().do_GET()

    def do_POST(self):
        # same-origin only: reject requests from other websites
        origin = self.headers.get("Origin", "")
        if origin and origin != f"http://{HOST}:{PORT}":
            return self.send_json({"error": "forbidden"}, 403)
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length > MAX_BODY:
            return self.send_json({"error": "too large"}, 413)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return self.send_json({"error": "bad json"}, 400)
        with LOCK:
            if self.path == "/api/state":
                save_state(clean_state(data))
                return self.send_json({"ok": True, "git": git_status()})
            if self.path == "/api/private":
                blob = clean_private(data)
                if blob is None:
                    return self.send_json({"error": "private data must be an encrypted blob"}, 400)
                PRIVATE_FILE.write_text(json.dumps(blob, indent=1) + "\n", encoding="utf-8")
                return self.send_json({"ok": True, "git": git_status()})
            if self.path == "/api/pull":
                res = do_pull()
                planmod.build()
                private = json.loads(PRIVATE_FILE.read_text(encoding="utf-8")) if PRIVATE_FILE.exists() else None
                return self.send_json({**res, "state": load_state(), "private": private, "git": git_status()})
            if self.path == "/api/push":
                return self.send_json({**do_push(), "git": git_status()})
        self.send_json({"error": "not found"}, 404)


def main():
    code, top = git("rev-parse", "--show-toplevel")
    if code != 0:
        print("warning: FDE/ is not inside a git repo -- Get latest / Save to GitHub will not work.")
    if "--no-pull" not in sys.argv:
        print("git:", do_pull()["text"])
    planmod.build()
    save_state(load_state())
    url = f"http://{HOST}:{PORT}/portal/"
    handler = functools.partial(Handler, directory=str(FDE))
    try:
        server = ThreadingHTTPServer((HOST, PORT), handler)
    except OSError:
        print(f"Port {PORT} is busy -- the portal is probably already running. Opening it.")
        webbrowser.open(url)
        return
    print(f"FDE portal running at {url}  (close this window to stop; click 'Save to GitHub' before you leave)")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
