---
name: embed
description: "Embed the live-comments discussion of the current Claude Code session into an HTML page: write the session's embed.js script line into the HTML file, or into the source the page is built from — a template, a layout, a generator or a Markdown document — so that selecting a fragment of the page in the browser opens a topic of the session. The input is the path to the HTML file or to its source. Starts the discussion first if the session has none. Use when the user asks to add live comments to an HTML page, report or its source, to embed or connect a page to the discussion, or invokes /live-comments:embed."
argument-hint: "<path to .html or its source>"
allowed-tools:
  - Bash(python3 ${CLAUDE_SKILL_DIR}/../start/cm.py *)
---

# live-comments:embed — embed the discussion into an HTML page

The discussion of a session is started by the `start` skill (`/live-comments:start`). This skill writes into an HTML page the line of the session's script:

```html
<script src="http://127.0.0.1:8765/embed.js" data-session="<session id>"></script>
```

In the page opened in the browser, the script turns a selected fragment into a topic of the session and highlights fragments that have topics. The script works only in a page opened as a file (`file://`): the server does not serve pages and does not answer pages served over HTTP by an application or a dev server (Flask, Django, PHP, Rails, the dev server of a bundler).

`CM` below is `python3 ${CLAUDE_SKILL_DIR}/../start/cm.py`. The commands take the session from `CLAUDE_CODE_SESSION_ID`.

- `CM embed <file>` — writes the line before the last `</body>` of the file outside HTML and template comments (in any letter case, with the indent of `</body>`), or at its end after a blank line if there is no `</body>`, and prints the `file://` path. A line written by `CM embed` before, of this or another session, is replaced; other scripts, and examples of the line that are not on a line of their own, stay. The rest of the file, its line endings included, stays as it was, and a repeated run changes nothing. A file not in UTF-8 is not changed: the command says so.
- `CM embed --print` — prints the line without writing it.

## Steps

1. **The discussion.** If the discussion of this session is not running in this conversation — no `CM open` and no background `CM wait` — start it by the `start` skill with the same file as its argument. Its step 2 embeds the file by steps 2–4 below, so after it nothing is left to do here. The script of a session without a discussion shows nothing.
2. **The input.** The argument is the path to the file; without it, take the page the user is talking about, and if it is not clear which one, ask. Read the file and decide what it is:
   - **An HTML file** — the page itself, the one opened in the browser: `CM embed <file>`. If the file is the output of a build — a generator, a converter or a static site generator of the project writes it, or it lies in a build output directory — the line goes into its source too, by the items below: otherwise the next build erases it.
   - **A source where the page's `</body>` is written as markup** — an HTML template or layout (Jinja, Django, Handlebars, Mustache, ERB, Go templates, PHP, Vue or Svelte app shell, `index.html` of a bundler): `CM embed <source>`. If the source has no `</body>` itself, it is not the right file: find the layout or base template it extends, which has `</body>`, and embed there.
   - **A source where `</body>` is produced by code** — a generator script that builds the HTML in strings (Python, JavaScript, shell): do not run `CM embed` on it, it would break the code. Take the line from `CM embed --print` and add it, in the syntax of that code, right before the place that writes `</body>`, on an output line of its own: preceded by a line break unless the output before it always ends with one, and followed by a line break (for example `html += "\n<script …></script>\n"`), so that `CM embed` on the built page recognises and replaces it.
   - **A source without HTML markup** — Markdown, AsciiDoc, reStructuredText or another format converted to HTML: the line goes where the converter passes raw HTML to the end of the page body.
     - In Markdown, raw HTML at the end of the document, after a blank line, is enough: if the document has no `</body>` anywhere, code blocks included, and shows no `embed.js` line as an example in a code block, run `CM embed <source>`; otherwise take the line from `CM embed --print`, append it at the end of the document after a blank line, and remove by hand a line of `embed.js` embedded there before, outside code blocks.
     - reStructuredText and AsciiDoc show raw HTML as text: do not run `CM embed` on them. Take the line from `CM embed --print` and put it at the end of the document in the format's raw HTML block — in reStructuredText `.. raw:: html`, a blank line and the line indented; in AsciiDoc between two `++++` lines — replacing such a block written before.
     - If the converter strips raw HTML or the page has its own template (pandoc `--template`, a static site generator layout), embed into that template instead.
     - If the build inlines resources (pandoc `--embed-resources` or `--self-contained`, a bundler that inlines scripts), the line must not go through it: the inlined script no longer finds the server. Embed only into the built page, after each build, remove a line of `embed.js` from the document and its template, and tell the user so.
   - If no place in the source writes the end of the page's body, say so and ask the user where the page is built.

   The built page must get exactly one line of `embed.js`: when the line goes into a source, remove a line of `embed.js` written before into any other file the page is built from — the document, the template, the generator. A line in a shared layout or base template reaches every page built from it: tell the user which pages get it.
3. **The built page.** If the page of the source is not a file but is served over HTTP by an application or a dev server, the script does not work there: tell the user so before embedding, and offer to embed into a static HTML page built from the source and opened as a file, if the project builds one. After embedding into a source, find the HTML page built from it — from the build command, the generator's configuration or the output directory — and if it exists, embed into it too with `CM embed <page>`: the line then works right away, without a rebuild, and the next build keeps it from the source. If the page does not exist yet, tell the user which command builds it.
4. **The report.** Give the user the `file://` link to the HTML page and say which file got the line. If the line went into a source under version control, say that it is tied to this session: the next embed of another session replaces it, and before committing the line has to be removed if it should not stay in the repository.

Embedding changes only the script line; nothing else in the page or its source is changed, also while the discussion collects decisions (see “Decisions only” in the `start` skill).
