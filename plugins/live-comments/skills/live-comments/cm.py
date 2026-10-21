#!/usr/bin/env python3
"""Live discussions of a Claude Code session: a server for the browser and commands for Claude.

One server serves all sessions: http://127.0.0.1:8765. Each session has its
own page /<session id> — a tree of topics. A topic is the discussion of one
question; its page is /<session id>/<topic id>. The page /<session id>/diff
reviews the changes of the session's git repository: file diffs, staging of
files, blocks and selected lines, discarding changes of files and blocks,
comments on lines. The server does not serve the HTML file: the file is
opened as file://, and the embed.js script written into it (the embed
command) creates topics from selected fragments and highlights fragments
that have topics.
The default session is CLAUDE_CODE_SESSION_ID.

    cm.py open [--label TEXT]   start the server if it is not running
                                (detached from the session), connect the
                                session, print the link
    cm.py embed PAGE            write the session's embed.js script into an
                                HTML file
    cm.py wait                  wait for the first topic of the session where
                                something awaits Claude, or for the "Apply
                                resolved" plan, and print it; after the
                                SessionEnd hook it does not end
    cm.py reply ID [-f FILE] [--title TEXT] [--followup] [--working]
                                reply in a topic (Markdown from FILE or stdin);
                                --title — the topic's question in one line;
                                --followup — an addition to the previous reply;
                                --working — Claude keeps working on the topic
                                after this reply
    cm.py branch ID -f FILE [--message MID] [--title TEXT]
                                open two or more subquestions of a topic; MID —
                                the user message they are taken from;
                                --title — the topic's question in one line
    cm.py resolve ID --decision TEXT
                                record the decision and close the topic
    cm.py ask -f FILE           top-level topics on behalf of Claude: questions
                                the user decides
    cm.py chat -f FILE          top-level topics on behalf of the user: the
                                user's questions from the chat
    cm.py thread ID             the whole topic
    cm.py show                  short tree of the session's topics
    cm.py activity [TEXT] [--topic ID]
                                what Claude is doing now, in the header of the
                                session's pages instead of "Claude is
                                listening"; --topic — also above the reply
                                field of topic ID; without TEXT — the default
                                phrases
    cm.py leave                 close the session: delete its discussion and
                                print it; the last one stops the server
    cm.py disconnect [--hook]   disconnect the session and keep its discussion;
                                the last one stops the server; --hook — the
                                SessionEnd hook: the session from the hook JSON
                                on stdin, quiet, never starts the server; the
                                session's wait does not end
    cm.py serve                 the server in the current process (open starts
                                it by itself)
    cm.py stop                  stop the server; wait commands restart it from
                                the current cm.py

FILE of branch, ask and chat is a JSON list [{"title": question in one line,
"text": question text}]. All commands except serve and stop accept
--session ID. Storage: ~/.local/share/live-comments/sessions/<session id>.json
($XDG_DATA_HOME/live-comments/sessions when XDG_DATA_HOME is set). The
fonts of the pages: ~/.config/live-comments/fonts.json ($XDG_CONFIG_HOME
when set), their files in ~/.local/share/live-comments/fonts; the colors of
the pages: ~/.config/live-comments/theme.json.
"""

import argparse
import hashlib
import html
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import statusfeed

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "live-comments/sessions"
SERVER_LOG = DATA.parent / "server.log"
# Auto-apply of each session closed by leave: the next open of the session takes it.
KEPT_AUTO_APPLY = DATA / "auto-apply"
# Auto-apply last chosen by the user in any session: new sessions start with it.
AUTO_APPLY_DEFAULT = DATA.parent / "auto-apply-default"
# The user's fonts of the pages and the copies of their font files.
FONTS_FILE = statusfeed.BAR_DIR / "fonts.json"
FONTS_DIR = DATA.parent / "fonts"
# The font roles of the pages and the CSS variable of each.
FONT_ROLES = {"text": "--lc-font", "mono": "--lc-mono"}
FONT_TYPES = {".woff2": ("font/woff2", "woff2"), ".woff": ("font/woff", "woff"),
              ".ttf": ("font/ttf", "truetype"), ".otf": ("font/otf", "opentype")}
FONT_FAMILY = re.compile(r'^[^"\\;{}<>\n\r]{1,80}$')
# The user's colors of the pages, the names of the colors of the palette and
# the CSS values of --lc-scheme for the schemes the theme may force.
THEME_FILE = statusfeed.BAR_DIR / "theme.json"
THEME_COLORS = ("bg", "card", "text", "muted", "line", "accent", "accent-soft", "bad", "good", "warn",
                "user", "on-accent", "add", "del", "hl", "hl-answered", "hl-resolved")
THEME_SCHEMES = {"light": "light", "dark": "dark"}
COLOR = re.compile(r"^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,30}|[a-z-]{3,12}\([-\w\s.,%/#+]{1,120}\))$")
HOST = "127.0.0.1"
PORT = 8765
ORIGIN = f"http://{HOST}:{PORT}"
VERSION = 21
STATIC = {"app.js": "text/javascript", "app.css": "text/css", "diff.js": "text/javascript",
          "embed.js": "text/javascript", "embed.css": "text/css"}
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
STATE_NAME = {"open": "open", "resolved": "resolved", "declined": "declined"}
EMBED_TAG = re.compile(r'\n?<script[^>]*src="http://127\.0\.0\.1:\d+/embed\.js"[^>]*></script>')


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_id(prefix):
    return prefix + format(int(time.time() * 1000), "x") + os.urandom(2).hex()


def title_of(t):
    """Returns the topic's question in one line: the topic title, and without
    it the beginning of the first message, at most 90 characters."""
    if t.get("title"):
        return t["title"]
    line = " ".join((t["messages"][0]["text"] if t["messages"] else "").split())
    return line[:89] + "…" if len(line) > 90 else line


def read_auto_apply(path):
    """Returns auto-apply recorded in file path: True — on, False — off, None
    — no file. An empty file, the mark of earlier versions, means on."""
    try:
        return path.read_text(encoding="utf-8").strip() != "off"
    except FileNotFoundError:
        return None


