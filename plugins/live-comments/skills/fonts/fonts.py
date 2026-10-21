#!/usr/bin/env python3
"""Fonts of the live-comments discussion pages.

The user's file ~/.config/live-comments/fonts.json ($XDG_CONFIG_HOME when
set) gives each font role the family put before the default fonts of the
role, and optionally a font file that the server hands to the pages:

    {"mono": {"family": "Terminus", "file": "TerminusTTF-4.49.3.ttf"},
     "text": {"family": "Inter"}}

Roles: text — the text of the pages and their controls; mono — monospace
text: code in messages, the changes page, paths and the status bar values.
Font files are copied to ~/.local/share/live-comments/fonts ($XDG_DATA_HOME
when set); "file" is the name of the copy there.

    fonts.py [show]                       the fonts of the roles and whether
                                          each is found
    fonts.py set ROLE FAMILY [--file F]   set the font of ROLE; F — a .ttf,
                                          .otf, .woff or .woff2 file to embed
    fonts.py reset [ROLE]                 the default font of ROLE, of all
                                          roles without ROLE
    fonts.py find NAME                    installed fonts and font files
                                          whose name contains NAME
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

CONFIG = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "live-comments" / "fonts.json"
FONTS_DIR = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "live-comments" / "fonts"
ROLES = {"text": "the text of the pages and their controls",
         "mono": "monospace text: code, the changes page, paths, status bar values"}
DEFAULTS = {"text": 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
            "mono": "ui-monospace, Menlo, Consolas, monospace"}
# The first bytes of each font format the browsers read.
MAGIC = {".ttf": (b"\x00\x01\x00\x00", b"true"), ".otf": (b"OTTO", b"\x00\x01\x00\x00"),
         ".woff": (b"wOFF",), ".woff2": (b"wOF2",)}
FAMILY = re.compile(r'^[^"\\;{}<>\n\r]{1,80}$')
SEARCH_DIRS = ["~/.local/share/fonts", "~/.fonts", "~/Library/Fonts", "~/Downloads",
               "/usr/share/fonts", "/usr/local/share/fonts", "/Library/Fonts", "/System/Library/Fonts"]
SERVER = "http://127.0.0.1:8765"


def load():
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except ValueError as e:
        raise SystemExit(f"{CONFIG}: not JSON: {e}")
    return cfg if isinstance(cfg, dict) else {}


def save(cfg):
    """Writes the settings, removes the file without settings and the copies
    of font files no role uses."""
    if cfg:
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    elif CONFIG.exists():
        CONFIG.unlink()
    used = {f.get("file") for f in cfg.values() if isinstance(f, dict)}
    if FONTS_DIR.is_dir():
        for p in FONTS_DIR.iterdir():
            if p.is_file() and p.name not in used:
                p.unlink()


def installed(name):
    """Returns the installed font families whose name contains name, or None
    when fc-list is absent."""
    if not shutil.which("fc-list"):
        return None
    out = subprocess.run(["fc-list", ":", "family"], capture_output=True, text=True).stdout
    families = {fam.strip() for line in out.splitlines() for fam in line.split(",")}
    return sorted(f for f in families if name.lower() in f.lower())


def font_files(name):
    """Returns the font files of the formats the browsers read whose file name
    contains name, without spaces, dashes and case."""
    key = re.sub(r"[\s_-]", "", name.lower())
    found = []
    for d in SEARCH_DIRS:
        root = Path(d).expanduser()
        if not root.is_dir():
            continue
        for p in root.rglob("*"):
            if p.suffix.lower() in MAGIC and key in re.sub(r"[\s_-]", "", p.name.lower()) and p.is_file():
                found.append(p)
    return found


def check_file(path):
    if path.suffix.lower() not in MAGIC:
        raise SystemExit(f"{path}: the browsers read only {', '.join(MAGIC)} fonts")
    try:
        head = path.open("rb").read(4)
    except OSError as e:
        raise SystemExit(f"{path}: {e.strerror}")
    if head not in MAGIC[path.suffix.lower()]:
        raise SystemExit(f"{path}: not a {path.suffix} font")


def served():
    """Returns /fonts.css of the running server, "" without the server and
    None for a server that has no fonts."""
    try:
        with urllib.request.urlopen(SERVER + "/fonts.css", timeout=1) as r:
            return r.read().decode("utf-8")
    except urllib.error.HTTPError:
        return None
    except OSError:
        return ""


def cmd_show(_):
    cfg = load()
    print(f"settings: {CONFIG}{'' if CONFIG.exists() else ' (none)'}")
    for role, what in ROLES.items():
        f = cfg.get(role)
        print(f"{role} — {what}")
        if not isinstance(f, dict) or not f.get("family"):
            print(f"  default: {DEFAULTS[role]}")
            continue
        family = f["family"]
        if f.get("file"):
            path = FONTS_DIR / f["file"]
            state = f"embedded from {path}" if path.is_file() else f"file {path} is missing: the installed font is used"
        else:
            fams = installed(family)
            state = ("fc-list is absent: cannot check whether it is installed" if fams is None
                     else "installed" if family.lower() in (x.lower() for x in fams)
                     else "not installed: the pages fall back to the default")
        print(f"  {family} ({state}), then {DEFAULTS[role]}")
    if served() is None:
        print("the running server is an older version without fonts: restart it")


def cmd_set(args):
    if not FAMILY.match(args.family):
        raise SystemExit('FAMILY: 1–80 characters without " \\ ; { } < > and line breaks')
    font = {"family": args.family}
    if args.file:
        src = Path(args.file).expanduser().resolve()
        check_file(src)
        FONTS_DIR.mkdir(parents=True, exist_ok=True)
        if src.parent != FONTS_DIR.resolve():
            shutil.copyfile(src, FONTS_DIR / src.name)
        font["file"] = src.name
    else:
        fams = installed(args.family)
        if fams is not None and args.family.lower() not in (x.lower() for x in fams):
            print(f"warning: {args.family} is not installed" +
                  (f"; similar: {', '.join(fams)}" if fams else "") +
                  "; give its file with --file, or the pages fall back to the default")
    cfg = load()
    cfg[args.role] = font
    save(cfg)
    cmd_show(args)


def cmd_reset(args):
    cfg = load()
    for role in [args.role] if args.role else list(ROLES):
        cfg.pop(role, None)
    save(cfg)
    cmd_show(args)


def cmd_find(args):
    fams = installed(args.name)
    if fams is None:
        print("installed: fc-list is absent")
    else:
        print("installed: " + (", ".join(fams) or "none"))
    files = font_files(args.name)
    print("files:" + ("" if files else " none"))
    for p in files:
        print(f"  {p}")


def main():
    ap = argparse.ArgumentParser(description="Fonts of the live-comments discussion pages")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("show")
    sp = sub.add_parser("set")
    sp.add_argument("role", choices=list(ROLES))
    sp.add_argument("family")
    sp.add_argument("--file")
    sp = sub.add_parser("reset")
    sp.add_argument("role", nargs="?", choices=list(ROLES))
    sp = sub.add_parser("find")
    sp.add_argument("name")
    args = ap.parse_args()
    {"show": cmd_show, None: cmd_show, "set": cmd_set, "reset": cmd_reset, "find": cmd_find}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
