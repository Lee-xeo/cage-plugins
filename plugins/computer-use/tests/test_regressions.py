"""Regression tests for stopping with Esc, the move of old grants, snapshots of windows and the shared clipboard.
They run on macOS, with no app touched: input and the accessibility interface are replaced, the pasteboard is a
private one. Run: python3 -m unittest discover -s tests (from the plugin's folder)."""
import json
import os
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import appcontrol as ac  # noqa: E402


class Patched(unittest.TestCase):
    def patch(self, name, value):
        old = getattr(ac, name)
        setattr(ac, name, value)
        self.addCleanup(setattr, ac, name, old)

    def setUp(self):
        ac._overlay["stopped_at"] = 0.0


def stop_now():
    ac._overlay["stopped_at"] = time.time()
    ac._overlay["epoch"] += 1


class FakeInput(object):
    def __init__(self, test, after=None):
        self.events, self.after = [], after
        test.patch("deliver", self.deliver)
        test.patch("mouse_event", lambda kind, point, button=0, flags=0, press=None, window=None: (kind, point.x))
        test.patch("placed_mouse", lambda kind, view, point, button=0, flags=0, press=1, frame=None: (kind, point.x))
        test.patch("window_frame", lambda view: None)
        test.patch("pointer_location", lambda: ac.CGPoint(0, 0))
        test.patch("CGWarpMouseCursorPosition", lambda point: None)
        test.patch("CGAssociateMouseAndMouseCursorPosition", lambda flag: None)
        test.patch("BackgroundInput", Dummy)

    def deliver(self, event, pid=None):
        self.events.append(event)
        if self.after:
            self.after(event, self.events)


class Dummy(object):
    def __init__(self, *_):
        self.told = False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


APP = {"pid": 4242, "name": "Fake", "bundle_id": "fake.app", "path": "/x"}


class StopWithEsc(Patched):
    def test_queued_call_does_nothing_after_esc(self):
        calls = []
        self.patch("lookup_app", lambda wanted: APP)
        self.patch("front_state", lambda: None)
        self.patch("keep_front", lambda *a: False)
        self.patch("watch_front", lambda *a: None)
        handlers = dict(ac.HANDLERS)
        handlers["app_click"] = lambda arguments: calls.append(arguments) or "clicked"
        self.patch("HANDLERS", handlers)
        lock = ac.lock_for({"app": "Fake"})
        outcome = []

        def queued():
            try:
                outcome.append(ac.run_tool("app_click", {"app": "Fake"}))
            except ac.Refused as refusal:
                outcome.append(refusal)

        with lock:
            worker = threading.Thread(target=queued)
            worker.start()
            time.sleep(0.2)
            stop_now()  # Esc while the call waits for the app's turn
        worker.join(5)
        self.assertEqual(calls, [])
        self.assertIsInstance(outcome[0], ac.Refused)

    def test_epoch_alone_stops_a_queued_call_after_the_pause(self):
        calls = []
        self.patch("lookup_app", lambda wanted: APP)
        handlers = dict(ac.HANDLERS)
        handlers["app_click"] = lambda arguments: calls.append(1) or "clicked"
        self.patch("HANDLERS", handlers)
        lock = ac.lock_for({"app": "Fake"})
        outcome = []

        def queued():
            try:
                ac.run_tool("app_click", {"app": "Fake"})
            except ac.Refused as refusal:
                outcome.append(refusal)

        with lock:
            worker = threading.Thread(target=queued)
            worker.start()
            time.sleep(0.2)
            ac._overlay["epoch"] += 1
            ac._overlay["stopped_at"] = time.time() - ac.PAUSE - 5  # long past: the epoch alone says it
        worker.join(5)
        self.assertEqual(calls, [])
        self.assertTrue(outcome)

    def check_drag(self, run):
        def after(event, events):
            moves = [e for e in events if e[0] == ac.BUTTONS["left"][2]]
            if len(moves) == 3:
                stop_now()

        fake = FakeInput(self, after)
        with self.assertRaises(ac.Refused):
            run()
        kinds = [e[0] for e in fake.events]
        down, up, dragged, _ = ac.BUTTONS["left"]
        self.assertEqual(kinds.count(down), 1)
        self.assertEqual(kinds.count(dragged), 3, "no move after Esc")
        self.assertEqual(kinds[-1], up, "the button is let go")
        self.assertEqual(kinds.count(up), 1)
        self.assertEqual(fake.events[-1][1], fake.events[-2][1], "let go where the drag had got to")

    def test_drag_in_background(self):
        view = type("V", (), {"window": {"number": 1}})()
        self.check_drag(lambda: ac.drag_in_background(APP, view, ac.CGPoint(0, 0), ac.CGPoint(160, 0), 0, 0))

    def test_drag_with_pointer(self):
        self.check_drag(lambda: ac.drag_with_pointer(ac.CGPoint(0, 0), ac.CGPoint(160, 0), 0, 0))

    def test_long_click_let_go_on_esc(self):
        down, up = ac.BUTTONS["left"][0], ac.BUTTONS["left"][1]

        def after(event, events):
            if event[0] == down:
                threading.Timer(0.1, stop_now).start()

        fake = FakeInput(self, after)
        with self.assertRaises(ac.Refused):
            ac.click_with_pointer(ac.CGPoint(5, 5), "left", 1, 0, hold=3)
        self.assertEqual([e[0] for e in fake.events if e[0] != ac.MOVED], [down, up])

    def test_held_key_let_go_on_esc(self):
        sent = []
        self.patch("key_event", lambda code, flags, pressed: ("key", pressed))

        def deliver(event, pid=None):
            sent.append(event)
            if event == ("key", True):
                threading.Timer(0.1, stop_now).start()

        self.patch("deliver", deliver)
        with self.assertRaises(ac.Refused):
            ac.tap(0, 0, None, hold=3)
        self.assertEqual(sent, [("key", True), ("key", False)])


