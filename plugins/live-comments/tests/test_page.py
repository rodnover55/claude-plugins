"""Tests of the discussion pages in Firefox: a re-render changes only the
elements that differ, so a selection being dragged, the focus, the typed
text and the scroll position stay.

    python3 -m unittest discover -s plugins/live-comments/tests

The tests start their own server and a Firefox without a window; without
Firefox they are skipped.
"""

import base64
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from browser import CTRL, ESC, Firefox, firefox_path, free_port
from server import Server

HERE = Path(__file__).resolve().parent
# The session whose pages have the status bar.
BAR_SESSION = "bar-session"

server = None
browser = None
work = None

# The middle of the first character after the start of text arguments[1]
# inside the first element arguments[0] that has it: {x, y} in the window.
POINT = """
for (const root of document.querySelectorAll(arguments[0])) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const at = node.data.indexOf(arguments[1]);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at + 1);
    range.setEnd(node, at + 2);
    const box = range.getBoundingClientRect();
    return {x: box.left + 1, y: box.top + box.height / 2};
  }
}
return null;
"""

# The selection: its text and where it starts and ends — the key of the
# message, "head" for the header, "other" for the rest.
SELECTION = """
const sel = getSelection();
if (!sel.rangeCount) return {text: "", start: null, end: null};
const range = sel.getRangeAt(0);
function place(node) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  const msg = el.closest(".lc-msg, tr[data-line]");
  if (msg) return msg.getAttribute("data-key") || "line";
  return el.closest(".lc-head") ? "head" : "other";
}
return {text: sel.toString(), start: place(range.startContainer), end: place(range.endContainer)};
"""

# The middle of the first element arguments[0], scrolled into the window: {x, y} in the window.
CENTER = """
const el = document.querySelector(arguments[0]);
el.scrollIntoView({block: "center"});
const box = el.getBoundingClientRect();
return {x: box.left + box.width / 2, y: box.top + box.height / 2};
"""

# Remembers the elements arguments[0] of the page.
KEEP = "window.lcKept = Array.from(document.querySelectorAll(arguments[0])); return window.lcKept.length;"
# Whether the remembered elements are still the elements arguments[0] of the page, in the same order.
KEPT = """
const now = Array.from(document.querySelectorAll(arguments[0]));
return window.lcKept.length > 0 && window.lcKept.every((el, i) => el.isConnected && el === now[i]);
"""


# The page as text: the elements with their attributes in the order of
# their names, without what a reload changes — the marks of new replies and
# the heights of the fields.
HTML = """
function text(node) {
  if (node.nodeType !== 1) return node.data;
  if (node.classList.contains("lc-new")) return "";
  const attrs = node.getAttributeNames().filter(a => a !== "style" || node.tagName !== "TEXTAREA").sort()
    .map(a => " " + a + "=" + JSON.stringify(node.getAttribute(a))).join("");
  return "<" + node.tagName + attrs + ">" + Array.from(node.childNodes, text).join("") + "</" + node.tagName + ">";
}
return text(document.getElementById("lc-app"));
"""

# Starts to record where the page changes: "head" for the header, otherwise
# the class of the changed element or of its nearest message.
WATCH = """
window.lcChanged = [];
new MutationObserver(list => list.forEach(m => {
  const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
  const part = el.closest(".lc-head, .lc-msg, .lc-replybox textarea");
  window.lcChanged.push(part ? (part.classList.contains("lc-head") ? "head" : part.className) : el.className || el.nodeName);
})).observe(document.getElementById("lc-app"), {childList: true, subtree: true, attributes: true, characterData: true});
"""


def setUpModule():
    global server, browser, work
    if not firefox_path():
        raise unittest.SkipTest("no Firefox: set LIVE_COMMENTS_FIREFOX")
    work = tempfile.mkdtemp(prefix="work-", dir=HERE)
    try:
        server = Server(Path(work) / "server", free_port(), sessions=[BAR_SESSION])
        browser = Firefox(str(Path(work) / "profile"))
    except Exception:
        tearDownModule()
        raise


def tearDownModule():
    if browser:
        browser.close()
    if server:
        server.close()
    if work:
        shutil.rmtree(work, ignore_errors=True)


def paragraphs(prefix, count):
    """Returns a Markdown text of count paragraphs; paragraph n has the word <prefix><n>."""
    return "\n\n".join(
        f"Paragraph {prefix}{n} says that the page keeps its elements while the discussion goes on, "
        f"and repeats it once more so that the paragraph takes a couple of lines of the page."
        for n in range(count))


