#!/usr/bin/env python3
"""The status bar of the live-comments discussion pages.

Reads the Claude Code status line JSON on stdin and prints the bar as JSON:
{"items": [...]}, each item made of the standard blocks text, chip, meter,
dot, link, countdown and age. The blocks and their options are described in
protocol.md of the statusbar skill of the live-comments plugin.

This is the default bar of the plugin. Your copy is
~/.config/live-comments/statusbar.py: change it, or ask Claude to change it
(/live-comments:statusbar), and check it with check.py of the same skill.
"""

import json
import os
import sys
from datetime import datetime

# Rate limit windows of the input: the key, the short name and the name in the tooltip.
LIMITS = (("five_hour", "5h", "5-hour"), ("seven_day", "7d", "7-day"), ("spend_limit", "spend", "Spend"))


def get(data, *path):
    """Returns the value at path in data, or None if a key on the way is absent."""
    for key in path:
        data = data.get(key) if isinstance(data, dict) else None
    return data


def tokens(n):
    """Returns tokens in short: 950, 85.7k, 1M."""
    for size, unit in ((1e6, "M"), (1e3, "k")):
        if n >= size:
            return f"{n / size:.1f}".rstrip("0").rstrip(".") + unit
    return str(n)


def span(ms):
    """Returns a duration of ms milliseconds in short: 3d 4h, 2h 13m, 42m, <1m."""
    m = int(ms // 60000)
    h, d = m // 60, m // 1440
    if d:
        return f"{d}d {h % 24}h"
    if h:
        return f"{h}h {m % 60}m"
    return f"{m}m" if m else "<1m"


def when(t):
    """Returns the local time of epoch seconds t: the time for today, the date and time for other days."""
    d = datetime.fromtimestamp(t)
    return d.strftime("%H:%M" if d.date() == datetime.now().date() else "%d %b %H:%M")


def item(*blocks, title=None, fill=False):
    """Returns an item of the bar made of blocks; empty blocks (None, False) are left out."""
    it = {"blocks": [b for b in blocks if b]}
    if title:
        it["title"] = title
    if fill:
        it["fill"] = True
    return it


def model(d):
    """The model, its reasoning effort and fast mode."""
    name = get(d, "model", "display_name") or get(d, "model", "id")
    if not name:
        return None
    version = get(d, "version")
    effort = get(d, "effort", "level")
    return item({"text": name, "style": "strong"},
                effort and {"chip": effort},
                get(d, "fast_mode") and {"chip": "fast"},
                title=(get(d, "model", "id") or name) + (f" · Claude Code {version}" if version else ""))


def context(d):
    """Input tokens in the context window: a meter, yellow from 60%, red from 85%."""
    used = get(d, "context_window", "total_input_tokens")
    if not used:
        return None
    size = get(d, "context_window", "context_window_size")
    pct = get(d, "context_window", "used_percentage")
    if pct is None and size:
        pct = used / size * 100
    return item({"text": "Context"},
                pct is not None and {"meter": pct, "warn": 60, "bad": 85},
                {"text": tokens(used) + (f" / {tokens(size)}" if size else ""), "style": "muted"},
                title=f"Context window: {used:,}" + (f" of {size:,}" if size else "") + " tokens")


def limits(d):
    """The rate limit windows: a meter, yellow from 70%, red from 90%, and the time until the reset.
    Without the status line the server requests them by itself; the tooltip says when."""
    checked = get(d, "live_comments", "limits_at")
    out = []
    for key, short, name in LIMITS:
        pct = get(d, "rate_limits", key, "used_percentage")
        if pct is None:
            continue
        resets = get(d, "rate_limits", key, "resets_at")
        out.append(item({"text": short},
                        {"meter": pct, "warn": 70, "bad": 90},
                        resets and {"countdown": resets, "prefix": "↻ ", "done": "reset"},
                        title=f"{name} limit: {pct:.1f}% used" + (f", resets {when(resets)}" if resets else "") +
                        (f", checked at {when(checked)}" if checked else "")))
    return out


def cache(d):
    """The prompt cache: warm or cold, the hit ratio and the time until it goes cold."""
    c = get(d, "prompt_cache")
    if not isinstance(c, dict):
        return None
    warm = bool(c.get("warm"))
    hit = c.get("hit_ratio")
    expires = c.get("expires_at")
    if warm and expires:
        left = {"countdown": expires, "done": "cold"}
    else:
        left = not warm and {"text": "cold", "style": "muted"}
    return item({"dot": "good" if warm else "muted"},
                {"text": "Cache"},
                hit is not None and {"text": f"{hit:.0%}", "style": "strong"},
                left,
                title="Prompt cache " + ("warm" if warm else "cold") + (f", TTL {c['ttl']}" if c.get("ttl") else "") +
                (f", hit ratio {hit:.0%}" if hit is not None else "") +
                (f", goes cold at {when(expires)}" if warm and expires else ""))


def cost(d):
    """The session cost; the session time and the time of waiting for the API are in the tooltip."""
    usd = get(d, "cost", "total_cost_usd")
    if usd is None:
        return None
    dur, api = get(d, "cost", "total_duration_ms"), get(d, "cost", "total_api_duration_ms")
    return item({"text": f"${usd:.2f}", "style": "strong"},
                title="Session cost at list price" + (f" · session time {span(dur)}" if dur else "") +
                (f" · waiting for the API {span(api)}" if api else ""))


def lines(d):
    """Lines of code added and removed in the session."""
    added = get(d, "cost", "total_lines_added") or 0
    removed = get(d, "cost", "total_lines_removed") or 0
    if not added and not removed:
        return None
    return item({"text": f"+{added}", "style": "good"}, {"text": f"−{removed}", "style": "bad"},
                title="Lines of code changed in the session")


def pull_request(d):
    """The open pull request; its review state is in the tooltip."""
    pr = get(d, "pr")
    if not isinstance(pr, dict) or not pr.get("number"):
        return None
    state = (pr.get("review_state") or "").replace("_", " ")
    return item({"link": f"PR #{pr['number']}", "href": pr.get("url") or ""},
                title="Open pull request" + (f": {state}" if state else ""))


def place(d):
    """The repository, and without it the working directory: the item takes the
    free space of the line, is cut first and pushes the next items to the right."""
    cwd = get(d, "workspace", "current_dir") or get(d, "cwd") or ""
    home = os.path.expanduser("~")
    if cwd == home or cwd.startswith(home + os.sep):
        cwd = "~" + cwd[len(home):]
    repo = get(d, "workspace", "repo") or {}
    if repo.get("owner") and repo.get("name"):
        path = f"{repo['owner']}/{repo['name']}"
        block = {"link": path, "href": f"https://{repo['host']}/{path}" if repo.get("host") else "", "style": "mono"}
    else:
        block = {"text": cwd, "style": "mono"}
    return item(block, title=f"Working directory: {cwd}" if cwd else None, fill=True)


def age(d):
    """How long ago the bar changed; the tooltip says where the data come from — the status
    line or the session transcript — and when they changed."""
    source = "the session transcript" if get(d, "live_comments", "source") == "transcript" else "the status line"
    at = get(d, "live_comments", "at")
    return item({"age": True}, title=f"Data from {source}" + (f", changed at {when(at)}" if at else ""))


def bar(d):
    """Returns the bar for the status line JSON d: the items from left to right."""
    items = [model(d), context(d), *limits(d), cache(d), cost(d), lines(d), pull_request(d), place(d), age(d)]
    return {"items": [it for it in items if it]}


if __name__ == "__main__":
    print(json.dumps(bar(json.load(sys.stdin)), ensure_ascii=False))
