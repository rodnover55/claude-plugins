-- Copies a live-comments link to the clipboard: the handler of lc-copy:<link> links
-- that the Claude Code status line puts on the ⧉ icon. Compiled into an applet
-- registered for the lc-copy URL scheme (install-copy-handler.sh). Links outside
-- the live-comments server are ignored, so that a foreign lc-copy: link cannot
-- put arbitrary text into the clipboard.
on open location theURL
	set prefix to "lc-copy:"
	if (length of theURL) is not greater than (length of prefix) then return
	if not (theURL starts with prefix) then return
	set theLink to text ((length of prefix) + 1) thru -1 of theURL
	if not (theLink starts with "http://127.0.0.1:8765/") then return
	set the clipboard to theLink
	display notification theLink with title "Link copied"
end open location
