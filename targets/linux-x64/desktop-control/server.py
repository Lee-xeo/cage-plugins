# An MCP server on standard input and output that takes pictures of the
# screen and sends mouse and keyboard input. Linux with an X11 display only;
# it needs nothing beyond Python's standard library and the system's own X
# libraries (libX11 and libXtst).
import base64
import contextlib
import ctypes
import json
import os
import struct
import sys
import time
import zlib
from array import array
from operator import itemgetter

VERSION = "0.2.1"
# The longest edge of a picture handed back, in pixels.
LONGEST = 1456

ref, uint, ulong, c_int = ctypes.c_void_p, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int
LIBRARIES = ("The X11 libraries libX11.so.6 and libXtst.so.6 are not installed. Install them (for example the "
             "libx11-6 and libxtst6 packages), then try again.")
try:
    x11, xtst = ctypes.CDLL("libX11.so.6"), ctypes.CDLL("libXtst.so.6")
except OSError:
    x11 = xtst = None


class Image(ctypes.Structure):
    # The start of Xlib's XImage; the rest is not read here.
    _fields_ = [("width", c_int), ("height", c_int), ("xoffset", c_int), ("format", c_int), ("data", ref),
                ("byte_order", c_int), ("bitmap_unit", c_int), ("bitmap_bit_order", c_int), ("bitmap_pad", c_int),
                ("depth", c_int), ("bytes_per_line", c_int), ("bits_per_pixel", c_int),
                ("red_mask", ulong), ("green_mask", ulong), ("blue_mask", ulong)]


class KeyboardState(ctypes.Structure):
    _fields_ = [("group", ctypes.c_ubyte), ("locked_group", ctypes.c_ubyte), ("base_group", ctypes.c_ushort),
                ("latched_group", ctypes.c_ushort)] + [(name, ctypes.c_ubyte) for name in (
                    "mods", "base_mods", "latched_mods", "locked_mods", "compat_state", "grab_mods",
                    "compat_grab_mods", "lookup_mods", "compat_lookup_mods")] + [("ptr_buttons", ctypes.c_ushort)]


class ErrorEvent(ctypes.Structure):
    _fields_ = [("type", c_int), ("display", ref), ("resourceid", ulong), ("serial", ulong),
                ("error_code", ctypes.c_ubyte), ("request_code", ctypes.c_ubyte), ("minor_code", ctypes.c_ubyte)]


def declare(library, name, result, *arguments):
    function = getattr(library, name)
    function.restype, function.argtypes = result, list(arguments)
    return function


if x11:
    keycode, number_out = ctypes.c_ubyte, ctypes.POINTER(c_int)
    open_display = declare(x11, "XOpenDisplay", ref, ctypes.c_char_p)
    close_display = declare(x11, "XCloseDisplay", c_int, ref)
    default_screen = declare(x11, "XDefaultScreen", c_int, ref)
    display_wide = declare(x11, "XDisplayWidth", c_int, ref, c_int)
    display_high = declare(x11, "XDisplayHeight", c_int, ref, c_int)
    root_window = declare(x11, "XRootWindow", ulong, ref, c_int)
    get_image = declare(x11, "XGetImage", ctypes.POINTER(Image), ref, ulong, c_int, c_int, uint, uint, ulong, c_int)
    destroy_image = declare(x11, "XDestroyImage", c_int, ctypes.POINTER(Image))
    sync = declare(x11, "XSync", c_int, ref, c_int)
    flush = declare(x11, "XFlush", c_int, ref)
    free = declare(x11, "XFree", c_int, ref)
    keycodes = declare(x11, "XDisplayKeycodes", c_int, ref, number_out, number_out)
    get_mapping = declare(x11, "XGetKeyboardMapping", ctypes.POINTER(ulong), ref, keycode, c_int, number_out)
    change_mapping = declare(x11, "XChangeKeyboardMapping", c_int, ref, c_int, c_int, ctypes.POINTER(ulong), c_int)
    keysym_code = declare(x11, "XKeysymToKeycode", keycode, ref, ulong)
    keyboard_state = declare(x11, "XkbGetState", c_int, ref, uint, ctypes.POINTER(KeyboardState))
    lock_modifiers = declare(x11, "XkbLockModifiers", c_int, ref, uint, uint, uint)
    on_error = ctypes.CFUNCTYPE(c_int, ref, ctypes.POINTER(ErrorEvent))
    set_error_handler = declare(x11, "XSetErrorHandler", ref, on_error)
    has_test = declare(xtst, "XTestQueryExtension", c_int, ref, number_out, number_out, number_out, number_out)
    fake_motion = declare(xtst, "XTestFakeMotionEvent", c_int, ref, c_int, c_int, c_int, ulong)
    fake_button = declare(xtst, "XTestFakeButtonEvent", c_int, ref, uint, c_int, ulong)
    fake_key = declare(xtst, "XTestFakeKeyEvent", c_int, ref, uint, c_int, ulong)

    # Xlib's own handler ends the program on any error; this one notes it.
    errors = []

    @on_error
    def note_error(_, event):
        errors.append(event.contents.error_code)
        return 0

    set_error_handler(note_error)

