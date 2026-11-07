# Release changes

What the plugin versions being released change against their previous versions. Before every release the file is written anew for the versions being released.

## live-comments 1.10.0

### HTML pages

- **Subquestions from a page** — the question form of a fragment has the “Parent question” list with the top level and the open questions of the session. A question asked under a parent becomes its subquestion the same way as the subquestions Claude opens. A resolved or closed question takes no new subquestions.
- **The parent set by the page** — an element of the page with `data-cm-parent="<topic id>"` makes the form offer that question as the parent of questions about fragments inside it, so you do not have to choose it. On `<body>` or `<main>` the attribute covers the whole page.
- When the server does not take a question, the page shows the reason instead of “The discussion server is unavailable”.

### Questions and decisions

- **Closing at your request** — a request to close a question, in its topic or in the chat, closes it the same way as the “Close” button. While “Resolve” waits for Claude, the decision is recorded and the question is not closed.

### Upgrading

- The server version is 36, and `/live-comments:start` restarts a server left running by the previous version. Reload the open discussion pages and the HTML pages with the script.
