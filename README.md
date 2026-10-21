# claude-plugins

A Claude Code plugin marketplace.

| Plugin | Description |
| :- | :- |
| [live-comments](plugins/live-comments) | Live discussion pages for a Claude Code session: a tree of questions answered in the same session, comments on HTML pages, and a VS Code-like review of git changes |

## Install

In a shell:

```bash
claude plugin marketplace add rodnover55/claude-plugins
claude plugin install live-comments@rodnover55
```

Or inside a Claude Code session:

```
/plugin marketplace add rodnover55/claude-plugins
/plugin install live-comments@rodnover55
```

To try a local checkout instead of GitHub, pass its path: `claude plugin marketplace add ./claude-plugins`.

## live-comments

Run `/live-comments` (or `/live-comments:live-comments` if another command already uses that name), optionally with the path to an HTML page to comment on, or ask Claude to start a discussion page. Claude prints the link to the session page.

- **Session page** — a tree of questions, one question per topic. Ask a question there, and Claude answers it in the same session; replies appear without a page reload. Several questions in one message are split into subquestions. When no question waits for your reply, the next reply of Claude opens by itself.
- **Decisions** — “Resolve” asks Claude to record the topic's decision as a plan item; “Decline” drops a question. “Apply resolved” hands Claude the plan of all resolved questions to carry out. While the discussion is connected, Claude changes nothing until you press “Apply resolved”: words in topics or in the chat confirm nothing, except a single request in the chat while no topics are open (see **Chat**).
- **HTML pages** — Claude writes a script tag into a local HTML page (a report, a mockup); select a fragment in the browser to ask a question about it.
- **Changes page** — a VS Code-like review of the repository's git changes: stage or discard files, blocks and selected lines, and ask questions on lines.
- **Chat** — while the discussion is connected, questions and requests you write in the chat become topics on the page. When no topics are open, a message with a single question or request is answered or carried out right away in the chat; a message with several becomes topics.

