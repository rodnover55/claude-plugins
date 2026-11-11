"""Firefox without a window for the tests of the discussion pages.

The system Firefox is driven over its Marionette port: the mouse and the keys
go through the browser's own handling of input, so text is selected and typed
as by the user. The browser is the `firefox` of PATH, or the one named by
LIVE_COMMENTS_FIREFOX.
"""

import json
import os
import shutil
import socket
import subprocess
import time

# The keys of WebDriver that are held with others.
CTRL = "\ue009"
ALT = "\ue00a"
# The Esc key of WebDriver.
ESC = "\ue00c"

PREFS = """
user_pref("marionette.port", %d);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("app.update.enabled", false);
"""


def free_port():
    """Returns a TCP port of 127.0.0.1 nobody listens on."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def firefox_path():
    """Returns the path of the Firefox to run, or None if there is none."""
    return os.environ.get("LIVE_COMMENTS_FIREFOX") or shutil.which("firefox")


class Firefox:
    """A running Firefox and the Marionette session with it.

    profile — an empty directory for the browser's profile; a Firefox
    installed as a snap reads it only outside the hidden directories of the
    home directory.
    """

    def __init__(self, profile):
        self.port = free_port()
        os.makedirs(profile, exist_ok=True)
        with open(os.path.join(profile, "user.js"), "w", encoding="utf-8") as f:
            f.write(PREFS % self.port)
        self.proc = subprocess.Popen(
            [firefox_path(), "--headless", "--no-remote", "--profile", profile, "--marionette", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, start_new_session=True)
        self.sock = None
        self.buf = b""
        self.sent = 0
        for _ in range(300):
            try:
                self.sock = socket.create_connection(("127.0.0.1", self.port), timeout=60)
                break
            except OSError:
                time.sleep(0.1)
        if not self.sock:
            self.close()
            raise RuntimeError("Firefox did not open its Marionette port")
        self.receive()
        self.command("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {"pageLoadStrategy": "eager"}}})
        self.command("WebDriver:SetWindowRect", {"width": 1400, "height": 900})

    def receive(self):
        """Returns the next message of the browser."""
        while b":" not in self.buf:
            self.buf += self.sock.recv(65536)
        size, _, rest = self.buf.partition(b":")
        while len(rest) < int(size):
            rest += self.sock.recv(65536)
        self.buf = rest[int(size):]
        return json.loads(rest[:int(size)])

    def command(self, name, params=None):
        """Runs Marionette command name and returns its result; an error of
        the command is raised."""
        self.sent += 1
        data = json.dumps([0, self.sent, name, params or {}]).encode("utf-8")
        self.sock.sendall(str(len(data)).encode() + b":" + data)
        while True:
            msg = self.receive()
            if msg[0] == 1 and msg[1] == self.sent:
                if msg[2]:
                    raise RuntimeError(f"{name}: {msg[2].get('message')}")
                res = msg[3]
                return res["value"] if isinstance(res, dict) and "value" in res else res

    def open(self, url):
        self.command("WebDriver:Navigate", {"url": url})

    def js(self, script, *args):
        """Runs script as the body of a function in the page with args as its
        arguments and returns what it returns."""
        return self.command("WebDriver:ExecuteScript", {"script": script, "args": list(args)})

    def wait(self, script, *args, timeout=10):
        """Waits until script returns a true value and returns it."""
        end = time.time() + timeout
        while True:
            value = self.js(script, *args)
            if value:
                return value
            if time.time() > end:
                raise AssertionError("no such state of the page in %d seconds: %s" % (timeout, script))
            time.sleep(0.05)

    def mouse(self, *steps):
        """Moves the mouse: each step is ("move", x, y) in the window,
        ("down",) or ("up",) of the left button, or ("pause", milliseconds).
        Presses at one place soon after each other are a double click."""
        acts = []
        for step in steps:
            if step[0] == "move":
                acts.append({"type": "pointerMove", "x": int(step[1]), "y": int(step[2]), "duration": 0,
                             "origin": "viewport"})
            elif step[0] == "pause":
                acts.append({"type": "pause", "duration": step[1]})
            else:
                acts.append({"type": "pointerDown" if step[0] == "down" else "pointerUp", "button": 0})
        self.command("WebDriver:PerformActions", {"actions": [
            {"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": acts}]})

    def click(self, x, y):
        self.mouse(("move", x, y), ("down",), ("up",))

    def wheel(self, x, y, dy):
        """Turns the wheel by dy pixels at point (x, y) of the window."""
        self.command("WebDriver:PerformActions", {"actions": [
            {"type": "wheel", "id": "wheel", "actions": [
                {"type": "scroll", "x": int(x), "y": int(y), "deltaX": 0, "deltaY": int(dy), "duration": 0,
                 "origin": "viewport"}]}]})

    def keys(self, text, mod=None):
        """Types text; with mod — while the key mod (CTRL, ALT) is held."""
        acts = [{"type": "keyDown", "value": mod}] if mod else []
        for ch in text:
            acts += [{"type": "keyDown", "value": ch}, {"type": "keyUp", "value": ch}]
        if mod:
            acts.append({"type": "keyUp", "value": mod})
        self.command("WebDriver:PerformActions", {"actions": [{"type": "key", "id": "keys", "actions": acts}]})

    def release(self):
        """Releases the pressed buttons and keys and forgets the last click."""
        self.command("WebDriver:ReleaseActions")

    def close(self):
        try:
            if self.sock:
                self.sock.settimeout(5)
                self.command("Marionette:Quit", {"flags": ["eForceQuit"]})
        except (OSError, RuntimeError, ValueError):
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, 9)
            self.proc.wait()
