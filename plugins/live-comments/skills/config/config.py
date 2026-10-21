#!/usr/bin/env python3
"""Settings of the live-comments discussion pages: fonts and the color theme.

Fonts. The user's file ~/.config/live-comments/fonts.json ($XDG_CONFIG_HOME
when set) gives each font role the family put before the default fonts of the
role, and optionally a font file that the server hands to the pages:

    {"mono": {"family": "Terminus", "file": "TerminusTTF-4.49.3.ttf"},
     "text": {"family": "Inter"}}

Roles: text — the text of the pages and their controls; mono — monospace
text: code in messages, the changes page, paths and the status bar values.
Font files are copied to ~/.local/share/live-comments/fonts ($XDG_DATA_HOME
when set); "file" is the name of the copy there.

Theme. The user's file ~/.config/live-comments/theme.json gives the colors of
the palette in the light and the dark scheme, and the scheme the pages always
use instead of the system one:

    {"scheme": "dark", "light": {"accent": "#16a34a"}, "dark": {"accent": "#4ade80"}}

    config.py [show]                      the fonts and the theme
    config.py font set ROLE FAMILY [--file F]
                                          set the font of ROLE; F — a .ttf,
                                          .otf, .woff or .woff2 file to embed
    config.py font reset [ROLE]           the default font of ROLE, of all
                                          roles without ROLE
    config.py font find NAME              installed fonts and font files
                                          whose name contains NAME
    config.py theme set NAME=COLOR... [--light | --dark]
                                          set colors of the palette in both
                                          schemes, or only in one
    config.py theme scheme auto|light|dark
                                          the scheme of the pages; auto — the
                                          one of the system
    config.py theme reset [NAME...]       the default colors NAME, all colors
                                          and the scheme without NAME
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

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "live-comments"
FONTS_FILE = CONFIG_DIR / "fonts.json"
THEME_FILE = CONFIG_DIR / "theme.json"
FONTS_DIR = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "live-comments" / "fonts"
ROLES = {"text": "the text of the pages and their controls",
         "mono": "monospace text: code, the changes page, paths, status bar values"}
DEFAULTS = {"text": 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
            "mono": "ui-monospace, Menlo, Consolas, monospace"}
# The colors of the palette: what each one paints, its default light and dark value.
COLORS = {
    "bg": ("the background of the pages", "#f6f7f9", "#0f1115"),
    "card": ("cards, messages, menus, the status bar", "#fff", "#171a21"),
    "text": ("text", "#1f2328", "#e6e9ef"),
    "muted": ("secondary text, hints", "#5f6b7a", "#9aa4b2"),
    "line": ("borders and separators", "#d9dee5", "#2a303b"),
    "accent": ("links, main buttons, Claude's messages, focus", "#2563eb", "#60a5fa"),
    "accent-soft": ("the background of inline code and selections", "rgba(37,99,235,.12)", "rgba(96,165,250,.14)"),
    "bad": ("errors, revert, removed files", "#c2410c", "#fb923c"),
    "good": ("decisions, resolved topics, stage, added files", "#15803d", "#4ade80"),
    "warn": ("warnings, modified files, question counters", "#b45309", "#facc15"),
    "user": ("the user's questions: their bars, quotes and fragment underlines", "#f59e0b", "#f59e0b"),
    "on-accent": ("text on accent, good, bad and warn fills", "#fff", "#fff"),
    "add": ("the background of added lines of the changes page", "rgba(34,197,94,.15)", "rgba(34,197,94,.15)"),
    "del": ("the background of removed lines of the changes page", "rgba(239,68,68,.14)", "rgba(239,68,68,.14)"),
    "hl": ("fragments with a question on the HTML pages", "#fde68a", "rgba(250,204,21,.3)"),
    "hl-answered": ("answered fragments on the HTML pages", "#dbeafe", "rgba(96,165,250,.22)"),
    "hl-resolved": ("resolved fragments on the HTML pages", "#dcfce7", "rgba(74,222,128,.18)"),
}
SCHEMES = ("auto", "light", "dark")
# The first bytes of each font format the browsers read.
MAGIC = {".ttf": (b"\x00\x01\x00\x00", b"true"), ".otf": (b"OTTO", b"\x00\x01\x00\x00"),
         ".woff": (b"wOFF",), ".woff2": (b"wOF2",)}
FAMILY = re.compile(r'^[^"\\;{}<>\n\r]{1,80}$')
# The same check of a color as the server's.
COLOR = re.compile(r"^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,30}|[a-z-]{3,12}\([-\w\s.,%/#+]{1,120}\))$")
SEARCH_DIRS = ["~/.local/share/fonts", "~/.fonts", "~/Library/Fonts", "~/Downloads",
               "/usr/share/fonts", "/usr/local/share/fonts", "/Library/Fonts", "/System/Library/Fonts"]
SERVER = "http://127.0.0.1:8765"


def load(path):
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except ValueError as e:
        raise SystemExit(f"{path}: not JSON: {e}")
    return cfg if isinstance(cfg, dict) else {}


def save(path, cfg):
    """Writes the settings, removes the file without settings."""
    if cfg:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    elif path.exists():
        path.unlink()


def save_fonts(cfg):
    """Writes the font settings and removes the copies of font files no role
    uses."""
    save(FONTS_FILE, cfg)
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
    """Returns whether the running server hands the theme to the pages: None
    without the server."""
    try:
        with urllib.request.urlopen(SERVER + "/theme.css", timeout=1):
            return True
    except urllib.error.HTTPError:
        return False
    except OSError:
        return None


def show_fonts():
    cfg = load(FONTS_FILE)
    print(f"fonts: {FONTS_FILE}{'' if FONTS_FILE.exists() else ' (none)'}")
    for role, what in ROLES.items():
        f = cfg.get(role)
        print(f"  {role} — {what}")
        if not isinstance(f, dict) or not f.get("family"):
            print(f"    default: {DEFAULTS[role]}")
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
        print(f"    {family} ({state}), then {DEFAULTS[role]}")


def show_theme():
    cfg = load(THEME_FILE)
    print(f"theme: {THEME_FILE}{'' if THEME_FILE.exists() else ' (none)'}")
    print(f"  scheme: {cfg.get('scheme') if cfg.get('scheme') in SCHEMES else 'auto'}")
    light, dark = (cfg.get(s) if isinstance(cfg.get(s), dict) else {} for s in ("light", "dark"))
    for name, (what, dl, dd) in COLORS.items():
        values = [f"{s} {own[name]} (default {d})" if name in own else f"{s} {d}"
                  for s, own, d in (("light", light, dl), ("dark", dark, dd))]
        print(f"  {name} — {what}: {', '.join(values)}")


def show(_=None):
    show_fonts()
    show_theme()
    state = served()
    if state is False:
        print("the running server is an older version without the theme: restart it")


def cmd_font_set(args):
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
    cfg = load(FONTS_FILE)
    cfg[args.role] = font
    save_fonts(cfg)
    show()


def cmd_font_reset(args):
    cfg = load(FONTS_FILE)
    for role in [args.role] if args.role else list(ROLES):
        cfg.pop(role, None)
    save_fonts(cfg)
    show()


def cmd_font_find(args):
    fams = installed(args.name)
    if fams is None:
        print("installed: fc-list is absent")
    else:
        print("installed: " + (", ".join(fams) or "none"))
    files = font_files(args.name)
    print("files:" + ("" if files else " none"))
    for p in files:
        print(f"  {p}")


def cmd_theme_set(args):
    colors = {}
    for pair in args.colors:
        name, sep, value = pair.partition("=")
        name, value = name.strip(), value.strip()
        if not sep or name not in COLORS:
            raise SystemExit(f"{pair}: expected NAME=COLOR, NAME one of: {', '.join(COLORS)}")
        if not COLOR.match(value):
            raise SystemExit(f"{pair}: COLOR is a CSS color such as #16a34a, rgba(22,163,74,.2) or teal")
        colors[name] = value
    cfg = load(THEME_FILE)
    for scheme in [args.only] if args.only else ["light", "dark"]:
        own = cfg.get(scheme) if isinstance(cfg.get(scheme), dict) else {}
        own.update(colors)
        cfg[scheme] = own
    save(THEME_FILE, cfg)
    show()


def cmd_theme_scheme(args):
    cfg = load(THEME_FILE)
    if args.scheme == "auto":
        cfg.pop("scheme", None)
    else:
        cfg["scheme"] = args.scheme
    save(THEME_FILE, cfg)
    show()


def cmd_theme_reset(args):
    unknown = [n for n in args.names if n not in COLORS]
    if unknown:
        raise SystemExit(f"{', '.join(unknown)}: NAME is one of: {', '.join(COLORS)}")
    cfg = load(THEME_FILE) if args.names else {}
    for scheme in ("light", "dark"):
        own = cfg.get(scheme)
        if isinstance(own, dict):
            for name in args.names:
                own.pop(name, None)
            if not own:
                cfg.pop(scheme)
    save(THEME_FILE, cfg)
    show()


def main():
    ap = argparse.ArgumentParser(description="Settings of the live-comments discussion pages")
    sub = ap.add_subparsers(dest="what")
    sub.add_parser("show").set_defaults(run=show)

    font = sub.add_parser("font").add_subparsers(dest="cmd", required=True)
    sp = font.add_parser("set")
    sp.add_argument("role", choices=list(ROLES))
    sp.add_argument("family")
    sp.add_argument("--file")
    sp.set_defaults(run=cmd_font_set)
    sp = font.add_parser("reset")
    sp.add_argument("role", nargs="?", choices=list(ROLES))
    sp.set_defaults(run=cmd_font_reset)
    sp = font.add_parser("find")
    sp.add_argument("name")
    sp.set_defaults(run=cmd_font_find)

    theme = sub.add_parser("theme").add_subparsers(dest="cmd", required=True)
    sp = theme.add_parser("set")
    sp.add_argument("colors", nargs="+", metavar="NAME=COLOR")
    only = sp.add_mutually_exclusive_group()
    only.add_argument("--light", dest="only", action="store_const", const="light")
    only.add_argument("--dark", dest="only", action="store_const", const="dark")
    sp.set_defaults(run=cmd_theme_set)
    sp = theme.add_parser("scheme")
    sp.add_argument("scheme", choices=SCHEMES)
    sp.set_defaults(run=cmd_theme_scheme)
    sp = theme.add_parser("reset")
    sp.add_argument("names", nargs="*", metavar="NAME")
    sp.set_defaults(run=cmd_theme_reset)

    args = ap.parse_args()
    getattr(args, "run", show)(args)


if __name__ == "__main__":
    sys.exit(main())
