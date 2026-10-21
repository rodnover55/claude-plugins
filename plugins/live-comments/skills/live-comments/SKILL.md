---
name: live-comments
description: "Live discussion page of a Claude Code session: a tree of topics, one question per topic, answered by Claude in the same session without page reloads. An HTML page gets a script tag that turns selected fragments into topics of the session; the server itself serves only the discussion pages. A review page of the session shows git changes like VS Code: the user stages files, hunks or selected lines and asks questions on lines, which become topics. Several questions in a topic message are always split into subtopics; a resolved subtopic leaves its decision in the parent, and the parent resolves when all its subtopics are closed. Decline drops a question with no action. “Apply resolved” hands Claude the plan of resolved questions and removes resolved and declined ones; the session stays. While the session is connected, questions and requests asked in chat become topics instead of chat answers; when no topics are open, a chat message with a single question or request is answered or carried out right away in chat. Otherwise, while the session is connected, nothing is changed until “Apply resolved”: the discussion collects decisions. Use when the user asks to discuss or comment an HTML page or report live, to start a discussion page, or invokes /live-comments."
argument-hint: "[path to .html]"
allowed-tools:
  - Bash(python3 ${CLAUDE_SKILL_DIR}/cm.py *)
---

# live-comments — live discussion of a session

A **topic** is the discussion of one question. Topics form a tree: a question that comes up in the discussion of a topic becomes its **subquestion**, that is, a child topic.

- **Server** `cm.py` is one for all sessions: `http://127.0.0.1:8765`. It runs separately from the session and outlives it; it stops when no connected sessions are left (see “End of the Claude Code session”).
- **Session page** — `http://127.0.0.1:8765/<session id>`. It has nothing but the “New question” field, a forum-like tree of questions, and under it the “Plan of accepted decisions” block: the decisions of all resolved topics as numbered plan items, each with a “↗” link to its question; decisions of subquestions are subitems of their question's decision. A session is not deleted from the page: without questions the page is empty.
  - Each topic is one row: the question and its state. The discussion is not in the tree.
  - By default the tree is collapsed to top-level questions; an arrow expands the rows of subquestions. The page remembers expanded branches in the browser and shows them the same after a reload and after returning from a question page. A closed topic collapses, even if it closed while the page was closed.
  - Resolved and declined topics stand below open ones at every level of the tree.
  - When no question is the user's turn (as for “Next unanswered”), the first one that becomes the user's turn — Claude has replied — opens by itself. The page waits if it opened with such questions already there, and while the user types in the “New question” field: then the question opens after the text is sent.
  - The “Changes ↗” link in the header is always there and opens the changes page in a new tab.
  - The “Apply resolved” button is available when at least one question is resolved. It hands Claude, through the output of `wait`, the plan of resolved questions and removes resolved and declined questions from the list; open ones stay (see “Applying”).
  - The “▾” arrow next to the button opens a menu. “Apply when all questions are resolved” turns on auto-apply: the resolved ones are applied by themselves as soon as no open questions are left. While auto-apply waits, the button has the badge “applies by itself” with the number of open questions, and the menu has “Cancel auto-apply”. Auto-apply belongs to the whole session and stays as chosen until changed: after firing, it waits for the next questions, and after `leave` it carries over to the session's next discussion. The last choice in any session becomes the auto-apply of new sessions; other existing sessions keep theirs.
- **Topic page** — `http://127.0.0.1:8765/<session id>/<topic id>`; a click on a question row leads to it. It has:
  - the “Back” button — to the question one level up, and for a top-level question — to the session page. Key: Alt+U (in any keyboard layout), including from the reply field; Alt+H opens the session page;
  - the “Next unanswered” button — above the discussion and last in the “Reply” row; opens the next open question in tree order where it is the user's turn: not resolved, not declined, without open subquestions, not waiting for Claude and not in Claude's work. The number in parentheses on the button is how many such questions there are besides the open one. After the last such question the first one opens; if there are no others, the button is called “Home” and leads to the session page. Key: Alt+N (in any keyboard layout), including from the reply field; on the session page Alt+N opens the first such question;
  - the path from the root to the topic;
  - a quote, if the topic is asked about a fragment of an HTML page;
  - the discussion and the reply field; subquestions are shown as the same kind of tree in the “Subquestions” message that opened them.