def write_auto_apply(path, on):
    """Records auto-apply on or off in file path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("on" if on else "off", encoding="utf-8")


def answered(t):
    """Returns the ids of user messages in topic t that Claude has answered."""
    done = set()
    for m in t["messages"]:
        if m["author"] == "claude":
            done.update(m.get("answers") or [])
    return done


def pending(t):
    """Returns what awaits Claude in the open topic t, or None.

    Unanswered user messages and a request to record the decision await
    Claude. Result: tid — the topic; since — the time of the oldest waiting
    item; questions — ids of unanswered messages; resolve — whether a
    decision is requested; auto — the request came because all subquestions
    closed. A closed topic gives None.
    """
    if t["state"] != "open":
        return None
    done = answered(t)
    waiting = [m for m in t["messages"] if m["author"] == "user" and m["id"] not in done]
    req = t.get("resolveRequested")
    if not waiting and not req:
        return None
    since = min([m["created"] for m in waiting] + ([req] if req else []))
    return {"tid": t["id"], "since": since, "questions": [m["id"] for m in waiting],
            "resolve": bool(req), "auto": bool(req and t.get("resolveAuto"))}


def open_on_desktop(path):
    """Opens path with the default application of the desktop: xdg-open, open
    on macOS, the shell on Windows. Returns the error text or None."""
    if os.name == "nt":
        try:
            os.startfile(path)
        except OSError as e:
            return str(e)
        return None
    cmd = ["open" if sys.platform == "darwin" else "xdg-open", path]
    try:
        p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                             start_new_session=True)
    except OSError as e:
        return str(e)
    try:
        code = p.wait(timeout=3)
    except subprocess.TimeoutExpired:
        # The opener keeps running together with the application it started.
        return None
    if code:
        return p.stderr.read().decode("utf-8", "replace").strip() or f"{cmd[0]} exited with code {code}"
    return None


# SVG of PlantUML diagrams by the hash of their source: messages are shown again on every update of the page.
PLANTUML_CACHE = {}
PLANTUML_LOCK = threading.Lock()


def plantuml_svg(source):
    """The SVG of PlantUML diagram source, made by the local plantuml without
    access to files and network. Source without @start… is taken as the body
    of @startuml. A syntax error gives an SVG with the error. Returns (svg,
    error): error is the text of a failure, svg is then None."""
    if not re.match(r"\s*@start", source):
        source = "@startuml\n" + source + "\n@enduml\n"
    key = hashlib.sha256(source.encode("utf-8")).hexdigest()
    with PLANTUML_LOCK:
        if key in PLANTUML_CACHE:
            return PLANTUML_CACHE[key], None
    env = dict(os.environ, PLANTUML_SECURITY_PROFILE="SANDBOX")
    try:
        p = subprocess.run(["plantuml", "-tsvg", "-charset", "UTF-8", "-pipe"], input=source.encode("utf-8"),
                           capture_output=True, timeout=60, env=env)
    except FileNotFoundError:
        return None, "plantuml is not installed"
    except subprocess.TimeoutExpired:
        return None, "plantuml did not finish in 60 s"
    svg = p.stdout.decode("utf-8", "replace")
    if "<svg" not in svg:
        return None, p.stderr.decode("utf-8", "replace").strip() or f"plantuml exited with code {p.returncode}"
    with PLANTUML_LOCK:
        if len(PLANTUML_CACHE) >= 200:
            PLANTUML_CACHE.clear()
        PLANTUML_CACHE[key] = svg
    return svg, None


# ---------------------------------------------------------------- storage

def write_session(s):
    """Increments the state number of session s and writes its file."""
    s["rev"] += 1
    path = DATA / (s["session"] + ".json")
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def read_session(sid):
    """Returns session sid from its file, or None if there is no such file."""
    try:
        return json.loads((DATA / (sid + ".json")).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


class Store:
    """Sessions and their topics in the server's memory.

    Every change of a session is saved to its file and wakes those waiting
    on cond. Access the store only under cond.
    """

    def __init__(self):
        self.cond = threading.Condition()
        self.sessions = {}
        # How many wait requests of each session are pending on the server now.
        self.listening = {}
        # What the session took from wait and has not finished yet: lives while the server lives.
        self.working = {}
        # Sessions closed by leave while the server lives.
        self.deleted = set()
        # The status bar of each session's pages from statusfeed; lives while
        # the server lives.
        self.status = {}
        DATA.mkdir(parents=True, exist_ok=True)
        for f in DATA.glob("*.json"):
            s = json.loads(f.read_text(encoding="utf-8"))
            self.sessions[s["session"]] = s

    def delete(self, sid):
        """Deletes session sid and wakes those waiting: their requests to the
        session get a 410 response. The session file moves to deleted/, from
        where wait or leave of the session returns the closed_report to
        Claude and erases the file. Auto-apply of the session, on or off, is
        kept in KEPT_AUTO_APPLY: the next open of the session takes it."""
        s = self.sessions.pop(sid, None)
        self.working.pop(sid, None)
        self.status.pop(sid, None)
        self.deleted.add(sid)
        if s:
            self.save(s)
            write_auto_apply(KEPT_AUTO_APPLY / sid, bool(s.get("autoApply")))
        path = DATA / (sid + ".json")
        if path.exists():
            (DATA / "deleted").mkdir(exist_ok=True)
            path.replace(DATA / "deleted" / path.name)
        self.cond.notify_all()

    def missing(self, sid):
        """Returns the error text and code for a session sid that does not exist."""
        if sid in self.deleted:
            return f"session {sid} deleted: the discussion is closed", 410
        return f"no session {sid}: cm.py open", 404

    def save(self, s):
        """Increments the state number of session s, writes its file and wakes those waiting."""
        write_session(s)
        self.cond.notify_all()

    @staticmethod
    def topic(s, tid):
        return next((t for t in s["topics"] if t["id"] == tid), None)

    @staticmethod
    def children(s, tid):
        return [t for t in s["topics"] if t["parent"] == tid]

    def queue(self, s):
        """Returns the tasks of session s from pending, the oldest first."""
        return sorted(filter(None, map(pending, s["topics"])), key=lambda p: p["since"])

    def public(self, s):
        sid = s["session"]
        w = self.working.get(sid)
        return {**s, "applied": len(s.get("applied") or []), "queue": [p["tid"] for p in self.queue(s)],
                "working": {"tid": w["tid"], "resolve": w["resolve"]} if w else None,
                "listening": self.listening.get(sid, 0) > 0, "status": self.status.get(sid), "now": now()}

    def request_parent_resolve(self, s, t):
        """Requests the decision of topic t's parent if all of the parent's
        subquestions are closed and at least one of them is resolved. Returns
        the parent's id if the request is made, otherwise None."""
        p = self.topic(s, t["parent"]) if t["parent"] else None
        if not p or p["state"] != "open" or p.get("resolveRequested"):
            return None
        kids = self.children(s, p["id"])
        if any(k["state"] == "open" for k in kids) or not any(k["state"] == "resolved" for k in kids):
            return None
        p.update(resolveRequested=now(), resolveAuto=True, updated=now())
        return p["id"]

    def decline(self, s, t):
        """Closes topic t and all its open subquestions as declined."""
        t.update(state="declined", closed=now(), updated=now(), resolveRequested=None, resolveAuto=False,
                 inWork=False)
        for sid, w in list(self.working.items()):
            if w["tid"] == t["id"]:
                del self.working[sid]
        for k in self.children(s, t["id"]):
            if k["state"] == "open":
                self.decline(s, k)

    def apply(self, s, auto=False):
        """"Apply resolved": removes resolved and declined topics from the
        discussion and queues them for Claude to carry out the plan; open
        topics stay. Decisions of removed subquestions in the discussion of
        an open parent are marked applied. auto — applied by auto-apply.
        Returns the number of applied decisions; without resolved topics
        changes nothing and returns 0. Does not save the session."""
        done = [t for t in s["topics"] if t["state"] != "open"]
        n = sum(t["state"] == "resolved" for t in done)
        if not n:
            return 0
        ids = {t["id"] for t in done}
        s["topics"] = [t for t in s["topics"] if t["id"] not in ids]
        for t in s["topics"]:
            for m in t["messages"]:
                if m.get("kind") == "subdecision" and m.get("topic") in ids and not m.get("revoked"):
                    m["applied"] = True
        s.setdefault("applied", []).append({"id": new_id("a"), "created": now(), "auto": auto, "topics": done})
        return n

    def auto_apply(self, s):
        """Auto-apply: if the user turned it on, no open topics are left and
        at least one is resolved, applies the resolved ones. Auto-apply stays
        on until cancelled. Returns True if the resolved ones were applied.
        Does not save the session."""
        if not s.get("autoApply") or any(t["state"] == "open" for t in s["topics"]) or not self.apply(s, auto=True):
            return False
        s["autoApplied"] = now()
        return True


def new_topic(parent, author, text, anchor=None, title="", created=None):
    created = created or now()
    return {"id": new_id("t"), "parent": parent, "title": title, "anchor": anchor,
            "created": created, "updated": created, "state": "open", "closed": None,
            "resolveRequested": None, "resolveAuto": False, "decision": None,
            "messages": [{"id": new_id("m"), "author": author, "text": text, "created": created}]}


def questions_of(data):
    """Checks the list of questions for branch, ask and chat; returns it or None."""
    qs = data.get("questions")
    if not isinstance(qs, list) or not all(isinstance(q, dict) and q.get("title") and q.get("text") for q in qs):
        return None
    return qs


# -------------------------------------------------------------------- git

