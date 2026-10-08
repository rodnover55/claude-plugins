"""The status bar of the discussion pages: its input and the user's bar file.

The bar is drawn by the user's bar file statusbar.py or statusbar.js (the
statusbar skill) from a status line JSON of the session: a JSON with the
field names of the one Claude Code passes to the status line command. It is
built here from the session transcript, without the fields only Claude Code
knows — the cost, the durations and the pull request. The 5-hour and 7-day
rate limits come from a small background `claude -p` request at most once
in LIMITS_EVERY seconds while a discussion page is open. Fields sent to the
server (custom data, POST /api/<session>/statusline) are added to the JSON
where it has no such field; the fields the server computes are never
changed by them.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path

CLAUDE_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
BAR_DIR = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "live-comments"
# How often the rate limits are requested with `claude -p`, at most; 0 in
# LIVE_COMMENTS_LIMITS_POLL turns the requests off.
LIMITS_EVERY = 300
LIMITS_POLL = os.environ.get("LIVE_COMMENTS_LIMITS_POLL") != "0"
# A page counts as open this long after its last long poll began or ended.
PAGE_OPEN = 40
# A sent field is used while its last send is at most this much older than
# the last change of the transcript.
CUSTOM_FRESH = 600
# The fields the server computes from the transcript and with claude -p:
# sent data never change them, even when the server has no value yet.
COMPUTED = (("session_id",), ("transcript_path",), ("cwd",), ("workspace", "current_dir"),
            ("workspace", "project_dir"), ("workspace", "added_dirs"), ("workspace", "repo"),
            ("model",), ("version",), ("effort",), ("session_name",), ("context_window",),
            ("prompt_cache",), ("cost", "total_lines_added"), ("cost", "total_lines_removed"),
            ("rate_limits",), ("live_comments",))
# How often the loop looks for bars that are due.
TICK = 2
# The bar of a session is updated at most this often: the transcript is read
# and the bar file runs. The first update of a session after the server
# started is at once.
UPDATE_EVERY = 60
WINDOWS = ("five_hour", "seven_day")
BAR_LIMIT = 16384


def log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} statusfeed: {msg}", file=sys.stderr, flush=True)


def model_name(mid):
    """Returns the display name of model id mid: claude-opus-5-5 → Opus 5.5,
    claude-haiku-4-5-20251001 → Haiku 4.5."""
    parts = re.sub(r"\[.*\]$", "", mid).split("-")
    if parts and parts[0] == "claude":
        parts = parts[1:]
    words = [p.capitalize() for p in parts if not p.isdigit()]
    nums = [p for p in parts if p.isdigit() and len(p) <= 2]
    return " ".join(words) + (" " + ".".join(nums) if nums else "")


def context_size(mid):
    """Returns the context window of model id mid in tokens: 1M for an
    "[1m]" id, Fable, Mythos, and Opus and Sonnet from 4.6 on; 200K otherwise."""
    if mid.endswith("[1m]"):
        return 1_000_000
    parts = mid.split("-")
    nums = [int(p) for p in parts if p.isdigit() and len(p) <= 2]
    version = tuple(nums[:2]) if nums else (0,)
    if any(f in parts for f in ("fable", "mythos")):
        return 1_000_000
    if any(f in parts for f in ("opus", "sonnet")) and version >= (4, 6):
        return 1_000_000
    return 200_000


_repos = {}


def repo_of(cwd):
    """Returns {host, owner, name} of the origin remote of the repository in
    cwd, or None; the answer is kept for a minute."""
    hit = _repos.get(cwd)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    repo = None
    try:
        url = subprocess.run(["git", "-C", cwd, "remote", "get-url", "origin"], capture_output=True,
                             text=True, timeout=2).stdout.strip()
        m = re.match(r"^(?:[a-z+]+://)?(?:[^@/]+@)?([^/:]+)[:/](.+?)/([^/]+?)(?:\.git)?/?$", url)
        if m:
            repo = {"host": m.group(1), "owner": m.group(2), "name": m.group(3)}
    except (OSError, subprocess.SubprocessError):
        pass
    _repos[cwd] = (time.time(), repo)
    return repo


def edited_lines(entry):
    """Returns the lines added and removed by the file edit whose result is in
    transcript entry entry: the + and - lines of its patch, and every line of a
    created file. The same count as Claude Code's total_lines_added and
    total_lines_removed."""
    res = entry.get("toolUseResult")
    if not isinstance(res, dict):
        return 0, 0
    added = removed = 0
    for hunk in res.get("structuredPatch") or []:
        for line in hunk.get("lines") or []:
            if line.startswith("+"):
                added += 1
            elif line.startswith("-"):
                removed += 1
    if res.get("type") == "create" and isinstance(res.get("content"), str):
        added += len(res["content"].splitlines())
    return added, removed


def epoch(ts):
    """Returns Unix seconds of an ISO time of the transcript, or None."""
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


class Lines:
    """A growing JSON lines file read by parts: each read returns the entries
    added since the previous one."""

    def __init__(self, path):
        self.path = path
        self.offset = 0
        self.rest = b""

    def read(self):
        """Returns the new entries; None if the file got shorter, and then it is
        read from the start on the next call."""
        try:
            size = self.path.stat().st_size
        except OSError:
            return []
        if size < self.offset:
            self.offset, self.rest = 0, b""
            return None
        if size == self.offset:
            return []
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            data = self.rest + f.read(size - self.offset)
        self.offset = size
        lines = data.split(b"\n")
        self.rest = lines.pop()
        out = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
        return out


class Transcript:
    """The transcript of session sid and its subagents, read as they grow:
    what a status line JSON of the session needs."""

    def __init__(self, sid):
        self.sid = sid
        self.path = None
        self.looked = 0
        self.reset()

    def reset(self):
        self.main = Lines(self.path) if self.path else None
        self.subs = {}
        # The last assistant entry of the main chain.
        self.last = None
        self.first_cwd = None
        self.title = None
        self.ttl = None
        self.msg = None
        self.reads = self.writes = self.fresh = self.requests = 0
        self.added = self.removed = 0
        self.changed = 0
        # The time of the latest entry, in Unix seconds.
        self.latest = 0

    def find(self):
        """Looks for the transcript file, at most once in 30 seconds."""
        if self.path or time.time() - self.looked < 30:
            return
        self.looked = time.time()
        found = list(CLAUDE_DIR.glob(f"projects/*/{self.sid}.jsonl"))
        if found:
            self.path = max(found, key=lambda p: p.stat().st_mtime)
            self.reset()

    def refresh(self):
        """Reads what was added to the transcripts. Returns True if something was."""
        self.find()
        if not self.main:
            return False
        entries = self.main.read()
        if entries is None:
            self.reset()
            entries = self.main.read() or []
        grew = bool(entries)
        for e in entries:
            self.take(e)
        for p in self.path.parent.glob(f"{self.sid}/subagents/*.jsonl"):
            sub = self.subs.setdefault(p, Lines(p))
            for e in sub.read() or []:
                grew = True
                a, r = edited_lines(e)
                self.added += a
                self.removed += r
        if grew:
            self.changed = time.time()
        return grew

    def take(self, e):
        """Takes one entry of the main transcript into account."""
        a, r = edited_lines(e)
        self.added += a
        self.removed += r
        self.latest = max(self.latest, epoch(e.get("timestamp")) or 0)
        if e.get("type") == "ai-title" and e.get("aiTitle"):
            self.title = e["aiTitle"]
        if e.get("cwd") and not self.first_cwd:
            self.first_cwd = e["cwd"]
        msg = e.get("message")
        if e.get("type") != "assistant" or e.get("isSidechain") or not isinstance(msg, dict):
            return
        self.last = e
        u = msg.get("usage") or {}
        # One response is written as several entries with the same message id.
        if msg.get("id") == self.msg:
            return
        self.msg = msg.get("id")
        self.requests += 1
        self.reads += u.get("cache_read_input_tokens") or 0
        self.writes += u.get("cache_creation_input_tokens") or 0
        self.fresh += u.get("input_tokens") or 0
        created = u.get("cache_creation") or {}
        if created.get("ephemeral_1h_input_tokens"):
            self.ttl = "1h"
        elif created.get("ephemeral_5m_input_tokens"):
            self.ttl = "5m"

    def status_json(self, limits):
        """Returns a status line JSON of the session built from the transcript,
        with the rate limits limits ({window: {used_percentage, resets_at}, at}
        or None); fields the transcript lacks are absent."""
        e = self.last or {}
        msg = e.get("message") or {}
        u = msg.get("usage") or {}
        mid = msg.get("model")
        cwd = e.get("cwd") or self.first_cwd or ""
        d = {"session_id": self.sid, "transcript_path": str(self.path), "cwd": cwd,
             "workspace": {"current_dir": cwd, "project_dir": self.first_cwd or cwd, "added_dirs": []},
             "cost": {"total_lines_added": self.added, "total_lines_removed": self.removed},
             "live_comments": {"source": "transcript", "at": int(self.latest) or None}}
        repo = repo_of(cwd) if cwd else None
        if repo:
            d["workspace"]["repo"] = repo
        if mid:
            d["model"] = {"id": mid, "display_name": model_name(mid)}
        if e.get("version"):
            d["version"] = e["version"]
        if e.get("effort"):
            d["effort"] = {"level": e["effort"]}
        if self.title:
            d["session_name"] = self.title
        reads, writes = u.get("cache_read_input_tokens") or 0, u.get("cache_creation_input_tokens") or 0
        used = (u.get("input_tokens") or 0) + reads + writes
        if used and mid:
            size = context_size(mid)
            pct = round(used / size * 100, 1)
            d["context_window"] = {
                "total_input_tokens": used, "total_output_tokens": u.get("output_tokens") or 0,
                "context_window_size": size, "used_percentage": pct, "remaining_percentage": round(100 - pct, 1),
                "current_usage": {"input_tokens": u.get("input_tokens") or 0, "output_tokens": u.get("output_tokens") or 0,
                                  "cache_creation_input_tokens": writes, "cache_read_input_tokens": reads}}
        if self.requests:
            total = self.reads + self.writes + self.fresh
            last = epoch(e.get("timestamp"))
            ttl = self.ttl or "5m"
            expires = int(last + (3600 if ttl == "1h" else 300)) if last and (reads or writes) else None
            d["prompt_cache"] = {"warm": bool(expires and expires > time.time()),
                                 "caching_observed": bool(self.reads or self.writes), "ttl": ttl,
                                 "expires_at": expires, "requests": self.requests,
                                 "hit_ratio": round(self.reads / total, 4) if total else None}
        if limits:
            d["rate_limits"] = {k: limits[k] for k in WINDOWS if k in limits}
            d["live_comments"]["limits_at"] = int(limits["at"])
        return d


def leaves(data, path=()):
    """Returns the leaf values of the nested object data: (path, value) pairs,
    path being the tuple of keys; a list is a leaf."""
    out = []
    for key, value in data.items():
        if isinstance(value, dict):
            out += leaves(value, path + (key,))
        else:
            out.append((path + (key,), value))
    return out


def computed(path):
    """Whether the field at path is one the server computes, or lies inside one."""
    return any(path[:len(c)] == c for c in COMPUTED)


def add_missing(data, path, value):
    """Puts value at path into the nested object data if there is no field
    there yet; an existing field, or a non-object on the way, wins."""
    for key in path[:-1]:
        nxt = data.setdefault(key, {})
        if not isinstance(nxt, dict):
            return
        data = nxt
    data.setdefault(path[-1], value)


def run_bar(data):
    """Runs the user's bar file — statusbar.py with this Python, and without it
    statusbar.js with Node — with the status line JSON data on stdin, and
    returns the bar it prints ({"items": [...]}). Without a file returns an
    empty bar; returns None if the file fails, runs longer than 1 second,
    prints something else or there is no Node for statusbar.js."""
    py, js = BAR_DIR / "statusbar.py", BAR_DIR / "statusbar.js"
    if py.is_file():
        cmd = [sys.executable, str(py)]
    elif js.is_file():
        node = shutil.which("node")
        if not node:
            return None
        cmd = [node, str(js)]
    else:
        return {"items": []}
    try:
        run = subprocess.run(cmd, input=json.dumps(data).encode("utf-8"), capture_output=True, timeout=1)
    except (OSError, subprocess.SubprocessError) as e:
        log(f"{cmd[-1]}: {e}")
        return None
    if run.returncode:
        log(f"{cmd[-1]} exited with code {run.returncode}: {run.stderr.decode('utf-8', 'replace')[-500:]}")
        return None
    if len(run.stdout) > BAR_LIMIT:
        log(f"{cmd[-1]} printed more than {BAR_LIMIT} bytes")
        return None
    try:
        bar = json.loads(run.stdout)
    except ValueError:
        log(f"{cmd[-1]} printed not JSON")
        return None
    return bar if isinstance(bar, dict) and isinstance(bar.get("items"), list) else None


def poll_limits():
    """Sends one small `claude -p` request — Haiku, no tools, no MCP servers,
    a one-line system prompt — and returns the rate limit windows from its
    rate_limit_event: {"five_hour": {used_percentage, resets_at}, "seven_day":
    …}. Returns None without claude on PATH, when the run fails or has no
    such event."""
    claude = shutil.which("claude")
    if not claude:
        return None
    cmd = [claude, "-p", ".", "--model", "haiku", "--output-format", "stream-json", "--verbose",
           "--no-session-persistence", "--max-turns", "1", "--tools", "", "--strict-mcp-config",
           "--system-prompt", "Reply with one word."]
    try:
        run = subprocess.run(cmd, capture_output=True, timeout=120, cwd=tempfile.gettempdir(),
                             stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as e:
        log(f"claude -p: {e}")
        return None
    out = {}
    for line in run.stdout.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") != "rate_limit_event":
            continue
        info = ev.get("rate_limit_info") or {}
        windows = dict(info.get("unifiedWindows") or {})
        if info.get("rateLimitType") in WINDOWS and "utilization" in info:
            windows.setdefault(info["rateLimitType"], info)
        for key in WINDOWS:
            w = windows.get(key)
            if isinstance(w, dict) and isinstance(w.get("utilization"), (int, float)):
                out[key] = {"used_percentage": round(w["utilization"] * 100, 1), "resets_at": w.get("resetsAt")}
    if not out:
        log(f"claude -p gave no rate limits (exit code {run.returncode})")
    return out or None


class Feed:
    """Keeps the bars of the sessions with open discussion pages current.

    sessions() returns the ids of the sessions of the server; publish(sid,
    bar) hands a new bar of session sid to the pages. A thread updates the bar
    of each such session once in UPDATE_EVERY seconds, the first time at
    once: it reads what was added to the transcript, builds the JSON from it,
    adds the sent fields it lacks and runs the bar file; a bar that differs
    from the last one goes to the pages.
    """

    def __init__(self, sessions, publish):
        self.sessions = sessions
        self.publish = publish
        self.lock = threading.Lock()
        self.pages = {}
        # Session → the sent fields {path: (value, time of the send)} and the time of the last send.
        self.custom = {}
        self.transcripts = {}
        # Session → the time of its last update; session → its last bar.
        self.updated = {}
        self.bars = {}
        # The rate limits {window: {used_percentage, resets_at}, at} from claude -p.
        self.limits = None
        self.limits_tried = 0
        self.polling = False

    def page_seen(self, sid):
        """A discussion page of session sid is polling the server."""
        with self.lock:
            self.pages[sid] = time.time()

    def statusline(self, sid, data):
        """Fields of session sid sent to POST /api/<session>/statusline: each
        sent field replaces the one sent before at its path, the other sent
        fields stay; fields the server computes are dropped."""
        now = time.time()
        with self.lock:
            sent = self.custom.setdefault(sid, {"fields": {}, "at": 0})
            for path, value in leaves(data):
                if computed(path):
                    continue
                # A field and fields inside it can't both be: the new one replaces them.
                for old in [p for p in sent["fields"] if p[:len(path)] == path or path[:len(p)] == p]:
                    del sent["fields"][old]
                sent["fields"][path] = (value, now)
            sent["at"] = now

    def start(self):
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while True:
            try:
                self.tick()
            except Exception as e:  # the thread must outlive any surprise in a transcript
                log(f"tick: {e!r}")
            time.sleep(TICK)

    def tick(self):
        now = time.time()
        with self.lock:
            open_ = [sid for sid, t in self.pages.items() if now - t < PAGE_OPEN]
        alive = set(self.sessions())
        for sid in open_:
            if sid in alive and (sid not in self.updated or now - self.updated[sid] >= UPDATE_EVERY):
                self.updated[sid] = now
                self.update(sid)
        with self.lock:
            due = LIMITS_POLL and open_ and not self.polling and \
                now - max(self.limits["at"] if self.limits else 0, self.limits_tried) >= LIMITS_EVERY
            if due:
                self.polling = True
                self.limits_tried = now
        if due:
            threading.Thread(target=self.poll, daemon=True).start()

    def poll(self):
        got = poll_limits()
        with self.lock:
            if got:
                self.limits = {**got, "at": time.time()}
            self.polling = False

    def update(self, sid):
        """Runs the bar file of session sid on its current input."""
        tx = self.transcripts.setdefault(sid, Transcript(sid))
        tx.refresh()
        if not tx.path:
            return
        with self.lock:
            limits = self.limits
            sent = self.custom.get(sid)
            fields = []
            if sent:
                cutoff = (tx.latest or tx.changed) - CUSTOM_FRESH
                for path in [p for p, (_, t) in sent["fields"].items() if t < cutoff]:
                    del sent["fields"][path]
                fields = [(p, v) for p, (v, _) in sent["fields"].items()]
        data = tx.status_json(limits)
        for path, value in fields:
            add_missing(data, path, value)
        if fields:
            data["live_comments"]["custom_at"] = int(sent["at"])
        bar = run_bar(data)
        if bar is None:
            return
        # Only a changed bar reaches the pages: its time is when the bar changed.
        text = json.dumps(bar, sort_keys=True)
        if self.bars.get(sid) != text:
            self.bars[sid] = text
            self.publish(sid, bar)
