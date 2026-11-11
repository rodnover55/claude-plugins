# Release changes

What the plugin versions being released change against their previous versions. Before every release the file is written anew for the versions being released.

## live-comments 1.11.0

### Code blocks, diagrams and images

- **Full screen** — the “Full screen” button, an icon that is the last button of every code block, diagram and image, shows it in a window over the whole page. A diagram and an image are zoomed there by the wheel or the “−” and “+” buttons and moved by dragging; “Fit” shows the whole of it again, and Esc closes the window.
- **Copy** — every code block has the “Copy” button that copies its code.
- **Diff blocks** — a ```` ```diff ```` code block of a message is shown as a diff like on the changes page, with the “Side by side” and “Inline” buttons that switch the view of all such blocks.
- **Apply** — a code block that Claude's reply gives for a file shows the path of the file and, while the topic is open, the “Apply” button: Claude puts the code into the file right away and answers in the topic.

### Discussion pages

- **Updates in place** — when the discussion changes, the page changes only what differs, so the selection, the focus, the scroll position and the typed text stay. The server sends the page only the questions that changed.
- **Tree of questions on a topic page** — the “☰ Questions” button opens the tree of all questions of the session, and “Open at the side” keeps it in a panel at the left side of the page.
- **Header** — the header of the session page and of a topic page stays at the top of the window while the page scrolls. The path in it ends with the title of the topic, which shows the first message of the topic under the pointer.
- “Next unanswered” opens a question scrolled to Claude's last message.

### Applying and stopping

- **Apply resolved once** — the item in the menu of the “Apply resolved” button applies the resolved questions by themselves one time, as soon as no open questions are left. After that auto-apply is off again, and the choice neither carries over to the session's next discussion nor becomes the auto-apply of new sessions.
- **Stop discussion** — the button on the session page finishes the discussion from the browser the same way as `/live-comments:stop`: Claude lists the decisions and the open questions in the chat.

### Upgrading

- The server version is 39, and `/live-comments:start` restarts a server left running by the previous version. Reload the open discussion pages.
