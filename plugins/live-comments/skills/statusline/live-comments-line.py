#!/usr/bin/env python3
"""Prints the live-comments line of the Claude Code status line.

    live-comments-line.py [--copy] < status line JSON

Reads the status line JSON input on stdin and, if the session (session_id)
has a discussion on the live-comments server, prints one line:
"[open topics] <session page link>". With --copy the line ends with a ⧉
icon that is an OSC 8 link lc-copy:<session page link>: a click on it in the
terminal hands the link to the lc-copy: handler, which copies it. Without a
discussion, or when the server does not answer within 0.3 s, prints nothing.
"""

import json
import re
import sys
import urllib.request

ORIGIN = "http://127.0.0.1:8765"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def main():
    try:
        session = json.loads(sys.stdin.buffer.read()).get("session_id")
    except (ValueError, AttributeError):
        return
    if not session or not SAFE_ID.match(session):
        return
    try:
        with urllib.request.urlopen(f"{ORIGIN}/api/{session}/state", timeout=0.3) as r:
            state = json.loads(r.read())
    except Exception:
        return
    url = f"{ORIGIN}/{session}"
    n = sum(t.get("state") == "open" for t in state.get("topics", []))
    line = f"\033[0;33m[{n}]\033[00m {url}"
    if "--copy" in sys.argv[1:]:
        line += f" \033]8;;lc-copy:{url}\a⧉\033]8;;\a"
    sys.stdout.buffer.write(line.encode("utf-8") + b"\n")


if __name__ == "__main__":
    main()