class OldGrants(Patched):
    def setUp(self):
        super().setUp()
        self.dir = tempfile.mkdtemp()
        self.new = os.path.join(self.dir, "support", "app-grants.json")
        self.old = os.path.join(self.dir, "plugin", "app-grants.json")
        os.makedirs(os.path.dirname(self.old))
        self.patch("DATA_DIR", os.path.dirname(self.new))
        self.patch("GRANTS", self.new)
        self.patch("LEGACY_GRANTS", self.old)

    def write_old(self, data):
        with open(self.old, "w") as file:
            json.dump(data, file)

    def test_first_read_moves_both_lists(self):
        self.write_old({"always": ["a.b"], "never": ["c.d"]})
        self.assertEqual(ac.grants(), {"always": ["a.b"], "never": ["c.d"]})
        self.assertTrue(os.path.exists(self.new))
        os.remove(self.old)
        os.rmdir(os.path.dirname(self.old))  # the old plugin folder is gone
        self.assertEqual(ac.grants(), {"always": ["a.b"], "never": ["c.d"]})
        self.assertEqual(ac.consent_of({"bundle_id": "c.d", "path": "", "name": "x"}), "refused")
        self.assertEqual(ac.consent_of({"bundle_id": "a.b", "path": "", "name": "x"}), "allowed")

    def test_existing_new_file_is_kept(self):
        self.write_old({"always": ["old.one"], "never": []})
        os.makedirs(os.path.dirname(self.new))
        with open(self.new, "w") as file:
            json.dump({"always": [], "never": ["new.one"]}, file)
        self.assertEqual(ac.grants(), {"always": [], "never": ["new.one"]})
        with open(self.new) as file:
            self.assertEqual(json.load(file)["never"], ["new.one"])

    def test_race_does_not_overwrite(self):
        self.write_old({"always": ["old.one"], "never": []})
        os.makedirs(os.path.dirname(self.new))
        with open(self.new, "w") as file:
            json.dump({"always": ["mine"], "never": []}, file)
        self.assertFalse(ac.write_grants({"always": ["old.one"], "never": []}, only_new=True))
        with open(self.new) as file:
            self.assertEqual(json.load(file)["always"], ["mine"])


class FakeWindow(object):
    def __init__(self, title):
        self.title = title
        self.alive = True

    def same(self, other):
        return self is other


def fake_view(title, window):
    view = ac.View.__new__(ac.View)
    view.pid, view.name = APP["pid"], APP["name"]
    view.window = {"element": window, "title": title, "number": id(window) % 1000}
    ac._snapshot_count[0] += 1
    view.snapshot = "s%d" % ac._snapshot_count[0]
    return view


