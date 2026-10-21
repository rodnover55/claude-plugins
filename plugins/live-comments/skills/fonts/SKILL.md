---
name: fonts
description: "Change the fonts of the live-comments discussion pages at the user's request, such as “поменяй моноширинный шрифт на Terminus”: the font of the text and the monospace font of code, the changes page and the status bar. A font is either installed in the system or embedded from a .ttf, .otf, .woff or .woff2 file that the live-comments server hands to the pages. The settings and the font files stay in the user's own directories, outside the plugin. Use when the user asks to change, show or reset the fonts of the discussion pages, or invokes /live-comments:fonts."
argument-hint: "[what to change | reset]"
allowed-tools:
  - Bash(python3 ${CLAUDE_SKILL_DIR}/fonts.py *)
---

# Fonts of the live-comments pages

The discussion pages draw text with two fonts — **roles**:
- `text` — the text of the pages and their controls; default `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
- `mono` — monospace text: code in messages, the changes page, paths, the values of the status bar; default `ui-monospace, Menlo, Consolas, monospace`.

The user's font of a role goes before the default fonts of the role: when the font is not available, the pages fall back to them.

- **Settings** — `~/.config/live-comments/fonts.json` (`$XDG_CONFIG_HOME/live-comments/` when `XDG_CONFIG_HOME` is set), the user's own file, not part of the plugin:
  ```json
  {"mono": {"family": "Terminus", "file": "TerminusTTF-4.49.3.ttf"}, "text": {"family": "Inter"}}
  ```
- **Font files** — copies in `~/.local/share/live-comments/fonts/` (`$XDG_DATA_HOME/live-comments/fonts/`); `file` is the name of the copy. The server hands the file of a role to the pages, so the font works without installing it in the system, also on the HTML pages with comments.
- The pages take the fonts when loaded: after a change, the open pages need a reload.

`FONTS` below is `python3 ${CLAUDE_SKILL_DIR}/fonts.py`:
- `FONTS` — the fonts of the roles and whether each is found;
- `FONTS set ROLE FAMILY [--file FILE]` — the font of a role; with `--file` the file is checked and copied;
- `FONTS reset [ROLE]` — the default font of a role, of all roles without `ROLE`;
- `FONTS find NAME` — installed fonts and font files whose name contains `NAME`.

## Changing a font

1. **The role** from the request: “моноширинный”, “код”, “diff” — `mono`; “основной”, “текст”, “интерфейс” — `text`; “все шрифты” — both. If it is not clear, ask.
2. **Find the font**: `FONTS find <name>`.
   - The user gave a file — use it.
   - A file of the font is found — use it: an embedded font looks the same in every browser. Of several files take the regular one (not bold or italic), `.woff2` before `.ttf` and `.otf`.
   - Only an installed font is found — use its family name exactly as `find` prints it, without `--file`.
   - Nothing is found — say so. Offer to download the font from its official site, and download it only after the user agrees: into a new empty directory under `~/.local/share/live-comments/download/`, unpacking an archive there, then `--file` with the regular font from it, then remove the download directory. For Terminus it is Terminus TTF, https://files.ax86.net/terminus-ttf/ (SIL Open Font License). Browsers do not read bitmap fonts (`.pcf`, `.bdf`, `.psf`, `.otb`): only `.ttf`, `.otf`, `.woff`, `.woff2`.
3. **Set it**: `FONTS set <role> "<family>" [--file <file>]`. With a file, the family is only its name on the pages: take the font's name, such as `Terminus`.
4. Tell the user which font each role now has, from the output of the command, and that the open pages show it after a reload. If the output says the server is an older version, the server has to be restarted for the fonts: `python3 <live-comments skill directory>/cm.py stop`, then `/live-comments` again.

## Showing and reset

- “какие шрифты” — run `FONTS` and tell the user the font of each role.
- **Reset** (the argument `reset`, or “верни шрифт по умолчанию”): `FONTS reset [ROLE]`; the copies of font files no role uses are removed.
