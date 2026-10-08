# Status bar protocol, version 1

The status bar at the bottom of the discussion pages is described by the user's file in `~/.config/live-comments/` (`$XDG_CONFIG_HOME/live-comments/` when `XDG_CONFIG_HOME` is set): `statusbar.py` in Python or `statusbar.js` in JavaScript. If both are there, `statusbar.py` is used. While a discussion page of the session is open, the live-comments server runs the file once a minute, the first time at once — `statusbar.py` with the server's Python, `statusbar.js` with `node` from `PATH`:

- **stdin**: a status line JSON of the session, with the field names of [the Claude Code status line](https://code.claude.com/docs/en/statusline#available-data). The server builds it from the session transcript: the model, effort, version, directories and repository, `session_name`, the context window, the prompt cache and the changed lines. It has no `cost.total_cost_usd`, durations, `pr`, `vim`, `agent` or `worktree`. Its `rate_limits` come from a small background `claude -p` request, at most once in 5 minutes.
- **Custom data** are added to it: fields sent to `POST http://127.0.0.1:8765/api/<session id>/statusline` as a JSON object of at most 64 KB.
  - A sent field is added only where the server computes no such field: the fields from the transcript listed above, `rate_limits` and `live_comments` are never changed by it. So `cost.total_cost_usd` and `pr` from the Claude Code status line JSON, or fields of one's own such as `my_metric`, reach the bar file, while a sent `model` or `context_window` does not.
  - Each send updates only the fields it contains, at any depth; fields sent before stay. Several programs can send different fields.
  - A sent field drops when its last send is more than 10 minutes older than the last change of the transcript.
  - One line in the user's status line script sends the data of Claude Code — the cost, the durations and the pull request:
    ```bash
    printf '%s' "$input" | curl -s --max-time 0.3 -X POST -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:8765/api/$(printf '%s' "$input" | jq -r .session_id)/statusline"
    ```
    and one line sends a field of one's own: `curl -s -X POST -H 'Content-Type: application/json' -d '{"my_metric": 5}' http://127.0.0.1:8765/api/<session id>/statusline`.
- The extra field `live_comments`: `source` — always `"transcript"`; `at` — the time of the latest transcript entry; `limits_at` — when the server got the rate limits; `custom_at` — the time of the last send of custom data, absent without them. Times are Unix seconds.
- **stdout**: the bar as one JSON object, described below.
- The file has 1 second. If it fails, takes longer or prints something else, the pages keep the previous bar; without the file the pages hide the bar.

The pages of the session draw the bar the server got last; the bar is at most 16 KB. A bar equal to the previous one does not reach the pages, so the `age` block shows when the bar last changed.

## Bar

```json
{"items": [item, …]}
```

`items` are the items of the bar from left to right, separated by thin lines. On a narrow page the bar wraps.

## Item

```json
{"blocks": [block, …], "title": "…", "fill": true}
```

| Key | Required | Meaning |
| :- | :- | :- |
| `blocks` | yes | The blocks of the item from left to right, at least one |
| `title` | no | The tooltip of the item |
| `fill` | no | `true`: the item takes the free space of the line and is cut with “…” first; the items after it stand at the right edge. It has no separating line |

## Blocks

A block is an object with one type key, whose value is the content, and options of the type.

| Block | Options | What it shows |
| :- | :- | :- |
| `{"text": "Opus 5.5"}` | `style` | Text |
| `{"chip": "high"}` | `style`, `accent` by default | A short label in a rounded frame tinted with its color |
| `{"meter": 66}` | `warn` (70), `bad` (90) | A bar filled by the percentage 0–100 and the rounded percentage: green below `warn`, yellow below `bad`, red from `bad` |
| `{"dot": "good"}` | — | A round dot; the value is a color style |
| `{"link": "PR #12", "href": "https://…"}` | `href`, `style` | A link that opens in a new tab; without an `http://` or `https://` `href` it is text |
| `{"countdown": 1791488126}` | `prefix`, `done`, `style` (`muted` by default) | The time left until the moment in Unix epoch seconds — “3d 4h”, “2h 13m”, “42m”, “<1m” — after `prefix`. The page recounts it every 30 seconds; after the moment it shows `done`, and without `done` nothing |
| `{"age": true}` | `prefix`, `style` (`muted` by default) | How long ago the bar came to the server — “<1m ago”, “12m ago” — after `prefix`, recounted every 30 seconds |

### Styles

`style` is one or more names separated by spaces:
- colors: `good` (green), `warn` (yellow), `bad` (red), `accent` (the accent color of the page, blue), `muted` (grey);
- `strong` — bold, in the main text color;
- `mono` — a monospace font.

The colors follow the light or dark theme of the page.

## Example

```json
{"items": [
  {"blocks": [{"text": "Opus 5.5", "style": "strong"}, {"chip": "high"}], "title": "claude-opus-5-5"},
  {"blocks": [{"text": "Context"}, {"meter": 66, "warn": 60, "bad": 85}, {"text": "131.5k / 200k", "style": "muted"}]},
  {"blocks": [{"text": "5h"}, {"meter": 23.5}, {"countdown": 1791488126, "prefix": "↻ ", "done": "reset"}]},
  {"blocks": [{"link": "rodnover55/claude-plugins", "href": "https://github.com/rodnover55/claude-plugins"}], "fill": true},
  {"blocks": [{"age": true}]}
]}
```

## Check

`python3 <statusbar skill directory>/check.py [FILE]` runs the file the way the live-comments server does, on a sample of the status line JSON, checks the output against this protocol and prints the bar as text with the tooltips, or the errors. Without `FILE` it checks the user's file.
