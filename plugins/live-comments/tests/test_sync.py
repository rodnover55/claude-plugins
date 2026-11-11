"""Tests of what the server sends to a page that keeps the state of its
session: only the topics changed since the state the page has.

    python3 -m unittest discover -s plugins/live-comments/tests
"""

import shutil
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from browser import free_port
from server import Server

HERE = Path(__file__).resolve().parent

server = None
work = None


def setUpModule():
    global server, work
    work = tempfile.mkdtemp(prefix="work-", dir=HERE)
    try:
        server = Server(Path(work) / "server", free_port())
    except Exception:
        tearDownModule()
        raise


def tearDownModule():
    if server:
        server.close()
    if work:
        shutil.rmtree(work, ignore_errors=True)


class DeltaTest(unittest.TestCase):
    def setUp(self):
        self.sid = "s" + uuid.uuid4().hex[:12]
        server.post("/api/sessions", {"session": self.sid, "label": "Tests"})
        self.first = self.topic("The first question")
        self.second = self.topic("The second question")
        self.state = self.wait(-1, "")

    def topic(self, text):
        tid = server.post(f"/api/{self.sid}/topics", {"text": text})["id"]
        server.post(f"/api/{self.sid}/topics/{tid}/claude", {"text": "A reply"})
        return tid

    def wait(self, rev, boot):
        return server.get(f"/api/{self.sid}/wait?delta=1&rev={rev}&boot={boot}")

    def changes(self):
        """Returns what a page with the last state gets and takes it as the page's state."""
        self.state = self.wait(self.state["rev"], self.state["boot"])
        return self.state

    def test_page_without_state_gets_all_topics(self):
        self.assertEqual([t["id"] for t in self.state["topics"]], [self.first, self.second])
        self.assertNotIn("ids", self.state)
        self.assertTrue(self.state["boot"])

    def test_changed_topic_comes_alone(self):
        server.post(f"/api/{self.sid}/topics/{self.second}/messages", {"text": "One more question"})
        got = self.changes()
        self.assertEqual([t["id"] for t in got["topics"]], [self.second])
        self.assertEqual(got["topics"][0]["messages"][-1]["text"], "One more question")
        self.assertEqual(got["ids"], [self.first, self.second])
        self.assertEqual(got["queue"], [self.second])

    def test_change_outside_topics_brings_no_topics(self):
        before = self.state["rev"]
        server.post(f"/api/{self.sid}/activity", {"text": "working"})
        got = self.changes()
        self.assertEqual(got["topics"], [])
        self.assertEqual(got["ids"], [self.first, self.second])
        self.assertEqual(got["since"], before)
        self.assertEqual(got["activity"]["text"], "working")

    def test_new_and_removed_topics(self):
        third = self.topic("The third question")
        got = self.changes()
        self.assertEqual([t["id"] for t in got["topics"]], [third])
        self.assertEqual(got["ids"], [self.first, self.second, third])
        server.post(f"/api/{self.sid}/topics/{self.first}/decision", {"decision": "Decided"})
        self.assertEqual([t["id"] for t in self.changes()["topics"]], [self.first])
        server.post(f"/api/sessions/{self.sid}/apply")
        got = self.changes()
        self.assertEqual(got["topics"], [])
        self.assertEqual(got["ids"], [self.second, third])

    def test_page_behind_by_several_changes_gets_them_all(self):
        server.post(f"/api/{self.sid}/topics/{self.first}/messages", {"text": "A question"})
        server.post(f"/api/{self.sid}/activity", {"text": "working"})
        server.post(f"/api/{self.sid}/topics/{self.second}/messages", {"text": "A question"})
        self.assertEqual([t["id"] for t in self.changes()["topics"]], [self.first, self.second])

    def test_state_of_another_server_run_is_replaced(self):
        started = time.time()
        got = self.wait(self.state["rev"], "another-run")
        self.assertLess(time.time() - started, 5)
        self.assertEqual([t["id"] for t in got["topics"]], [self.first, self.second])
        self.assertNotIn("ids", got)

    def test_request_without_delta_gets_whole_state(self):
        got = server.get(f"/api/{self.sid}/wait?rev=-1")
        self.assertEqual([t["id"] for t in got["topics"]], [self.first, self.second])
        self.assertNotIn("ids", got)
        self.assertNotIn("boot", got)


if __name__ == "__main__":
    unittest.main()