class PageTest(unittest.TestCase):
    def setUp(self):
        self.sid = "s" + uuid.uuid4().hex[:12]
        self.updates = 0
        self.open_session()

    def tearDown(self):
        browser.release()

    def open_session(self, **data):
        server.post("/api/sessions", {"session": self.sid, "label": "Tests", **data})

    def topic(self, text, reply=None):
        """Creates a top-level question with Claude's reply and returns its id."""
        tid = server.post(f"/api/{self.sid}/topics", {"text": text})["id"]
        if reply:
            self.reply(tid, reply)
        return tid

    def reply(self, tid, text):
        server.post(f"/api/{self.sid}/topics/{tid}/claude", {"text": text})

    def ask(self, tid, text):
        server.post(f"/api/{self.sid}/topics/{tid}/messages", {"text": text})

    def page(self, path="", ready=".lc-head"):
        browser.open(f"{server.origin}/{self.sid}{path}")
        browser.wait("return !!document.querySelector(arguments[0])", ready)

    def update(self, topic=None):
        """Changes the state of the session and waits until the page shows
        it; topic — the topic Claude is said to work on."""
        self.updates += 1
        text = f"working on step {self.updates}"
        server.post(f"/api/{self.sid}/activity", {"text": text, "topic": topic})
        browser.wait("return document.querySelector('.lc-status').textContent.includes(arguments[0])", text)

    def same_after_reload(self):
        """The page brought to the state by updates is the page a reload shows."""
        self.update()
        before = browser.js(HTML)
        browser.js("location.reload()")
        browser.wait("const s = document.querySelector('.lc-status'); return s && s.textContent.includes(arguments[0])",
                     f"working on step {self.updates}")
        time.sleep(0.2)
        self.assertEqual(browser.js(HTML), before)

    def point(self, text, root=".lc-msg"):
        at = browser.js(POINT, root, text)
        self.assertIsNotNone(at, f"no text {text!r} in {root}")
        return at

    def press(self, selector):
        """Clicks the middle of the first element selector."""
        at = browser.js(CENTER, selector)
        browser.click(at["x"], at["y"])

    def drag(self, at, dy, clicks=1, held=None, moving=None):
        """Presses the left button at point at — the last of clicks presses is
        held — moves the mouse by dy pixels and releases it. held runs after
        the press, moving — in the middle of the way."""
        steps = [("move", at["x"], at["y"])] + [("down",), ("up",)] * (clicks - 1) + [("down",)]
        browser.mouse(*steps)
        if held:
            held()
        way = list(range(15, abs(dy) + 1, 15))
        for i, d in enumerate(way):
            browser.mouse(("move", at["x"] + 2, at["y"] + (d if dy > 0 else -d)))
            if moving and i == len(way) // 2:
                moving()
        browser.mouse(("up",))
        return browser.js(SELECTION)


class SelectionTest(PageTest):
    """A selection dragged with the mouse starts where the button was
    pressed, whatever happens to the page meanwhile."""

    def setUp(self):
        super().setUp()
        self.tid = self.topic("How does the page keep a selection?", paragraphs("word", 30))
        self.page("/" + self.tid, ".lc-msg.lc-claude")
        browser.js("window.scrollTo(0, 300)")

    def select_before(self):
        """Leaves a selection on the page and changes the state of the session."""
        at = self.point("word2 ")
        browser.mouse(("move", at["x"], at["y"]), ("down",), ("move", at["x"] + 80, at["y"]), ("up",))
        self.assertTrue(browser.js(SELECTION)["text"])
        self.update()

    def check(self, sel, down, word="word9"):
        """sel starts at the pressed word of Claude's reply when dragged down, and ends there when dragged up."""
        self.assertNotIn("head", (sel["start"], sel["end"]), sel["text"][:80])
        self.assertTrue(sel["start"] and sel["start"].startswith("m:"), sel)
        self.assertEqual(sel["start"], sel["end"])
        if down:
            self.assertTrue(sel["text"].startswith(word[1:]) or sel["text"].startswith(word), sel["text"][:80])
        else:
            self.assertTrue(sel["text"].endswith(word[:1]) or sel["text"].endswith(word), sel["text"][-80:])
        self.assertGreater(len(sel["text"]), 60)

    def test_press_after_update_with_old_selection(self):
        for down in (True, False):
            with self.subTest(down=down):
                self.select_before()
                self.check(self.drag(self.point("word9 "), 150 if down else -150), down)

    def test_update_while_button_is_held(self):
        for down in (True, False):
            with self.subTest(down=down):
                self.check(self.drag(self.point("word9 "), 150 if down else -150, held=self.update), down)

    def test_update_while_dragging(self):
        for down in (True, False):
            with self.subTest(down=down):
                self.check(self.drag(self.point("word9 "), 150 if down else -150, moving=self.update), down)

    def test_double_click_and_drag(self):
        for down in (True, False):
            with self.subTest(down=down):
                self.select_before()
                sel = self.drag(self.point("word9 "), 150 if down else -150, clicks=2, held=self.update,
                                moving=self.update)
                self.check(sel, down)
                self.assertTrue(sel["text"].startswith("word9") if down else sel["text"].endswith("word9"))

    def test_new_reply_comes_while_text_is_selected(self):
        sel = self.drag(self.point("word9 "), 150)
        self.ask(self.tid, "One more question")
        self.reply(self.tid, "The second reply of Claude")
        browser.wait("return document.querySelectorAll('.lc-msg').length === 4")
        self.assertEqual(browser.js(SELECTION), sel)

    def test_quote_button_puts_selection_into_field(self):
        self.drag(self.point("word9 "), 60)
        browser.wait("const b = document.querySelector('.lc-dbar'); return b && !b.hidden;")
        self.update()
        self.press(".lc-dbar button")
        value = browser.js("return document.querySelector('textarea[data-key]').value")
        self.assertTrue(value.startswith("> ") and "word9" in value, value[:60])


