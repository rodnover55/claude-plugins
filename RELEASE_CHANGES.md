# Release changes

What the plugin versions being released change against their previous versions. Before every release the file is written anew for the versions being released.

## live-comments 1.9.0

### Questions and decisions

- **Each question on its own** — a question is resolved or closed only by its own buttons, whatever the states of its parent and subquestions. “Resolve” works while subquestions are open, and text in the reply field becomes your decision, which Claude phrases as the plan item.
- **Close instead of Decline** — “Close” ends a question without a decision and is not a rejection of what was discussed in it. “Reopen” opens a closed question as well as a resolved one.
- **Apply resolved by branches** — the plan takes only the branches where every question is resolved or closed; a branch with an open question stays in the discussion whole.
- **Splitting** — when a message, or Claude's answer, has several questions, the first one stays in the topic, and the others become its subquestions.
- **Reply and carry out now** — in the “▾” menu of “Reply”: Claude carries the message out right away and answers with the result in the topic, which stays open.
- **Quoting** — the “Quote” button adds text selected in a discussion to the reply as a quote. Pasted text goes in as a quote too, and Ctrl+Z (Cmd+Z on macOS) right after pasting removes the quoting.
- `/live-comments:stop` leaves closed questions out of the outcome.

### Images

- **Images in your messages** — paste a PNG, JPEG, GIF, WebP or SVG image, such as a screenshot, into any field of the pages: it is shown in the message, and Claude looks at it when it answers; an SVG Claude reads as its code.
- **Images in Claude's replies** — Claude shows local screenshots, charts and pictures it made in its replies.
- Images in messages get a white background, so transparent ones stay visible in the dark scheme. The images of a session are deleted together with its discussion by `/live-comments:stop`.

### Cleanup

- **`/live-comments:clear`** — lists the discussions left on the disk with the directory where each session was started, its size and its last activity, the oldest first, and deletes the ones you choose, by default those without activity for more than a week, after you confirm.

### Upgrading

- Discussions stored by the previous version open with the new states: declined questions become closed.
- The server version is 34: `/live-comments:start` restarts a server left running by the previous version. Reload the open discussion pages.
