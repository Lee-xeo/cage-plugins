# An MCP server on standard input and output that takes pictures of the
# screen and sends mouse and keyboard input. macOS only; it needs nothing
# beyond Python's standard library and the system's own frameworks.
import base64
import ctypes
import json
import os
import subprocess
import sys
import tempfile
import time

VERSION = "0.2.1"
# The longest edge of a picture handed back, in pixels.
LONGEST = 1456

cg = ctypes.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")


class Point(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


def declare(name, result, *arguments):
    function = getattr(cg, name)
    function.restype, function.argtypes = result, list(arguments)
    return function


ref, u16, u32, i32 = ctypes.c_void_p, ctypes.c_uint16, ctypes.c_uint32, ctypes.c_int32
mouse_event = declare("CGEventCreateMouseEvent", ref, ref, u32, Point, u32)
key_event = declare("CGEventCreateKeyboardEvent", ref, ref, u16, ctypes.c_bool)
scroll_event = declare("CGEventCreateScrollWheelEvent2", ref, ref, u32, u32, i32, i32, i32)
set_flags = declare("CGEventSetFlags", None, ref, ctypes.c_uint64)
set_field = declare("CGEventSetIntegerValueField", None, ref, u32, ctypes.c_int64)
post = declare("CGEventPost", None, u32, ref)
release = declare("CFRelease", None, ref)
main_display = declare("CGMainDisplayID", u32)
display_wide = declare("CGDisplayPixelsWide", ctypes.c_size_t, u32)
display_high = declare("CGDisplayPixelsHigh", ctypes.c_size_t, u32)
may_see = declare("CGPreflightScreenCaptureAccess", ctypes.c_bool)
ask_to_see = declare("CGRequestScreenCaptureAccess", ctypes.c_bool)
may_act = declare("AXIsProcessTrusted", ctypes.c_bool)
may_act_asking = declare("AXIsProcessTrustedWithOptions", ctypes.c_bool, ref)
cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
cf.CFDictionaryCreate.restype = ref
cf.CFDictionaryCreate.argtypes = [ref, ctypes.POINTER(ref), ctypes.POINTER(ref), ctypes.c_long, ref, ref]


def ask_to_act():
    """Have the system show its own request, which lists the application in Settings."""
    key, yes = ref.in_dll(cg, "kAXTrustedCheckOptionPrompt"), ref.in_dll(cf, "kCFBooleanTrue")
    options = cf.CFDictionaryCreate(None, ctypes.byref(key), ctypes.byref(yes), 1,
                                    ctypes.addressof(ref.in_dll(cf, "kCFTypeDictionaryKeyCallBacks")),
                                    ctypes.addressof(ref.in_dll(cf, "kCFTypeDictionaryValueCallBacks")))
    if options:
        may_act_asking(options)
        release(options)

BUTTONS = {"left": (1, 2, 6, 0), "right": (3, 4, 7, 1), "middle": (25, 26, 27, 2)}  # down, up, dragged, number
MODIFIERS = {"cmd": 0x100000, "command": 0x100000, "shift": 0x20000, "ctrl": 0x40000, "control": 0x40000,
             "alt": 0x80000, "option": 0x80000}
KEYS = {
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
    "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
    "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 117, "escape": 53, "esc": 53,
    "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
    "f11": 103, "f12": 111,
}

def measure():
    """The size of a picture of the screen, and the points of the screen for each of its pixels."""
    wide, high = display_wide(main_display()), display_high(main_display())
    shrink = max(1.0, max(wide, high) / LONGEST)
    width, height = round(wide / shrink), round(high / shrink)
    return width, height, wide / width


# Positions are given in pixels of a picture; this turns them into points of
# the screen. Set again with every picture, as the screen may have changed.
scale = measure()[2]


class Refused(Exception):
    pass


def send(event):
    if not event:
        raise Refused("the system did not accept the input")
    post(0, event)
    release(event)


def need_input():
    if not may_act():
        ask_to_act()
        raise Refused("Input is not allowed yet. In System Settings > Privacy & Security > Accessibility, turn on the "
                      "application that runs this tool, then try again.")


def place(arguments, x="x", y="y"):
    try:
        px, py = float(arguments[x]), float(arguments[y])
    except (KeyError, TypeError, ValueError):
        raise Refused(f"{x} and {y} must be numbers, in pixels of the latest screenshot")
    wide, high = display_wide(main_display()), display_high(main_display())
    point = Point(px * scale, py * scale)
    if not (0 <= point.x <= wide and 0 <= point.y <= high):
        raise Refused("that position is outside the screen")
    return point


def screenshot(_):
    if not may_see():
        ask_to_see()
        raise Refused("Seeing the screen is not allowed yet. In System Settings > Privacy & Security > Screen & System "
                      "Audio Recording, turn on the application that runs this tool, restart it, then try again.")
    global scale
    width, height, scale = measure()
    with tempfile.TemporaryDirectory() as folder:
        path = os.path.join(folder, "screen.jpg")
        subprocess.run(["/usr/sbin/screencapture", "-x", "-m", "-t", "jpg", path], check=True, timeout=20,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["/usr/bin/sips", "-z", str(height), str(width), path], check=True, timeout=20,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(path, "rb") as file:
            data = file.read()
    return [{"type": "image", "data": base64.b64encode(data).decode(), "mimeType": "image/jpeg"},
            {"type": "text", "text": f"{width}x{height} pixels. Positions for the other tools are pixels of this picture."}]


def move(arguments):
    need_input()
    send(mouse_event(None, 5, place(arguments), 0))
    return "moved"


def click(arguments):
    need_input()
    point = place(arguments)
    button = arguments.get("button", "left")
    count = arguments.get("count", 1)
    if button not in BUTTONS or count not in (1, 2, 3):
        raise Refused("button is left, right or middle; count is 1, 2 or 3")
    down, up, _, number = BUTTONS[button]
    send(mouse_event(None, 5, point, 0))
    time.sleep(0.05)
    for press in range(1, count + 1):
        for kind in (down, up):
            event = mouse_event(None, kind, point, number)
            if event:
                set_field(event, 1, press)  # which click of a double or triple click this is
            send(event)
            time.sleep(0.02)
    return "clicked"


def drag(arguments):
    need_input()
    start, end = place(arguments, "from_x", "from_y"), place(arguments, "to_x", "to_y")
    send(mouse_event(None, 5, start, 0))
    time.sleep(0.05)
    send(mouse_event(None, 1, start, 0))
    for step in range(1, 11):
        time.sleep(0.02)
        between = Point(start.x + (end.x - start.x) * step / 10, start.y + (end.y - start.y) * step / 10)
        send(mouse_event(None, 6, between, 0))
    time.sleep(0.05)
    send(mouse_event(None, 2, end, 0))
    return "dragged"


def scroll(arguments):
    need_input()
    send(mouse_event(None, 5, place(arguments), 0))
    time.sleep(0.05)
    try:
        down, right = int(arguments.get("down", 0)), int(arguments.get("right", 0))
    except (TypeError, ValueError):
        raise Refused("down and right must be whole numbers of lines")
    if not -100 <= down <= 100 or not -100 <= right <= 100 or (down == 0 and right == 0):
        raise Refused("give down or right, between -100 and 100 lines")
    send(scroll_event(None, 1, 2, -down, -right, 0))  # 1: in lines
    return "scrolled"


def key(code, flags=0):
    for pressed in (True, False):
        event = key_event(None, code, pressed)
        if event:
            set_flags(event, flags)
        send(event)
        time.sleep(0.02)


def type_text(arguments):
    need_input()
    text = arguments.get("text")
    if not isinstance(text, str) or not text or len(text) > 5000:
        raise Refused("text must be 1 to 5000 characters")
    # Through the clipboard: typed key by key, the text would pass through
    # whatever input method is active and come out as something else. The
    # text that was on the clipboard is put back afterwards.
    utf8 = dict(os.environ, LANG="en_US.UTF-8", LC_ALL="en_US.UTF-8")
    before = subprocess.run(["/usr/bin/pbpaste"], capture_output=True, timeout=10, env=utf8).stdout
    subprocess.run(["/usr/bin/pbcopy"], input=text.encode(), check=True, timeout=10, env=utf8)
    try:
        key(KEYS["v"], MODIFIERS["cmd"])
        time.sleep(0.3)
    finally:
        subprocess.run(["/usr/bin/pbcopy"], input=before, timeout=10, env=utf8)
    return "typed"


def press_key(arguments):
    need_input()
    keys = arguments.get("keys")
    if not isinstance(keys, str) or not keys:
        raise Refused("keys is a key, or modifiers and a key joined by +, such as cmd+c")
    names = keys.lower().split("+") if keys != "+" and not keys.endswith("++") else keys.lower()[:-1].split("+")[:-1] + ["shift", "="]
    flags = 0
    for name in names[:-1]:
        if name not in MODIFIERS:
            raise Refused(f"unknown modifier {name}; use cmd, shift, ctrl or alt")
        flags |= MODIFIERS[name]
    if names[-1] not in KEYS:
        raise Refused(f"unknown key {names[-1]}")
    key(KEYS[names[-1]], flags)
    return "pressed"


def number(description):
    return {"type": "number", "description": description}


SPOT = {"x": number("pixels from the left edge of the latest screenshot"),
        "y": number("pixels from the top edge of the latest screenshot")}
TOOLS = [
    (screenshot, "screenshot", "Take a picture of the main screen of the user's computer.", {}, []),
    (click, "click", "Click the mouse at a position on the screen.",
     {**SPOT, "button": {"type": "string", "enum": ["left", "right", "middle"], "description": "default left"},
      "count": {"type": "integer", "enum": [1, 2, 3], "description": "2 for a double click; default 1"}}, ["x", "y"]),
    (move, "move_pointer", "Move the mouse pointer to a position on the screen without clicking.", SPOT, ["x", "y"]),
    (drag, "drag", "Press the left mouse button at one position, move to another and let go.",
     {"from_x": number("start, pixels from the left"), "from_y": number("start, pixels from the top"),
      "to_x": number("end, pixels from the left"), "to_y": number("end, pixels from the top")},
     ["from_x", "from_y", "to_x", "to_y"]),
    (scroll, "scroll", "Turn the mouse wheel at a position on the screen.",
     {**SPOT, "down": {"type": "integer", "description": "lines to scroll down; negative scrolls up"},
      "right": {"type": "integer", "description": "lines to scroll right; negative scrolls left"}}, ["x", "y"]),
    (type_text, "type_text", "Enter text into whatever has the keyboard focus, by way of the clipboard.",
     {"text": {"type": "string", "description": "the text to type"}}, ["text"]),
    (press_key, "press_key", "Press one key, alone or with modifiers, such as return, escape, cmd+c or ctrl+shift+tab.",
     {"keys": {"type": "string", "description": "a key name or character, with any of cmd, shift, ctrl, alt before it joined by +"}},
     ["keys"]),
]
BY_NAME = {name: function for function, name, _, _, _ in TOOLS}


def answer(message):
    method = message.get("method")
    if method == "initialize":
        return {"protocolVersion": message["params"]["protocolVersion"], "capabilities": {"tools": {}},
                "serverInfo": {"name": "desktop-control", "version": VERSION}}
    if method == "tools/list":
        return {"tools": [{"name": name, "description": description,
                           "inputSchema": {"type": "object", "properties": properties, "required": required}}
                          for _, name, description, properties, required in TOOLS]}
    if method == "tools/call":
        function = BY_NAME.get(message["params"].get("name"))
        if function is None:
            return None
        try:
            result = function(message["params"].get("arguments") or {})
        except Refused as refusal:
            return {"content": [{"type": "text", "text": str(refusal)}], "isError": True}
        except (subprocess.SubprocessError, OSError) as failure:
            return {"content": [{"type": "text", "text": f"failed: {failure}"}], "isError": True}
        return {"content": result if isinstance(result, list) else [{"type": "text", "text": result}]}
    if method == "ping":
        return {}
    return None


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    if "id" not in request:
        continue  # a notification needs no reply
    result = answer(request)
    reply = {"jsonrpc": "2.0", "id": request["id"]}
    if result is None:
        reply["error"] = {"code": -32601, "message": "method not found"}
    else:
        reply["result"] = result
    sys.stdout.write(json.dumps(reply) + "\n")
    sys.stdout.flush()
