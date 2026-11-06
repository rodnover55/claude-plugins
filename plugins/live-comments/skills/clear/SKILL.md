---
name: clear
description: "Clean up the stored live-comments discussions: list every session that has files of the live-comments server on the disk — its label, state, the directory where the Claude Code session was started, the size and the last activity — and delete for good the outdated ones chosen by the user's filter, by default those without activity for more than a week, after the user confirms. Deleting a session removes its discussion, its images and its other files. Use when the user asks to clean up, clear or delete old live-comments sessions or discussions, to see how much space they take, or invokes /live-comments:clear."
argument-hint: "[filter, for example: older than 3 days]"
allowed-tools:
  - Bash(python3 ${CLAUDE_SKILL_DIR}/../start/cm.py *)
---

# live-comments:clear — delete outdated discussions

The server keeps the discussion of a session after the Claude Code session ends, until `leave` of the `stop` skill (`/live-comments:stop`) closes it. Discussions of sessions that were never stopped stay on the disk with their images. This skill lists them and deletes the outdated ones.

`CM` below is `python3 ${CLAUDE_SKILL_DIR}/../start/cm.py`.

1. List the sessions: `CM sessions`. The command lists them from the oldest last activity to the newest. For every session it prints its id, label and state, the directory where the Claude Code session was started, the size of its files and the last activity with its age in days; the current session is marked “this session”. The states are “connected”, “disconnected” and “closed” — closed by `leave`, with only some of its files left. The directory is “unknown” when Claude Code has deleted the session's transcript and the session has no git repository.
2. Choose the sessions to delete by the user's filter: the skill's argument or the user's words, such as “older than 3 days”, “all from ~/workspace/notes”, “all but connected”. Without a filter, choose the sessions whose last activity was more than 7 days ago. Do not choose the current session unless the user names it. A connected session with recent activity is in use by another Claude Code session: choose it only if the user names it.
3. Show the user all sessions as a table in the order of `CM sessions`, the oldest first: label, state, directory, size, last activity; mark the chosen ones. Under the table give the filter, the number of the chosen sessions and their total size, and ask the user to confirm the deletion or to change the filter. Delete nothing before the user confirms. If no session is chosen, say so and stop.
4. After the confirmation, delete the chosen sessions: `CM purge <id> [<id> …]`. The command deletes every file of each session for good: the discussion, the images, the kept auto-apply. The pending `wait` of a deleted connected session ends with “session deleted”. If no connected sessions are left, the server stops.
   - If `purge` answers that another server version is on the port, run `CM stop`, then `CM purge` again.
5. In the chat report the deleted sessions and the freed size from the output of `purge`.