ALL_PLANES, Z_PIXMAP, MSB_FIRST, LOCK, CORE_KEYBOARD = 0xFFFFFFFFFFFFFFFF, 2, 1, 0x2, 0x100
BUTTONS = {"left": 1, "middle": 2, "right": 3}
# X keysyms. Characters are their own keysyms up to U+00FF and
# 0x01000000 plus the code point above.
SHIFT, CONTROL, ALT, SUPER = 0xFFE1, 0xFFE3, 0xFFE9, 0xFFEB
MODIFIERS = {"ctrl": CONTROL, "control": CONTROL, "cmd": CONTROL, "command": CONTROL, "shift": SHIFT,
             "alt": ALT, "option": ALT, "super": SUPER, "win": SUPER, "windows": SUPER, "meta": SUPER}
KEYS = {
    "return": 0xFF0D, "enter": 0xFF0D, "tab": 0xFF09, "space": 0x20, "backspace": 0xFF08, "delete": 0xFFFF,
    "insert": 0xFF63, "escape": 0xFF1B, "esc": 0xFF1B, "left": 0xFF51, "up": 0xFF52, "right": 0xFF53,
    "down": 0xFF54, "home": 0xFF50, "end": 0xFF57, "pageup": 0xFF55, "pagedown": 0xFF56,
    **{f"f{n}": 0xFFBD + n for n in range(1, 13)},
}


class Refused(Exception):
    pass


@contextlib.contextmanager
def connect(input=False):
    """A connection to the X display for the length of one call."""
    if not x11:
        raise Refused(LIBRARIES)
    name = os.environ.get("DISPLAY")
    if not name:
        raise Refused("No X11 display is available: DISPLAY is not set. This tool works in X11 sessions; under "
                      "Wayland it reaches only windows shown through XWayland, and needs DISPLAY set.")
    display = open_display(None)
    if not display:
        raise Refused(f"The X11 display {name} cannot be opened. Make sure the session is running and this "
                      "program may connect to it (XAUTHORITY), then try again.")
    del errors[:]
    try:
        if input and not has_test(display, *(ctypes.byref(c_int()) for _ in range(4))):
            raise Refused("The display does not offer the XTEST extension, which mouse and keyboard input needs.")
        yield display
        sync(display, 0)
        if errors:
            raise Refused(f"the display refused the request (X error {errors[0]})")
    finally:
        close_display(display)


def measure(wide, high):
    """The size of a picture of the screen, and the pixels of the screen for each of its pixels."""
    shrink = max(1.0, max(wide, high) / LONGEST)
    width, height = round(wide / shrink), round(high / shrink)
    return width, height, wide / width


# Positions are given in pixels of a picture; this turns them into pixels of
# the screen. Set again with every picture, as the screen may have changed.
scale = None


def place(display, arguments, x="x", y="y"):
    global scale
    try:
        px, py = float(arguments[x]), float(arguments[y])
    except (KeyError, TypeError, ValueError):
        raise Refused(f"{x} and {y} must be numbers, in pixels of the latest screenshot")
    screen = default_screen(display)
    wide, high = display_wide(display, screen), display_high(display, screen)
    if scale is None:
        scale = measure(wide, high)[2]
    sx, sy = round(px * scale), round(py * scale)
    if not (0 <= sx <= wide and 0 <= sy <= high):
        raise Refused("that position is outside the screen")
    return min(sx, wide - 1), min(sy, high - 1)


def pairs(source, target):
    """For each of target pixels along an edge, the two source pixels nearest its middle."""
    near = [min(max(int((i + 0.5) * source / target - 0.5), 0), source - 1) for i in range(target)]
    return near, [min(n + 1, source - 1) for n in near]


def average(a, b):
    """Each byte of a and b averaged, by arithmetic on all the bytes taken as one large number."""
    x, y = int.from_bytes(a, "little"), int.from_bytes(b, "little")
    mask = int.from_bytes(b"\xfe" * len(a), "little")
    return ((x & y) + (((x ^ y) & mask) >> 1)).to_bytes(len(a), "little")


