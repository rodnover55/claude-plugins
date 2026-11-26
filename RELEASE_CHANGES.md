# Release changes

What the plugin versions being released change against their previous versions. Before every release the file is written anew for the versions being released.

## live-comments 1.12.0

### Changes page

- **Groups of the file list** — a click on the header of “Changes” or “Staged Changes” in the “☰ Files” list folds or unfolds the whole group. Folded groups are remembered in the browser for the repository, like folded folders.
- **Folding the tree** — the buttons above the search field of the file list: “Collapse all” and “Expand all” fold and unfold all folders and both groups, “Collapse nested” and “Expand nested” fold and unfold the folders inside the chosen folder at any depth.
- **Folded files** — collapsed and expanded file diffs are remembered in the browser for the repository until the HEAD commit changes.
- **Next unanswered** — Alt+N goes to the next open question on lines where it is the user's turn, also in the other group. Its file and discussion unfold, and the page shows Claude's last message of the question at the top.
- **Ask and carry out now** — the “▾” arrow next to “Ask” of a question on lines sends the question as a message of “Reply and carry out now”: Claude carries it out right away and answers with the result in its discussion.
- **Scroll position** — when the discussions under lines or the diffs change, the page stays at the same diff line or message at the top of the window.

### Topic page

- **Lines of a question** — the file, the lines and the diff fragment of a question on lines stand in its first message, and the title of the topic shows them under the pointer too. Claude makes the title of such a question from the question together with its file and diff fragment.
- **Reply in a subquestion** — the item in the menu of the “Reply” button opens a subquestion of the topic with the typed message, and Claude answers in it.
- **Apply at diff blocks** — every ```` ```diff ```` block of Claude's reply in an open topic has the “Apply” button, also without the path of a file: Claude makes the change in the file right away and answers in the topic.

### Stopping

- Stopping the discussion no longer stops Claude's work in progress, such as the plan of “Apply resolved”: Claude carries it on and gives its results in the chat.

### Python

- The plugin runs `python3` from the standard `PATH` of the system (`getconf PATH`), not the one a version manager such as mise or pyenv picks by the current directory. Run `/live-comments:statusline` again to make the live-comments line of the status line run the same way.

### Upgrading

- The server version is 40, and `/live-comments:start` restarts a server left running by the previous version. Reload the open discussion pages.