class Snapshots(Patched):
    def setUp(self):
        super().setUp()
        ac.VIEWS.pop(APP["pid"], None)
        ac.SNAPSHOTS.pop(APP["pid"], None)
        self.patch("window_alive", lambda view: view.window["element"].alive)

    def test_click_from_a_goes_to_a_or_is_refused(self):
        a, b = FakeWindow("A"), FakeWindow("B")
        view_a, view_b = fake_view("A", a), fake_view("B", b)
        ac.register_view(view_a)
        ac.register_view(view_b)
        self.assertIs(ac.need_view(APP, {"snapshot": view_a.snapshot}, coordinates=True), view_a)
        self.assertIs(ac.need_view(APP, {"snapshot": view_b.snapshot}, coordinates=True), view_b)
        with self.assertRaises(ac.Refused):  # x and y with no snapshot, two windows read: not guessed
            ac.need_view(APP, {"x": 5, "y": 5}, coordinates=True)
        self.assertIs(ac.need_view(APP, {}), view_b)  # element numbers need no picture

    def test_reading_a_window_again_voids_its_old_snapshot(self):
        a, b = FakeWindow("A"), FakeWindow("B")
        first = fake_view("A", a)
        ac.register_view(first)
        ac.register_view(fake_view("B", b))
        again = fake_view("A", a)
        ac.register_view(again)
        with self.assertRaises(ac.Refused):
            ac.need_view(APP, {"snapshot": first.snapshot}, coordinates=True)
        self.assertIs(ac.need_view(APP, {"snapshot": again.snapshot}, coordinates=True), again)

    def test_closed_window_snapshot_refused_and_single_window_needs_none(self):
        a, b = FakeWindow("A"), FakeWindow("B")
        view_a = fake_view("A", a)
        ac.register_view(view_a)
        self.assertIs(ac.need_view(APP, {}, coordinates=True), view_a)
        ac.register_view(fake_view("B", b))
        a.alive = False
        with self.assertRaises(ac.Refused):
            ac.need_view(APP, {"snapshot": view_a.snapshot}, coordinates=True)
        self.assertIsNotNone(ac.need_view(APP, {}, coordinates=True))  # only B is left, so it is the one

    def test_unknown_snapshot_refused(self):
        ac.register_view(fake_view("A", FakeWindow("A")))
        with self.assertRaises(ac.Refused):
            ac.need_view(APP, {"snapshot": "s999999"}, coordinates=True)


class Clipboard(Patched):
    def setUp(self):
        super().setUp()
        ns = ac.send(ac.objc_getClass(b"NSPasteboard"), "pasteboardWithUniqueName")
        self.board = ns
        self.patch("the_board", lambda: ns)

    def text(self, words):
        return [[("public.utf8-plain-text", words.encode())]]

    def held(self):
        items = ac.board_items()
        return items[0][0][1].decode() if items else None

    def test_two_pastes_at_once_each_get_their_own(self):
        ac.put_on_board(self.text("mine"))
        seen, lock = {}, threading.Lock()

        def paste(name):
            def run():
                with ac._board_lock:
                    saved = ac.board_items()
                    ac.put_on_board(self.text(name))
                    mine = ac.board_count()
                    try:
                        time.sleep(0.3)  # the app reads it meanwhile
                        with lock:
                            seen[name] = self.held()
                    finally:
                        if ac.board_count() == mine:
                            ac.put_on_board(saved)
            return run

        threads = [threading.Thread(target=paste(n)) for n in ("one", "two")]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertEqual(seen, {"one": "one", "two": "two"})
        self.assertEqual(self.held(), "mine")

    def test_paste_through_the_real_function_keeps_a_new_copy(self):
        ac.put_on_board(self.text("before"))
        self.patch("need_access", lambda: None)
        self.patch("find_app", lambda wanted: dict(APP, access="full"))
        self.patch("need_full", lambda *a: None)
        self.patch("guard", lambda app: None)
        self.patch("show", lambda *a, **k: None)
        self.patch("settle", lambda: None)
        self.patch("focused_field", lambda app: None)
        self.patch("text_size", lambda element: None)
        self.patch("window_in_front", lambda *a: True)
        self.patch("paste_item", lambda app: None)

        def attempt(app, view, in_front, arrived):
            self.assertEqual(self.held(), "hello")  # what is pasted is on the pasteboard
            ac.put_on_board(self.text("copied by the user meanwhile"))
            return "somehow"

        self.patch("paste_attempts", attempt)
        result = ac.tool_app_paste({"app": "Fake", "text": "hello"})
        self.assertIn("left as it is", result)
        self.assertEqual(self.held(), "copied by the user meanwhile")

    def test_paste_through_the_real_function_restores_when_untouched(self):
        ac.put_on_board(self.text("before"))
        for name, value in (("need_access", lambda: None), ("find_app", lambda w: dict(APP, access="full")),
                            ("need_full", lambda *a: None), ("guard", lambda a: None),
                            ("show", lambda *a, **k: None), ("settle", lambda: None),
                            ("focused_field", lambda a: None), ("text_size", lambda e: None),
                            ("window_in_front", lambda *a: True), ("paste_item", lambda a: None),
                            ("paste_attempts", lambda *a: "somehow")):
            self.patch(name, value)
        result = ac.tool_app_paste({"app": "Fake", "text": "hello"})
        self.assertIn("holds what it held before", result)
        self.assertEqual(self.held(), "before")