# Index changes must not run at the same time: git keeps the index locked.
GIT_LOCK = threading.Lock()
HUNK = re.compile(rb"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


class GitError(Exception):
    """An error of git or of a line operation; the text is a message for the user."""


def git(repo, *args, data=b"", ok=(0,)):
    """Runs git in repository repo with data on stdin and returns the output
    as bytes; an exit code not in ok raises GitError with git's error text."""
    r = subprocess.run(["git", "-C", repo, "-c", "core.quotepath=off", *args], input=data,
                       capture_output=True, timeout=60)
    if r.returncode not in ok:
        raise GitError(r.stderr.decode("utf-8", "replace").strip() or f"git {args[0]}: exit code {r.returncode}")
    return r.stdout


def git_status(repo):
    """Returns the changes of repository repo: the branch and the files; a
    file has its path from the repository root and the status letters in the
    index (index) and in the working tree (work), as in git status --porcelain."""
    out = git(repo, "status", "--porcelain=v1", "-z", "-uall", "--no-renames").decode("utf-8", "replace")
    files = [{"path": e[3:], "index": e[0], "work": e[1]} for e in out.split("\0") if len(e) > 3]
    branch = git(repo, "symbolic-ref", "--short", "-q", "HEAD", ok=(0, 1)).decode().strip()
    return {"repo": repo, "branch": branch or "detached HEAD", "files": files}


def git_path(path):
    """Checks a file path from a request: relative, inside the repository."""
    if not isinstance(path, str) or not path or path.startswith("/") or ".." in Path(path).parts:
        raise GitError(f"invalid file path: {path!r}")
    return path


def file_diff(repo, path, staged):
    """Returns the diff of file path: the index against HEAD (staged) or the
    working tree against the index; a file missing from the index is
    compared with an empty one.

    rows — diff lines {"t": " ", "+" or "-", "o", "n", "s": text}: o and n
    are the line numbers in the old and new version, and a line missing from
    a version gets the number of the next line of that version; noeol — no
    newline at the end of the line. A hunk header is {"t": "@", "s"}. info —
    diff header lines (new or deleted file, mode), binary — the file is
    binary. hash — the diff fingerprint: line operations check by it that
    the diff is the one the user saw."""
    opts = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U3"]
    if staged:
        raw = git(repo, *opts, "--cached", "--", path)
    elif git(repo, "ls-files", "--", path).strip():
        raw = git(repo, *opts, "--", path)
    else:
        raw = git(repo, *opts, "--no-index", "--", "/dev/null", path, ok=(0, 1))
    rows, info, binary, o, n = [], [], False, 0, 0
    for line in raw.split(b"\n"):
        m = HUNK.match(line)
        if m:
            # The empty side of a hunk ("-5,0") points at the line before the hunk.
            o, n = int(m[1]) + (m[2] == b"0"), int(m[3]) + (m[4] == b"0")
            rows.append({"t": "@", "s": line.decode("utf-8", "replace")})
        elif not rows:
            text = line.decode("utf-8", "replace")
            binary = binary or text.startswith("Binary files ")
            if text and not text.startswith(("diff --git", "index ", "--- ", "+++ ")):
                info.append(text)
        elif line[:1] in (b" ", b"+", b"-"):
            t = line[:1].decode()
            rows.append({"t": t, "o": o, "n": n, "s": line[1:].decode("utf-8", "replace")})
            o += t != "+"
            n += t != "-"
        elif line[:1] == b"\\":
            rows[-1]["noeol"] = True
    return {"path": path, "staged": staged, "rows": rows, "info": info, "binary": binary,
            "hash": hashlib.sha1(raw).hexdigest()}


# File diffs: (repository, path, staged) → (state fingerprint, diff).
DIFF_CACHE = {}


def stat_of(path):
    """Returns the modification time and size of file path, or None if it does not exist."""
    try:
        st = os.stat(path)
        return st.st_mtime_ns, st.st_size
    except OSError:
        return None


def group_diffs(repo, staged):
    """Returns the diffs (see file_diff) of all files of a group: staged
    changes (staged) or working tree changes, in git status order. A file's
    diff is recomputed only if HEAD, the index or (for the working tree) the
    file itself changed since the last time."""
    files = [f["path"] for f in git_status(repo)["files"]
             if (f["index"] not in " ?" if staged else f["work"] != " ")]
    head = git(repo, "rev-parse", "-q", "--verify", "HEAD", ok=(0, 1)).strip()
    index = stat_of(Path(repo) / git(repo, "rev-parse", "--git-path", "index").decode().strip())
    out = []
    for path in files:
        key = (head, index, None if staged else stat_of(Path(repo) / path))
        hit = DIFF_CACHE.get((repo, path, staged))
        if not hit or hit[0] != key:
            hit = DIFF_CACHE[(repo, path, staged)] = (key, file_diff(repo, path, staged))
        out.append(hit[1])
    return out


def split_lines(data):
    """Splits file contents into lines the same way git does: by \\n, with line ends."""
    return re.findall(rb"[^\n]*\n|[^\n]+\Z", data)


def pick_rows(old, new, rows, chosen, reverse):
    """Returns version old with only the diff lines rows whose indexes are in
    chosen carried over: "+" added, "-" removed. With reverse — version new
    with only the chosen changes undone. old and new are the contents of the
    versions as bytes."""
    old, new = split_lines(old), split_lines(new)
    base, other, bk, ok_ = (new, old, "n", "o") if reverse else (old, new, "o", "n")
    out, i = [], 0

    def add(line):
        if out and not out[-1].endswith(b"\n"):
            out[-1] += b"\n"
        out.append(line)

    for k, r in enumerate(rows):
        if r["t"] == "@":
            continue
        b = r[bk]
        for line in base[i:b - 1]:
            add(line)
        i = max(i, b - 1)
        if r["t"] == " ":
            add(base[b - 1])
            i = b
        elif (r["t"] == "-") != reverse:
            # The line of version base stays if its change is not chosen.
            if k not in chosen:
                add(base[b - 1])
            i = b
        elif k in chosen:
            add(other[r[ok_] - 1])
    for line in base[i:]:
        add(line)
    return b"".join(out)


def file_mode(repo, path):
    """Returns the mode of file path in the index, without it in HEAD, and
    without that by the working tree."""
    for args in (("ls-files", "-s", "--", path), ("ls-tree", "HEAD", "--", path)):
        out = git(repo, *args, ok=(0, 128)).split()
        if out:
            return out[0].decode()
    return "100755" if os.access(Path(repo) / path, os.X_OK) else "100644"


def chosen_rows(repo, path, staged, chosen, digest):
    """Returns the diff of file path (see file_diff), the chosen change lines
    in it and the file mode. chosen — indexes of lines in the diff's rows,
    digest — its hash that the user saw: if the diff has changed since then
    or the chosen lines contain no changes — GitError."""
    d = file_diff(repo, path, staged)
    if d["hash"] != digest:
        raise GitError("the file's diff has changed — select the lines again")
    rows = d["rows"]
    chosen = {k for k in chosen if isinstance(k, int) and 0 <= k < len(rows) and rows[k]["t"] in "+-"}
    if not chosen:
        raise GitError("the selected lines contain no changes")
    mode = file_mode(repo, path)
    if d["binary"] or mode in ("120000", "160000"):
        raise GitError("lines can be selected only in a text file")
    return d, chosen, mode


def stage_rows(repo, path, chosen, digest, staged):
    """Stages the chosen lines of the working tree diff of file path, and
    with staged unstages the chosen lines of the index diff against HEAD.
    chosen and digest — as in chosen_rows."""
    d, chosen, mode = chosen_rows(repo, path, staged, chosen, digest)
    rows = d["rows"]
    if staged:
        old, new = git(repo, "cat-file", "blob", "HEAD:" + path, ok=(0, 128)), git(repo, "cat-file", "blob", ":" + path, ok=(0, 128))
    else:
        f = Path(repo) / path
        old, new = git(repo, "cat-file", "blob", ":" + path, ok=(0, 128)), f.read_bytes() if f.is_file() else b""
    data = pick_rows(old, new, rows, chosen, staged)
    # Working tree lines pass through git filters (line endings and others), as with git add.
    sha = git(repo, "hash-object", "-w", "--stdin", *(["--no-filters"] if staged else ["--path", path]),
              data=data).decode().strip()
    git(repo, "update-index", "--add", "--cacheinfo", f"{mode},{sha},{path}")


def revert_rows(repo, path, chosen, digest):
    """Undoes in the working tree of file path the chosen lines of its diff
    against the index: removed lines come back, added ones go away. chosen
    and digest — as in chosen_rows."""
    d, chosen, _ = chosen_rows(repo, path, False, chosen, digest)
    f = Path(repo) / path
    data = pick_rows(git(repo, "cat-file", "blob", ":" + path, ok=(0, 128)),
                     f.read_bytes() if f.is_file() else b"", d["rows"], chosen, True)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(data)


def discard_file(repo, path):
    """Discards the working tree changes of file path: a file from the index
    returns to the working tree, and a file missing from the index is deleted."""
    if git(repo, "ls-files", "--", path).strip():
        git(repo, "checkout", "-q", "--", path)
    else:
        (Path(repo) / path).unlink()


def stage_all(repo, path, staged):
    """Stages all changes of file path, and without path of all files; with
    staged unstages them."""
    spec = ["--", path] if path else []
    if not staged:
        git(repo, "add", "-A", *spec)
    elif git(repo, "rev-parse", "-q", "--verify", "HEAD", ok=(0, 1)).strip():
        git(repo, "reset", "-q", "HEAD", *spec, ok=(0, 1))
    else:
        git(repo, "rm", "-r", "-q", "--cached", "--ignore-unmatch", *(spec or ["--", "."]))


# ------------------------------------------------------------------ fonts

def user_fonts():
    """Returns the fonts of the pages from the user's file FONTS_FILE: a
    dictionary role → {"family": name, "file": path or None}. Roles with an
    unsafe name and the whole unreadable file are skipped."""
    try:
        cfg = json.loads(FONTS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    fonts = {}
    for role in FONT_ROLES:
        f = cfg.get(role) if isinstance(cfg, dict) else None
        family = f.get("family") if isinstance(f, dict) else None
        if not isinstance(family, str) or not FONT_FAMILY.match(family):
            continue
        path = f.get("file")
        if isinstance(path, str) and path:
            path = FONTS_DIR / Path(path).expanduser()
            path = path if path.suffix.lower() in FONT_TYPES and path.is_file() else None
        else:
            path = None
        fonts[role] = {"family": family, "file": path}
    return fonts


def fonts_css():
    """Returns /fonts.css: the user's fonts before the default ones in the CSS
    variables of the roles, and a font file of a role is loaded from
    /fonts/<role>."""
    rules, names = [], []
    for role, f in user_fonts().items():
        name = f["family"]
        if f["file"]:
            fmt = FONT_TYPES[f["file"].suffix.lower()][1]
            rules.append(f'@font-face{{font-family:"{name}";src:url(/fonts/{role}) format("{fmt}");font-display:swap}}')
        names.append(f'{FONT_ROLES[role]}:"{name}",var({FONT_ROLES[role]}-default)')
    if names:
        rules.append(":root{" + ";".join(names) + "}")
    return "\n".join(rules) + "\n"


def font_file(role):
    """Returns the font file of role and its MIME type, or None."""
    f = user_fonts().get(role)
    if not f or not f["file"]:
        return None
    return f["file"], FONT_TYPES[f["file"].suffix.lower()][0]


# ------------------------------------------------------------------ theme

def theme_css():
    """Returns /theme.css: the user's colors of THEME_FILE in the variables
    --lc-NAME-light and --lc-NAME-dark of the palette, and the scheme the theme
    forces in --lc-scheme. Unknown names, unsafe values and the whole
    unreadable file are skipped."""
    try:
        cfg = json.loads(THEME_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    if not isinstance(cfg, dict):
        return ""
    decls = []
    if cfg.get("scheme") in THEME_SCHEMES:
        decls.append(f"--lc-scheme:{THEME_SCHEMES[cfg['scheme']]}")
    for scheme in ("light", "dark"):
        colors = cfg.get(scheme)
        if not isinstance(colors, dict):
            continue
        for name, value in colors.items():
            if name in THEME_COLORS and isinstance(value, str) and COLOR.match(value):
                decls.append(f"--lc-{name}-{scheme}:{value}")
    return ":root{" + ";".join(decls) + "}\n" if decls else ""


# ----------------------------------------------------------------- server

APP_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Discussion</title><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/theme.css"></head>
<body><main id="lc-app"></main>
<script>window.LIVE_COMMENTS = %s;</script>
<script src="/diff.js"></script>
<script src="/app.js"></script></body></html>
"""


def index_page(store):
    rows = []
    for sid, s in sorted(store.sessions.items(), key=lambda kv: kv[1].get("lastSeen") or "", reverse=True):
        rows.append(f'<li><a href="/{sid}">{html.escape(s.get("label") or sid)}</a> · '
                    f'{"connected" if s.get("connected") else "not connected"} · {sid}</li>')
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Discussions</title>'
            '<link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/fonts.css">'
            '<link rel="stylesheet" href="/theme.css"></head><body><main id="lc-app"><h1>Session discussions</h1>'
            f'<ul class="lc-sessions">{"".join(rows) or "<li>No sessions.</li>"}</ul></main></body></html>')


def make_handler(store, feed):
    hosts = {f"{HOST}:{PORT}", f"localhost:{PORT}"}

    class Handler(BaseHTTPRequestHandler):
        server_version = f"live-comments/{VERSION}"

        def log_message(self, fmt, *args):
            pass

        def send_bytes(self, data, ctype, code=200, cors=False):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            # The embed.js script runs in a file opened as file://: such a
            # document sends the header Origin: null.
            if cors and self.headers.get("Origin") == "null":
                self.send_header("Access-Control-Allow-Origin", "null")
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                # The tab was closed in the middle of a long poll.
                pass

        def send_json(self, obj, code=200, cors=True):
            self.send_bytes(json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                            "application/json; charset=utf-8", code, cors)

        def fail(self, msg, code):
            self.send_json({"error": msg}, code)

        def allowed(self):
            """Lets through only requests to 127.0.0.1 (protection against DNS
            rebinding) and changes only from its own pages, from file:// and
            from cm.py: a foreign site in the browser must not write into a
            Claude session."""
            if self.headers.get("Host") not in hosts:
                return False
            origin = self.headers.get("Origin")
            return self.command in ("GET", "OPTIONS") or origin in (None, "null") or origin[7:] in hosts

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")

        def do_OPTIONS(self):
            if not self.allowed():
                self.send_response(403)
                self.end_headers()
                return
            self.send_response(204)
            if self.headers.get("Origin") == "null":
                self.send_header("Access-Control-Allow-Origin", "null")
                self.send_header("Access-Control-Allow-Methods", "GET, POST")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                if self.headers.get("Access-Control-Request-Private-Network"):
                    self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if not self.allowed():
                self.fail("forbidden", 403)
                return
            url = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(url.query)
            parts = [urllib.parse.unquote(p) for p in url.path.strip("/").split("/") if p]
            if not parts:
                with store.cond:
                    self.send_bytes(index_page(store).encode("utf-8"), "text/html; charset=utf-8")
            elif len(parts) == 1 and parts[0] in STATIC:
                self.send_bytes((HERE / parts[0]).read_bytes(), STATIC[parts[0]] + "; charset=utf-8", cors=True)
            elif parts == ["fonts.css"]:
                self.send_bytes(fonts_css().encode("utf-8"), "text/css; charset=utf-8", cors=True)
            elif parts == ["theme.css"]:
                self.send_bytes(theme_css().encode("utf-8"), "text/css; charset=utf-8", cors=True)
            elif len(parts) == 2 and parts[0] == "fonts":
                found = font_file(parts[1])
                if found:
                    self.send_bytes(found[0].read_bytes(), found[1], cors=True)
                else:
                    self.send_bytes("No such font".encode("utf-8"), "text/plain; charset=utf-8", 404)
            elif parts[0] == "api":
                self.api_get(parts[1:], q)
            else:
                with store.cond:
                    s = store.sessions.get(parts[0])
                    diff = len(parts) == 2 and parts[1] == "diff"
                    ok = s and len(parts) <= 2 and (len(parts) == 1 or diff or store.topic(s, parts[1]))
                if not ok:
                    self.send_bytes("No such page".encode("utf-8"), "text/plain; charset=utf-8", 404)
                    return
                cfg = {"session": parts[0], "topic": None if diff else parts[1] if len(parts) == 2 else None,
                       "view": "diff" if diff else None}
                self.send_bytes((APP_PAGE % json.dumps(cfg)).encode("utf-8"), "text/html; charset=utf-8")

        def api_get(self, parts, q):
            if parts == ["info"]:
                with store.cond:
                    self.send_json({"server": "live-comments", "version": VERSION, "sessions": {
                        sid: {"label": s.get("label"), "connected": s.get("connected"),
                              "listening": store.listening.get(sid, 0) > 0}
                        for sid, s in store.sessions.items()}}, cors=False)
                return
            if len(parts) >= 2 and parts[1] == "git":
                self.git_get(parts[0], parts[2:], q)
                return
            if len(parts) != 2:
                self.fail("no such request", 404)
                return
            sid, what = parts
            with store.cond:
                s = store.sessions.get(sid)
                if not s:
                    self.fail(*store.missing(sid))
                elif what == "state":
                    self.send_json(store.public(s))
                elif what == "wait":
                    rev = int(q.get("rev", ["-1"])[0])
                    # A discussion page with the status bar: its bar is kept current while it polls.
                    bar = "bar" in q
                    if bar:
                        feed.page_seen(sid)
                    store.cond.wait_for(lambda: s["rev"] != rev or sid not in store.sessions, timeout=25)
                    if bar:
                        feed.page_seen(sid)
                    if sid in store.sessions:
                        self.send_json(store.public(s))
                    else:
                        self.fail(*store.missing(sid))
                elif what == "next":
                    self.next_task(s, float(q.get("timeout", ["50"])[0]))
                else:
                    self.fail("no such request", 404)

        def next_task(self, s, timeout):
            """Gives Claude the "Apply resolved" plan first, and without it the
            session's oldest task, and remembers it as the current work. The
            plan is given once. While the request is pending, the session is
            "listening"; disconnect of the session ends it."""
            sid = s["session"]
            if not s.get("connected"):
                self.fail(f"session {sid} is not connected: cm.py open", 404)
                return
            # A new wait means the session's previous task is finished.
            store.working.pop(sid, None)
            store.listening[sid] = store.listening.get(sid, 0) + 1
            s["lastSeen"] = now()
            store.save(s)
            try:
                store.cond.wait_for(lambda: sid not in store.sessions or not s.get("connected")
                                    or bool(s.get("applied")) or bool(store.queue(s)), timeout=timeout)
                gone = sid not in store.sessions
                off = not gone and not s.get("connected")
                batch = s["applied"].pop(0) if not gone and not off and s.get("applied") else None
                tasks = [] if gone or off or batch else store.queue(s)
                task = tasks[0] if tasks else None
                if task:
                    store.working[sid] = task
            finally:
                store.listening[sid] -= 1
                s["lastSeen"] = now()
            if gone:
                self.fail(*store.missing(sid))
                return
            store.save(s)
            if off:
                self.fail(f"session {sid} is not connected: cm.py open", 404)
            elif batch:
                self.send_json({"apply": batch, "label": s.get("label"), "topics": s["topics"]})
            elif task:
                self.send_json({"task": task, "queue": len(tasks), "topics": s["topics"]})
            else:
                self.send_json({"task": None})

        def repo_of(self, sid):
            """Returns the git repository of session sid; if there is none,
            responds with an error and returns None."""
            with store.cond:
                s = store.sessions.get(sid)
                if not s:
                    self.fail(*store.missing(sid))
                    return None
                repo = s.get("repo")
            if not repo:
                self.fail("the session has no git repository recorded: it is recorded by cm.py open "
                          "run inside a repository", 404)
            return repo

        def git_get(self, sid, rest, q):
            """Changes of the session's repository (/git) and diffs of all
            files of a group (/git/diffs?staged=0|1). Served only to its own
            pages."""
            repo = self.repo_of(sid)
            if not repo:
                return
            try:
                with GIT_LOCK:
                    if not rest:
                        res = git_status(repo)
                    elif rest == ["diffs"]:
                        res = {"files": group_diffs(repo, q.get("staged", ["0"])[0] == "1")}
                    else:
                        self.fail("no such request", 404)
                        return
            except (GitError, subprocess.TimeoutExpired) as e:
                self.send_json({"error": str(e)}, 409, cors=False)
                return
            self.send_json(res, cors=False)

        def git_post(self, sid, op, data):
            """Staging (op "stage") or unstaging ("unstage"): {path, rows,
            hash} — the chosen diff lines of a file, {path} — the whole file,
            {} — all files. Undo in the working tree: "revert" — the chosen
            lines of a file, "discard" — all changes of file {path}. Only from
            its own pages. Responds with the new changes of the repository."""
            if (self.headers.get("Origin") or "")[7:] not in hosts:
                self.fail("forbidden", 403)
                return
            repo = self.repo_of(sid)
            if not repo:
                return
            try:
                path = git_path(data["path"]) if data.get("path") else None
                rows = data.get("rows")
                if op == "revert" and (rows is None or not path) or op == "discard" and not path:
                    raise GitError("nothing to undo was given")
                with GIT_LOCK:
                    if op == "discard":
                        discard_file(repo, path)
                    elif op == "revert":
                        revert_rows(repo, path, rows, data.get("hash"))
                    elif rows is not None and path:
                        stage_rows(repo, path, rows, data.get("hash"), op == "unstage")
                    else:
                        stage_all(repo, path, op == "unstage")
                    res = git_status(repo)
            except (GitError, subprocess.TimeoutExpired, OSError) as e:
                self.send_json({"error": str(e)}, 409, cors=False)
                return
            self.send_json(res, cors=False)

        def do_POST(self):
            if not self.allowed():
                self.fail("forbidden", 403)
                return
            parts = [p for p in urllib.parse.urlparse(self.path).path.strip("/").split("/") if p]
            data = self.body()
            if parts == ["api", "shutdown"]:
                self.send_json({"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if len(parts) == 4 and parts[0] == "api" and parts[2] == "git" and parts[3] in ("stage", "unstage", "revert", "discard"):
                self.git_post(parts[1], parts[3], data)
                return
            if len(parts) == 3 and parts[0] == "api" and parts[2] == "open":
                self.open_file(parts[1], data)
                return
            if parts == ["api", "plantuml"]:
                self.plantuml(data)
                return
            with store.cond:
                if parts == ["api", "sessions"]:
                    self.open_session(data)
                elif len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "delete":
                    self.delete_session(parts[2])
                elif len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "disconnect":
                    self.disconnect_session(parts[2], data)
                elif len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "apply":
                    self.apply_session(parts[2])
                elif len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "auto-apply":
                    self.auto_apply_session(parts[2], data)
                elif len(parts) == 3 and parts[0] == "api" and parts[2] == "statusline":
                    self.set_statusline(parts[1], data)
                elif len(parts) == 3 and parts[0] == "api" and parts[2] == "activity":
                    self.set_activity(parts[1], data)
                elif len(parts) >= 3 and parts[0] == "api" and parts[2] == "topics":
                    s = store.sessions.get(parts[1])
                    if not s:
                        self.fail(*store.missing(parts[1]))
                    elif len(parts) == 3:
                        self.add_topic(s, data)
                    elif len(parts) == 5:
                        t = store.topic(s, parts[3])
                        action = getattr(self, "act_" + parts[4], None)
                        if not t or not action:
                            self.fail("no such topic or action", 404)
                        else:
                            action(s, t, data)
                    else:
                        self.fail("no such request", 404)
                else:
                    self.fail("no such request", 404)

        def open_file(self, sid, data):
            """A file:// link on a discussion page, {path}: the browser does not
            open local files from the server's pages, so the server opens the
            file with the default application of the desktop — an HTML page in
            the browser, as file://. Only the server's own pages may ask: not
            file:// pages and not sandboxed frames, whose Origin is null."""
            if (self.headers.get("Origin") or "")[7:] not in hosts:
                self.fail("files are opened only from the discussion pages", 403)
                return
            with store.cond:
                missing = None if sid in store.sessions else store.missing(sid)
            if missing:
                self.fail(*missing)
                return
            path = str(data.get("path") or "")
            if not os.path.isabs(path) or not os.path.exists(path):
                self.fail(f"no file {path}", 404)
                return
            err = open_on_desktop(path)
            if err:
                self.fail(f"could not open {path}: {err}", 500)
                return
            self.send_json({"ok": True})

        def plantuml(self, data):
            """A PlantUML diagram of a message, {source} → {svg}. Only the
            server's own pages may ask: the diagram runs a local program."""
            if (self.headers.get("Origin") or "")[7:] not in hosts:
                self.fail("diagrams are made only for the discussion pages", 403)
                return
            svg, err = plantuml_svg(str(data.get("source") or ""))
            if err:
                self.fail(err, 500)
            else:
                self.send_json({"svg": svg})

        def open_session(self, data):
            sid = data.get("session") or ""
            if not SAFE_ID.match(sid):
                self.fail("invalid session id", 400)
                return
            store.deleted.discard(sid)
            (DATA / "deleted" / (sid + ".json")).unlink(missing_ok=True)
            s = store.sessions.get(sid)
            if not s:
                # A new discussion of the session inherits auto-apply from the
                # previous one, and a new session takes the last one the user chose.
                kept = KEPT_AUTO_APPLY / sid
                on = read_auto_apply(kept)
                if on is None:
                    on = bool(read_auto_apply(AUTO_APPLY_DEFAULT))
                s = store.sessions[sid] = {"session": sid, "created": now(), "rev": 0, "topics": [],
                                           "autoApply": now() if on else None}
                kept.unlink(missing_ok=True)
            s.update(label=data.get("label") or s.get("label") or sid[:8], connected=True, ended=False,
                     lastSeen=now())
            # Only cm.py open sets the repository: pages in the browser send Origin.
            if self.headers.get("Origin") is None:
                s["repo"] = data.get("repo")
            store.save(s)
            self.send_json({"session": sid, "label": s["label"]})

        def delete_session(self, sid):
            """The leave command: disconnects the session and deletes its
            topics. If no connected sessions are left, stops the server."""
            if not store.sessions.get(sid):
                self.fail(*store.missing(sid))
                return
            store.delete(sid)
            self.send_connected()

        def disconnect_session(self, sid, data):
            """The disconnect command, which the SessionEnd hook runs when the
            Claude Code session ends: the session is no longer connected, and
            its discussion stays on the server; open connects it again. From
            the hook ({ended: true}) the session is marked ended: its wait
            does not end (see sleep_till_killed). If no connected sessions are
            left, stops the server."""
            s = store.sessions.get(sid)
            if not s:
                self.fail(*store.missing(sid))
                return
            s["connected"] = False
            s["ended"] = bool(data.get("ended"))
            store.working.pop(sid, None)
            store.save(s)
            self.send_connected()

        def send_connected(self):
            """Answers with the number of connected sessions; if none are left, stops the server."""
            connected = sum(1 for x in store.sessions.values() if x.get("connected"))
            self.send_json({"connected": connected})
            if not connected:
                threading.Thread(target=self.server.shutdown, daemon=True).start()

        def apply_session(self, sid):
            """The "Apply resolved" button: Store.apply; at least one resolved
            topic is needed."""
            s = store.sessions.get(sid)
            if not s:
                self.fail(*store.missing(sid))
                return
            n = store.apply(s)
            if not n:
                self.fail("no resolved questions — nothing to apply", 409)
                return
            store.save(s)
            self.send_json({"applied": n, "left": len(s["topics"]), "listening": store.listening.get(sid, 0) > 0})

        def auto_apply_session(self, sid, data):
            """The menu of the "Apply resolved" button: {on: true} turns on
            auto-apply — the resolved ones are applied by themselves every time
            no open topics are left; {on: false} turns it off. If no open
            topics are left when it is turned on, the resolved ones are applied
            at once. The choice becomes the auto-apply of new sessions; other
            existing sessions keep theirs."""
            s = store.sessions.get(sid)
            if not s:
                self.fail(*store.missing(sid))
                return
            s["autoApply"] = now() if data.get("on") else None
            write_auto_apply(AUTO_APPLY_DEFAULT, bool(data.get("on")))
            applied = store.auto_apply(s)
            store.save(s)
            self.send_json({"autoApply": s["autoApply"], "applied": applied,
                            "listening": store.listening.get(sid, 0) > 0})

        def set_statusline(self, sid, data):
            """Custom data of the session's status bar: a JSON object of at most
            64 KB — for example the Claude Code status line JSON, or fields of
            one's own. statusfeed adds its fields to the input of the bar file
            where the server computes no such field."""
            if not store.sessions.get(sid):
                self.fail(*store.missing(sid))
                return
            if not isinstance(data, dict) or len(json.dumps(data, ensure_ascii=False).encode("utf-8")) > 65536:
                self.fail("the status line JSON is an object of at most 64 KB", 400)
                return
            feed.statusline(sid, data)
            self.send_json({"ok": True})

        def set_activity(self, sid, data):
            """The activity command: {text, topic} — what Claude is doing now,
            one line of at most 200 characters, shown in the header of the
            session's pages instead of "Claude is listening"; with topic — also
            above the reply field of that topic. An empty text returns the
            default phrases. Lives in the session until changed or leave."""
            s = store.sessions.get(sid)
            if not s:
                self.fail(*store.missing(sid))
                return
            text = " ".join(str(data.get("text") or "").split())[:200]
            tid = data.get("topic") or None
            if text and tid and not store.topic(s, tid):
                self.fail(f"no topic {tid}", 404)
                return
            s["activity"] = {"text": text, "since": now(), "topic": tid} if text else None
            store.save(s)
            self.send_json({"activity": s["activity"]})

        def add_topic(self, s, data):
            """A new top-level topic from the user ({text, anchor}) or topics
            from a list of questions ({questions, author}): from Claude, and
            with author "user" on behalf of the user."""
            if "questions" in data:
                qs = questions_of(data)
                if not qs:
                    self.fail("a list of questions with title and text is required", 400)
                    return
                author = "user" if data.get("author") == "user" else "claude"
                made = [new_topic(None, author, q["text"], None, q["title"]) for q in qs]
                s["topics"] += made
                store.save(s)
                self.send_json({"topics": [{"id": x["id"], "title": x["title"]} for x in made]})
                return
            text = (data.get("text") or "").strip()
            if not text:
                self.fail("empty question", 400)
                return
            a = data.get("anchor")
            keys = ("kind", "file", "staged", "side", "start", "end", "rows", "quote") if isinstance(a, dict) and \
                a.get("kind") == "diff" else ("page", "pageTitle", "quote", "prefix", "suffix", "pos", "path", "anchor", "fig")
            anchor = {k: a.get(k) for k in keys} if isinstance(a, dict) else None
            t = new_topic(None, "user", text, anchor)
            s["topics"].append(t)
            store.save(s)
            self.send_json(t)

        def done(self, s, t, extra=None):
            t["updated"] = now()
            store.save(s)
            self.send_json({**t, **(extra or {})})

        def need_open(self, t):
            if t["state"] == "open":
                return True
            self.fail(f"topic closed ({STATE_NAME[t['state']]}) — nothing changed", 409)
            return False

        # ---- user actions

        def act_messages(self, s, t, data):
            text = (data.get("text") or "").strip()
            if not self.need_open(t):
                return
            if not text:
                self.fail("empty message", 400)
                return
            t["messages"].append({"id": new_id("m"), "author": "user", "text": text, "created": now()})
            self.done(s, t)

        def act_resolve(self, s, t, data):
            if not self.need_open(t):
                return
            if any(k["state"] == "open" for k in store.children(s, t["id"])):
                self.fail("the topic has open subquestions", 409)
                return
            t.update(resolveRequested=now(), resolveAuto=False)
            self.done(s, t)

        def act_decline(self, s, t, data):
            if not self.need_open(t):
                return
            store.decline(s, t)
            store.request_parent_resolve(s, t)
            self.done(s, t, {"autoApplied": store.auto_apply(s)})

        def act_reopen(self, s, t, data):
            """Revokes the decision of a resolved topic that has no parent or
            whose parent is open. The topic is open again; the previous
            decision in its discussion and in the parent's discussion is
            marked revoked; a user message about the revocation comes into
            the topic and awaits Claude's reply. The request to record the
            parent's decision is withdrawn: it has an open subquestion again."""
            if t["state"] != "resolved":
                self.fail(f"only a resolved topic can be reopened, this one is {STATE_NAME[t['state']]}", 409)
                return
            p = store.topic(s, t["parent"]) if t["parent"] else None
            if p and p["state"] != "open":
                why = "is resolved: reopen it first" if p["state"] == "resolved" else "is declined"
                self.fail(f"the question one level up “{title_of(p)}” {why}", 409)
                return
            for m in t["messages"]:
                if m.get("kind") == "decision":
                    m["revoked"] = True
            if p:
                for m in p["messages"]:
                    if m.get("kind") == "subdecision" and m.get("topic") == t["id"] and not m.get("revoked"):
                        m.update(revoked=True, decision=t["decision"])
                p.update(resolveRequested=None, resolveAuto=False, updated=now())
                for sid, w in list(store.working.items()):
                    if w["tid"] == p["id"] and w["resolve"]:
                        del store.working[sid]
            t["messages"].append({"id": new_id("m"), "author": "user", "kind": "reopen", "created": now(),
                                  "text": f"Decision revoked: {t['decision']}"})
            t.update(state="open", decision=None, closed=None)
            self.done(s, t)

        # ---- Claude actions

        def act_claude(self, s, t, data):
            """Claude's reply. Answers the messages of the session's current
            work, and if the topic is a different one, all unanswered ones; a
            followup answers nothing. With working the topic stays in Claude's
            work until its next reply without working, a decision or a
            decline."""
            if not self.need_open(t):
                return
            sid = s["session"]
            work = store.working.get(sid)
            if data.get("followup"):
                answers = []
            elif work and work["tid"] == t["id"] and work["questions"]:
                answers = work["questions"]
            else:
                answers = (pending(t) or {}).get("questions", [])
                if not answers:
                    self.fail("the topic has no unanswered messages — reply not sent; "
                              "an addition to a reply goes with --followup", 409)
                    return
            t["messages"].append({"id": new_id("m"), "author": "claude", "text": data.get("text", ""),
                                  "created": now(), "answers": answers})
            if data.get("title"):
                t["title"] = data["title"]
            t["inWork"] = bool(data.get("working"))
            if work and work["tid"] == t["id"]:
                del store.working[sid]
            self.done(s, t)

        def act_decision(self, s, t, data):
            decision = (data.get("decision") or "").strip()
            if not decision:
                self.fail("empty decision", 400)
                return
            if not self.need_open(t):
                return
            if any(k["state"] == "open" for k in store.children(s, t["id"])):
                self.fail("the topic has open subquestions", 409)
                return
            t["messages"].append({"id": new_id("m"), "author": "claude", "kind": "decision", "text": decision,
                                  "created": now(), "answers": (pending(t) or {}).get("questions", [])})
            t.update(state="resolved", decision=decision, closed=now(), resolveRequested=None, resolveAuto=False,
                     inWork=False)
            for sid, w in list(store.working.items()):
                if w["tid"] == t["id"]:
                    del store.working[sid]
            parent = store.topic(s, t["parent"]) if t["parent"] else None
            if parent:
                parent["messages"].append({"id": new_id("m"), "author": "claude", "kind": "subdecision",
                                           "topic": t["id"], "created": now(), "answers": [],
                                           "text": f"Subquestion “{title_of(t)}” resolved: {decision}"})
                parent["updated"] = now()
            parent_resolve = store.request_parent_resolve(s, t)
            self.done(s, t, {"parentResolve": parent_resolve, "autoApplied": store.auto_apply(s)})

        def act_branch(self, s, t, data):
            """Opens two or more subquestions of a topic. With message — the
            questions are taken from this user message: subquestions on the
            user's behalf, and the message counts as answered. Without
            message — Claude raised the questions. With title — sets the
            topic's question in one line."""
            qs = questions_of(data)
            if not qs or len(qs) < 2:
                self.fail("a list of two or more questions with title and text is required; "
                          "answer a single new question in the topic itself", 400)
                return
            if not self.need_open(t):
                return
            mid = data.get("message")
            if mid and not any(m["id"] == mid and m["author"] == "user" for m in t["messages"]):
                self.fail(f"the topic has no user message {mid}", 404)
                return
            made = [new_topic(t["id"], "user" if mid else "claude", q["text"], None, q["title"]) for q in qs]
            s["topics"] += made
            if data.get("title"):
                t["title"] = data["title"]
            t["messages"].append({"id": new_id("m"), "author": "claude", "kind": "branch", "created": now(),
                                  "answers": [mid] if mid else [], "topics": [x["id"] for x in made],
                                  "text": "Subquestions: " + "; ".join(f"“{x['title']}”" for x in made)})
            work = store.working.get(s["session"])
            if work and work["tid"] == t["id"] and not work["resolve"] and set(work["questions"]) <= answered(t):
                del store.working[s["session"]]
            self.done(s, t, {"topics": [{"id": x["id"], "title": x["title"]} for x in made]})

    return Handler


def info():
    """Returns /api/info of the server on port PORT, or None if nobody answers there."""
    try:
        with urllib.request.urlopen(f"{ORIGIN}/api/info", timeout=1) as r:
            return json.loads(r.read())
    except Exception:
        return None


def session_ids(store):
    with store.cond:
        return list(store.sessions)


def publish_bar(store, sid, bar):
    """Hands the status bar bar of session sid to its pages: keeps it in
    memory with the time it came, not in the session file, and wakes the pages."""
    with store.cond:
        s = store.sessions.get(sid)
        if not s:
            return
        store.status[sid] = {**bar, "updated": now()}
        s["rev"] += 1
        store.cond.notify_all()


def cmd_serve(_):
    if info():
        print(f"already running: {ORIGIN}/")
        return 0
    store = Store()
    feed = statusfeed.Feed(lambda: session_ids(store), lambda sid, bar: publish_bar(store, sid, bar))
    try:
        httpd = ThreadingHTTPServer((HOST, PORT), make_handler(store, feed))
    except OSError as e:
        print(f"port {PORT} is busy: {e}")
        return 1
    httpd.daemon_threads = True
    feed.start()
    print(f"{ORIGIN}/  storage: {DATA}", flush=True)
    httpd.serve_forever()
    return 0


def start_server():
    """Starts the server from this file detached from the session, so that it
    outlives the session, and waits up to 5 seconds for it to answer. Returns
    whether the server answered."""
    DATA.mkdir(parents=True, exist_ok=True)
    log = open(SERVER_LOG, "a", encoding="utf-8")
    subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "serve"],
                     stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
    for _ in range(50):
        time.sleep(0.1)
        if info():
            return True
    return False


def ensure_server():
    """Starts the server if it is not on port PORT yet. Exits the program if
    the port is taken by a foreign server or an old version."""
    running = info()
    if running and running.get("version") == VERSION:
        return
    if running:
        raise SystemExit(f"another server version is on port {PORT}: stop it (cm.py stop)")
    if not start_server():
        raise SystemExit(f"the server did not start, log: {SERVER_LOG}")


# --------------------------------------------------------------- commands

def api(method, path, obj=None, timeout=70):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8") if obj is not None else None
    req = urllib.request.Request(ORIGIN + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def call(method, path, obj=None):
    """Like api, but prints a server error or its absence and exits the
    program with code 1."""
    try:
        return api(method, path, obj)
    except urllib.error.HTTPError as e:
        print(json.loads(e.read()).get("error"))
        raise SystemExit(1)
    except (urllib.error.URLError, ConnectionError) as e:
        print(f"server {ORIGIN} is not answering ({e}): cm.py open")
        raise SystemExit(1)


def need_session(args):
    session = args.session or os.environ.get("CLAUDE_CODE_SESSION_ID")
    if not session:
        raise SystemExit("no session: pass --session or run from Claude Code")
    return session


def read_text(args):
    if args.file:
        return Path(args.file).read_text(encoding="utf-8").strip()
    return sys.stdin.read().strip()


def lines_of(a):
    """Returns the file lines that a topic from the diff with anchor a is
    asked about: "lines 10–12 of the working tree"."""
    where = ("HEAD" if a.get("staged") else "the index") if a.get("side") == "old" else \
        ("the index" if a.get("staged") else "the working tree")
    span = f"line {a['start']}" if a["start"] == a["end"] else f"lines {a['start']}–{a['end']}"
    return f"{span} of {where}"


def format_topic(topics, t, task=None, hints=True):
    """Returns topic t as text for Claude: the path from the root, the quote,
    messages with ids, subquestions with decisions. With task marks what
    awaits Claude; hints — hints on what to do with the topic (new, no title)."""
    by = {x["id"]: x for x in topics}
    chain, p = [], t
    while p:
        chain.append(p)
        p = by.get(p["parent"])
    fresh = len(t["messages"]) == 1 and t["messages"][0]["author"] == "user"
    out = [f"topic: {t['id']} · {STATE_NAME[t['state']]}" + (" · new" if fresh and hints else "") +
           (" · in progress by Claude" if t["state"] == "open" and t.get("inWork") else ""),
           "path: " + " › ".join(f"“{title_of(x)}”" for x in reversed(chain))]
    if hints and not t.get("title"):
        out.append("no title: set it with reply --title or branch --title")
    a = t.get("anchor")
    if a and a.get("kind") == "diff":
        out.append(f"file: {a['file']}, {lines_of(a)}")
        out.append("diff fragment " + ("of the index against HEAD:" if a.get("staged") else
                                       "of the working tree against the index:"))
        out += ["  " + r for r in a.get("rows") or []]
    elif a:
        out += [f"{name}: {a[k]}" for k, name in (("page", "page"), ("path", "section")) if a.get(k)]
        out += [f"anchor: #{a['anchor']}"] if a.get("anchor") else []
        out.append(f"quote: “{a.get('quote')}”")
    if t["state"] == "resolved":
        out.append(f"decision: {t['decision']}")
    kinds = {"decision": " · decision", "subdecision": " · subquestion decision", "branch": " · subquestions",
             "reopen": " · decision revoked"}
    for m in t["messages"]:
        who = "Claude" if m["author"] == "claude" else "User"
        kind = kinds.get(m.get("kind"), "") + (" (revoked)" if m.get("revoked") else "") + \
            (" (applied)" if m.get("applied") else "")
        mark = "  ← AWAITING REPLY" if task and m["id"] in task["questions"] else ""
        out += ["", f"--- {who}{kind} · {m['created']} · {m['id']}{mark}", m["text"]]
    kids = [x for x in topics if x["parent"] == t["id"]]
    if kids:
        out += ["", "subquestions:"]
        for k in kids:
            out.append(f"- {k['id']} “{title_of(k)}” · {STATE_NAME[k['state']]}" +
                       (f": {k['decision']}" if k["state"] == "resolved" else ""))
    if task and task["resolve"]:
        why = "all subquestions closed" if task["auto"] else "the user pressed Resolve"
        out += ["", f"--- {why} · {t['resolveRequested']}  ← RECORD DECISION"]
    return "\n".join(out)


def level(topics, parent):
    """Returns the topics from topics at level parent; without parent — the
    topics whose parent is not among topics."""
    ids = {x["id"] for x in topics}
    return [x for x in topics if (x["parent"] if x["parent"] in ids else None) == parent]


def dump(topics, context=()):
    """Returns the lines of the tree of topics with states and every topic in
    full; context — the other topics of the session, needed for the path
    from the root."""
    out, order = ["tree:"], []

    def walk(parent, depth):
        for t in sorted(level(topics, parent), key=lambda x: x["created"]):
            order.append(t)
            flag = " [WAITING]" if pending(t) else \
                " [IN PROGRESS]" if t["state"] == "open" and t.get("inWork") else ""
            out.append(f"{'  ' * depth}- {t['id']} [{STATE_NAME[t['state']]}]{flag} {title_of(t)}")
            walk(t["id"], depth + 1)

    walk(None, 0)
    if not order:
        out.append("(no topics)")
    for i, t in enumerate(order, 1):
        out += ["", f"=== topic {i} of {len(order)} ===", format_topic([*topics, *context], t, hints=False)]
    return out


def format_session(s, why):
    """Returns the whole discussion of the deleted session s as text for
    Claude: a header with the deletion reason why, the tree of topics with
    states and every topic in full."""
    return "\n".join([f"Discussion “{s.get('label')}” deleted: {why}. The session is disconnected. "
                      "Everything collected in it:", "", *dump(s["topics"])])


def format_apply(res):
    """Returns the text for Claude about applying the resolved ones — by the
    "Apply resolved" button or by auto-apply — from the next response: the
    order to carry out the plan, the plan from the decisions of the removed
    topics and every removed topic in full."""
    done = res["apply"]["topics"]
    why = ("No open questions are left, and auto-apply, turned on by the user in the "
           "“Apply resolved” menu, fired" if res["apply"].get("auto") else "The user pressed “Apply resolved”")
    return "\n".join([f"{why} in the discussion “{res.get('label')}”: carry out the plan. "
                      "Resolved and declined questions are removed from the discussion; below is their only copy. "
                      "Open questions stay in the discussion; the session is connected.",
                      "", "plan:", *format_plan(plan_of(done)), "", "removed questions:",
                      *dump(done, res["topics"])])


def plan_of(topics, parent=None):
    """Returns plan items from the decisions of topics at level parent (see
    level): a list of pairs (resolved topic, its subitems) in topic order.
    Decisions of subquestions of an unresolved topic rise to its level."""
    items = []
    for t in level(topics, parent):
        sub = plan_of(topics, t["id"])
        if t["state"] == "resolved":
            items.append((t, sub))
        else:
            items += sub
    return items


def format_plan(items, prefix=""):
    """Returns the lines of a numbered plan from plan_of items: "1.", "1.1."
    and so on; an item has the decision, the question and its topic's id."""
    out = []
    for i, (t, sub) in enumerate(items, 1):
        num = f"{prefix}{i}."
        out.append(f"{'   ' * prefix.count('.')}{num} {t['decision']} [question “{title_of(t)}”, {t['id']}]")
        out += format_plan(sub, num)
    return out


def closed_report(session):
    """Returns the whole discussion of session session closed by leave and
    erases its file; None if the session is not closed or the text was
    already returned."""
    path = DATA / "deleted" / (session + ".json")
    if not path.exists():
        return None
    text = format_session(json.loads(path.read_text(encoding="utf-8")), "the session was closed by leave")
    path.unlink()
    return text


def cmd_open(args):
    session = need_session(args)
    ensure_server()
    top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    repo = top.stdout.strip() if top.returncode == 0 else None
    res = call("POST", "/api/sessions", {"session": session, "label": args.label, "repo": repo})
    print(f"session page: {ORIGIN}/{session}")
    print(f"change review: {ORIGIN}/{session}/diff" + ("" if repo else " (the session is not in a git repository)"))
    print(f"session: {session} “{res['label']}”")


def cmd_embed(args):
    session = need_session(args)
    page = Path(args.page).resolve()
    if not page.is_file():
        print(f"no page {page}")
        return 1
    text = EMBED_TAG.sub("", page.read_text(encoding="utf-8"))
    tag = f'\n<script src="{ORIGIN}/embed.js" data-session="{session}"></script>'
    i = text.rfind("</body>")
    text = text[:i] + tag + "\n" + text[i:] if i >= 0 else text + tag + "\n"
    page.write_text(text, encoding="utf-8")
    print(f"page: {page.as_uri()}")
    print(f"written: {tag.strip()}")


def sleep_till_killed():
    """The wait of a session ended by the SessionEnd hook. On /clear Claude
    Code runs the hook and keeps background tasks in the new conversation, and
    the end of a background task starts a turn there. So the wait does not end:
    Claude Code kills it on exit; without its shell it ends by itself."""
    shell = os.getppid()
    while os.getppid() == shell:
        time.sleep(30)
    return 0


def cmd_wait(args):
    session = need_session(args)
    failures = 0
    while True:
        try:
            res = api("GET", f"/api/{session}/next?timeout=50")
            failures = 0
        except urllib.error.HTTPError as e:
            report = closed_report(session) if e.code == 410 else None
            if not report and (read_session(session) or {}).get("ended"):
                return sleep_till_killed()
            print(report or json.loads(e.read()).get("error"))
            return 0 if report else 1
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            # leave of the last session stops the server before it manages to
            # answer: the report is taken from the file.
            report = closed_report(session)
            if report:
                print(report)
                return 0
            # The server is stopped or crashed while the session is not
            # closed: the wait starts it again, and the session keeps listening.
            # A disconnected session does not start it.
            saved = read_session(session)
            if saved and saved.get("ended"):
                return sleep_till_killed()
            if saved and not saved.get("connected"):
                print(f"session {session} is not connected: cm.py open")
                return 1
            if saved and not info() and start_server():
                continue
            failures += 1
            if failures > 24:
                print(f"server {ORIGIN} is not answering: {e}")
                return 1
            time.sleep(5)
            continue
        if res.get("apply"):
            print(format_apply(res))
            return 0
        if res.get("task"):
            t = next(x for x in res["topics"] if x["id"] == res["task"]["tid"])
            print(f"Topics awaiting Claude: {res['queue']}. The first one:\n")
            print(format_topic(res["topics"], t, res["task"]))
            return 0


def cmd_reply(args):
    t = call("POST", f"/api/{need_session(args)}/topics/{args.id}/claude",
             {"text": read_text(args), "followup": args.followup, "working": args.working, "title": args.title})
    print(f"reply in topic {t['id']} “{title_of(t)}”")


def read_questions(args):
    qs = json.loads(Path(args.file).read_text(encoding="utf-8"))
    if not isinstance(qs, list):
        raise SystemExit("FILE is a JSON list [{\"title\": …, \"text\": …}]")
    return qs


def cmd_branch(args):
    res = call("POST", f"/api/{need_session(args)}/topics/{args.id}/branch",
               {"questions": read_questions(args), "message": args.message, "title": args.title})
    print(f"subquestions of topic {args.id}:")
    for x in res["topics"]:
        print(f"- {x['id']} “{x['title']}”")


def cmd_ask(args):
    res = call("POST", f"/api/{need_session(args)}/topics", {"questions": read_questions(args)})
    print("topics:")
    for x in res["topics"]:
        print(f"- {x['id']} “{x['title']}”")


def cmd_chat(args):
    session = need_session(args)
    res = call("POST", f"/api/{session}/topics", {"questions": read_questions(args), "author": "user"})
    print("topics:")
    for x in res["topics"]:
        print(f"- {x['id']} “{x['title']}” {ORIGIN}/{session}/{x['id']}")


def cmd_resolve(args):
    t = call("POST", f"/api/{need_session(args)}/topics/{args.id}/decision", {"decision": args.decision})
    print(f"topic {t['id']} resolved: {t['decision']}")
    if t.get("parentResolve"):
        print(f"all subquestions of topic {t['parentResolve']} are closed: wait will give it for recording the decision")
    if t.get("autoApplied"):
        print("no open questions are left: auto-apply, turned on by the user, applied the resolved ones; "
              "wait will give the plan")


def session_topics(args):
    return call("GET", f"/api/{need_session(args)}/state")


def cmd_thread(args):
    st = session_topics(args)
    t = next((x for x in st["topics"] if x["id"] == args.id), None)
    if not t:
        print(f"no topic {args.id}")
        return 1
    print(format_topic(st["topics"], t))


def cmd_show(args):
    st = session_topics(args)
    print(f"session {st['session']} “{st.get('label')}”" + (" — listening" if st.get("listening") else ""))
    a = st.get("activity")
    if a:
        print(f"activity: {a['text']}" + (f" (topic {a['topic']})" if a.get("topic") else ""))
    print(f"page: {ORIGIN}/{st['session']}")

    def walk(parent, depth):
        for t in (x for x in st["topics"] if x["parent"] == parent):
            flag = " [WAITING]" if t["id"] in st["queue"] else \
                " [IN PROGRESS]" if t["state"] == "open" and t.get("inWork") else ""
            print(f"{'  ' * depth}- {t['id']} [{STATE_NAME[t['state']]}]{flag} {title_of(t)}")
            walk(t["id"], depth + 1)

    walk(None, 0)


def cmd_activity(args):
    res = call("POST", f"/api/{need_session(args)}/activity", {"text": args.text, "topic": args.topic})
    a = res["activity"]
    print(f"activity: {a['text']}" + (f" (topic {a['topic']})" if a.get("topic") else "") if a
          else "activity cleared: the pages show the default phrases")


def cmd_leave(args):
    session = need_session(args)
    res = call("POST", f"/api/sessions/{session}/delete", {})
    print(closed_report(session) or f"session {session} deleted")
    print(f"\nconnected sessions: {res['connected']}" + ("; server stopped" if res["connected"] == 0 else ""))


def cmd_disconnect(args):
    if not args.hook:
        session = need_session(args)
        res = call("POST", f"/api/sessions/{session}/disconnect", {})
        print(f"session {session} disconnected, the discussion stays: {ORIGIN}/{session}")
        print(f"connected sessions: {res['connected']}" + ("; server stopped" if res["connected"] == 0 else ""))
        return 0
    # The SessionEnd hook: the end of a Claude Code session must not fail or
    # start the server, so errors are ignored.
    try:
        session = str(json.load(sys.stdin).get("session_id") or "")
    except (ValueError, AttributeError):
        return 0
    saved = read_session(session) if SAFE_ID.match(session) else None
    if not saved or not saved.get("connected"):
        return 0
    if info():
        try:
            api("POST", f"/api/sessions/{session}/disconnect", {"ended": True}, timeout=5)
        except Exception:
            pass
    else:
        saved.update(connected=False, ended=True)
        write_session(saved)
    return 0


def cmd_stop(_):
    api("POST", "/api/shutdown", {})
    print("server stopped")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def cmd(name, *args):
        sp = sub.add_parser(name)
        if name not in ("serve", "stop"):
            sp.add_argument("--session")
        for a in args:
            sp.add_argument(a)
        return sp

    cmd("serve")
    cmd("stop")
    cmd("open").add_argument("--label")
    cmd("embed", "page")
    cmd("wait")
    cmd("leave")
    cmd("show")
    cmd("thread", "id")
    r = cmd("reply", "id")
    r.add_argument("-f", "--file")
    r.add_argument("--title")
    r.add_argument("--followup", action="store_true")
    r.add_argument("--working", action="store_true")
    b = cmd("branch", "id")
    b.add_argument("-f", "--file", required=True)
    b.add_argument("--message")
    b.add_argument("--title")
    cmd("resolve", "id").add_argument("--decision", required=True)
    cmd("ask").add_argument("-f", "--file", required=True)
    cmd("chat").add_argument("-f", "--file", required=True)
    a = cmd("activity")
    a.add_argument("text", nargs="?")
    a.add_argument("--topic")
    cmd("disconnect").add_argument("--hook", action="store_true")
    args = p.parse_args()
    handlers = {"serve": cmd_serve, "stop": cmd_stop, "open": cmd_open, "embed": cmd_embed, "wait": cmd_wait,
                "leave": cmd_leave, "show": cmd_show, "thread": cmd_thread, "reply": cmd_reply,
                "branch": cmd_branch, "resolve": cmd_resolve, "ask": cmd_ask,
                "chat": cmd_chat, "activity": cmd_activity, "disconnect": cmd_disconnect}
    return handlers[args.cmd](args) or 0


if __name__ == "__main__":
    sys.exit(main())
