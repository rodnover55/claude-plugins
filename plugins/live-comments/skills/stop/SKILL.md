---
name: stop
description: "Finish the live-comments discussion of the current Claude Code session: stop waiting for the discussion, disconnect the session from the live-comments server and close its discussion there, then list the outcome in the chat — the decisions and the questions left without an answer or a decision. The server stops when no connected sessions are left. Use when the user asks to finish, stop, end or close the live discussion of the session, or invokes /live-comments:stop."
allowed-tools:
  - Bash(python3 ${CLAUDE_SKILL_DIR}/../start/cm.py *)
---

# live-comments:stop — finish the discussion of a session

The discussion of a session is started by the `start` skill (`/live-comments:start`). This skill finishes it.

`CM` below is `python3 ${CLAUDE_SKILL_DIR}/../start/cm.py`. The commands take the session from `CLAUDE_CODE_SESSION_ID`.

1. Stop the background `CM wait` task of the session, if it is running: otherwise its end would wake you up after the discussion is closed.
2. Close the session: `CM leave`. The command disconnects the session, deletes its discussion from the server and prints it in full: the tree of topics with states and every topic. This is the only copy. If no other connected sessions are left, the server stops. Do not stop it with `pkill -f`: the pattern also matches the command line of the shell itself.
   - If `leave` answers that the server is not answering, the server stopped while the session was disconnected (for example, after `/clear`), and the discussion may still be stored: run `CM open`, which starts the server and connects the session again with its stored topics, and then `CM leave` again.
   - If `leave` answers that there is no such session, the session never had a discussion: tell the user so, and do nothing else.
   - If `leave` answers that the session was deleted, the discussion was already closed: tell the user so.
3. In the chat list the outcome from the output of `leave`: the decisions, and the questions left without an answer or without a decision (`[WAITING]`, “open”). Set no activity: `leave` removes it together with the discussion.

After `leave` the session is no longer connected: answer questions in the chat as usual, without moving them into a discussion. A new `/live-comments:start` in the same session starts the discussion anew, without the old topics, but with the session's auto-apply, on or off. The decisions stay in the project's memory.