Code blocks ```` ```mermaid ```` and ```` ```plantuml ```` (or ```` ```puml ````) in messages and decisions are shown as diagrams: Mermaid is drawn in the browser (loaded from the jsDelivr CDN), PlantUML by the local `plantuml` command, which must be installed for it.

Press `?` on any discussion page for keyboard shortcuts. Ask Claude to finish the discussion to get a summary of decisions and open questions.

When the Claude Code session ends (exit or `/clear`), the plugin's `SessionEnd` hook disconnects it from the discussion: the topics stay on the server, and the server stops when no connected sessions are left. `/live-comments` in a resumed session with the same id connects it again with the same topics.

### Status line

Run `/live-comments:statusline` to show the session's discussion in the Claude Code status line:

```
[2] http://127.0.0.1:8765/<session id> ⧉
```

The number is the count of open topics; Ctrl+click (Cmd+click on macOS) on ⧉ copies the link. Claude adds the line below your current status line, or makes it the status line if there is none, and installs the handler of `lc-copy:` links for the ⧉ icon: a `.desktop` file on Linux, an AppleScript applet on macOS. `/live-comments:statusline remove` undoes it. How it works, the requirements and the manual steps are in [the skill's instructions](plugins/live-comments/skills/statusline/SKILL.md).

### Status bar of the discussion pages

Every discussion page can have a status bar at the bottom: by default the model and effort, the context window and the 5-hour and 7-day rate limits with gauges and reset countdowns, the prompt cache, the cost, changed lines, the pull request and the repository.

To turn it on, run `/live-comments:statusbar`: Claude creates your bar file `~/.config/live-comments/statusbar.py` from [the plugin's default](plugins/live-comments/skills/statusbar/statusbar.py). For JavaScript run `/live-comments:statusbar js`: the file is `statusbar.js`, run with Node.

While a discussion page is open, the server keeps the bar current by itself, once a minute: it reads the session transcript and gets the rate limits with a small background `claude -p` request at most once in 5 minutes (about $0.003 at list price; `LIVE_COMMENTS_LIMITS_POLL=0` in the environment of the server turns it off). The transcript has no session cost, so the default bar has no cost, durations or pull request; to get them, send the data of your status line to the server (see [Data from outside](#data-from-outside)).

#### Changing the bar

The easiest way is to ask Claude, for example `/live-comments:statusbar add a disk usage gauge`, `/live-comments:statusbar remove the cache`, `/live-comments:statusbar make the context red from 70%`. Claude edits your file and checks it. `reset` returns the default bar, `remove` removes the bar, `python` and `js` switch the language.

To edit the file yourself: it is a plain program that reads a status line JSON of the session ([its fields](https://code.claude.com/docs/en/statusline#available-data); by default the server builds it from the session transcript, see [the protocol](plugins/live-comments/skills/statusbar/protocol.md)) on stdin and prints the bar. Each item of the bar is a function that returns `item(...)`, and `bar()` lists them from left to right:

```python
def bar(d):
    items = [model(d), context(d), *limits(d), cache(d), cost(d), lines(d), pull_request(d), place(d), age(d)]
    return {"items": [it for it in items if it]}
```

An item is made of standard blocks; the pages draw nothing else:

| Block | Example | Shows |
| :- | :- | :- |
| text | `{"text": "Load", "style": "strong"}` | Text |
| chip | `{"chip": "prod"}` | A short label in a rounded frame |
| meter | `{"meter": 73, "warn": 80, "bad": 95}` | A gauge of a percentage 0–100 with the number: green, yellow from `warn`, red from `bad` |
| dot | `{"dot": "good"}` | A colored dot |
| link | `{"link": "CI", "href": "https://…"}` | A link that opens in a new tab |
| countdown | `{"countdown": 1791488126, "prefix": "in "}` | The time left until a Unix time; the page recounts it |
| age | `{"age": true}` | How long ago the bar came |

`style` takes `good`, `warn`, `bad`, `accent`, `muted`, `strong` and `mono`, several separated by spaces. The full format is in [the protocol](plugins/live-comments/skills/statusbar/protocol.md).

#### Your own data

A text and a gauge with data the session does not have:

```python
def disk(d):
    """Home disk usage: a gauge, yellow from 80%, red from 95%."""
    u = shutil.disk_usage(os.path.expanduser("~"))
    return item({"text": "Disk"},
                {"meter": u.used / u.total * 100, "warn": 80, "bad": 95},
                {"text": f"{u.free / 1e9:.0f} GB free", "style": "muted"},
                title=f"Home disk: {u.used / 1e9:.0f} of {u.total / 1e9:.0f} GB used")
```

Add `disk(d)` to the list in `bar()` and `import shutil` at the top of the file.

- `item(*blocks, title=None, fill=False)` leaves out empty blocks, so an optional block is written as `condition and {...}`. A function with nothing to show returns `None`. With `fill=True` the item takes the free space of the line and is cut first.
- A gauge takes a percentage: convert your value, for example `spent / budget * 100`, and show the value itself in a text block next to it.
- The file has 1 second for everything. Keep slow data, such as a command or an HTTP request, in a cache file; this helper needs `import time` and `from pathlib import Path`:

  ```python
  def cached(path, ttl, fetch):
      """Returns fetch() and keeps it in the file path for ttl seconds."""
      p = Path(path).expanduser()
      try:
          if time.time() - p.stat().st_mtime < ttl:
              return json.loads(p.read_text())
      except (OSError, ValueError):
          pass
      value = fetch()
      p.parent.mkdir(parents=True, exist_ok=True)
      p.write_text(json.dumps(value))
      return value
  ```

- If the file fails or runs longer, the pages keep the previous bar, and the error goes to the server log `~/.local/share/live-comments/server.log`. Wrap a function that can fail in `try`/`except` and return `None` from it: then only its item disappears.
- While a page is open, the server runs your file once a minute, so your own data stay current while Claude is idle too, and a changed file shows within a minute.
- `statusbar.js` is built the same way, with the same functions.
- Check the file: `python3 <plugin directory>/skills/statusbar/check.py` prints the bar as text, or the errors. The plugin directory of an installed plugin is `~/.claude/plugins/cache/rodnover55/live-comments/<version>/`.

#### Data from outside

Data the server cannot read by itself — the cost, the durations and the pull request from the Claude Code status line, or values of your own programs — can be sent to the server: a JSON object of at most 64 KB at `POST http://127.0.0.1:8765/api/<session id>/statusline`. Your bar file gets the sent fields together with the data from the transcript.

- A sent field is added only where the server computes no such field: the model, the context, the cache, the changed lines, the rate limits and the other fields it builds from the transcript can't be changed by sending.
- Each send updates only the fields it contains; fields sent before stay, so several programs can send different fields.
- A sent field drops when its last send is more than 10 minutes older than the last change of the session transcript.

One line in your status line script sends the data of Claude Code, and the bar shows the cost:

```bash
printf '%s' "$input" | curl -s --max-time 0.3 -X POST -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:8765/api/$(printf '%s' "$input" | jq -r .session_id)/statusline"
```

A field of your own is sent the same way, from any program, and drawn in your bar file with the standard blocks:

```bash
curl -s -X POST -H 'Content-Type: application/json' -d '{"my_metric": 5}' http://127.0.0.1:8765/api/<session id>/statusline
```

Your status line is outside the plugin: ask Claude to add the line to it if you want this.

How the bar works inside is in [docs/statusbar.md](plugins/live-comments/docs/statusbar.md).

### Requirements

- Linux or macOS
- Python 3.8+ available as `python3`
- git
- A browser on the same machine: the server listens on `http://127.0.0.1:8765`

Discussions are stored in `~/.local/share/live-comments/` (`$XDG_DATA_HOME/live-comments/` when `XDG_DATA_HOME` is set). When Claude Code auto memory is on, Claude also records decisions in the project's memory directory.
