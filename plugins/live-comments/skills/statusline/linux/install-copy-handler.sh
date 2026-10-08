#!/bin/sh
# Installs the handler of lc-copy: links on Linux: copies lc-copy to
# ~/.local/share/live-comments/, writes ~/.local/share/applications/live-comments-copy.desktop
# for x-scheme-handler/lc-copy and makes it the default handler with xdg-mime.
# $XDG_DATA_HOME replaces ~/.local/share when it is set. Prints the handler that
# was the default before, if there was one.
set -e
here=$(cd "$(dirname "$0")" && pwd)
data=${XDG_DATA_HOME:-$HOME/.local/share}
dir=$data/live-comments
apps=$data/applications
mime=x-scheme-handler/lc-copy

command -v xdg-mime >/dev/null 2>&1 || { echo "xdg-mime is not installed: install xdg-utils" >&2; exit 1; }
command -v wl-copy >/dev/null 2>&1 || command -v xclip >/dev/null 2>&1 || command -v xsel >/dev/null 2>&1 ||
  { echo "no clipboard tool: install wl-clipboard (Wayland) or xclip (X11)" >&2; exit 1; }

previous=$(xdg-mime query default $mime 2>/dev/null || true)
mkdir -p "$dir" "$apps"
cp "$here/lc-copy" "$dir/lc-copy"
chmod 755 "$dir/lc-copy"
cat > "$apps/live-comments-copy.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=live-comments Link Copy
Comment=Copies live-comments links from lc-copy: links of the Claude Code status line
Exec="$dir/lc-copy" %u
NoDisplay=true
MimeType=$mime;
EOF
xdg-mime default live-comments-copy.desktop $mime
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$apps" || true
fi
echo "lc-copy: links -> $(xdg-mime query default $mime) -> $dir/lc-copy"
if [ -n "$previous" ] && [ "$previous" != live-comments-copy.desktop ]; then
  echo "previous handler: $previous"
fi
