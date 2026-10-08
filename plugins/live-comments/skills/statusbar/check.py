#!/usr/bin/env python3
"""Checks a status bar file of the discussion pages.

    check.py [FILE] [--input JSON]

Runs FILE — a .py file with Python or a .js file with Node; by default the
user's file statusbar.py, and without it statusbar.js, in
~/.config/live-comments ($XDG_CONFIG_HOME/live-comments when XDG_CONFIG_HOME
is set) — the way the live-comments server does: with a status line JSON
on stdin and 1 second to finish. The input is the JSON file --input, and without
it a sample with all fields of the Claude Code status line, its times counted
from now. Checks the output against protocol.md and prints the bar as text
with the tooltips of its items, or the errors; with errors the exit code is 1.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

BAR_DIR = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "live-comments"
LIMIT = 16384
COLORS = {"good", "warn", "bad", "accent", "muted"}
STYLES = COLORS | {"strong", "mono"}
# Block types and their options.
BLOCKS = {
    "text": {"style"},
    "chip": {"style"},
    "meter": {"warn", "bad"},
    "dot": set(),
    "link": {"href", "style"},
    "countdown": {"prefix", "done", "style"},
    "age": {"prefix", "style"},
}


def sample():
    """Returns a status line JSON with all fields, its times counted from now."""
    now = int(time.time())
    cwd = os.getcwd()
    return {
        "cwd": cwd, "session_id": "check", "session_name": "check", "transcript_path": "/tmp/check.jsonl",
        "model": {"id": "claude-opus-5-5", "display_name": "Opus 5.5"},
        "workspace": {"current_dir": cwd, "project_dir": cwd, "added_dirs": [],
                      "repo": {"host": "github.com", "owner": "owner", "name": "project"}},
        "version": "2.1.290", "output_style": {"name": "default"},
        "cost": {"total_cost_usd": 3.4567, "total_duration_ms": 4380000, "total_api_duration_ms": 912000,
                 "total_lines_added": 156, "total_lines_removed": 23},
        "context_window": {"total_input_tokens": 131500, "total_output_tokens": 1200, "context_window_size": 200000,
                           "used_percentage": 66, "remaining_percentage": 34,
                           "current_usage": {"input_tokens": 1500, "output_tokens": 1200,
                                             "cache_creation_input_tokens": 5000, "cache_read_input_tokens": 125000}},
        "exceeds_200k_tokens": False, "fast_mode": False, "effort": {"level": "high"}, "thinking": {"enabled": True},
        "prompt_cache": {"warm": True, "caching_observed": True, "ttl": "1h", "expires_at": now + 2520, "requests": 14,
                         "misses": 2, "hit_ratio": 0.91},
        "rate_limits": {"five_hour": {"used_percentage": 23.5, "resets_at": now + 7980},
                        "seven_day": {"used_percentage": 93.2, "resets_at": now + 280000}},
        "pr": {"number": 12, "url": "https://github.com/owner/project/pull/12", "review_state": "pending"},
    }


def number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def block_errors(b, at):
    """Returns the errors of block b at path at."""
    if not isinstance(b, dict):
        return [f"{at}: a block is an object"]
    kinds = [k for k in b if k in BLOCKS]
    if len(kinds) != 1:
        return [f"{at}: a block has exactly one type key of {', '.join(BLOCKS)}; it has {kinds or 'none'}"]
    kind = kinds[0]
    errs = []
    extra = set(b) - {kind} - BLOCKS[kind]
    if extra:
        errs.append(f"{at}: {kind} has no options {', '.join(sorted(extra))}")
    v = b[kind]
    good = {"text": isinstance(v, str), "chip": isinstance(v, str), "link": isinstance(v, str),
            "meter": number(v), "countdown": number(v), "dot": v in COLORS, "age": v is True}[kind]
    if not good:
        errs.append(f"{at}: wrong value of {kind}: {v!r}")
    for key in ("warn", "bad"):
        if key in b and not number(b[key]):
            errs.append(f"{at}: {key} is a number")
    for key in ("prefix", "done", "href"):
        if key in b and not isinstance(b[key], str):
            errs.append(f"{at}: {key} is a string")
    if "style" in b and (not isinstance(b["style"], str) or not set(b["style"].split()) <= STYLES):
        errs.append(f"{at}: style is names of {', '.join(sorted(STYLES))} separated by spaces: {b['style']!r}")
    return errs


def errors_of(bar):
    """Returns the errors of bar against protocol.md."""
    if not isinstance(bar, dict) or set(bar) != {"items"} or not isinstance(bar["items"], list):
        return ['the bar is an object {"items": [item, …]}']
    errs = []
    size = len(json.dumps(bar, ensure_ascii=False).encode("utf-8"))
    if size > LIMIT:
        errs.append(f"the bar takes {size} bytes, more than {LIMIT}")
    for i, it in enumerate(bar["items"]):
        at = f"items[{i}]"
        if not isinstance(it, dict):
            errs.append(f"{at}: an item is an object")
            continue
        extra = set(it) - {"blocks", "title", "fill"}
        if extra:
            errs.append(f"{at}: an item has no keys {', '.join(sorted(extra))}")
        if "title" in it and not isinstance(it["title"], str):
            errs.append(f"{at}.title is a string")
        if "fill" in it and not isinstance(it["fill"], bool):
            errs.append(f"{at}.fill is true or false")
        blocks = it.get("blocks")
        if not isinstance(blocks, list) or not blocks:
            errs.append(f"{at}.blocks is a list of at least one block")
            continue
        for j, b in enumerate(blocks):
            errs += block_errors(b, f"{at}.blocks[{j}]")
    return errs


def span(sec):
    m = int(sec // 60)
    h, d = m // 60, m // 1440
    return f"{d}d {h % 24}h" if d else f"{h}h {m % 60}m" if h else f"{m}m" if m else "<1m"


def block_text(b, now):
    """Returns block b as text the way the page draws it."""
    if "text" in b:
        return b["text"]
    if "chip" in b:
        return f"[{b['chip']}]"
    if "meter" in b:
        n = round(max(0, min(100, b["meter"])) / 20)
        return "▰" * n + "▱" * (5 - n) + f" {round(b['meter'])}%"
    if "dot" in b:
        return "●"
    if "link" in b:
        return b["link"] + ("↗" if b.get("href", "").startswith(("http://", "https://")) else "")
    if "countdown" in b:
        left = b["countdown"] - now
        return b.get("prefix", "") + span(left) if left > 0 else b.get("done", "")
    return b.get("prefix", "") + "<1m ago"


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("file", nargs="?")
    p.add_argument("--input", help="a status line JSON file instead of the sample")
    args = p.parse_args()
    if args.file:
        path = Path(args.file).expanduser()
    else:
        path = next((f for f in (BAR_DIR / "statusbar.py", BAR_DIR / "statusbar.js") if f.is_file()), None)
    if not path or not path.is_file():
        print(f"no file {path or BAR_DIR / 'statusbar.py'}: the pages show no status bar")
        return 1
    if path.suffix == ".js":
        node = shutil.which("node")
        if not node:
            print(f"{path} needs Node: no node on PATH")
            return 1
        cmd = [node, str(path)]
    else:
        cmd = [sys.executable, str(path)]
    data = Path(args.input).read_bytes() if args.input else json.dumps(sample()).encode("utf-8")
    try:
        run = subprocess.run(cmd, input=data, capture_output=True, timeout=1)
    except subprocess.TimeoutExpired:
        print(f"{path} did not finish in 1 second")
        return 1
    if run.returncode:
        print(f"{path} exited with code {run.returncode}:\n{run.stderr.decode('utf-8', 'replace')}")
        return 1
    try:
        bar = json.loads(run.stdout)
    except ValueError as e:
        print(f"{path} printed not JSON ({e}):\n{run.stdout[:500].decode('utf-8', 'replace')}")
        return 1
    errs = errors_of(bar)
    if errs:
        print("errors:\n" + "\n".join("- " + e for e in errs))
        return 1
    now = time.time()
    print(" │ ".join(" ".join(filter(None, (block_text(b, now) for b in it["blocks"]))) for it in bar["items"]))
    for i, it in enumerate(bar["items"]):
        if it.get("title"):
            print(f"  items[{i}] tooltip: {it['title']}")
    print(f"ok: {len(bar['items'])} items")
    return 0


if __name__ == "__main__":
    sys.exit(main())