class StableTest(PageTest):
    """A re-render leaves the elements that have not changed in the page."""

    def setUp(self):
        super().setUp()
        self.tid = self.topic("How does the page keep its elements?", paragraphs("word", 30))

    def test_messages_stay_on_update(self):
        self.page("/" + self.tid, ".lc-msg.lc-claude")
        parts = ".lc-msg, .lc-md, .lc-md p, textarea, .lc-replybox button"
        self.assertGreater(browser.js(KEEP, parts), 30)
        self.update()
        self.ask(self.tid, "One more question")
        self.reply(self.tid, "The second reply of Claude")
        browser.wait("return document.querySelectorAll('.lc-msg').length === 4")
        self.assertTrue(browser.js("return window.lcKept.every(el => el.isConnected)"))
        self.assertEqual(browser.js("return document.querySelectorAll('.lc-msg')[3].textContent"),
                         "ClaudenewThe second reply of Claude")

    def test_update_changes_only_what_differs(self):
        self.page("/" + self.tid, ".lc-msg.lc-claude")
        browser.js(WATCH)
        self.update()
        self.update()
        changed = browser.js("return window.lcChanged")
        self.assertTrue(changed)
        self.assertEqual(set(changed), {"head"})

    def test_change_of_another_topic_leaves_the_discussion(self):
        other = self.topic("Another question", "Another reply")
        self.page("/" + self.tid, ".lc-msg.lc-claude")
        self.update()
        browser.js(WATCH)
        self.ask(other, "One more question")
        self.reply(other, "One more reply")
        self.update()
        changed = set(browser.js("return window.lcChanged"))
        self.assertFalse([c for c in changed if "lc-msg" in c or "lc-textarea" in c], changed)

    def test_page_after_updates_is_the_page_after_reload(self):
        other = self.topic("Another question", "Another reply")
        self.page("/" + self.tid, ".lc-msg.lc-claude")
        # What Claude does for the topic stands above the reply field.
        for step in (1, 2):
            self.update(self.tid)
            self.assertEqual(browser.js("return document.querySelector('.lc-claude-status').textContent"),
                             f"working on step {step}")
        self.ask(self.tid, "One more question")
        self.same_after_reload()
        self.assertEqual(server.get(f"/api/{self.sid}/next?timeout=5")["task"]["tid"], self.tid)
        self.same_after_reload()
        self.reply(self.tid, "The second reply\n\n- with a list\n- of two items")
        made = server.post(f"/api/{self.sid}/topics/{self.tid}/branch", {"questions": [
            {"title": "The first subquestion", "text": "Its text"}, {"title": "The second subquestion", "text": "Its text"}]})
        self.same_after_reload()
        self.ask(other, "One more question")
        self.reply(other, "One more reply")
        server.post(f"/api/{self.sid}/topics/{made['topics'][0]['id']}/decision", {"decision": "Decided **so**"})
        server.post(f"/api/{self.sid}/topics/{made['topics'][1]['id']}/close")
        self.same_after_reload()
        server.post(f"/api/{self.sid}/topics/{self.tid}/resolve", {"text": "My decision"})
        self.same_after_reload()
        server.post(f"/api/{self.sid}/topics/{self.tid}/decision", {"decision": "The decision of the question"})
        server.post(f"/api/{self.sid}/topics/{other}/close")
        self.same_after_reload()

    def test_field_keeps_text_cursor_focus_and_undo(self):
        self.page("/" + self.tid, "textarea[data-key]")
        self.press("textarea[data-key]")
        browser.keys("hello world")
        browser.js("window.lcField = document.activeElement; window.lcField.setSelectionRange(5, 5);")
        self.update()
        self.ask(self.tid, "One more question")
        self.reply(self.tid, "The second reply of Claude")
        browser.wait("return document.querySelectorAll('.lc-msg').length === 4")
        state = browser.js("""
            const ta = document.activeElement;
            return [ta === window.lcField, ta.isConnected, ta.value, ta.selectionStart, ta.selectionEnd];
        """)
        self.assertEqual(state, [True, True, "hello world", 5, 5])
        browser.keys("z", CTRL)
        value = browser.js("return window.lcField.value")
        self.assertNotEqual(value, "hello world")
        self.assertTrue("hello world".startswith(value), value)

    def test_sent_reply_leaves_field_empty(self):
        self.page("/" + self.tid, "textarea[data-key]")
        self.press("textarea[data-key]")
        browser.keys("a reply of the user")
        browser.js("window.lcField = document.activeElement;")
        self.press("button[data-act=reply]")
        browser.wait("return document.querySelectorAll('.lc-msg.lc-user').length === 2")
        self.assertEqual(browser.js("return [window.lcField.isConnected, window.lcField.value]"), [True, ""])
        self.assertEqual(browser.js("return document.querySelectorAll('.lc-msg.lc-user .lc-md')[1].textContent"),
                         "a reply of the user")

    def test_scroll_position_stays(self):
        self.page("/" + self.tid, ".lc-msg.lc-claude")
        for y in (400, 100000):
            with self.subTest(y=y):
                browser.js("window.scrollTo(0, arguments[0])", y)
                count = browser.js("return document.querySelectorAll('.lc-msg').length")
                before = browser.js("return [Math.round(scrollY), Math.round(document.querySelector('.lc-md p')"
                                    ".getBoundingClientRect().top)]")
                self.update()
                self.ask(self.tid, "One more question")
                self.reply(self.tid, paragraphs("more", 3))
                browser.wait("return document.querySelectorAll('.lc-msg').length === arguments[0]", count + 2)
                after = browser.js("return [Math.round(scrollY), Math.round(document.querySelector('.lc-md p')"
                                   ".getBoundingClientRect().top)]")
                self.assertEqual(after, before)

    def test_reply_menu_stays_open_on_update(self):
        self.page("/" + self.tid, "textarea[data-key]")
        self.press("button[data-act=reply-menu]")
        self.assertEqual(browser.js(KEEP, ".lc-menu"), 1)
        self.update()
        self.assertTrue(browser.js(KEPT, ".lc-menu"))
        at = self.point("word29 ")
        browser.click(at["x"], at["y"])
        self.assertEqual(browser.js("return document.querySelectorAll('.lc-menu').length"), 0)

    def test_questions_window_and_side_panel_stay_on_update(self):
        self.topic("Another question", "Another reply")
        self.page("/" + self.tid, ".lc-msg.lc-claude")
        self.press("button[data-act=tree-menu]")
        self.assertEqual(browser.js(KEEP, ".lc-tree-menu, .lc-tree-menu li"), 3)
        self.update()
        self.assertTrue(browser.js(KEPT, ".lc-tree-menu, .lc-tree-menu li"))
        self.press("button[data-act=tree-side]")
        self.assertEqual(browser.js(KEEP, ".lc-side, .lc-side li"), 3)
        self.assertEqual(browser.js("return document.querySelectorAll('.lc-tree-menu, [data-act=tree-menu]').length"), 0)
        self.update()
        self.assertTrue(browser.js(KEPT, ".lc-side, .lc-side li"))
        self.press("button[data-act=tree-unside]")
        self.assertEqual(browser.js("return [document.querySelectorAll('.lc-side').length, "
                                    "document.querySelectorAll('[data-act=tree-menu]').length]"), [0, 1])

    def test_drafts_button_leads_to_the_field(self):
        other = self.topic("Another question", "Another reply")
        self.page("/" + self.tid, "textarea[data-key]")
        self.press("textarea[data-key]")
        browser.keys("a draft")
        self.page("/" + other, "a[data-draft]")
        self.press("a[data-draft]")
        browser.wait("return location.pathname.endsWith(arguments[0]) && document.activeElement.tagName === 'TEXTAREA'",
                     self.tid)
        self.assertEqual(browser.js("return document.activeElement.value"), "a draft")


