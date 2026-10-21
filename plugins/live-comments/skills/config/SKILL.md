---
name: config
description: "Change the look of the live-comments discussion pages at the user's request in free text, such as “поменяй моноширинный шрифт на Terminus”, “сделай акцент зелёным” or “всегда тёмная тема”: the fonts — the font of the text and the monospace font of code, the changes page and the status bar — and the color theme — the colors of the palette in the light and the dark scheme and the scheme the pages always use. A font is either installed in the system or embedded from a .ttf, .otf, .woff or .woff2 file that the live-comments server hands to the pages. The settings and the font files stay in the user's own directories, outside the plugin. Use when the user asks to change, show or reset the fonts, colors or theme of the discussion pages, or invokes /live-comments:config."
argument-hint: "[what to change, in free text]"
allowed-tools:
  - Bash(python3 ${CLAUDE_SKILL_DIR}/config.py *)
---

# Settings of the live-comments pages

The argument is the user's request in free text: what to show, change or reset. From it, take what the request is about — the fonts, the theme or both — and follow the sections below. Without an argument, show the settings and ask what to change.

The settings are the user's own files in `~/.config/live-comments/` (`$XDG_CONFIG_HOME/live-comments/` when `XDG_CONFIG_HOME` is set), not part of the plugin; never put them in the plugin or a repository. The pages take the settings when loaded: after a change, the open pages need a reload.

`CONFIG` below is `python3 ${CLAUDE_SKILL_DIR}/config.py`:
- `CONFIG` — the fonts and the theme;
- `CONFIG font set ROLE FAMILY [--file FILE]` — the font of a role; with `--file` the file is checked and copied;
- `CONFIG font reset [ROLE]` — the default font of a role, of all roles without `ROLE`;
- `CONFIG font find NAME` — installed fonts and font files whose name contains `NAME`;
- `CONFIG theme set NAME=COLOR... [--light | --dark]` — colors of the palette in both schemes, or only in the light or the dark one;
- `CONFIG theme scheme auto|light|dark` — the scheme of the pages; `auto` follows the system;
- `CONFIG theme reset [NAME...]` — the default colors `NAME`; without `NAME`, all colors and the scheme.

After every command, tell the user what the settings now are, from its output, and that the open pages show them after a reload. If the output says the server is an older version, the server has to be restarted: `python3 <live-comments skill directory>/cm.py stop`, then `/live-comments` again.

## Fonts

The pages draw text with two fonts — **roles**:
- `text` — the text of the pages and their controls; default `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
- `mono` — monospace text: code in messages, the changes page, paths, the values of the status bar; default `ui-monospace, Menlo, Consolas, monospace`.

The user's font of a role goes before the default fonts of the role: when the font is not available, the pages fall back to them.

- **Settings** — `~/.config/live-comments/fonts.json`:
  ```json
  {"mono": {"family": "Terminus", "file": "TerminusTTF-4.49.3.ttf"}, "text": {"family": "Inter"}}
  ```
- **Font files** — copies in `~/.local/share/live-comments/fonts/` (`$XDG_DATA_HOME/live-comments/fonts/`); `file` is the name of the copy. The server hands the file of a role to the pages, so the font works without installing it in the system, also on the HTML pages with comments.

Changing a font:
1. **The role** from the request: “моноширинный”, “код”, “diff” — `mono`; “основной”, “текст”, “интерфейс” — `text`; “все шрифты” — both. If it is not clear, ask.
2. **Find the font**: `CONFIG font find <name>`.
   - The user gave a file — use it.
   - A file of the font is found — use it: an embedded font looks the same in every browser. Of several files take the regular one (not bold or italic), `.woff2` before `.ttf` and `.otf`.
   - Only an installed font is found — use its family name exactly as `find` prints it, without `--file`.
   - Nothing is found — say so. Offer to download the font from its official site, and download it only after the user agrees: into a new empty directory under `~/.local/share/live-comments/download/`, unpacking an archive there, then `--file` with the regular font from it, then remove the download directory. For Terminus it is Terminus TTF, https://files.ax86.net/terminus-ttf/ (SIL Open Font License). Browsers do not read bitmap fonts (`.pcf`, `.bdf`, `.psf`, `.otb`): only `.ttf`, `.otf`, `.woff`, `.woff2`.
3. **Set it**: `CONFIG font set <role> "<family>" [--file <file>]`. With a file, the family is only its name on the pages: take the font's name, such as `Terminus`.

Reset (“верни шрифт по умолчанию”): `CONFIG font reset [ROLE]`; the copies of font files no role uses are removed.

## Theme

The pages paint with a palette of named colors; each color has a value in the light scheme and in the dark one, and the pages use the scheme of the system unless the theme forces one. `CONFIG` prints every color, what it paints and its values.

- **Settings** — `~/.config/live-comments/theme.json`; only the colors the user changed are kept:
  ```json
  {"scheme": "dark", "light": {"accent": "#16a34a"}, "dark": {"accent": "#4ade80"}}
  ```
- The theme applies to the discussion pages, the changes page and the comment controls on the HTML pages with comments; it does not change the HTML pages themselves.

Changing the theme:
1. **Run `CONFIG`** and take from the request the colors it is about by what they paint: “акцент”, “ссылки”, “кнопки” — `accent`; “фон” — `bg`, and `card` when the cards should follow; “вопросы пользователя” — `user`; “добавленные/удалённые строки” — `add`/`del`. A request about the whole look (“тема в стиле Solarized”, “контрастнее”) changes as many colors as it needs.
2. **Choose the values.** A value is a CSS color: `#rgb`, `#rrggbb`, `rgba(...)`, `hsl(...)`, `oklch(...)` or a color name. Keep the text readable on its background in each scheme it is set for: a color given for one scheme only (“в тёмной теме”) goes with `--dark` or `--light`; a color for both schemes gets a matching pair — set the light and the dark value separately when one value does not suit both. Keep `accent-soft`, `add`, `del` and `hl*` translucent or pale, as the defaults are. If the request does not say which color or how, propose the values and ask.
3. **Set them**: `CONFIG theme set accent=#16a34a accent-soft=rgba(22,163,74,.12) --light`, then the same for `--dark`, or one call without a flag for both schemes.
4. **Scheme**: “всегда тёмная” — `CONFIG theme scheme dark`, “всегда светлая” — `light`, “как в системе” — `auto`.

Reset (“верни цвета по умолчанию”): `CONFIG theme reset [NAME...]`.
