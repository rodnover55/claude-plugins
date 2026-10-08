---
name: statusbar
description: "Prepare or change the status bar at the bottom of the live-comments discussion pages. The bar is described by the user's own file ~/.config/live-comments/statusbar.py (Python) or statusbar.js (JavaScript), kept outside the plugin: it turns the Claude Code status line data into items made of the standard blocks of the pages — text, chip, meter, dot, link, countdown, age. The skill creates the file from the plugin's default bar, changes it at the user's request, switches its language, resets or removes it, and checks it. Use when the user asks to set up, change or customize the status bar of the discussion pages, or invokes /live-comments:statusbar."
argument-hint: "[what to change | python | js | reset | remove]"
allowed-tools:
  - Bash(python3 ${CLAUDE_SKILL_DIR}/check.py *)
---

# live-comments status bar

The status bar is a line at the bottom of every discussion page of the session: by default the model and reasoning effort, the context window and the rate limits with meters, the prompt cache, the cost, changed lines, the pull request and the repository.

- **The user's file** — `~/.config/live-comments/statusbar.py` in Python or `~/.config/live-comments/statusbar.js` in JavaScript (`$XDG_CONFIG_HOME/live-comments/` when `XDG_CONFIG_HOME` is set). If both are there, `statusbar.py` is used. The file belongs to the user and is not part of the plugin. The plugin ships only the default bar as an example: `${CLAUDE_SKILL_DIR}/statusbar.py` and `${CLAUDE_SKILL_DIR}/statusbar.js` draw the same bar.
- **The protocol** — `${CLAUDE_SKILL_DIR}/protocol.md`. The file reads a status line JSON of the session on stdin and prints `{"items": [...]}`; every item is made of the standard blocks of the protocol — `text`, `chip`, `meter`, `dot`, `link`, `countdown`, `age` — with its styles. The pages draw nothing else.
- **How the bar reaches the pages**: while a discussion page of the session is open, the live-comments server runs the file once a minute, the first time at once, and the pages redraw the bar without a reload. Without the file the pages hide the bar; if the file fails or runs longer than 1 second, they keep the previous bar.
- **The input**: by default the server builds the JSON from the session transcript — without the cost, the durations and the pull request — and gets the 5-hour and 7-day rate limits with a small background `claude -p` request at most once in 5 minutes. Custom data sent to `POST http://127.0.0.1:8765/api/<session id>/statusline` — such as the cost and the pull request from the status line JSON of Claude Code, or fields of the user's own — are added where the server computes no such field; each send updates only its own fields (see the protocol).

`CHECK` below is `python3 ${CLAUDE_SKILL_DIR}/check.py`: it runs the user's file the way the server does, on a sample of the status line JSON with all fields, checks the output against the protocol and prints the bar as text with the tooltips of its items, or the errors. `CHECK <file>` checks another file.

## Preparing the file

1. **Choose the language**: Python by default; JavaScript if the user asks for it (the argument `js`). JavaScript needs `node` on `PATH` of the live-comments server: check `command -v node`.
2. **Create the file** if neither `statusbar.py` nor `statusbar.js` exists:
   `mkdir -p ~/.config/live-comments && cp ${CLAUDE_SKILL_DIR}/statusbar.py ~/.config/live-comments/` (or `statusbar.js`).
   Do not overwrite an existing file: it may hold the user's changes.
3. **Check** with `CHECK` and fix the errors.
4. Tell the user the path of the file and show the bar from the output of `CHECK`. The open pages show it within a minute.

## Changing the bar

When the user asks to change the bar — add, remove or reorder items, change their labels, thresholds, colors or tooltips, show other data:
1. Read `${CLAUDE_SKILL_DIR}/protocol.md` and the user's file. If there is no file, prepare it first (see “Preparing the file”).
2. Change the user's file, never the default in the plugin. Build the items only from the blocks and styles of the protocol.
   - The data come from the status line JSON; its fields are listed in [the status line docs](https://code.claude.com/docs/en/statusline#available-data). Data that the JSON lacks, such as the git branch, the file may get by itself, as long as the whole file finishes well within 1 second.
   - The cost, the durations and the pull request are only in the status line JSON of Claude Code. If the user wants them, their status line script has to send that JSON to the server: add the `curl` line from the protocol to it. Other programs can send fields of their own the same way; the fields the server computes can't be changed by sending.
   - The pages recount `countdown` and `age` by themselves; for a time that has to stay current between updates, use them rather than a formatted text.
3. If a wish cannot be built from the standard blocks — a new kind of element, other colors or layout — say so and offer the closest combination of blocks. New blocks are added only in the plugin: to the protocol, to the pages and to `check.py`.
4. Run `CHECK` and fix the errors until it passes.
5. Say what changed and show the bar from the output of `CHECK`. The open pages show the new bar within a minute.

## Language, reset and removal

These change or replace the user's own file: rename the old file to `<name>.bak` instead of deleting it.
- **Switch the language** (the argument `python` or `js`): write the same bar in the other language — the user's bar, with the user's changes — into the new file, check it with `CHECK`, then rename the old file to `.bak`. While `statusbar.py` exists, `statusbar.js` is not used.
- **Reset** (the argument `reset`): after the user confirms, rename the user's file to `.bak` and copy the default in the same language, then run `CHECK`.
- **Remove** (the argument `remove`): after the user confirms, rename the user's file to `.bak`. The open pages hide the bar within a minute.