# A Markdown text with a diff block of one changed line.
DIFF_BLOCK = """The change:

```diff
@@ -3,3 +3,3 @@
 line before
-old line
+new line
 line after
```
"""


class DiffBlockTest(PageTest):
    """A diff code block of a message is shown as a diff, side by side or inline."""

    def setUp(self):
        super().setUp()
        self.tid = self.topic("What does the change look like?\n\n" + DIFF_BLOCK, DIFF_BLOCK)
        self.page("/" + self.tid, ".lc-msg.lc-claude .lc-mdiff")

    def tearDown(self):
        # The view is the one of the changes page: its tests start with the default one.
        browser.js("localStorage.removeItem('lc-diff-mode')")
        super().tearDown()

    def cells(self, selector):
        return browser.js("return Array.from(document.querySelectorAll(arguments[0]), el => el.textContent)", selector)

    def test_view_switch_redraws_the_blocks_of_both_sides(self):
        self.assertEqual(browser.js("return document.querySelectorAll('.lc-msg .lc-mdiff').length"), 2)
        self.press(".lc-msg .lc-code-diff button[data-mode=split]")
        browser.wait("return document.querySelectorAll('.lc-msg .lc-dt-split').length === 2")
        self.assertEqual(self.cells(".lc-claude tr:has(.lc-cadd) td"), ["4", "old line", "4", "new line"])
        self.press(".lc-msg .lc-code-diff button[data-mode=inline]")
        browser.wait("return document.querySelectorAll('.lc-msg .lc-dt-inline').length === 2")
        self.assertEqual(self.cells(".lc-claude tr.lc-dr-del td, .lc-claude tr.lc-dr-add td"),
                         ["4", "", "-", "old line", "", "4", "+", "new line"])
        self.assertEqual(self.cells(".lc-msg .lc-code-diff button.lc-on"), ["Inline", "Inline"])
        self.same_after_reload()

    def test_blocks_stay_on_update(self):
        browser.js(KEEP, ".lc-msg .lc-mdiff, .lc-msg .lc-mdiff td")
        self.update()
        self.assertTrue(browser.js(KEPT, ".lc-msg .lc-mdiff, .lc-msg .lc-mdiff td"))

    def test_quote_button_puts_selected_lines_as_a_diff_block(self):
        self.press(".lc-msg .lc-code-diff button[data-mode=inline]")
        browser.wait("return document.querySelectorAll('.lc-msg .lc-dt-inline').length === 2")
        self.drag(self.point("old line", ".lc-claude .lc-mdiff"), 18)
        browser.wait("const b = document.querySelector('.lc-dbar'); return b && !b.hidden;")
        self.press(".lc-dbar button")
        value = browser.js("return document.querySelector('textarea[data-key]').value")
        self.assertEqual(value.strip(), "> ```diff\n> -old line\n> +new line\n> ```")


