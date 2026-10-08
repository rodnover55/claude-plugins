#!/bin/sh
# Installs the handler of lc-copy: links on macOS: compiles lc-copy.applescript
# into ~/.local/share/live-comments/LiveCommentsCopy.app, registers the app for
# the lc-copy URL scheme and hides it from the Dock. $XDG_DATA_HOME replaces
# ~/.local/share when it is set.
set -e
here=$(cd "$(dirname "$0")" && pwd)
dir=${XDG_DATA_HOME:-$HOME/.local/share}/live-comments
app=$dir/LiveCommentsCopy.app
plist=$app/Contents/Info.plist
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

mkdir -p "$dir"
if [ -d "$app" ]; then
  "$lsregister" -u "$app" 2>/dev/null || true
  rm -rf "$app"
fi
osacompile -o "$app" "$here/lc-copy.applescript"
plutil -replace CFBundleIdentifier -string io.github.rodnover55.live-comments-copy "$plist"
plutil -replace CFBundleName -string "Live Comments Copy" "$plist"
plutil -replace LSUIElement -bool true "$plist"
plutil -replace CFBundleURLTypes -json '[{"CFBundleURLName":"live-comments link copy","CFBundleURLSchemes":["lc-copy"]}]' "$plist"
# The edited Info.plist breaks the applet's signature: sign it again locally.
codesign --force --sign - "$app"
"$lsregister" -f "$app"
echo "lc-copy: links -> $app"
