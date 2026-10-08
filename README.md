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

- **Session page** — a tree of questions, one question per topic. Ask a question there, and Claude answers it in the same session; replies appear without a page reload. Several questions in one message are split into subquestions.
- **Decisions** — “Resolve” asks Claude to record the topic's decision as a plan item; “Decline” drops a question. “Apply resolved” hands Claude the plan of all resolved questions to carry out. While topics are open, Claude changes nothing except what you explicitly confirm.
- **HTML pages** — Claude writes a script tag into a local HTML page (a report, a mockup); select a fragment in the browser to ask a question about it.
- **Changes page** — a VS Code-like review of the repository's git changes: stage or discard files, blocks and selected lines, and ask questions on lines.
- **Chat** — while the discussion is connected, questions you ask in the chat become topics on the page.

Press `?` on any discussion page for keyboard shortcuts. Ask Claude to finish the discussion to get a summary of decisions and open questions.

### Status line

Run `/live-comments:statusline` to show the session's discussion in the Claude Code status line:

```
[2] http://127.0.0.1:8765/<session id> ⧉
```

The number is the count of open topics; Ctrl+click (Cmd+click on macOS) on ⧉ copies the link. Claude adds the line below your current status line, or makes it the status line if there is none, and installs the handler of `lc-copy:` links for the ⧉ icon: a `.desktop` file on Linux, an AppleScript applet on macOS. `/live-comments:statusline remove` undoes it. How it works, the requirements and the manual steps are in [the skill's instructions](plugins/live-comments/skills/statusline/SKILL.md).

### Requirements

- Linux or macOS
- Python 3.8+ available as `python3`
- git
- A browser on the same machine: the server listens on `http://127.0.0.1:8765`

Discussions are stored in `~/.local/share/live-comments/` (`$XDG_DATA_HOME/live-comments/` when `XDG_DATA_HOME` is set). When Claude Code auto memory is on, Claude also records decisions in the project's memory directory.
