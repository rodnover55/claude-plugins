# Status bar of the discussion pages: internals

The status bar is the line at the bottom of every discussion page of a session: the session page, the topic pages and the changes page. The server draws it with the user's own bar file from a status line JSON of the session — a JSON with the field names of the one Claude Code passes to the status line command — built from the session transcript, with the custom fields sent to the server added. This document describes how the parts work together; the format of the bar is in [the protocol](../skills/statusbar/protocol.md), and the user instructions are in [the README](../../../README.md#status-bar-of-the-discussion-pages).

## Data flow

```
custom data, e.g. the user's status line (curl) ── POST /api/<session>/statusline ────────────┐
                                                                                              ▼
~/.claude/projects/*/<session>.jsonl ── read as it grows ─────────────────▶ statusfeed.Feed (cm.py server)
claude -p (≤ once in 5 min) ── rate_limit_event ──────────────────────────▶   │ picks the input JSON
                                                                              │ runs statusbar.py | statusbar.js
                                                                              ▼
                                                     Store.status[session] ── long poll /wait ──▶ app.js renderStatus()
```

The feed works only for sessions with an open discussion page: a page marks its long poll with `bar=1`, and a session counts as having a page for 40 seconds after such a poll began or ended. Once a minute for each such session — the first time at once after the server starts — the feed reads what was added to its transcripts, picks the input JSON and runs the bar file. A bar that differs from the last one goes to the pages.

## Parts

| File | Role |
| :- | :- |
| `skills/start/statusfeed.py` | The feed: the transcript reader, the JSON built from it, the rate limits with `claude -p`, the run of the bar file |
| `skills/start/cm.py` | The server: `POST /api/<session>/statusline`, the `bar=1` mark of `/wait`, `publish_bar`, the `status` field of the session state |
| `~/.config/live-comments/statusbar.py` or `statusbar.js` | The user's bar file: a status line JSON in, the bar out. Not part of the plugin |
| `skills/statusbar/statusbar.py`, `statusbar.js` | The default bar in Python and in JavaScript; the `statusbar` skill copies one of them as the user's file |
| `skills/statusbar/protocol.md` | The input and the format of the bar: items, blocks, styles |
| `skills/statusbar/check.py` | Runs a bar file on a sample input, validates the output against the protocol and prints the bar as text |
| `skills/statusbar/SKILL.md` | Instructions for Claude: prepare, change, switch the language of, reset and remove the user's file |
| `skills/start/app.js`, `app.css` | The pages: `renderStatus`, `sbBlock`, `sbStyle`, `onlyStatus`; the look `.lc-sbar`, `.lc-sb-*` |

## The input

The bar file always gets a status line JSON with the field names of Claude Code, built from the transcript, with the custom fields added. The extra field `live_comments` says when its data changed: `at` — the time of the latest transcript entry, `custom_at` — the time of the last send of custom data.

**Custom data.** Any program on the machine can send a JSON object of at most 64 KB with `POST /api/<session>/statusline`; requests from other sites in a browser are refused by the `Host` and `Origin` checks. The feed keeps the sent fields of each session as leaves — paths of keys with their values and the time of their last send: each send replaces the leaves it contains, and a leaf and leaves inside it can't both be. When it builds the JSON, it puts a leaf where the JSON from the transcript has no field at its path. Leaves inside the fields the server computes (`COMPUTED`: the fields from the transcript in the table below, `rate_limits`, `live_comments`) are dropped when sent, even while the server has no value there yet. A leaf drops when its last send is more than 10 minutes older than the last change of the transcript. The standard `live-comments-line.py` sends nothing; a user who wants the cost, the durations or the pull request on the bar adds one `curl` line to their status line script (see the protocol), which sends the JSON Claude Code passes to the status line command: of it, only the fields the server lacks are added.

**From the transcript.** `Transcript` reads `~/.claude/projects/*/<session>.jsonl` (`$CLAUDE_CONFIG_DIR/projects/` when set) and the subagent transcripts in `<session>/subagents/` as they grow, and keeps:

| Field of the JSON | Taken from |
| :- | :- |
| `model`, `version`, `effort.level`, `cwd`, `workspace.current_dir` | the last assistant entry of the main chain; `display_name` is made from the model id: `claude-opus-5-5` → `Opus 5.5` |
| `workspace.project_dir` | the first `cwd` of the transcript |
| `workspace.repo` | `git remote get-url origin` in `cwd`, kept for a minute |
| `session_name` | the last `ai-title` entry |
| `context_window` | `usage` of the last response: input, cache read and cache write tokens. The window size is not in the transcript: 1M for `[1m]` ids, Fable, Mythos, and Opus and Sonnet from 4.6, 200K otherwise |
| `prompt_cache` | `usage` of all responses of the main chain, each counted once by its message id: the hit ratio, the TTL of the last cache write (`ephemeral_1h` or `5m`), `expires_at` as the time of the last response plus the TTL |
| `cost.total_lines_added`, `cost.total_lines_removed` | the patches of the file edit results (`structuredPatch`) and the lines of created files, in the main and subagent transcripts; this is the count of Claude Code |
| `rate_limits` | `claude -p`, with `live_comments.limits_at` |

