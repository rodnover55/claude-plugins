---
name: statusline
description: "Set up or remove the live-comments line in the Claude Code status line: “[open topics] <session page link> ⧉”, where a click on ⧉ copies the link. Adds the line to the user's existing status line, or makes it the status line if there is none, and installs the handler of lc-copy: links for the ⧉ icon on Linux or macOS. Use when the user asks to show the live-comments discussion in the status line, to set up or remove that line, or invokes /live-comments:statusline."
argument-hint: "[remove]"
allowed-tools:
  - Bash(sh ${CLAUDE_SKILL_DIR}/linux/install-copy-handler.sh)
  - Bash(sh ${CLAUDE_SKILL_DIR}/macos/install-copy-handler.sh)
---

# live-comments status line

While the session has a discussion on the live-comments server (see the `live-comments` skill), the status line shows one more line:

```
[2] http://127.0.0.1:8765/<session id> ⧉
```

The number is the count of open topics of the discussion. Ctrl+click (Cmd+click on macOS) on ⧉ copies the link to the clipboard and shows a “Link copied” notification. Without a discussion the line is absent.

## How it works

- Claude Code runs the status line command on every update and passes it the session JSON on stdin; the JSON has `session_id`.
- `live-comments-line.py` reads this JSON, requests `http://127.0.0.1:8765/api/<session_id>/state` with a 0.3-second timeout and prints the line; without a discussion or a server it prints nothing. With `--copy` the line ends with ⧉: an OSC 8 terminal link `lc-copy:<session page link>`.
- A click on the link makes the terminal hand `lc-copy:<link>` to the system handler of the `lc-copy` scheme. The handler copies `<link>` to the clipboard; it ignores links that do not start with `http://127.0.0.1:8765/`.
- The handler differs by system:
  - **Linux**: the script `linux/lc-copy`, registered for `x-scheme-handler/lc-copy` by a `.desktop` file; it copies with `wl-copy` on Wayland, otherwise `xclip` or `xsel`, and notifies with `notify-send`.
  - **macOS**: the applet `LiveCommentsCopy.app` compiled from `macos/lc-copy.applescript` and registered for the `lc-copy` URL scheme; it copies with `set the clipboard` and notifies with `display notification`.

## Requirements

- `python3` on `PATH` of the status line command.
- A terminal with OSC 8 links for the click on ⧉: iTerm2, kitty, WezTerm, Ghostty and others. macOS Terminal.app does not support them: there the ⧉ icon is shown but is not clickable, so set the line up without `--copy`.
- **Linux**: `xdg-mime` (xdg-utils); `wl-copy` (wl-clipboard) on Wayland, or `xclip` or `xsel` on X11; `notify-send` is optional.
- **macOS**: nothing extra: `osacompile`, `plutil`, `codesign` and `lsregister` come with the system.

## Setup

Files go to `~/.local/share/live-comments/` (`$XDG_DATA_HOME/live-comments/` when `XDG_DATA_HOME` is set), the data directory of the live-comments server. They are copied there because the skill directory changes with every plugin update.

1. **Copy the line script:**
   `mkdir -p ~/.local/share/live-comments && cp ${CLAUDE_SKILL_DIR}/live-comments-line.py ~/.local/share/live-comments/`
2. **Install the copy handler** for the current system (`uname`):
   - Linux: `sh ${CLAUDE_SKILL_DIR}/linux/install-copy-handler.sh`
   - macOS: `sh ${CLAUDE_SKILL_DIR}/macos/install-copy-handler.sh`

   If the script fails because a requirement is missing, tell the user what to install, and set the line up without `--copy` if they do not want to install it. On Linux the script prints the previous default handler of `lc-copy:` links, if there was one: tell the user about it.
3. **Add the line to the status line.** Read `statusLine` in `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR/settings.json` when `CLAUDE_CONFIG_DIR` is set). The line script needs the same JSON input as the status line command, and its output goes on a new line below the existing status line.
   - **No `statusLine`**: set
     `"statusLine": {"type": "command", "command": "python3 <data directory>/live-comments/live-comments-line.py --copy"}`
     with the absolute path.
   - **`command` runs a script file**: add the line at the end of the script. The script has to keep its stdin to pass it on; for example, a Bash script that starts with `input=$(cat)` gets:
     ```bash
     lc_line=$(printf '%s' "$input" | python3 "$HOME/.local/share/live-comments/live-comments-line.py" --copy)
     [ -n "$lc_line" ] && printf '\n%s' "$lc_line"
     ```
     For a script in another language, call the line script the same way: pass the JSON input on stdin and print its output on a new line when it is not empty.
   - **`command` is an inline command**: move it into a new script `~/.claude/statusline-command.sh` that saves stdin in `input`, runs the old command with `printf '%s' "$input" | …`, and then adds the line as above; make the script the `command`. Keep the other `statusLine` fields, such as `padding`.
4. **Check** the line script with this session's id:
   `printf '{"session_id":"%s"}' "${CLAUDE_SESSION_ID}" | python3 ~/.local/share/live-comments/live-comments-line.py --copy`
   It prints the line if this session has a discussion (`/live-comments`); otherwise its output is empty, which is correct too.
5. Tell the user what was changed and that the click on ⧉ needs a terminal with OSC 8 links. If ⧉ is shown but not clickable, Claude Code may not have detected link support in the terminal: start it with `FORCE_HYPERLINK=1 claude`.

## Removal

When the user asks to remove the line (the argument `remove`):
1. Undo step 3: remove the line call from the status line script, restore the previous inline command, or remove `statusLine` if it consisted only of the line script.
2. Remove the copy handler:
   - Linux: `rm -f ~/.local/share/applications/live-comments-copy.desktop ~/.local/share/live-comments/lc-copy`, then `update-desktop-database ~/.local/share/applications` if it is installed. If another handler of `lc-copy:` links was the default before, restore it: `xdg-mime default <its .desktop file> x-scheme-handler/lc-copy`.
   - macOS: `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u ~/.local/share/live-comments/LiveCommentsCopy.app && rm -rf ~/.local/share/live-comments/LiveCommentsCopy.app`
3. Remove `~/.local/share/live-comments/live-comments-line.py`. Do not remove the rest of `~/.local/share/live-comments/`: it holds the discussions of the server.