# An SVG image wider than a message.
PICTURE = b'''<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="800">
<rect width="1600" height="800" fill="#4488cc"/><circle cx="400" cy="400" r="200" fill="#ffffff"/></svg>'''

# A Markdown text with a code block and a PlantUML diagram.
BLOCKS = """The code:

```python
print("code")
```

The diagram:

```plantuml
@startuml
Alice -> Bob
@enduml
```
"""

# The place of the first element arguments[0] in the window: {x, y, w, h}.
RECT = """
const box = document.querySelector(arguments[0]).getBoundingClientRect();
return {x: box.left, y: box.top, w: box.width, h: box.height};
"""


class FullScreenTest(PageTest):
    """The "Full screen" button shows a code block, a diagram or an image in a
    window over the whole page; a diagram and an image are zoomed and moved
    there."""

    def setUp(self):
        super().setUp()
        url = server.post(f"/api/{self.sid}/images", {"data": base64.b64encode(PICTURE).decode("ascii")})["url"]
        self.tid = self.topic("How does it look?", f"The picture:\n\n![a picture]({url})\n\n" + BLOCKS + DIFF_BLOCK)
        self.page("/" + self.tid, ".lc-msg.lc-claude .lc-mdiff")
        # The image and the diagram move the blocks under them when they come.
        browser.wait("return document.querySelector('.lc-claude img').naturalWidth > 0 && "
                     "!!document.querySelector('.lc-claude .lc-diagram-ready, .lc-claude .lc-diagram-error')", timeout=60)

    def tearDown(self):
        browser.js("localStorage.removeItem('lc-diff-mode')")
        super().tearDown()

    def rect(self, selector):
        return browser.js(RECT, selector)

    def open_window(self, block, shown):
        """Presses "Full screen" of block and waits for element shown of the window."""
        self.press(f".lc-claude {block} [data-act=full]")
        browser.wait("return !!document.querySelector('.lc-full:not([hidden]) ' + arguments[0])", shown)

    def assert_near(self, a, b, delta=1.5):
        for key in a:
            self.assertAlmostEqual(a[key], b[key], delta=delta, msg=f"{key}: {a} != {b}")

    def test_code_block_fills_the_page_and_esc_closes_it(self):
        browser.js(KEEP, ".lc-msg .lc-code, .lc-msg pre")
        self.open_window(".lc-code:not(.lc-code-diff)", "pre")
        scrolled = browser.js("return scrollY")
        self.assert_near(self.rect(".lc-full"), browser.js("return {x: 0, y: 0, w: innerWidth, h: innerHeight}"))
        self.assertEqual(browser.js("return document.querySelector('.lc-full pre').textContent"), 'print("code")')
        browser.keys(ESC)
        browser.wait("return document.querySelector('.lc-full').hidden")
        self.assertEqual(browser.js("return document.activeElement.getAttribute('data-act')"), "full")
        self.assertGreater(scrolled, 0)
        self.assertEqual(browser.js("return scrollY"), scrolled)
        self.assertTrue(browser.js(KEPT, ".lc-msg .lc-code, .lc-msg pre"))

    def test_button_is_an_icon_after_the_other_buttons(self):
        buttons = "Array.from(document.querySelectorAll('.lc-claude [data-act=full]')).filter(b => b.offsetParent)"
        # Of the image, the code block, the diagram and the diff block.
        self.assertEqual(browser.js(f"return {buttons}.length"), 4)
        self.assertTrue(browser.js(f"return {buttons}.every(b => !b.textContent && b.title === 'Full screen' && "
                                   "b.querySelector('svg') && b === b.parentNode.lastElementChild)"))
        # Inside the block: not beyond the edge of the code, the head, the diagram or the image.
        self.assertTrue(browser.js(f"""return {buttons}.every(b => {{
          const box = b.closest(".lc-img, .lc-code, .lc-diagram");
          const shown = box.querySelector(":scope > img, :scope > .lc-diagram-view, :scope > .lc-code-head") ||
            box.querySelector(":scope > pre");
          const at = b.getBoundingClientRect(), edge = shown.getBoundingClientRect();
          return at.right <= edge.right && at.left >= edge.left && at.top >= edge.top;
        }})"""))
        if shutil.which("plantuml"):
            self.press(".lc-claude .lc-diagram-toggle")
            self.assertEqual(browser.js("return Array.from(document.querySelectorAll('.lc-claude .lc-diagram button'))"
                                        ".filter(b => b.offsetParent).map(b => b.textContent || b.title)"),
                             ["Copy", "diagram", "Full screen"])

    def test_diff_block_switches_its_view_in_the_window(self):
        self.open_window(".lc-code-diff", ".lc-dtable")
        for mode, label in (("split", "Side by side"), ("inline", "Inline")):
            self.press(f".lc-full button[data-mode={mode}]")
            browser.wait("return !!document.querySelector('.lc-full .lc-dt-' + arguments[0]) && "
                         "!!document.querySelector('.lc-msg .lc-dt-' + arguments[0])", mode)
            self.assertEqual(browser.js("return document.querySelector('.lc-full button.lc-on').textContent"), label)
        self.press(".lc-full [data-act=close-full]")
        browser.wait("return document.querySelector('.lc-full').hidden")

    def test_image_is_zoomed_by_the_wheel_and_moved_by_dragging(self):
        self.open_window(".lc-img", ".lc-full-view img")
        view, fitted = self.rect(".lc-full-view"), self.rect(".lc-full-view img")
        self.assertAlmostEqual(fitted["w"] / fitted["h"], 2, delta=0.01)
        self.assertGreaterEqual(fitted["x"], view["x"])
        self.assertLessEqual(fitted["x"] + fitted["w"], view["x"] + view["w"])
        self.assertAlmostEqual(fitted["x"] - view["x"], view["x"] + view["w"] - fitted["x"] - fitted["w"], delta=1.5)
        # The point of the image under the pointer stays under it.
        at = {"x": fitted["x"] + fitted["w"] * 0.25, "y": fitted["y"] + fitted["h"] * 0.5}
        browser.wheel(at["x"], at["y"], -240)
        zoomed = self.rect(".lc-full-view img")
        self.assertGreater(zoomed["w"], fitted["w"] * 1.3)
        self.assertAlmostEqual((at["x"] - zoomed["x"]) / zoomed["w"], 0.25, delta=0.01)
        self.assertAlmostEqual((at["y"] - zoomed["y"]) / zoomed["h"], 0.5, delta=0.01)
        browser.mouse(("move", at["x"], at["y"]), ("down",))
        browser.mouse(("move", at["x"] + 60, at["y"] - 40))
        browser.mouse(("up",))
        moved = self.rect(".lc-full-view img")
        self.assert_near(moved, {"x": zoomed["x"] + 60, "y": zoomed["y"] - 40, "w": zoomed["w"], "h": zoomed["h"]})
        self.press(".lc-full [data-act=fit]")
        self.assert_near(self.rect(".lc-full-view img"), fitted)

    @unittest.skipUnless(shutil.which("plantuml"), "no plantuml")
    def test_diagram_is_zoomed_by_the_buttons(self):
        self.open_window(".lc-diagram > .lc-tools", ".lc-full-view img")
        fitted = self.rect(".lc-full-view img")
        self.press(".lc-full [data-act=zoom][title='Zoom in']")
        zoomed = self.rect(".lc-full-view img")
        self.assertAlmostEqual(zoomed["w"], fitted["w"] * 1.25, delta=1.5)
        self.assertAlmostEqual(zoomed["x"] + zoomed["w"] / 2, fitted["x"] + fitted["w"] / 2, delta=1.5)
        browser.keys(ESC)
        browser.wait("return document.querySelector('.lc-full').hidden")
        # In the source of the diagram the window shows the code.
        self.press(".lc-claude .lc-diagram-toggle")
        self.open_window(".lc-diagram > .lc-tools", "pre")
        self.assertIn("Alice -> Bob", browser.js("return document.querySelector('.lc-full pre').textContent"))