The transcript has no session cost: Claude Code writes its totals (`cost-state`) only when the session exits. So the JSON from the transcript has no `cost.total_cost_usd`, no durations and no `pr`, and the default bar shows no cost.

**The rate limits.** They are account-wide numbers that Claude Code gets with each API response; no file has them. The feed sends one small request at most once in 5 minutes, and only while a discussion page is open:

```
claude -p . --model haiku --output-format stream-json --verbose --no-session-persistence \
  --max-turns 1 --tools "" --strict-mcp-config --system-prompt "Reply with one word."
```

The `rate_limit_event` of its output has `unifiedWindows.five_hour` and `seven_day` with `utilization` from 0 to 1 and `resetsAt`; they become `rate_limits.*.used_percentage` and `resets_at`. The request takes about 5 seconds and costs about $0.003 at list price, which on a subscription is spent from the same limits. Sent `rate_limits` neither replace them nor postpone the request; `LIVE_COMMENTS_LIMITS_POLL=0` in the server's environment turns it off.

## The bar file

`run_bar` runs `statusbar.py` from `$XDG_CONFIG_HOME/live-comments/` (`~/.config/live-comments/` by default) with the server's Python, and without it `statusbar.js` with `node` from `PATH`, the input JSON on stdin and a 1-second timeout:

| Case | The pages |
| :- | :- |
| The file printed an object with an `items` list, at most 16 KB | draw it |
| There is no file | hide the bar |
| The file failed, ran longer than 1 second, printed something else; `statusbar.js` without Node | keep the previous bar; the error goes to the server log |

The bar file runs at each update of the session, once a minute, so the user's own data, such as a disk gauge, stay current while Claude is idle, and a changed bar file, new custom data and new transcript entries reach the pages within a minute. Only a bar that differs from the last one goes to the pages, so its time `updated` and the `age` block show when the bar last changed. For that the default bar puts `live_comments.at`, not the current time, into its tooltip.

## The server

`publish_bar` keeps the bar in `Store.status` with the time it came in `updated`:
- only in memory: the session file is not written, and after a restart of the server the bar is built again when a page opens;
- the session's `rev` grows and the waiting requests wake up, as on any change of the session;
- `Store.public` returns it as the `status` field of the session state;
- `leave` of the session drops it.

The server version `VERSION` grows when its API changes, and `cm.py open` refuses a running server of another version. `cm.py stop` stops it; the `wait` commands of connected sessions then start it again from the current `cm.py`.

## The page

The pages get the session state by long polling `/api/<session>/wait?bar=1&rev=…`.
- If the new state differs from the current one only in `status`, `rev` and the server time `now` (`onlyStatus`), the page redraws only the bar. The rest of the page is not re-rendered, so the bar updates while Claude works do not touch the input fields, the focus, the selection and the scroll position.
- The bar is a `footer.lc-sbar` outside `#lc-app`, fixed at the bottom of the window. The bottom padding of `#lc-app` keeps the end of the page above it; the body class `lc-has-sbar` lifts the toasts above the bar.
- `renderStatus` draws the items in order. `sbBlock` turns a block into an element; an unknown block, an unknown style name and a link without an `http://` or `https://` address are skipped or shown as text. All text goes in through `textContent`: a bar cannot insert HTML into the page.
- A timer redraws the bar every 30 seconds, so `countdown` and `age` stay current without new data.
- The bar is hidden when it has no items and when the discussion is closed.

The format is JSON of fixed blocks rather than HTML so that the user's file can change the content of the bar but not the page: the look stays the same in both themes, and nothing from the file runs in the browser.

## Adding a block or a style

A new block or style is a change of the protocol, so it goes into all its readers at once:
1. `skills/statusbar/protocol.md`: the row of the block or the style.
2. `skills/start/app.js`: a branch in `sbBlock`, or the name in `SB_STYLES`.
3. `skills/start/app.css`: the look, as `.lc-sb-<name>`.
4. `skills/statusbar/check.py`: the block and its options in `BLOCKS`, the check of its value in `block_errors` and its text in `block_text`, or the name in `STYLES`.
5. If the default bar should use it: `statusbar.py` and `statusbar.js` together.

Older pages skip a block they do not know, so the protocol version grows only when an existing block changes its meaning.

## Checking

- A bar file: `python3 skills/statusbar/check.py [FILE]`; without `FILE` it checks the user's file. `--input <file>` takes a real input instead of the sample.
- The JSON from a transcript: `python3 -c "import statusfeed, json; t = statusfeed.Transcript('<session id>'); t.refresh(); print(json.dumps(t.status_json(None)))"` in `skills/start/`; its output works as `--input` of `check.py`.
- The whole chain: open the session page; the server log `~/.local/share/live-comments/server.log` has the errors of the bar file and of `claude -p`.