- **Changes page** — `http://127.0.0.1:8765/<session id>/diff`: a review of the changes of the git repository where `CM open` was run, as in VS Code.
  - The diffs of all files of a group go one under another. The groups are “Changes” (working tree against the index, together with untracked files) and “Staged Changes” (index against HEAD); the group switch is in the toolbar above the diffs. The view is there too: “Side by side” (the default) or “Inline”; the choice is remembered in the browser.
  - The “☰ Files” button and the Ctrl+P key open, in the middle of the window over the diffs, the list of files of both groups as a tree of folders with a search field. The search keeps the files whose paths contain all its words. ↑↓ choose a file or folder, Enter or a click goes to the file's diff or folds the folder, ← and → fold and unfold folders while the field is empty, Esc closes the list. Folded folders are remembered in the browser for the repository; while searching, all folders are unfolded.
  - A file in the list and in its diff header has: “+” or “−” — stage or unstage the whole file, “↶” — discard the file's changes in the working tree (a new file is deleted), after confirmation.
  - A file collapses on a click on its header. The “Viewed” mark collapses the file; if the file's diff changes later, the mark clears by itself. The marks are kept in the browser.
  - A change block is a run of changed lines. In the middle column next to a block: “+” (“−” in the staged diff) — stage or unstage the block, and “↶” — discard the block in the working tree after confirmation.
  - Selected lines (with the mouse, or with a click and Shift+click on a line number) are staged with the “Stage N lines” button or unstaged with “Unstage N lines”.
  - The “Ask a question” button at selected lines opens a question field under them. The question becomes a top-level topic with an anchor: the file, the lines and the diff fragment. Its discussion is shown under these lines with the same buttons as on a topic page. If the lines are no longer in the diff, the discussion stands above the file's diff with a quote.
  - The user decides what to stage and what to discard; Claude does not touch the index.
  - The “← Discussion” button and the Alt+U and Alt+H keys open the session page.
- **HTML page** opens as a file (`file://`); the server does not serve it. The session's `embed.js` script is written into it.
  - From a selected fragment the script creates a session topic and highlights fragments that have topics.
  - A click on a highlight opens the topic on the server. If a fragment has several topics, a menu to choose from appears first.
- **Claude's replies** appear on the pages without a reload. New replies are signalled by the “new” badge and a number in the tab title. A recorded decision, “Subquestion … resolved” and a list of subquestions do not count as new: they repeat what is already visible; a declined topic has no “new” marks. While Claude replies, while the question waits for Claude in the queue, or while Claude continues working on the question after a “taking this on” reply, a badge says so on the topic page right above the reply field and in the topic's row in the tree.
- **Claude's activity**: the header of every discussion page says whether Claude is listening: “● Claude is listening” or “● Claude is not listening now — will answer on return”. Claude replaces this phrase with what it is doing now, and returns it; activity for a topic also stands above the topic's reply field instead of its state badge (see “Activity”).
- **Buttons of an open topic**: “Reply”, “Resolve” (asks Claude to record the decision) and “Decline”. Resolve is unavailable while the topic has open subquestions. A declined topic is final: no one can reply in it, and the question can be returned to only with a new topic. A resolved topic is opened again with the “Reopen” button (see “Reopening”).
- **Drafts**: the text in the “New question” field, in a topic's reply field and in a question on lines is saved in the browser right away as a draft shared by the session's tabs. The user can leave a page without losing anything: the text returns to the field when the page opens again; a question on lines also gets its lines back. Sending, and “Cancel” of a question on lines, delete the draft. In the tree, a topic with a reply draft has the “draft” badge.
  - The “Drafts (N)” button in the header and the Alt+X key (in any keyboard layout), including from the reply field, open the page of the next draft in the order they were created, after the last one — the first; the cursor goes to the end of the text. N is how many drafts there are on other pages; without them there is no button.