def colours(image, width, height):
    """The pixels of an XImage as red, green and blue bytes, shrunk to width x height.

    Whole rows and columns are moved by slicing; nothing loops over single
    pixels in Python."""
    size = image.bits_per_pixel // 8
    if image.bits_per_pixel not in (24, 32) or image.depth < 24:
        raise Refused(f"The screen uses {image.depth}-bit colour at {image.bits_per_pixel} bits per pixel; this "
                      "tool reads only 24-bit colour.")
    offsets = []
    for mask in (image.red_mask, image.green_mask, image.blue_mask):
        shift = (mask & -mask).bit_length() - 1
        if mask >> shift != 0xFF or shift % 8:
            raise Refused("The screen uses a colour layout this tool cannot read.")
        offsets.append(size - 1 - shift // 8 if image.byte_order == MSB_FIRST else shift // 8)
    wide, high, line = image.width, image.height, image.bytes_per_line
    raw = ctypes.string_at(image.data, line * high)

    def rows(chosen):
        """The chosen rows, four bytes to a pixel."""
        joined = b"".join(raw[y * line:y * line + wide * size] for y in chosen)
        if size == 4:
            return joined
        four = bytearray(len(joined) // 3 * 4)
        for channel in range(3):
            four[channel::4] = joined[channel::3]
        return bytes(four)

    if (width, height) == (wide, high):
        pixels = rows(range(high))
    else:
        # Each picture pixel is the average of the 2 x 2 screen pixels
        # nearest its middle, so lines one pixel thin do not drop out.
        top, bottom = pairs(high, height)
        left, right = pairs(wide, width)
        tall = memoryview(average(rows(top), rows(bottom))).cast("I")
        halves = []
        for columns in (left, right):
            pick, picked = itemgetter(*columns), array("I")
            for row in range(height):
                taken = pick(tall[row * wide:(row + 1) * wide])
                picked.extend(taken if isinstance(taken, tuple) else (taken,))
            halves.append(picked.tobytes())
        pixels = average(*halves)
    rgb = bytearray(width * height * 3)
    for channel, offset in enumerate(offsets):
        rgb[channel::3] = pixels[offset::4]
    return rgb


def png(width, height, rgb):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    stride = width * 3
    lines = b"".join(b"\x00" + rgb[i:i + stride] for i in range(0, len(rgb), stride))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(lines, 6)) + chunk(b"IEND", b""))


def screenshot(_):
    global scale
    with connect() as display:
        screen = default_screen(display)
        wide, high = display_wide(display, screen), display_high(display, screen)
        width, height, scale = measure(wide, high)
        image = get_image(display, root_window(display, screen), 0, 0, wide, high, ALL_PLANES, Z_PIXMAP)
        if not image:
            raise Refused("The screen cannot be read right now.")
        try:
            rgb = colours(image.contents, width, height)
        finally:
            destroy_image(image)
    data = png(width, height, rgb)
    return [{"type": "image", "data": base64.b64encode(data).decode(), "mimeType": "image/png"},
            {"type": "text", "text": f"{width}x{height} pixels. Positions for the other tools are pixels of this picture."}]


def move_to(display, at):
    fake_motion(display, default_screen(display), at[0], at[1], 0)
    flush(display)


def button(display, number, pressed):
    fake_button(display, number, pressed, 0)
    flush(display)


def move(arguments):
    with connect(input=True) as display:
        move_to(display, place(display, arguments))
    return "moved"


def click(arguments):
    with connect(input=True) as display:
        point = place(display, arguments)
        which = arguments.get("button", "left")
        count = arguments.get("count", 1)
        if which not in BUTTONS or count not in (1, 2, 3):
            raise Refused("button is left, right or middle; count is 1, 2 or 3")
        move_to(display, point)
        time.sleep(0.05)
        for _ in range(count):
            for pressed in (True, False):
                button(display, BUTTONS[which], pressed)
                time.sleep(0.02)
    return "clicked"


def drag(arguments):
    with connect(input=True) as display:
        start, end = place(display, arguments, "from_x", "from_y"), place(display, arguments, "to_x", "to_y")
        move_to(display, start)
        time.sleep(0.05)
        button(display, 1, True)
        try:
            for step in range(1, 11):
                time.sleep(0.02)
                move_to(display, (round(start[0] + (end[0] - start[0]) * step / 10),
                                  round(start[1] + (end[1] - start[1]) * step / 10)))
            time.sleep(0.05)
        finally:
            button(display, 1, False)
    return "dragged"