class ProtectedApps(Patched):
    def _app(self, name, bundle_id, pid=100, policy=0, path="", executable="", file=""):
        return {"pid": pid, "name": name, "bundle_id": bundle_id, "policy": policy,
                "path": path, "executable": executable, "file": file or name}

    def test_protected_matches_helpers_and_case_variants(self):
        self.assertTrue(ac.protected(self._app("Cage", "IO.GITHUB.LEE-XEO.CLAUDE-CAGE")))
        self.assertTrue(ac.protected(self._app("Security", "com.apple.securityagent")))
        self.assertTrue(ac.protected(self._app("Overlay", "", executable="/x/ClaudeOverlay-arm64")))
        self.assertTrue(ac.protected(self._app("Overlay", "", executable="/x/ClaudeOverlay-x64")))
        self.assertTrue(ac.protected(self._app("Cage Networking", "com.apple.WebKit.Networking", policy=1)))
        self.assertTrue(ac.protected(self._app("Cage Graphics and Media", "com.apple.WebKit.GPU", policy=1)))
        self.assertTrue(ac.protected(self._app("Cage Web Content", "com.apple.WebKit.WebContent", policy=1)))
        self.assertTrue(ac.protected(self._app("AutoFill (Cage)", "com.apple.SafariPlatformSupport.Helper", policy=2)))
        self.assertFalse(ac.protected(self._app("Other Web Content", "com.apple.WebKit.WebContent", policy=1)))
        self.assertFalse(ac.protected(self._app("Package Manager", "com.example.pkg")))

    def test_lookup_and_resolve_do_not_leak_protected_apps(self):
        cage = self._app("Cage", "io.github.lee-xeo.claude-cage", pid=10, path="/Applications/Cage.app")
        calc = self._app("Calculator", "com.apple.calculator", pid=11, path="/System/Applications/Calculator.app")
        cal = self._app("Calendar", "com.apple.iCal", pid=12, path="/System/Applications/Calendar.app")
        with self.assertRaises(ac.Refused) as ctx:
            ac.lookup_app("c", apps=[cage, calc, cal])
        self.assertNotIn("cage", str(ctx.exception).lower())
        self.assertNotIn("lee-xeo", str(ctx.exception).lower())
        self.assertEqual(ac.lookup_app("ca", apps=[cage, calc])["bundle_id"], "com.apple.calculator")

        self.patch("installed_apps", lambda: [cage, calc, cal])
        with self.assertRaises(ac.Refused) as ctx:
            ac.resolve_installed("c")
        self.assertNotIn("cage", str(ctx.exception).lower())
        self.assertNotIn("lee-xeo", str(ctx.exception).lower())

        with self.assertRaises(ac.Refused) as ctx:
            ac.admit(dict(cage))
        self.assertNotIn("cage", str(ctx.exception).lower())

    def test_batch_wait_stops_on_esc(self):
        threading.Timer(0.1, stop_now).start()
        result = ac.tool_app_batch({"steps": [{"tool": "wait", "arguments": {"seconds": 3}}]})
        self.assertTrue(result["isError"])
        self.assertIn("Esc", result["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