- **Status bar**: at the bottom of every discussion page, a bar built by the user's own file of the `statusbar` skill (`/live-comments:statusbar`) — by default the model, context window, rate limits, prompt cache, changed lines and repository. The server builds it once a minute while a page is open, from the session transcript, which has no cost; custom data, such as the status line JSON of Claude Code with the cost, can be sent to `POST /api/<session id>/statusline`. Requests to change the bar go to the `statusbar` skill.
- **Keyboard help**: the “?” key on any discussion page, except while typing in a field, opens a window with the keys of this page; “?”, Esc or a click outside the window closes it.
- **Storage** — `~/.local/share/live-comments/sessions/<session id>.json` (`$XDG_DATA_HOME/live-comments/sessions/` when `XDG_DATA_HOME` is set).

`CM` below is `python3 ${CLAUDE_SKILL_DIR}/cm.py`. The commands take the session from `CLAUDE_CODE_SESSION_ID`.

## Start

1. Connect the session (as a regular command, not in the background):
   `CM open --label "<session topic in 2–4 words>"`
   The command starts the server if it is not running, remembers the git repository of the current directory and prints the links to the session page and to the changes page.
2. If there is an HTML page (the skill's argument or the page being talked about), write the session script into it:
   `CM embed <page>`
   The command inserts before `</body>` the line `<script src="http://127.0.0.1:8765/embed.js" data-session="…">` and prints the `file://` path. If the page is built by a generator, write this line into the generator's template too, otherwise a rebuild erases it.
3. Give the user the link to the session page and the `file://` path to the HTML page, if there is one. Give the link to the changes page if the user asks for a review of changes.
4. Start waiting in the background (Bash with `run_in_background`):
   `CM wait`
   The command finishes when a topic appears in the session where something awaits Claude, and prints this topic. Its completion wakes you up. Keep only one wait at a time. If the server is stopped or has crashed, the wait starts it again by itself and keeps waiting.

## Decisions only

While the session is connected, the discussion collects decisions. Nothing is changed except by the plan of “Apply resolved”, by auto-apply and by a chat message with one item while no topics are open (see “Question in the chat”): not the code, project files or the HTML page, not settings, not the server — neither on your own initiative nor at the user's request in a topic or in the chat. Only the discussion itself (the `CM` commands), the script line in the HTML page (`CM embed`) and the decisions file in memory change.
- A request to change something is not carried out: in a topic, answer that the change will be made by “Apply resolved” and include it in the topic's decision; from the chat, move it into the discussion, unless it is the only item of the message and no topics are open (see “Question in the chat”).
- Reading code and files, gathering information and running checks is allowed: they change nothing.

Carry out the plan of “Apply resolved” right away, even if there are open topics (see “Applying”).

## Confirmations

Words in a topic or in the chat confirm nothing: only the “Apply resolved” button does. The exception is a chat message with one item while no topics are open (see “Question in the chat”). An instruction is an item of a user message that says what to do: agreement with what Claude proposed in the chat or in a report (“great, go ahead”), or an instruction to take a specific action (“let's postpone this work for now”). Words saying that the question of the topic itself is resolved are a request to record the decision (see “Decision”).
1. An instruction in a topic is not carried out: it goes into the topic's decision. Reply that it will be done by “Apply resolved” and how it enters the decision; if the questions of the message have already been moved into subquestions, reply as an addition (`CM reply --followup`). An instruction does not count among the questions of the message.
2. An instruction from the chat becomes a top-level topic, like a question; if it is the only item of the message and no topics are open, carry it out right away (see “Question in the chat”).

## Answering a topic

When `wait` has finished, read its output. If the output is not visible, run `CM show`, and then `CM thread <id>`. If `wait` says that the session is not connected or that the server is not answering, run `CM open` again, and then `CM wait` in the background. If `wait` says that the user pressed “Apply resolved”, act according to the “Applying” section.

The output is one topic:
- the path from the root;
- the quote and the page, if there are any; a question from the changes page has the file, the lines (of the working tree, the index or HEAD) and the diff fragment with “+” and “-” signs. Read the file at these lines: the question is asked about them;
- messages with ids;
- subquestions with decisions.

Messages that need an answer are marked `← AWAITING REPLY`. The mark “new” in the first line means the topic has only the user's first message so far. Topics are given out in turn: first the one whose unanswered item came earlier.

1. **One topic — one question.** First count the questions in the unanswered message. A question is each item that needs its own answer or its own decision: a question, a clarification, a request to explain in more detail, a request to change something where one has to choose how exactly, an objection. Instructions are not questions (see “Confirmations”). Numbered items and paragraphs about different things are different questions. A clarification of the topic's answer or question counts like any other question. A questions file is a JSON list `[{"title": "<question in one line>", "text": "<the user's words about this question>"}]`.
   - **A message with two or more questions** — the first message of a new topic or a message in the discussion — move it entirely into subquestions of this topic, one per question: `CM branch <id> -f <file> --message <message id>`. The message counts as answered; the subquestions will come through `wait`. For a new topic add `--title "<the message's overall question in one line>"`.
   - **Splitting always makes subquestions.** Questions from a message in a topic's thread become its subquestions and are not moved to top-level topics or topics of the same level. Only questions from the chat become top-level topics (see “Question in the chat”).
   - **A message with one question** — answer it in the topic.
   - **A message without questions**, only with instructions — reply that they go into the topic's decision and will be carried out by “Apply resolved” (see “Confirmations”).
   - **Your answer raised several questions** that the user decides — open them as subquestions without `--message`: `CM branch <id> -f <file>`. Such subquestions wait for the user's reply.
2. **Find the answer** the same way as for a question in the chat: read the needed code, files and page. Follow the user's rules for answers (CLAUDE.md, memory): language, style, scope. Answer with words only: change nothing (see “Decisions only”).
3. **Send the answer:** write it to a temporary file and run `CM reply <id> -f <file> --title "<question in one line>"`.
   - `--title` is required if the output has the line “no title”. The title is the topic's question in one line; it is visible in the collapsed tree.
   - **Markdown.** Write replies in Markdown wherever it makes them easier to read: the page shows the messages of the user and of Claude as Markdown, like GitHub comments. Headings, paragraphs (a line break stays a break), lists with nesting and tasks `- [ ]`, quotes `>`, code blocks in ```` ``` ````, tables, `code`, **bold**, *italic*, ~~strikethrough~~, links `[text](https://…)`, images and bare addresses all work. Code blocks ```` ```mermaid ```` and ```` ```plantuml ```` (or ```` ```puml ````) are shown as diagrams: Mermaid is drawn in the browser, PlantUML by the local `plantuml` of the server without access to files and network (`!include` of local files does not work; a body without `@startuml` is wrapped in it); the source stays behind the “source” button. Use a diagram where it explains structure or flow better than text. Give code blocks their language (```` ```python ````, ```` ```bash ```` …): the page highlights their syntax. The same goes for decisions (`--decision`) and the `text` of questions files. The title (`--title`, `title`) is plain text. HTML in the text is shown as text.
   - **Links.** Give a link wherever the reply refers to something the user may want to open, written as `[what opens](address)`. All links in messages and decisions open in a new tab; `file://` links open as described below.
     - another topic of the discussion — `http://127.0.0.1:8765/<session id>/<topic id>`;
     - a changed file on the changes page — `http://127.0.0.1:8765/<session id>/diff?f=<path from the repository root>`, with `&s=1` for the staged diff;
     - a local file or folder — an HTML page, a report, a file you created or edited, also outside the repository — `file://<absolute path>`, for example `[page.html](file:///home/user/reports/page.html)`. Wherever the reply names such a file or its path, it is a link. The browser does not open local files from the discussion pages, so a click on such a link asks the server to open the file with the desktop's default application: an HTML page opens in the browser in a new tab;
     - a file or lines of a commit that is already on GitHub — `https://github.com/<owner>/<repo>/blob/<commit>/<path>#L<from>-L<to>`;
     - a commit, pull request, issue, documentation page or another source the answer relies on — its full `https://` address.

     Give only addresses that exist: take them from the output of the `CM` commands, `git remote`, `git log` and the sources you read; do not make them up. The same goes for decisions and the `text` of questions files.
   - If `reply` answers “topic closed (declined)”, the user declined the question while you were working on it. Send and record nothing.
4. Start `CM wait` in the background again right away.

**Long work** (investigation, a live check) must not hold up the queue:
1. Right away reply in the topic briefly that you have taken it on and what the result will be: `CM reply <id> -f <file> --working`, and set the activity of the topic: `CM activity "<what you are doing>" --topic <id>` (see “Activity”). This way the question is answered and the queue moves on, while the `--working` flag keeps the topic in Claude's work: the page shows the badge “Claude is working on the question…”, and `show` shows “[IN PROGRESS]”.
2. Start `wait` and answer other topics as they come.
3. Append the result to the same topic: `CM reply <id> -f <file> --followup`. The `--followup` flag means the message adds to the previous answer rather than answering a new question. A reply without `--working` removes the work badge; send an intermediate addition after which the work continues with `--followup --working`. Update the activity as the work moves on; when the work is finished, return the default phrases: `CM activity`.
4. If the user writes into the topic while it is in work (the first line of the `wait` output is marked “in progress by Claude”) and the work continues after the reply, reply with `--working` too.

## Question in the chat

While the session is connected (after `open` and until `leave` or deletion of the discussion), a message in the chat is answered in the chat or moved into the discussion. First count the items of the message by the “One topic — one question” rule; an instruction is an item too (see “Confirmations”). Then run `CM show`: a topic in the `[open]` state is open.
- **There are open topics** — do not answer in the chat: move the items into the discussion, even a single one.
- **There are no open topics, and the message has one item** — handle it in the chat right away, without a topic, as without the discussion: answer the question, carry out the instruction or the request to change something.
- **There are no open topics, and the message has to be split:** it has two or more items — do not answer in the chat: move the items into the discussion.

Move the items into the discussion as top-level topics, one per item. Do not open a topic that only groups the questions of a message.
1. Each item of the message is a separate new question: five items — five top-level topics. Write a questions file; `text` is the user's words about this question.
2. Run `CM chat -f <file>`. The command opens top-level topics on behalf of the user and prints a link to each.
3. In the chat reply briefly with the links to the topics.
4. The background `wait` will give these topics; answer them according to the rules of “Answering a topic”.

Carry out requests about the discussion itself (write the script into a page, finish the discussion) in the chat as usual; the wait keeps running.

## Decision

A decision is recorded in two cases:
- **The button or subquestions.** The output has the line `← RECORD DECISION` with a reason: “the user pressed Resolve” or “all subquestions closed”. In the second case the server itself requested the decision when the last open subquestion closed, and at least one subquestion is resolved.
- **The user's words.** An unanswered user message says that the topic's question is resolved, in any words: “resolved”, “let's close this”, “agreed, closing”, “we'll do it that way”. Such a message equals pressing Resolve.

1. If the topic has other unanswered messages too, first handle them by the rules of “Answering a topic”. Do not reply to the decision message itself separately: recording the decision answers it.
2. **Phrase the decision as a plan item** in 1–3 sentences: what has to be done — what to change and where, or what to leave as is. Write actions only: not an answer to the topic's question, not a summary of the discussion and not a rationale. The rationale stays in the topic, and the plan item on the session page links to it. Not “The cache needs a 5-minute TTL because the data changes hourly”, but “Set the cache TTL in `config/cache.yml` to 5 minutes”. The item is understandable without the topic's question: it names what exactly to do and where. If the plan is stated in the user's message, take it from there. If there is no explicit plan, write the plan the discussion arrived at.
   - For a topic with subquestions, the decision is a plan item for its own question; the decisions of the subquestions become its subitems (they are in the output). Do not repeat them word for word.
   - Declined subquestions are not part of the decision.
3. **Remember the decision** in the current project's memory: in the file `decisions-<name>.md` (type `project`) in the memory directory named in the system prompt. If the session has no memory directory, skip this step.
   - The name is the name of the root topic's HTML page without `.html`, and if there is no page — the session label in Latin letters joined with hyphens.
   - A new decision is a line “date · topic path · decision · topic id”.
   - If the file does not exist, create it and add a pointer line to `MEMORY.md`.
4. **Close the topic:** `CM resolve <id> --decision "<decision>"`.
   - The topic becomes “resolved” and collapses.
   - If the topic has a parent, the message “Subquestion “…” resolved: …” comes into the parent's discussion.
   - If it was the last open subquestion, the command says so, and the parent will come through `wait` for recording its decision.
   - If the topic has open subquestions, the server does not close it: reply in the topic which subquestions are still open. The topic closes when they close.
5. Start `CM wait` in the background again.

## Reopening

The “Reopen” button on the page of a resolved topic opens it again. The button is there if the topic has no parent or its parent is open; for a resolved parent, the parent has to be reopened first.
- The previous decision stays in the discussion of the topic and of the parent marked “revoked”.
- If the parent was waiting for its decision to be recorded, the request is withdrawn: it has an open subquestion again.
- The user message “Decision revoked: …” comes into the topic; in the `wait` output it is marked `· decision revoked`.

1. Delete the line of this decision from the file `decisions-<name>.md` in memory; the topic id finds the line. If no decisions are left in the file, delete the file and its line in `MEMORY.md`.
2. Reply in the topic with one line: the decision is revoked and removed from memory. Handle the other unanswered messages of the topic by the rules of “Answering a topic”.
3. Start `CM wait` in the background again.

From then on the topic is discussed and resolved like a regular open one.

## Declining

“Decline” closes the topic and all its open subquestions. Nothing is done for such a topic:
- `wait` does not give it;
- a reply to it is not accepted;
- a decision is written neither into the topic nor into memory.

If you were working on it at that moment, drop the work and start `wait`.

## Applying

The “Apply resolved” button removes all resolved and declined topics from the discussion, at any level of the tree. Open topics stay, and the session stays connected. The decision of a removed subquestion in the discussion of its open parent is marked “applied”. The `wait` output starts with an order to carry out the plan, followed by the plan and the removed topics:
- **the plan** — the decisions of the removed resolved topics as numbered items (“1.”, “1.1.”), each with its question and topic id;
- **the removed topics** — their tree and every topic in full: rationales, quotes, files and lines. This is the only copy: they are deleted from the server.

Auto-apply applies the resolved ones the same way, by itself: when Claude records the decision of the last open topic or the user declines it. Then `CM resolve` prints that the resolved ones were applied, and the `wait` output is the same, except that the order starts with auto-apply firing.

1. Start `CM wait` in the background again right away: the discussion continues.
2. Print the whole plan to the chat as it is in the output.
3. Carry out the plan item by item, even if there are open topics. Take the details for an item from its topic's discussion. Keep the activity on the current item, for example “Carrying out the plan: item 2 of 5 — cache TTL”, and return the default phrase when the plan is done (see “Activity”).
4. The decision of a parent whose subquestions are marked “applied” does not repeat them: they are already done.

## Activity

The phrase in the header of the session's pages describes what Claude is doing. By default it is “● Claude is listening” or “● Claude is not listening now — will answer on return”, depending on whether `wait` is running.
- `CM activity "<what you are doing now>"` — all pages of the session show this text instead of the default phrase. The colour of the dot still shows whether Claude is listening; the tooltip shows the default phrase and since when the text has been there.
- `CM activity "<what you are doing now>" --topic <id>` — the same, and the text also stands above the reply field of topic `<id>`, on its page and under the diff lines, instead of the topic's state badge (“Claude is working on the question…”, “Claude is replying…”). While a user message of the topic waits in the queue, the badge “awaiting reply” stays there instead.
- `CM activity` without text — returns the default phrases everywhere.
- `CM show` prints the current activity, if there is one.

1. **When to set.** Set the activity for work that takes longer than one reply and that the user does not see on the pages otherwise: carrying out the plan of “Apply resolved”, long work on a topic (`--working`), a long task from the chat, a long check or test run. Work for one topic gets `--topic <id>`; work for the whole session, such as the plan, gets no topic. Answering a topic needs no activity: the topic's badge already says “Claude is replying…”.
2. **What to write.** One short line, at most 200 characters, about the current step, in the language of your replies: “Running the tests”, “Carrying out the plan: item 3 of 7 — cache TTL”, “Investigating the slow start for topic “Startup time””. Update it as the work moves on.
3. **When to return the default.** As soon as the work is finished, before going back to waiting only: `CM activity`. The text does not go away by itself, and a stale text misleads the user. `leave` removes it together with the discussion.

## Stopping

When the user asks to finish:
1. Stop the background `wait` task.
2. Close the session: `CM leave`. The command disconnects the session, deletes its discussion from the server and prints it in full: the tree of topics with states and every topic. This is the only copy. If no other connected sessions are left, the server stops. Do not stop it with `pkill -f`: the pattern also matches the command line of the shell itself.
3. In the chat list the outcome: the decisions, and the questions left without an answer or without a decision (`[WAITING]`, “open”).

A new `open` in the same session starts the discussion anew, without the old topics, but with the session's auto-apply, on or off. The decisions stay in the project's memory.

## End of the Claude Code session

When the Claude Code session ends — on exit or `/clear` — the plugin's `SessionEnd` hook runs `CM disconnect --hook`: the session is disconnected, and its discussion stays on the server with all topics. Its pages say that the session is not connected. A pending `wait` of the session does not end: after `/clear` Claude Code keeps background tasks in the new conversation, and the end of the wait would start a turn there; Claude Code kills it on exit. If no connected sessions are left, the server stops; the discussion stays in its file. `CM open` in a session with the same id connects it again with the same topics.

## Other commands

- `CM chat -f <file>` — open top-level topics on behalf of the user (see “Question in the chat”).
- `CM ask -f <file>` — open top-level topics on behalf of Claude: questions the user decides, for example items of a report for discussion. The file is the same JSON list of questions; `text` is the whole item, self-contained. Such topics wait for the user's reply.
- `CM activity ["<text>"] [--topic <id>]` — what Claude is doing now, in the header of the session's pages and, with `--topic`, above the topic's reply field; without text — the default phrases (see “Activity”).
- `CM disconnect` — disconnect the session and keep its discussion; the `SessionEnd` hook runs it with `--hook` (see “End of the Claude Code session”).
- `CM thread <id>` — the whole topic.
- `CM show` — a short tree of the session's topics, with “WAITING” marks.
- `CM stop` — stop the server right away, for all sessions. The waits of connected sessions start it again from the current `cm.py`, so this is how the server is restarted with a new version.