def scroll(arguments):
    with connect(input=True) as display:
        point = place(display, arguments)
        try:
            down, right = int(arguments.get("down", 0)), int(arguments.get("right", 0))
        except (TypeError, ValueError):
            raise Refused("down and right must be whole numbers of wheel steps")
        if not -100 <= down <= 100 or not -100 <= right <= 100 or (down == 0 and right == 0):
            raise Refused("give down or right, between -100 and 100 wheel steps")
        move_to(display, point)
        time.sleep(0.05)
        # The wheel is buttons 4 and 5, and 6 and 7 sideways, one click a step.
        for steps, forward, back in ((down, 5, 4), (right, 7, 6)):
            for _ in range(abs(steps)):
                for pressed in (True, False):
                    button(display, forward if steps > 0 else back, pressed)
                time.sleep(0.01)
    return "scrolled"


def keysym(character):
    """The keysym of a character, or None for a control character other than newline and tab."""
    if character == "\n":
        return KEYS["return"]
    if character == "\t":
        return KEYS["tab"]
    point = ord(character)
    if point < 0x20 or 0x7F <= point < 0xA0:
        return None
    return point if point < 0x100 else 0x01000000 + point


# How long a borrowed key rests after its last press before it is given
# another character. A program that is behind reads the keys as they are when
# it catches up, so a key changed too soon would type the wrong character.
REST = 0.3


class Keyboard:
    """The keys of the keyboard for one call. A character no key produces is
    put on a key that produces nothing until the call ends, so typing does not
    depend on the keyboard layout or the clipboard."""

    def __init__(self, display):
        self.display = display
        low, high, per = c_int(), c_int(), c_int()
        keycodes(display, ctypes.byref(low), ctypes.byref(high))
        count = high.value - low.value + 1
        table = get_mapping(display, low.value, count, ctypes.byref(per))
        if not table:
            raise Refused("The keyboard layout cannot be read.")
        try:
            symbols = table[:count * per.value]
        finally:
            free(table)
        self.per = per.value
        keys = [symbols[i * self.per:(i + 1) * self.per] for i in range(count)]
        state = KeyboardState()
        group, self.locked, self.released = 0, False, False
        if keyboard_state(display, CORE_KEYBOARD, ctypes.byref(state)) == 0:
            group, self.locked = state.group, bool(state.locked_mods & LOCK)
        self.shift = keysym_code(display, SHIFT)
        # Keysyms the keyboard already has: on which key, and whether with
        # shift. With another layout group active, the first group's keys
        # would type something else, so only keys outside the characters are
        # taken then.
        self.found = {}
        for level in (0, 1) if self.shift else (0,):
            for index, symbols in enumerate(keys):
                symbol = symbols[level] if level < len(symbols) else 0
                if symbol and symbol not in self.found and (group == 0 or symbol >= 0xFF00):
                    self.found[symbol] = (low.value + index, level == 1)
        # Each key that produces nothing can carry two characters, the
        # second typed with shift.
        spare = [low.value + index for index, symbols in enumerate(keys) if not any(symbols)]
        self.free = [(code, 0) for code in spare] + ([(code, 1) for code in spare] if self.shift else [])
        self.carries = {code: [0, 0] for code in spare}
        self.borrowed, self.holder, self.used = {}, {}, {}

    def press(self, code, pressed):
        fake_key(self.display, code, pressed, 0)
        flush(self.display)

    @staticmethod
    def rest(since):
        wait = since + REST - time.monotonic()
        if wait > 0:
            time.sleep(wait)

    def borrow(self, symbol):
        """Put a keysym on a key that produces nothing, or on the borrowed key pressed longest ago."""
        if self.free:
            place = self.free.pop(0)
        elif self.holder:
            place = min(self.holder, key=self.used.__getitem__)
            del self.borrowed[self.holder.pop(place)]
            self.rest(self.used[place])
        else:
            raise Refused("The keyboard has no unused key to type this character with.")
        code, level = place
        self.carries[code][level] = symbol
        # A key with one letter alone types it lowercase, so until the key
        # carries a second character, it carries the first twice.
        first, second = self.carries[code]
        change_mapping(self.display, code, 2, (ulong * 2)(first, second or first), 1)
        sync(self.display, 0)
        self.borrowed[symbol], self.holder[place], self.used[place] = place, symbol, time.monotonic()
        time.sleep(0.02)  # for programs to take in the changed key

    def unlock(self):
        """Release caps lock, if it is on, until close: it would change the case of what is typed."""
        if self.locked and not self.released:
            lock_modifiers(self.display, CORE_KEYBOARD, LOCK, 0)
            sync(self.display, 0)
            self.released = True

    def close(self):
        """Return the borrowed keys to producing nothing, once programs have had time to read them."""
        if self.used:
            sync(self.display, 0)
            self.rest(max(self.used.values()) + 0.2)
            for code in {code for code, _ in self.used}:
                change_mapping(self.display, code, self.per, (ulong * self.per)(), 1)
            sync(self.display, 0)
            self.borrowed, self.holder, self.used = {}, {}, {}
        if self.released:
            lock_modifiers(self.display, CORE_KEYBOARD, LOCK, LOCK)
            self.released = False

    def tap(self, symbol, held=()):
        if symbol not in self.found and symbol not in self.borrowed:
            self.borrow(symbol)
        place = self.borrowed.get(symbol)
        code, shifted = (place[0], place[1] == 1) if place else self.found[symbol]
        if shifted and self.shift not in held:
            held = (*held, self.shift)
        for modifier in held:
            self.press(modifier, True)
        try:
            self.press(code, True)
            time.sleep(0.001)
            self.press(code, False)
        finally:
            for modifier in reversed(held):
                self.press(modifier, False)
        if place:
            self.used[place] = time.monotonic()
        time.sleep(0.002)


