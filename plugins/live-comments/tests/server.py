"""A live-comments server of its own for the tests: on a free port, with its
storage, settings and Claude Code directory inside a work directory, so the
user's server on port 8765 and the user's discussions are not touched.

    server.py PORT          the server in the current process; the
                            directories come from the environment
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

START = Path(__file__).resolve().parent.parent / "skills" / "start"

# The bar file of the tests: one item with the sent field "note".
STATUSBAR = """import json, sys
data = json.load(sys.stdin)
print(json.dumps({"items": [{"blocks": [{"text": "note"}, {"text": str(data.get("note", "none")), "style": "strong"}],
                             "title": "the note"}]}))
"""


class Server:
    """The server process and requests to it.

    work — the work directory, port — the port to listen on. sessions — the
    ids of Claude Code sessions that get a transcript, so their pages have
    the status bar.
    """

    def __init__(self, work, port, sessions=()):
        self.origin = f"http://127.0.0.1:{port}"
        work = Path(work)
        config = work / "config" / "live-comments"
        config.mkdir(parents=True)
        (config / "statusbar.py").write_text(STATUSBAR, encoding="utf-8")
        for sid in sessions:
            project = work / "claude" / "projects" / "tests"
            project.mkdir(parents=True, exist_ok=True)
            (project / f"{sid}.jsonl").write_text(json.dumps({"cwd": str(work)}) + "\n", encoding="utf-8")
        env = dict(os.environ, XDG_DATA_HOME=str(work / "data"), XDG_CONFIG_HOME=str(work / "config"),
                   CLAUDE_CONFIG_DIR=str(work / "claude"), LIVE_COMMENTS_LIMITS_POLL="0")
        self.proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), str(port)], env=env,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        for _ in range(100):
            try:
                self.get("/api/info")
                return
            except (urllib.error.URLError, ConnectionError):
                time.sleep(0.1)
        self.close()
        raise RuntimeError("the test server did not start")

    def request(self, method, path, data=None):
        body = json.dumps(data).encode("utf-8") if data is not None else None
        req = urllib.request.Request(self.origin + path, data=body, method=method,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())

    def get(self, path):
        return self.request("GET", path)

    def post(self, path, data=None):
        return self.request("POST", path, data or {})

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()


def serve(port):
    """Runs the server of skills/start on port; the status bars of the pages
    are updated every second instead of every minute."""
    sys.path.insert(0, str(START))
    import cm
    import statusfeed
    cm.PORT = port
    cm.ORIGIN = f"http://{cm.HOST}:{port}"
    statusfeed.TICK = 0.2
    statusfeed.UPDATE_EVERY = 1
    return cm.cmd_serve(None)


if __name__ == "__main__":
    sys.exit(serve(int(sys.argv[1])))