class TreeTest(PageTest):
    """The tree of questions of the session page."""

    def rows(self):
        return browser.js("return Array.from(document.querySelectorAll('.lc-root > li')).map(li => "
                          "li.getAttribute('data-tid'))")

    def test_rows_stay_and_move(self):
        first = self.topic("The first question", "The first reply")
        second = self.topic("The second question", "The second reply")
        self.page("", ".lc-root > li")
        self.assertEqual(self.rows(), [first, second])
        browser.js(KEEP, ".lc-root > li")
        self.update()
        self.assertTrue(browser.js(KEPT, ".lc-root > li"))
        # A resolved question goes below the open ones.
        server.post(f"/api/{self.sid}/topics/{first}/decision", {"decision": "Decided"})
        browser.wait("return document.querySelector('.lc-root > li').getAttribute('data-tid') === arguments[0]", second)
        self.assertEqual(self.rows(), [second, first])
        self.assertTrue(browser.js("return window.lcKept.every(el => el.isConnected)"))
        third = self.topic("The third question")
        browser.wait("return document.querySelectorAll('.lc-root > li').length === 3")
        self.assertEqual(self.rows(), [second, third, first])
        self.assertTrue(browser.js("return window.lcKept.every(el => el.isConnected)"))

    def test_page_after_updates_is_the_page_after_reload(self):
        first = self.topic("The first question", "The first reply")
        second = self.topic("The second question", "The second reply")
        self.page("", ".lc-root > li")
        made = server.post(f"/api/{self.sid}/topics/{first}/branch", {"questions": [
            {"title": "The first subquestion", "text": "Its text"}, {"title": "The second subquestion", "text": "Its text"}]})
        self.update()
        self.press(".lc-tog[data-act=toggle]")
        self.same_after_reload()
        self.ask(second, "One more question")
        self.same_after_reload()
        self.reply(second, "One more reply")
        server.post(f"/api/{self.sid}/topics/{made['topics'][0]['id']}/decision", {"decision": "Decided"})
        self.topic("The third question")
        self.same_after_reload()
        server.post(f"/api/{self.sid}/topics/{made['topics'][1]['id']}/close")
        server.post(f"/api/{self.sid}/topics/{first}/decision", {"decision": "The decision of the first question"})
        self.same_after_reload()
        server.post(f"/api/sessions/{self.sid}/apply")
        self.same_after_reload()
        self.assertEqual(len(self.rows()), 2)

    def test_asked_question_becomes_a_row(self):
        self.topic("The first question", "The first reply")
        self.page("", "textarea[data-key=new]")
        browser.js(KEEP, "textarea[data-key=new], .lc-root > li")
        self.press("textarea[data-key=new]")
        browser.keys("a new question")
        self.update()
        self.assertEqual(browser.js("return [document.activeElement.value, document.activeElement.selectionStart]"),
                         ["a new question", 14])
        self.press("button[data-act=ask]")
        browser.wait("return document.querySelectorAll('.lc-root > li').length === 2")
        self.assertTrue(browser.js("return window.lcKept.every(el => el.isConnected)"))
        self.assertEqual(browser.js("return document.querySelector('textarea[data-key=new]').value"), "")
        self.assertEqual(browser.js("return document.querySelectorAll('.lc-root > li .lc-title')[1].textContent"),
                         "a new question")

    def test_subquestions_expand(self):
        tid = self.topic("The question with subquestions", "The reply")
        server.post(f"/api/{self.sid}/topics/{tid}/branch", {"questions": [
            {"title": "The first subquestion", "text": "Its text"}, {"title": "The second subquestion", "text": "Its text"}]})
        self.page("", ".lc-root > li")
        self.assertEqual(browser.js("return document.querySelectorAll('.lc-root li li').length"), 0)
        self.press(".lc-tog[data-act=toggle]")
        self.assertEqual(browser.js(KEEP, ".lc-root li"), 3)
        self.update()
        self.assertTrue(browser.js(KEPT, ".lc-root li"))
        self.press(".lc-tog[data-act=toggle]")
        self.assertEqual(browser.js("return document.querySelectorAll('.lc-root li li').length"), 0)

    def test_apply_resolved_once_applies_and_turns_off(self):
        first = self.topic("The first question", "The first reply")
        second = self.topic("The second question", "The second reply")
        server.post(f"/api/{self.sid}/topics/{first}/decision", {"decision": "Decided"})
        self.page("", ".lc-root > li")
        self.press("button[data-act=apply-menu]")
        self.press("button[data-act=auto-apply-once]")
        browser.wait("return !!document.querySelector('.lc-split .lc-badge')")
        self.assertEqual(browser.js("return document.querySelector('.lc-split .lc-badge').textContent"),
                         "applies once · open: 1")
        self.assertEqual(self.rows(), [second, first])
        server.post(f"/api/{self.sid}/topics/{second}/decision", {"decision": "Decided"})
        browser.wait("return !document.querySelector('.lc-root > li')")
        self.assertIsNone(browser.js("return document.querySelector('.lc-split .lc-badge')"))
        state = server.get(f"/api/{self.sid}/wait?rev=-1")
        self.assertEqual([state["applied"], state["autoApply"]], [1, None])
        # The next resolved question stays in the discussion.
        third = self.topic("The third question")
        server.post(f"/api/{self.sid}/topics/{third}/decision", {"decision": "Decided"})
        browser.wait("return !!document.querySelector('.lc-root > li.lc-resolved')")
        self.assertEqual(self.rows(), [third])
        self.assertEqual(server.get(f"/api/{self.sid}/wait?rev=-1")["applied"], 1)

    def test_apply_resolved_once_leaves_the_auto_apply_of_other_discussions(self):
        def starts_with_auto_apply(sid):
            server.post("/api/sessions", {"session": sid, "label": "Tests"})
            return bool(server.get(f"/api/{sid}/wait?rev=-1")["autoApply"])

        def new():
            return "s" + uuid.uuid4().hex[:12]

        self.topic("The first question", "The first reply")
        server.post(f"/api/sessions/{self.sid}/auto-apply", {"on": True, "once": True})
        self.assertFalse(starts_with_auto_apply(new()))
        other = new()
        self.assertFalse(starts_with_auto_apply(other))
        self.addCleanup(server.post, f"/api/sessions/{other}/auto-apply", {"on": False})
        server.post(f"/api/sessions/{other}/auto-apply", {"on": True})
        # Cancelling the one for one time leaves the auto-apply of new sessions on.
        server.post(f"/api/sessions/{self.sid}/auto-apply", {"on": False})
        self.assertTrue(starts_with_auto_apply(new()))
        # The next discussion of the session starts without it.
        server.post(f"/api/sessions/{self.sid}/auto-apply", {"on": True, "once": True})
        server.post(f"/api/sessions/{self.sid}/delete")
        self.assertFalse(starts_with_auto_apply(self.sid))