def type_text(arguments):
    text = arguments.get("text")
    if not isinstance(text, str) or not text or len(text) > 5000:
        raise Refused("text must be 1 to 5000 characters")
    symbols = [s for s in map(keysym, text.replace("\r\n", "\n").replace("\r", "\n")) if s is not None]
    with connect(input=True) as display:
        keyboard = Keyboard(display)
        try:
            keyboard.unlock()
            for symbol in symbols:
                keyboard.tap(symbol)
        finally:
            keyboard.close()
    return "typed"


def press_key(arguments):
    keys = arguments.get("keys")
    if not isinstance(keys, str) or not keys:
        raise Refused("keys is a key, or modifiers and a key joined by +, such as ctrl+c")
    names = keys.lower().split("+") if keys != "+" and not keys.endswith("++") else keys.lower()[:-1].split("+")[:-1] + ["+"]
    if names[-1] in KEYS:
        symbol = KEYS[names[-1]]
    elif len(names[-1]) == 1 and keysym(names[-1]) is not None:
        symbol = keysym(names[-1])
    else:
        raise Refused(f"unknown key {names[-1]}")
    for name in names[:-1]:
        if name not in MODIFIERS:
            raise Refused(f"unknown modifier {name}; use ctrl, shift, alt or super")
    with connect(input=True) as display:
        held = []
        for name in names[:-1]:
            code = keysym_code(display, MODIFIERS[name])
            if not code:
                raise Refused(f"the keyboard has no {name} key")
            if code not in held:
                held.append(code)
        keyboard = Keyboard(display)
        try:
            keyboard.tap(symbol, tuple(held))
        finally:
            keyboard.close()
    return "pressed"


def number(description):
    return {"type": "number", "description": description}


SPOT = {"x": number("pixels from the left edge of the latest screenshot"),
        "y": number("pixels from the top edge of the latest screenshot")}
TOOLS = [
    (screenshot, "screenshot", "Take a picture of the screen of the user's computer.", {}, []),
    (click, "click", "Click the mouse at a position on the screen.",
     {**SPOT, "button": {"type": "string", "enum": ["left", "right", "middle"], "description": "default left"},
      "count": {"type": "integer", "enum": [1, 2, 3], "description": "2 for a double click; default 1"}}, ["x", "y"]),
    (move, "move_pointer", "Move the mouse pointer to a position on the screen without clicking.", SPOT, ["x", "y"]),
    (drag, "drag", "Press the left mouse button at one position, move to another and let go.",
     {"from_x": number("start, pixels from the left"), "from_y": number("start, pixels from the top"),
      "to_x": number("end, pixels from the left"), "to_y": number("end, pixels from the top")},
     ["from_x", "from_y", "to_x", "to_y"]),
    (scroll, "scroll", "Turn the mouse wheel at a position on the screen.",
     {**SPOT, "down": {"type": "integer", "description": "wheel steps to scroll down; negative scrolls up"},
      "right": {"type": "integer", "description": "wheel steps to scroll right; negative scrolls left"}}, ["x", "y"]),
    (type_text, "type_text", "Enter text into whatever has the keyboard focus.",
     {"text": {"type": "string", "description": "the text to type"}}, ["text"]),
    (press_key, "press_key", "Press one key, alone or with modifiers, such as return, escape, ctrl+c or ctrl+shift+tab.",
     {"keys": {"type": "string", "description": "a key name or character, with any of ctrl, shift, alt, super before "
                                                "it joined by +; win and meta mean super, cmd means ctrl"}},
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
        except OSError as failure:
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