class StatusBarTest(PageTest):
    """The status bar at the bottom of the pages."""

    def setUp(self):
        self.sid = BAR_SESSION
        self.updates = 0
        self.open_session()

    def test_bar_changes_only_what_differs(self):
        self.page("", ".lc-sbar .lc-sb-item")
        self.assertEqual(browser.js("return document.querySelector('.lc-sbar').textContent"), "notenone")
        browser.js(KEEP, ".lc-sbar .lc-sb-item, .lc-sbar .lc-sb-item span")
        browser.js(WATCH)
        server.post(f"/api/{self.sid}/statusline", {"note": "sent"})
        browser.wait("return document.querySelector('.lc-sbar').textContent === 'notesent'")
        self.assertTrue(browser.js(KEPT, ".lc-sbar .lc-sb-item, .lc-sbar .lc-sb-item span"))
        self.assertEqual(browser.js("return window.lcChanged"), [])


@unittest.skipUnless(shutil.which("git"), "no git")
class DiffTest(PageTest):
    """The change review page."""

    def setUp(self):
        self.sid = "s" + uuid.uuid4().hex[:12]
        self.updates = 0
        repo = Path(work) / ("repo-" + self.sid)
        repo.mkdir()
        lines = [f"line {n} of the file" for n in range(40)]
        (repo / "file.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

        def git(*args):
            subprocess.run(["git", "-c", "user.name=tests", "-c", "user.email=tests@example.com", *args], cwd=repo,
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        git("init")
        git("add", ".")
        git("commit", "-m", "initial")
        for n in (5, 6, 20):
            lines[n] = f"changed line {n} of the file"
        (repo / "file.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.open_session(repo=str(repo))
        self.page("/diff", "tr.lc-dr")

    def test_lines_stay_on_update(self):
        self.assertGreater(browser.js(KEEP, "tr.lc-dr, tr.lc-dr td"), 20)
        self.update()
        self.topic("A question that changes the session")
        self.update()
        self.assertTrue(browser.js(KEPT, "tr.lc-dr, tr.lc-dr td"))

    def test_view_switch_redraws_lines(self):
        browser.js(KEEP, "tr.lc-dr")
        self.press("button[data-mode=inline]")
        browser.wait("return !!document.querySelector('.lc-dt-inline tr.lc-dr-add')")
        self.assertFalse(browser.js("return window.lcKept.some(el => el.isConnected)"))

    def test_selection_of_lines_survives_update(self):
        sel = self.drag(self.point("changed line 5", "td.lc-cadd"), 45, held=self.update, moving=self.update)
        self.assertEqual((sel["start"], sel["end"]), ("line", "line"))
        self.assertTrue(sel["text"].startswith("hanged line 5"), sel["text"][:60])
        self.assertIn("line 6", sel["text"])

    def test_page_after_updates_is_the_page_after_reload(self):
        anchor = {"kind": "diff", "file": "file.txt", "staged": False, "side": "new", "start": 6, "end": 7,
                  "rows": ["+changed line 5 of the file", "+changed line 6 of the file"],
                  "quote": "+changed line 5 of the file\n+changed line 6 of the file"}
        tid = server.post(f"/api/{self.sid}/topics", {"text": "Why are these lines changed?", "anchor": anchor})["id"]
        self.same_after_reload()
        self.reply(tid, "Because of the tests")
        self.topic("A question that is not on lines", "A reply")
        self.same_after_reload()
        self.ask(tid, "One more question")
        self.same_after_reload()
        # Claude's work on the question alone shows in the discussion under the lines.
        self.assertEqual(server.get(f"/api/{self.sid}/next?timeout=5")["task"]["tid"], tid)
        self.same_after_reload()
        for _ in range(2):
            self.update(tid)
            self.assertEqual(browser.js("return document.querySelector('.lc-dcard .lc-claude-status').textContent"),
                             f"working on step {self.updates}")
        self.reply(tid, "One more reply")
        made = server.post(f"/api/{self.sid}/topics/{tid}/branch", {"questions": [
            {"title": "A subquestion of the question on lines", "text": "Its text"}]})
        self.same_after_reload()
        # A change of the subquestion alone shows there too.
        server.post(f"/api/{self.sid}/topics/{made['topics'][0]['id']}/close")
        self.same_after_reload()
        server.post(f"/api/{self.sid}/topics/{tid}/decision", {"decision": "Decided"})
        self.same_after_reload()

    def test_question_on_lines(self):
        self.drag(self.point("changed line 5", "td.lc-cadd"), 20)
        browser.wait("const b = document.querySelector('[data-act=comment-rows]'); return b && !b.closest('[hidden]');")
        self.press("[data-act=comment-rows]")
        browser.wait("return document.activeElement.getAttribute('data-key') === 'diffnew'")
        browser.keys("why these lines?")
        browser.js(KEEP, "textarea[data-key=diffnew], tr.lc-dr")
        self.update()
        self.assertTrue(browser.js("return window.lcKept.every(el => el.isConnected)"))
        self.assertEqual(browser.js("return [window.lcKept.includes(document.activeElement), "
                                    "document.activeElement.value]"), [True, "why these lines?"])
        self.press("[data-act=diff-ask]")
        browser.wait("return !!document.querySelector('.lc-dcard[data-tid] .lc-msg')")
        self.assertEqual(browser.js("return document.querySelector('.lc-dcard[data-tid] .lc-msg .lc-md').textContent"),
                         "why these lines?")
        self.assertEqual(browser.js("return document.querySelectorAll('textarea[data-key=diffnew]').length"), 0)
        self.assertTrue(browser.js("return window.lcKept.every(el => el.isConnected === (el.tagName === 'TR'))"))


if __name__ == "__main__":
    unittest.main()
