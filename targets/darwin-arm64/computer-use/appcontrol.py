# The Computer Use tools on macOS. They read an app's windows through the
# accessibility interface and act on them, mostly in the background, so the
# user keeps the pointer and the keyboard. server.py hands each call to call().
#
# Only Python's standard library and the system's own frameworks are used.
import base64
import ctypes as c
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
LONGEST = 1568        # longest side of a picture handed back, in pixels
MAX_TEXT = 2000       # characters typed or put on the clipboard at once
VISIT_LIMIT = 5000    # elements read in one app_state
TIME_LIMIT = 12.0     # seconds one app_state may spend reading
CHILD_LIMIT = 400     # children read from one element
MAX_DEPTH = 64
SETTLE = 0.15         # seconds an app is given to show what an action changed
DEFAULT_LIMIT = 250


class Refused(Exception):
    """A request that cannot be carried out; the message says what to do instead."""


# ------------------------------------------------------------------ bindings
vp, CFIndex, UTF8 = c.c_void_p, c.c_long, 0x08000100
_AS = c.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
_CF = c.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
_OBJC = c.CDLL("/usr/lib/libobjc.A.dylib")
c.CDLL("/System/Library/Frameworks/AppKit.framework/AppKit")  # NSWorkspace


def _fn(library, name, result, *arguments):
    function = getattr(library, name)
    function.restype, function.argtypes = result, list(arguments)
    return function


class CGPoint(c.Structure):
    _fields_ = [("x", c.c_double), ("y", c.c_double)]


class CGSize(c.Structure):
    _fields_ = [("width", c.c_double), ("height", c.c_double)]


class CGRect(c.Structure):
    _fields_ = [("origin", CGPoint), ("size", CGSize)]


class CFRange(c.Structure):
    _fields_ = [("location", CFIndex), ("length", CFIndex)]


CFRelease = _fn(_CF, "CFRelease", None, vp)
CFRetain = _fn(_CF, "CFRetain", vp, vp)
CFEqual = _fn(_CF, "CFEqual", c.c_bool, vp, vp)
CFGetTypeID = _fn(_CF, "CFGetTypeID", c.c_ulong, vp)
CFStringCreateWithCString = _fn(_CF, "CFStringCreateWithCString", vp, vp, c.c_char_p, c.c_uint32)
CFStringGetLength = _fn(_CF, "CFStringGetLength", CFIndex, vp)
CFStringGetMaximumSizeForEncoding = _fn(_CF, "CFStringGetMaximumSizeForEncoding", CFIndex, CFIndex, c.c_uint32)
CFStringGetCString = _fn(_CF, "CFStringGetCString", c.c_bool, vp, c.c_char_p, CFIndex, c.c_uint32)
CFArrayCreate = _fn(_CF, "CFArrayCreate", vp, vp, c.POINTER(vp), CFIndex, vp)
CFArrayGetCount = _fn(_CF, "CFArrayGetCount", CFIndex, vp)
CFArrayGetValueAtIndex = _fn(_CF, "CFArrayGetValueAtIndex", vp, vp, CFIndex)
CFBooleanGetValue = _fn(_CF, "CFBooleanGetValue", c.c_bool, vp)
CFNumberCreate = _fn(_CF, "CFNumberCreate", vp, vp, CFIndex, vp)
CFNumberGetValue = _fn(_CF, "CFNumberGetValue", c.c_bool, vp, CFIndex, vp)
CFNumberIsFloatType = _fn(_CF, "CFNumberIsFloatType", c.c_bool, vp)
CFAttributedStringGetString = _fn(_CF, "CFAttributedStringGetString", vp, vp)
CFURLGetString = _fn(_CF, "CFURLGetString", vp, vp)
CFDictionaryGetValue = _fn(_CF, "CFDictionaryGetValue", vp, vp, vp)
CFDictionaryCreate = _fn(_CF, "CFDictionaryCreate", vp, vp, c.POINTER(vp), c.POINTER(vp), CFIndex, vp, vp)
CFRunLoopRunInMode = _fn(_CF, "CFRunLoopRunInMode", c.c_int32, vp, c.c_double, c.c_bool)
kCFRunLoopDefaultMode = vp.in_dll(_CF, "kCFRunLoopDefaultMode").value
kCFBooleanTrue = vp.in_dll(_CF, "kCFBooleanTrue").value
kCFBooleanFalse = vp.in_dll(_CF, "kCFBooleanFalse").value
ARRAY_CALLBACKS = c.addressof(vp.in_dll(_CF, "kCFTypeArrayCallBacks"))
T_STRING = _fn(_CF, "CFStringGetTypeID", c.c_ulong)()
T_NUMBER = _fn(_CF, "CFNumberGetTypeID", c.c_ulong)()
T_BOOLEAN = _fn(_CF, "CFBooleanGetTypeID", c.c_ulong)()
T_ARRAY = _fn(_CF, "CFArrayGetTypeID", c.c_ulong)()
T_ATTRIBUTED = _fn(_CF, "CFAttributedStringGetTypeID", c.c_ulong)()
T_URL = _fn(_CF, "CFURLGetTypeID", c.c_ulong)()

AXUIElementCreateApplication = _fn(_AS, "AXUIElementCreateApplication", vp, c.c_int32)
AXUIElementCreateSystemWide = _fn(_AS, "AXUIElementCreateSystemWide", vp)
AXUIElementCopyAttributeValue = _fn(_AS, "AXUIElementCopyAttributeValue", c.c_int32, vp, vp, c.POINTER(vp))
AXUIElementCopyAttributeValues = _fn(_AS, "AXUIElementCopyAttributeValues", c.c_int32, vp, vp, CFIndex, CFIndex,
                                     c.POINTER(vp))
AXUIElementGetAttributeValueCount = _fn(_AS, "AXUIElementGetAttributeValueCount", c.c_int32, vp, vp,
                                        c.POINTER(CFIndex))
AXUIElementCopyMultipleAttributeValues = _fn(_AS, "AXUIElementCopyMultipleAttributeValues", c.c_int32, vp, vp,
                                             c.c_uint32, c.POINTER(vp))
AXUIElementIsAttributeSettable = _fn(_AS, "AXUIElementIsAttributeSettable", c.c_int32, vp, vp, c.POINTER(c.c_bool))
AXUIElementSetAttributeValue = _fn(_AS, "AXUIElementSetAttributeValue", c.c_int32, vp, vp, vp)
AXUIElementCopyActionNames = _fn(_AS, "AXUIElementCopyActionNames", c.c_int32, vp, c.POINTER(vp))
AXUIElementCopyActionDescription = _fn(_AS, "AXUIElementCopyActionDescription", c.c_int32, vp, vp, c.POINTER(vp))
AXUIElementPerformAction = _fn(_AS, "AXUIElementPerformAction", c.c_int32, vp, vp)
AXUIElementGetPid = _fn(_AS, "AXUIElementGetPid", c.c_int32, vp, c.POINTER(c.c_int32))
AXUIElementCopyElementAtPosition = _fn(_AS, "AXUIElementCopyElementAtPosition", c.c_int32, vp, c.c_float, c.c_float,
                                       c.POINTER(vp))
AXUIElementSetMessagingTimeout = _fn(_AS, "AXUIElementSetMessagingTimeout", c.c_int32, vp, c.c_float)
AXValueCreate = _fn(_AS, "AXValueCreate", vp, c.c_uint32, vp)
AXValueGetType = _fn(_AS, "AXValueGetType", c.c_uint32, vp)
AXValueGetValue = _fn(_AS, "AXValueGetValue", c.c_bool, vp, c.c_uint32, vp)
AXIsProcessTrusted = _fn(_AS, "AXIsProcessTrusted", c.c_bool)
AXIsProcessTrustedWithOptions = _fn(_AS, "AXIsProcessTrustedWithOptions", c.c_bool, vp)
T_ELEMENT = _fn(_AS, "AXUIElementGetTypeID", c.c_ulong)()
T_AXVALUE = _fn(_AS, "AXValueGetTypeID", c.c_ulong)()
try:  # private, but kept stable for years; window managers rely on it
    _AXUIElementGetWindow = _fn(_AS, "_AXUIElementGetWindow", c.c_int32, vp, c.POINTER(c.c_uint32))
except AttributeError:
    _AXUIElementGetWindow = None

CGEventCreate = _fn(_AS, "CGEventCreate", vp, vp)
CGEventCreateMouseEvent = _fn(_AS, "CGEventCreateMouseEvent", vp, vp, c.c_uint32, CGPoint, c.c_uint32)
CGEventCreateKeyboardEvent = _fn(_AS, "CGEventCreateKeyboardEvent", vp, vp, c.c_uint16, c.c_bool)
CGEventCreateScrollWheelEvent2 = _fn(_AS, "CGEventCreateScrollWheelEvent2", vp, vp, c.c_uint32, c.c_uint32,
                                     c.c_int32, c.c_int32, c.c_int32)
CGEventKeyboardSetUnicodeString = _fn(_AS, "CGEventKeyboardSetUnicodeString", None, vp, c.c_ulong,
                                      c.POINTER(c.c_uint16))
CGEventGetLocation = _fn(_AS, "CGEventGetLocation", CGPoint, vp)
CGEventSetLocation = _fn(_AS, "CGEventSetLocation", None, vp, CGPoint)
CGEventSetFlags = _fn(_AS, "CGEventSetFlags", None, vp, c.c_uint64)
CGEventSetIntegerValueField = _fn(_AS, "CGEventSetIntegerValueField", None, vp, c.c_uint32, c.c_int64)
CGEventPost = _fn(_AS, "CGEventPost", None, c.c_uint32, vp)
CGEventPostToPid = _fn(_AS, "CGEventPostToPid", None, c.c_int32, vp)
CGWarpMouseCursorPosition = _fn(_AS, "CGWarpMouseCursorPosition", c.c_int32, CGPoint)
CGAssociateMouseAndMouseCursorPosition = _fn(_AS, "CGAssociateMouseAndMouseCursorPosition", c.c_int32, c.c_int32)
CGWindowListCopyWindowInfo = _fn(_AS, "CGWindowListCopyWindowInfo", vp, c.c_uint32, c.c_uint32)
CGRectMakeWithDictionaryRepresentation = _fn(_AS, "CGRectMakeWithDictionaryRepresentation", c.c_bool, vp,
                                             c.POINTER(CGRect))
CGGetActiveDisplayList = _fn(_AS, "CGGetActiveDisplayList", c.c_int32, c.c_uint32, c.POINTER(c.c_uint32),
                             c.POINTER(c.c_uint32))
CGDisplayBounds = _fn(_AS, "CGDisplayBounds", CGRect, c.c_uint32)
CGDisplayCopyDisplayMode = _fn(_AS, "CGDisplayCopyDisplayMode", vp, c.c_uint32)
CGDisplayModeGetPixelWidth = _fn(_AS, "CGDisplayModeGetPixelWidth", c.c_size_t, vp)
CGDisplayModeGetWidth = _fn(_AS, "CGDisplayModeGetWidth", c.c_size_t, vp)
CGDisplayModeRelease = _fn(_AS, "CGDisplayModeRelease", None, vp)
CGPreflightScreenCaptureAccess = _fn(_AS, "CGPreflightScreenCaptureAccess", c.c_bool)
CGRequestScreenCaptureAccess = _fn(_AS, "CGRequestScreenCaptureAccess", c.c_bool)

objc_getClass = _fn(_OBJC, "objc_getClass", vp, c.c_char_p)
sel_registerName = _fn(_OBJC, "sel_registerName", vp, c.c_char_p)
objc_autoreleasePoolPush = _fn(_OBJC, "objc_autoreleasePoolPush", vp)
objc_autoreleasePoolPop = _fn(_OBJC, "objc_autoreleasePoolPop", None, vp)
_MSG_SEND = c.cast(_OBJC.objc_msgSend, vp).value
_prototypes, _selectors = {}, {}


def send(receiver, selector, *arguments, result=vp, types=()):
    """An Objective-C message, with the C types of its result and arguments."""
    key = (result, tuple(types))
    function = _prototypes.get(key)
    if function is None:
        function = _prototypes[key] = c.CFUNCTYPE(result, vp, vp, *types)(_MSG_SEND)
    selected = _selectors.get(selector)
    if selected is None:
        selected = _selectors[selector] = sel_registerName(selector.encode())
    return function(receiver, selected, *arguments)


# Python may run as an app bundle (Python.app); with AppKit loaded the system
# would then list this program in the Dock and the app switcher as "Python".
# It has no windows of its own, so it says it is a background program.
send(send(objc_getClass(b"NSApplication"), "sharedApplication"), "setActivationPolicy:", 2, result=c.c_bool,
     types=(c.c_long,))


# ------------------------------------------------------------- CF values
def cf_text(ref):
    if not ref:
        return ""
    size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(ref), UTF8) + 1
    buffer = c.create_string_buffer(size)
    return buffer.value.decode("utf-8", "replace") if CFStringGetCString(ref, buffer, size, UTF8) else ""


_names = {}


def cfname(text):
    """A CFString kept for the life of the program, for names used again and again."""
    ref = _names.get(text)
    if ref is None:
        ref = _names[text] = CFStringCreateWithCString(None, text.encode("utf-8"), UTF8)
    return ref


def new_cf(value):
    """A new CF object holding a value from a request; the caller releases it."""
    if isinstance(value, bool):
        return CFRetain(kCFBooleanTrue if value else kCFBooleanFalse)
    if isinstance(value, int):
        number = c.c_int64(value)
        return CFNumberCreate(None, 4, c.byref(number))
    if isinstance(value, float):
        number = c.c_double(value)
        return CFNumberCreate(None, 13, c.byref(number))
    if isinstance(value, str):
        if "\0" in value:
            raise Refused("text cannot hold a NUL character")
        try:
            raw = value.encode("utf-8")
        except UnicodeEncodeError:
            raise Refused("the text holds a broken character")
        return CFStringCreateWithCString(None, raw, UTF8)
    raise Refused("a value must be text, a number, or true or false")


class Element(object):
    """An accessibility element, kept while this object lives."""
    __slots__ = ("ref",)

    def __init__(self, ref, retain=True):
        self.ref = CFRetain(ref) if retain else ref

    def __del__(self):
        ref, self.ref = self.ref, None
        if ref:
            try:
                CFRelease(ref)
            except Exception:
                pass

    def same(self, other):
        return isinstance(other, Element) and bool(CFEqual(self.ref, other.ref))


def ax_value(ref):
    kind = AXValueGetType(ref)
    if kind == 1:
        point = CGPoint()
        return (point.x, point.y) if AXValueGetValue(ref, 1, c.byref(point)) else None
    if kind == 2:
        size = CGSize()
        return (size.width, size.height) if AXValueGetValue(ref, 2, c.byref(size)) else None
    if kind == 3:
        rect = CGRect()
        if AXValueGetValue(ref, 3, c.byref(rect)):
            return (rect.origin.x, rect.origin.y, rect.size.width, rect.size.height)
        return None
    if kind == 4:
        span = CFRange()
        return {"location": span.location, "length": span.length} if AXValueGetValue(ref, 4, c.byref(span)) else None
    return None  # the mark of an attribute missing from a reading of several


def to_py(ref):
    """A CF value as a Python one. Elements come back as Element; kinds not needed here, as None."""
    if not ref:
        return None
    kind = CFGetTypeID(ref)
    if kind == T_STRING:
        return cf_text(ref)
    if kind == T_BOOLEAN:
        return bool(CFBooleanGetValue(ref))
    if kind == T_NUMBER:
        if CFNumberIsFloatType(ref):
            number = c.c_double()
            CFNumberGetValue(ref, 13, c.byref(number))
        else:
            number = c.c_int64()
            CFNumberGetValue(ref, 4, c.byref(number))
        return number.value
    if kind == T_ELEMENT:
        return Element(ref)
    if kind == T_ARRAY:
        return [to_py(CFArrayGetValueAtIndex(ref, i)) for i in range(CFArrayGetCount(ref))]
    if kind == T_AXVALUE:
        return ax_value(ref)
    if kind == T_ATTRIBUTED:
        return cf_text(CFAttributedStringGetString(ref))
    if kind == T_URL:
        return cf_text(CFURLGetString(ref))
    return None


# ----------------------------------------------------------- accessibility
AX_ERRORS = {-25200: "it failed", -25201: "a value was not one it takes", -25202: "the element is gone",
             -25204: "the app did not answer in time", -25205: "it has no such attribute",
             -25206: "it does not offer that action", -25208: "it does not support that",
             -25211: "the accessibility interface is turned off", -25212: "it has no value"}


def ax_error(error):
    return AX_ERRORS.get(error, "error %d" % error)


def ax_get(element, attribute):
    out = vp()
    if AXUIElementCopyAttributeValue(element.ref, cfname(attribute), c.byref(out)) != 0 or not out.value:
        return None
    try:
        return to_py(out.value)
    finally:
        CFRelease(out.value)


_name_arrays = {}


def ax_many(element, attributes):
    """Several attributes in one exchange with the app: those it has, and the error of the exchange."""
    key = tuple(attributes)
    names = _name_arrays.get(key)
    if names is None:
        items = (vp * len(key))(*[cfname(attribute) for attribute in key])
        names = _name_arrays[key] = CFArrayCreate(None, items, len(key), ARRAY_CALLBACKS)
    out = vp()
    error = AXUIElementCopyMultipleAttributeValues(element.ref, names, 0, c.byref(out))
    if error != 0 or not out.value:
        return {}, error or -25200
    found = {}
    try:
        for i in range(min(CFArrayGetCount(out.value), len(key))):
            value = to_py(CFArrayGetValueAtIndex(out.value, i))
            if value is not None:
                found[key[i]] = value
    finally:
        CFRelease(out.value)
    return found, 0


def ax_slice(element, attribute, most):
    """Up to most elements of an attribute that lists elements, or None when there is no such attribute."""
    out = vp()
    if AXUIElementCopyAttributeValues(element.ref, cfname(attribute), 0, most, c.byref(out)) != 0 or not out.value:
        return None
    try:
        found = []
        for i in range(CFArrayGetCount(out.value)):
            item = CFArrayGetValueAtIndex(out.value, i)
            if item and CFGetTypeID(item) == T_ELEMENT:
                found.append(Element(item))
        return found
    finally:
        CFRelease(out.value)


def ax_count(element, attribute):
    count = CFIndex()
    return count.value if AXUIElementGetAttributeValueCount(element.ref, cfname(attribute), c.byref(count)) == 0 else 0


def ax_set(element, attribute, value):
    ref = new_cf(value)
    if not ref:
        raise Refused("that value could not be handed to the app")
    try:
        return AXUIElementSetAttributeValue(element.ref, cfname(attribute), ref)
    finally:
        CFRelease(ref)


def settable(element, attribute):
    flag = c.c_bool()
    return AXUIElementIsAttributeSettable(element.ref, cfname(attribute), c.byref(flag)) == 0 and bool(flag.value)


def actions_of(element):
    out = vp()
    if AXUIElementCopyActionNames(element.ref, c.byref(out)) != 0 or not out.value:
        return []
    try:
        return [name for name in to_py(out.value) or [] if isinstance(name, str)]
    finally:
        CFRelease(out.value)


def action_description(element, action):
    out = vp()
    if AXUIElementCopyActionDescription(element.ref, cfname(action), c.byref(out)) != 0 or not out.value:
        return ""
    try:
        return cf_text(out.value)
    finally:
        CFRelease(out.value)


def perform(element, action):
    return AXUIElementPerformAction(element.ref, cfname(action))


def pid_of(element):
    pid = c.c_int32()
    return pid.value if AXUIElementGetPid(element.ref, c.byref(pid)) == 0 else None


def window_number(window):
    if _AXUIElementGetWindow is None:
        return None
    number = c.c_uint32()
    return number.value if _AXUIElementGetWindow(window.ref, c.byref(number)) == 0 and number.value else None


SYSTEM = Element(AXUIElementCreateSystemWide(), retain=False)
AXUIElementSetMessagingTimeout(SYSTEM.ref, 2.0)  # for every element: a hung app holds up a call this long at most
_app_elements = {}


def app_element(pid):
    element = _app_elements.get(pid)
    if element is None:
        element = _app_elements[pid] = Element(AXUIElementCreateApplication(pid), retain=False)
        # Apps built on Electron or Chromium lay out their accessibility tree
        # only once asked to; the others ignore this.
        ax_set(element, "AXManualAccessibility", True)
    return element


def need_access():
    if AXIsProcessTrusted():
        return
    key, yes = vp.in_dll(_AS, "kAXTrustedCheckOptionPrompt"), vp.in_dll(_CF, "kCFBooleanTrue")
    options = CFDictionaryCreate(None, c.byref(key), c.byref(yes), 1,
                                 c.addressof(vp.in_dll(_CF, "kCFTypeDictionaryKeyCallBacks")),
                                 c.addressof(vp.in_dll(_CF, "kCFTypeDictionaryValueCallBacks")))
    if options:
        AXIsProcessTrustedWithOptions(options)
        CFRelease(options)
    raise Refused("Using apps is not allowed yet. In System Settings > Privacy & Security > Accessibility, turn on "
                  "the application that runs this tool, then try again.")


def front_pid():
    focused = ax_get(SYSTEM, "AXFocusedApplication")
    return pid_of(focused) if isinstance(focused, Element) else None


# ------------------------------------------------------------------- apps
def pump():
    """Let in the system's news of apps that started, quit or came to the front."""
    for _ in range(50):
        if CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.0, True) != 4:  # 4: a source was handled
            break


def nsstring(obj):
    if not obj:
        return ""
    raw = send(obj, "UTF8String", result=c.c_char_p)
    return raw.decode("utf-8", "replace") if raw else ""


def url_path(url):
    return nsstring(send(url, "path")) if url else ""


def running_apps():
    pump()
    pool = objc_autoreleasePoolPush()
    try:
        workspace = send(objc_getClass(b"NSWorkspace"), "sharedWorkspace")
        front = send(workspace, "frontmostApplication")
        front_number = send(front, "processIdentifier", result=c.c_int32) if front else -1
        listing = send(workspace, "runningApplications")
        found = []
        for i in range(send(listing, "count", result=c.c_ulong)):
            app = send(listing, "objectAtIndex:", i, types=(c.c_ulong,))
            if not app or send(app, "isTerminated", result=c.c_bool):
                continue
            pid = send(app, "processIdentifier", result=c.c_int32)
            path = url_path(send(app, "bundleURL"))
            found.append({"pid": pid, "name": nsstring(send(app, "localizedName")),
                          "bundle_id": nsstring(send(app, "bundleIdentifier")),
                          "file": os.path.splitext(os.path.basename(path))[0] if path else "", "path": path,
                          "executable": url_path(send(app, "executableURL")),
                          "policy": send(app, "activationPolicy", result=c.c_long),
                          "hidden": bool(send(app, "isHidden", result=c.c_bool)), "frontmost": pid == front_number})
        return found
    finally:
        objc_autoreleasePoolPop(pool)


# Apps no tool here touches, whatever policy.json says: they show the
# questions that approve these very tools, and the system's security prompts.
PROTECTED_BUNDLES = {"io.github.lee-xeo.claude-cage", "com.apple.SecurityAgent",
                     "com.apple.LocalAuthentication.UIAgent", "com.apple.UserNotificationCenter",
                     "com.apple.coreservices.uiagent", "com.apple.accessibility.universalAccessAuthWarn",
                     "com.apple.loginwindow", "com.apple.ScreenSaver.Engine"}
PROTECTED_PROGRAMS = {"osascript", "SecurityAgent", "coreautha", "universalAccessAuthWarn", "UserNotificationCenter",
                      "loginwindow", "CoreServicesUIAgent", "CageUpdateInstaller"}
DEFAULT_POLICY = {
    "click_only": ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.*", "com.mitchellh.ghostty",
                   "net.kovidgoyal.kitty", "org.alacritty", "io.alacritty", "com.github.wez.wezterm", "co.zeit.hyper",
                   "com.microsoft.VSCode", "com.microsoft.VSCodeInsiders", "com.vscodium",
                   "com.todesktop.230313mzl4w4u92", "com.exafunction.windsurf", "dev.zed.*", "com.apple.dt.Xcode",
                   "com.jetbrains.*", "com.google.android.studio", "com.sublimetext.*", "com.panic.Nova",
                   "com.barebones.bbedit"],
    "blocked": ["com.apple.keychainaccess", "com.apple.Passwords", "com.1password.*", "com.agilebits.*",
                "com.bitwarden.desktop", "com.lastpass.*", "com.dashlane.*", "org.keepassxc.keepassxc"],
    "guarded_windows": {
        "com.apple.systempreferences": [
            "Privacy", "隐私", "Accessibility", "辅助功能", "Screen & System Audio Recording", "录屏", "Full Disk Access",
            "完全磁盘访问", "Automation", "自动化", "Input Monitoring", "输入监控", "Files & Folders", "文件与文件夹",
            "App Management", "App 管理", "Developer Tools", "开发者工具", "Users & Groups", "用户与群组",
            "Login Items", "登录项", "Touch ID", "触控 ID", "Password", "密码", "Lock Screen", "锁定屏幕", "Sharing",
            "共享", "Device Management", "设备管理", "Profiles", "描述文件"]},
}


def policy():
    try:
        with open(os.path.join(HERE, "policy.json"), encoding="utf-8") as file:
            data = json.load(file)
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    rules = {}
    for key in ("click_only", "blocked"):
        listed = data.get(key, DEFAULT_POLICY[key])
        rules[key] = [item for item in listed if isinstance(item, str)] if isinstance(listed, list) else []
    guarded = data.get("guarded_windows", DEFAULT_POLICY["guarded_windows"])
    rules["guarded_windows"] = {bundle: [t for t in titles if isinstance(t, str) and t]
                                for bundle, titles in (guarded.items() if isinstance(guarded, dict) else [])
                                if isinstance(titles, list)}
    return rules


def listed_in(bundle, patterns):
    bundle = bundle.lower()
    for pattern in patterns:
        pattern = pattern.lower()
        if pattern.endswith("*") and bundle.startswith(pattern[:-1]) or bundle == pattern:
            return bool(bundle)
    return False


def protected(app):
    if app["bundle_id"] in PROTECTED_BUNDLES or app["bundle_id"].startswith("io.github.lee-xeo."):
        return True
    if os.path.basename(app["executable"]) in PROTECTED_PROGRAMS or app["name"] in PROTECTED_PROGRAMS:
        return True
    return "/Cage.app/" in app["path"] + "/" or "/Cage.app/" in app["executable"]


def access_of(app, rules=None):
    if protected(app):
        return "protected"
    rules = rules or policy()
    if listed_in(app["bundle_id"], rules["blocked"]):
        return "blocked"
    if listed_in(app["bundle_id"], rules["click_only"]):
        return "click_only"
    return "full"


def quoted(text):
    return json.dumps(text, ensure_ascii=False)


def lookup_app(query, apps=None):
    """The running app a request names, or None. Several equally good matches are refused."""
    if isinstance(query, int) and not isinstance(query, bool):
        query = str(query)
    if not isinstance(query, str) or not query.strip():
        raise Refused("app is the name, bundle identifier or process id of a running app, as list_apps shows")
    wanted = query.strip()
    low = wanted.lower()
    apps = running_apps() if apps is None else apps
    tests = [lambda a: a["bundle_id"].lower() == low,
             lambda a: wanted.isdigit() and a["pid"] == int(wanted),
             lambda a: a["name"].lower() == low or a["file"].lower() == low,
             lambda a: a["policy"] == 0 and (a["name"].lower().startswith(low) or a["file"].lower().startswith(low)),
             lambda a: a["policy"] == 0 and (low in a["name"].lower() or low in a["file"].lower())]
    for test in tests:
        found = [app for app in apps if test(app)]
        if len(found) > 1:
            regular = [app for app in found if app["policy"] == 0]
            found = regular if len(regular) == 1 else found
        if len(found) == 1:
            return found[0]
        if found:
            raise Refused("several running apps match %s: %s. Give the bundle identifier." % (quoted(wanted), "; ".join(
                "%s (%s, pid %d)" % (a["name"], a["bundle_id"] or "no bundle identifier", a["pid"]) for a in found[:8])))
    return None


def admit(app):
    app["access"] = access_of(app)
    if app["access"] == "protected":
        raise Refused("%s cannot be used through these tools: it shows the user's permission questions and security "
                      "prompts, which only the user may answer." % app["name"])
    if app["access"] == "blocked":
        raise Refused("%s is blocked for these tools because it keeps passwords or other secrets (policy.json beside "
                      "the tools lists it). Ask the user to do this part themselves." % app["name"])
    return app


def find_app(query):
    app = lookup_app(query)
    if app is None:
        raise Refused("no running app matches %s. list_apps shows the running apps; open_app starts one."
                      % quoted(str(query).strip()))
    return admit(app)


def need_full(app, what):
    if app["access"] == "click_only":
        raise Refused("%s is limited to looking, left clicks and scrolling, since it is a terminal or code editor: %s "
                      "is refused there. Commands and code are better handled with shell and file tools; the user can "
                      "change this in policy.json beside these tools." % (app["name"], what))


def guard(app):
    """Refuse to act while an app shows a settings page about security, passwords or sharing."""
    titles = policy()["guarded_windows"].get(app["bundle_id"])
    if not titles:
        return
    for window in windows_of(app_element(app["pid"])):
        title = window["title"].lower()
        if any(word.lower() in title for word in titles):
            raise Refused("%s is showing %s, a page about privacy, security, passwords, accounts or sharing. These tools "
                          "only look at it; ask the user to make changes there." % (app["name"], quoted(window["title"])))


# ------------------------------------------------------- screen and windows
def displays():
    ids, count = (c.c_uint32 * 16)(), c.c_uint32()
    if CGGetActiveDisplayList(16, ids, c.byref(count)) != 0:
        return []
    found = []
    for number in ids[:count.value]:
        bounds = CGDisplayBounds(number)
        scale, mode = 1.0, CGDisplayCopyDisplayMode(number)
        if mode:
            try:
                points = CGDisplayModeGetWidth(mode)
                if points:
                    scale = CGDisplayModeGetPixelWidth(mode) / float(points)
            finally:
                CGDisplayModeRelease(mode)
        found.append((bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height, scale))
    return found


def scale_at(x, y):
    found = displays()
    for left, top, wide, high, scale in found:
        if left <= x < left + wide and top <= y < top + high:
            return scale
    return found[0][4] if found else 2.0


def measure(wide, high):
    """The size of a picture of an area, at most LONGEST pixels on its longest side."""
    shrink = max(1.0, max(wide, high) / float(LONGEST))
    return max(1, int(round(wide / shrink))), max(1, int(round(high / shrink)))


_window_keys = {}


def window_key(name):
    ref = _window_keys.get(name)
    if ref is None:
        ref = _window_keys[name] = vp.in_dll(_AS, name).value
    return ref


def screen_windows():
    """The windows on screen, front to back."""
    info = CGWindowListCopyWindowInfo(1 | 16, 0)  # on screen only, without the desktop
    found = []
    if not info:
        return found
    try:
        for i in range(CFArrayGetCount(info)):
            entry = CFArrayGetValueAtIndex(info, i)
            bounds = CGRect()
            if not CGRectMakeWithDictionaryRepresentation(CFDictionaryGetValue(entry, window_key("kCGWindowBounds")),
                                                          c.byref(bounds)):
                continue
            value = lambda name: to_py(CFDictionaryGetValue(entry, window_key(name)))
            found.append({"id": value("kCGWindowNumber"), "pid": value("kCGWindowOwnerPID"),
                          "layer": value("kCGWindowLayer") or 0, "alpha": value("kCGWindowAlpha"),
                          "owner": value("kCGWindowOwnerName") or "", "title": value("kCGWindowName") or "",
                          "frame": (bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height)})
    finally:
        CFRelease(info)
    return found


def inside(point, frame):
    return frame[0] <= point.x < frame[0] + frame[2] and frame[1] <= point.y < frame[1] + frame[3]


def overlap(a, b):
    left, top = max(a[0], b[0]), max(a[1], b[1])
    right, bottom = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    return (left, top, right - left, bottom - top) if right > left and bottom > top else None


def frame_of(values):
    position, size = values.get("AXPosition"), values.get("AXSize")
    if isinstance(position, tuple) and isinstance(size, tuple) and len(position) == 2 and len(size) == 2:
        return (position[0], position[1], size[0], size[1])
    return None


def clean(value, most=200):
    if not isinstance(value, str):
        return ""
    text = " ".join(value.split())
    return text if len(text) <= most else text[:most - 1] + "…"


def excerpt(value, most):
    text = value.strip()
    return text if len(text) <= most else text[:most - 1] + "…"


WINDOW_ATTRIBUTES = ["AXTitle", "AXRole", "AXSubrole", "AXPosition", "AXSize", "AXMinimized", "AXMain", "AXModal"]


def windows_of(application):
    windows = ax_get(application, "AXWindows")
    focused = ax_get(application, "AXFocusedWindow")
    listed, shown = [], None
    for window in windows if isinstance(windows, list) else []:
        if not isinstance(window, Element):
            continue
        values, _ = ax_many(window, WINDOW_ATTRIBUTES)
        entry = {"element": window, "title": clean(values.get("AXTitle"), 120), "subrole": values.get("AXSubrole") or "",
                 "frame": frame_of(values), "minimized": bool(values.get("AXMinimized")),
                 "main": bool(values.get("AXMain")), "focused": window.same(focused), "number": window_number(window)}
        if entry["number"] is None and entry["frame"]:
            if shown is None:
                shown = screen_windows()
            pid = pid_of(window)
            for candidate in shown:
                if candidate["pid"] == pid and candidate["layer"] == 0 and all(
                        abs(a - b) < 2 for a, b in zip(candidate["frame"], entry["frame"])):
                    entry["number"] = candidate["id"]
                    break
        listed.append(entry)
    return listed


def pick_window(app, windows, number=None, title=None):
    if not windows:
        raise Refused("%s has no open window. app_menu can open one (such as File > New), and open_app shows the app."
                      % app["name"])
    if number is not None:
        if not isinstance(number, int) or isinstance(number, bool) or not 0 <= number < len(windows):
            raise Refused("there is no window %s; the app has %d, numbered from 0" % (number, len(windows)))
        return number
    if title is not None:
        if not isinstance(title, str) or not title.strip():
            raise Refused("window_title is part of a window's title")
        found = [i for i, window in enumerate(windows) if title.strip().lower() in window["title"].lower()]
        if len(found) != 1:
            raise Refused("%s windows have a title with %s; the windows are %s" % (
                "several" if found else "no", quoted(title), "; ".join(quoted(w["title"]) for w in windows)))
        return found[0]
    for key in ("focused", "main"):
        for i, window in enumerate(windows):
            if window[key] and not window["minimized"]:
                return i
    for i, window in enumerate(windows):
        if not window["minimized"]:
            return i
    return 0


def jpeg_size(data):
    at = 2
    while at + 9 < len(data):
        if data[at] != 0xFF:
            break
        marker, length = data[at + 1], int.from_bytes(data[at + 2:at + 4], "big")
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            return int.from_bytes(data[at + 7:at + 9], "big"), int.from_bytes(data[at + 5:at + 7], "big")
        at += 2 + length
    raise Refused("the picture of the window could not be read")


def capture_window(number):
    """A JPEG of one window, even under others, at most LONGEST pixels on its longest side; None if it cannot be had."""
    with tempfile.TemporaryDirectory() as folder:
        path = os.path.join(folder, "window.jpg")
        run = subprocess.run(["/usr/sbin/screencapture", "-x", "-o", "-l", str(number), "-t", "jpg", path],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        if run.returncode != 0 or not os.path.exists(path) or os.path.getsize(path) == 0:
            return None
        with open(path, "rb") as file:
            data = file.read()
        width, height = jpeg_size(data)
        wanted = measure(width, height)
        if wanted != (width, height):
            subprocess.run(["/usr/bin/sips", "-z", str(wanted[1]), str(wanted[0]), path], check=True, timeout=20,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            with open(path, "rb") as file:
                data = file.read()
            width, height = jpeg_size(data)
    return data, width, height


def image(data):
    return {"type": "image", "data": base64.b64encode(data).decode(), "mimeType": "image/jpeg"}


def text(words):
    return {"type": "text", "text": words}


# ------------------------------------------------------------------- views
VIEWS = {}  # process id: what the latest app_state of that app showed


class View(object):
    def __init__(self, app, window):
        self.pid, self.name, self.window = app["pid"], app["name"], window
        self.elements, self.notes = [None], [None]
        self.geometry = None  # window left, top, width, height in points; picture width, height

    def add(self, element, note):
        self.elements.append(element)
        self.notes.append(note)
        return len(self.elements) - 1

    def find(self, element):
        for number in range(1, len(self.elements)):
            if self.elements[number].same(element):
                return number
        return None


def need_view(app):
    view = VIEWS.get(app["pid"])
    if view is None:
        raise Refused("call app_state for %s first: element numbers and picture positions come from it" % app["name"])
    return view


def element_at(view, number):
    if not isinstance(number, int) or isinstance(number, bool) or not 1 <= number < len(view.elements):
        raise Refused("there is no element %s for %s; the latest app_state numbered 1 to %d"
                      % (number, view.name, len(view.elements) - 1))
    return view.elements[number]


def fresh(element, number):
    values, error = ax_many(element, BASE)
    if not values.get("AXRole"):
        raise Refused("element %d is no longer there (%s); call app_state again for current numbers"
                      % (number, ax_error(error) if error else "it gives no details"))
    return values


def to_picture(view, x, y):
    left, top, wide, high, width, height = view.geometry
    return int(round((x - left) * width / wide)), int(round((y - top) * height / high))


def picture_point(view, arguments):
    if view.geometry is None:
        raise Refused("the latest app_state of %s had no window to measure; give an element instead" % view.name)
    try:
        x, y = float(arguments["x"]), float(arguments["y"])
    except (KeyError, TypeError, ValueError):
        raise Refused("x and y are numbers, in pixels of the latest app_state picture")
    left, top, wide, high, width, height = view.geometry
    if not (0 <= x <= width and 0 <= y <= height):
        raise Refused("that position is outside the picture, which is %dx%d pixels" % (width, height))
    values, _ = ax_many(view.window["element"], ["AXPosition"])  # the window may have moved since
    position = values.get("AXPosition")
    if isinstance(position, tuple) and len(position) == 2:
        left, top = position
    return CGPoint(left + min(x, width - 0.5) * wide / width, top + min(y, height - 0.5) * high / height)


# --------------------------------------------------------- reading a window
BASE = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXPlaceholderValue", "AXIdentifier", "AXHelp",
        "AXPosition", "AXSize", "AXEnabled", "AXFocused", "AXSelected", "AXExpanded", "AXDisclosing", "AXURL"]
ROLE_NAMES = {
    "AXButton": "button", "AXCheckBox": "checkbox", "AXRadioButton": "radio button", "AXPopUpButton": "pop-up button",
    "AXMenuButton": "menu button", "AXTextField": "text field", "AXTextArea": "text area", "AXComboBox": "combo box",
    "AXStaticText": "text", "AXLink": "link", "AXImage": "image", "AXSlider": "slider", "AXIncrementor": "stepper",
    "AXTabGroup": "tabs", "AXTable": "table", "AXOutline": "outline", "AXList": "list", "AXRow": "row",
    "AXCell": "cell", "AXColumn": "column", "AXScrollArea": "scroll area", "AXToolbar": "toolbar", "AXGroup": "group",
    "AXSplitGroup": "split group", "AXWindow": "window", "AXSheet": "sheet", "AXDrawer": "drawer",
    "AXWebArea": "web page", "AXHeading": "heading", "AXMenu": "menu", "AXMenuItem": "menu item",
    "AXDisclosureTriangle": "disclosure", "AXProgressIndicator": "progress", "AXBusyIndicator": "busy",
    "AXBrowser": "column browser", "AXDateField": "date field", "AXColorWell": "color well",
    "AXLevelIndicator": "level", "AXRadioGroup": "radio group", "AXPopover": "popover", "AXGrid": "grid",
    "AXLayoutArea": "layout area", "AXLayoutItem": "layout item", "AXSecureTextField": "password field"}
SUBROLE_NAMES = {
    "AXCloseButton": "close", "AXMinimizeButton": "minimize", "AXZoomButton": "zoom",
    "AXFullScreenButton": "full screen", "AXSearchField": "search", "AXSecureTextField": "password",
    "AXSwitch": "switch", "AXToggle": "toggle", "AXSortButton": "sort", "AXTabButton": "tab", "AXDialog": "dialog",
    "AXSystemDialog": "system dialog", "AXFloatingWindow": "floating", "AXTextAttachment": "attachment"}
TEXT_INPUTS = {"AXTextField", "AXTextArea", "AXComboBox", "AXSecureTextField", "AXDateField"}
ONE_LINE = {"AXTextField", "AXComboBox", "AXSecureTextField", "AXDateField"}
TOGGLES = {"AXCheckBox", "AXRadioButton"}
NUMERIC = {"AXSlider", "AXIncrementor", "AXLevelIndicator", "AXProgressIndicator"}
CONTROLS = {"AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTextField", "AXTextArea",
            "AXComboBox", "AXLink", "AXSlider", "AXIncrementor", "AXDisclosureTriangle", "AXMenuItem", "AXDateField",
            "AXColorWell", "AXRow", "AXSecureTextField"}
STRUCTURE = {"AXWindow", "AXSheet", "AXDrawer", "AXPopover", "AXToolbar", "AXTabGroup", "AXTable", "AXOutline",
             "AXList", "AXBrowser", "AXWebArea", "AXRadioGroup", "AXGrid", "AXMenu", "AXHeading"}
SIZED = {"AXWindow", "AXSheet", "AXTable", "AXOutline", "AXList", "AXBrowser", "AXWebArea", "AXTextArea",
         "AXScrollArea", "AXGroup", "AXGrid", "AXPopover", "AXTabGroup"}
LEAVES = {"AXStaticText", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXSlider", "AXIncrementor",
          "AXValueIndicator", "AXScrollBar", "AXProgressIndicator", "AXBusyIndicator", "AXSplitter", "AXColorWell",
          "AXPopUpButton", "AXComboBox", "AXDisclosureTriangle", "AXLevelIndicator", "AXMenuButton", "AXDateField",
          "AXImage", "AXHandle", "AXSecureTextField"}
SKIPPED = {"AXMenuBar", "AXScrollBar", "AXValueIndicator", "AXSplitter", "AXRuler", "AXGrowArea", "AXHandle"}
TABLES = {"AXTable", "AXOutline", "AXList", "AXGrid", "AXBrowser"}
GATHER = {"AXRow", "AXLink", "AXButton", "AXMenuButton", "AXRadioButton", "AXMenuItem"}


class Walker(object):
    """Reads a window's elements for app_state, numbering those worth listing."""

    def __init__(self, view, limit, query=None):
        self.view, self.limit = view, limit
        self.query = query.lower() if query else None
        self.deadline = time.time() + TIME_LIMIT
        self.visited, self.listed, self.cut = 0, 0, False
        self.lines, self.memo, self.kids = [], {}, {}

    def stopped(self):
        if self.listed >= self.limit or self.visited >= VISIT_LIMIT or time.time() > self.deadline:
            self.cut = True
        return self.cut

    def values(self, element):
        found = self.memo.get(id(element))
        if found is None:
            self.visited += 1
            found, _ = ax_many(element, BASE)
            self.memo[id(element)] = found
        return found

    def children(self, element, role):
        found = self.kids.get(id(element))
        if found is None:
            found = ([], 0)
            if role not in LEAVES:
                order = ("AXVisibleRows", "AXVisibleChildren", "AXChildren") if role in TABLES else ("AXChildren",)
                for attribute in order:
                    items = ax_slice(element, attribute, CHILD_LIMIT)
                    if items is not None:
                        total = ax_count(element, attribute) if len(items) >= CHILD_LIMIT else len(items)
                        found = (items, total)
                        break
            self.kids[id(element)] = found
        return found

    def texts(self, element, depth, found, most=4):
        """The first few pieces of text inside an element, to name a row, link or button that has no name."""
        if depth > 3 or len(found) >= most:
            return
        values = self.values(element)
        role = values.get("AXRole") or ""
        if role in ("AXStaticText", "AXTextField", "AXHeading"):
            piece = clean(values.get("AXValue"), 80) or clean(values.get("AXTitle"), 80) or clean(
                values.get("AXDescription"), 80)
            if piece and piece not in found:
                found.append(piece)
            return
        if role == "AXImage":
            piece = clean(values.get("AXDescription"), 80)
            if piece and piece not in found:
                found.append(piece)
            return
        for child in self.children(element, role)[0][:12]:
            self.texts(child, depth + 1, found, most)
            if len(found) >= most:
                return

    def label(self, element, values, role):
        if role == "AXStaticText":
            return clean(values.get("AXValue")) or clean(values.get("AXTitle")) or clean(values.get("AXDescription"))
        name = clean(values.get("AXTitle")) or clean(values.get("AXDescription"))
        if not name and role in GATHER:
            found = []
            for child in self.children(element, role)[0][:12]:
                self.texts(child, 1, found)
                if len(found) >= 4:
                    break
            name = clean(" · ".join(found), 160)
        if not name and role in CONTROLS:
            name = clean(values.get("AXHelp"), 120)
        return name

    def entry(self, values, role, name, around):
        """How an element is listed, or None when it is not worth a line of its own."""
        if not role or role in SKIPPED:
            return None
        if role == "AXStaticText":
            if not name or (around and name in around):
                return None
        elif role == "AXImage":
            if not name:
                return None
        elif role not in CONTROLS and role not in STRUCTURE and (not name or name == around):
            return None  # a container without a name of its own only holds what follows
        subrole = values.get("AXSubrole") or ""
        kind = ROLE_NAMES.get(role) or role[2:].lower() or "element"
        if SUBROLE_NAMES.get(subrole) and SUBROLE_NAMES[subrole] != kind:
            kind += " (" + SUBROLE_NAMES[subrole] + ")"
        words = [kind]
        if name:
            words.append(quoted(name))
        value = values.get("AXValue")
        if role in TEXT_INPUTS:
            if role == "AXSecureTextField" or subrole == "AXSecureTextField":
                pass  # never shown
            elif isinstance(value, str) and value.strip():
                words.append("value=" + quoted(excerpt(value, 1000 if role == "AXTextArea" else 300)))
            else:
                hint = clean(values.get("AXPlaceholderValue"), 80)
                words.append("empty" + (" placeholder=" + quoted(hint) if hint else ""))
        elif role in TOGGLES and isinstance(value, int) and not isinstance(value, bool):
            if subrole in ("AXSwitch", "AXToggle"):
                words.append({0: "off", 1: "on"}.get(value, "value=%d" % value))
            else:
                words.append({0: "unchecked", 1: "checked", 2: "mixed"}.get(value, "value=%d" % value))
        elif role in NUMERIC and isinstance(value, (int, float)) and not isinstance(value, bool):
            words.append("value=%g" % value)
        elif role in ("AXPopUpButton", "AXComboBox", "AXMenuButton") and isinstance(value, str) and value.strip():
            words.append("value=" + quoted(clean(value, 80)))
        elif role == "AXDisclosureTriangle" and isinstance(value, int):
            words.append("expanded" if value else "collapsed")
        url = values.get("AXURL")
        if role == "AXLink" and isinstance(url, str) and url:
            words.append("url=" + quoted(clean(url, 120)))
        if values.get("AXFocused") is True:
            words.append("focused")
        if values.get("AXSelected") is True:
            words.append("selected")
        if values.get("AXEnabled") is False:
            words.append("disabled")
        for key in ("AXExpanded", "AXDisclosing"):
            if isinstance(values.get(key), bool) and role in ("AXRow", "AXPopUpButton", "AXComboBox", "AXMenuButton",
                                                             "AXGroup", "AXOutline"):
                words.append("expanded" if values[key] else "collapsed")
                break
        identifier = values.get("AXIdentifier")
        if not name and isinstance(identifier, str) and 0 < len(identifier) <= 60:
            words.append("id=" + identifier)
        return " ".join(words)

    def matches(self, values, name):
        for key in ("AXValue", "AXIdentifier", "AXPlaceholderValue", "AXHelp", "AXURL", "AXDescription", "AXTitle"):
            found = values.get(key)
            if isinstance(found, str) and self.query in found.lower():
                return True
        return self.query in name.lower()

    def place(self, frame, role):
        if not frame or self.view.geometry is None or frame[2] <= 0 or frame[3] <= 0:
            return ""
        left, top, wide, high, width, height = self.view.geometry
        x, y = to_picture(self.view, frame[0] + frame[2] / 2.0, frame[1] + frame[3] / 2.0)
        if not (0 <= x <= width and 0 <= y <= height):
            return ""  # outside the picture
        where = "@%d,%d" % (x, y)
        if role in SIZED:
            where += " %dx%d" % (round(frame[2] * width / wide), round(frame[3] * height / high))
        return where

    def walk(self, element, depth=0, indent=0, clip=None, around="", trail=()):
        if self.stopped():
            return
        values = self.values(element)
        role = values.get("AXRole") or ""
        if role in SKIPPED:
            return
        frame = frame_of(values)
        if frame and frame[2] > 0 and frame[3] > 0 and clip and not overlap(frame, clip):
            return  # scrolled out of sight
        name = self.label(element, values, role)
        line = self.entry(values, role, name, around)
        if line is not None:
            if self.query is None or self.matches(values, name):
                number = self.view.add(element, line)
                where = self.place(frame, role)
                if self.query is None:
                    self.lines.append("%s[%d] %s%s" % ("  " * min(indent, 12), number, line, " " + where if where else ""))
                else:
                    self.lines.append("[%d] %s%s%s" % (number, line, " " + where if where else "",
                                                       "  in: " + " › ".join(trail[-3:]) if trail else ""))
                self.listed += 1
            if self.query is None:
                indent += 1
            if name:
                around = name
                if role in STRUCTURE or role in ("AXRow", "AXGroup", "AXCell"):
                    trail = tuple(trail) + ((ROLE_NAMES.get(role) or role[2:].lower()) + " " + quoted(clean(name, 40)),)
        if role == "AXScrollArea" and frame and frame[2] > 0 and frame[3] > 0:
            clip = overlap(frame, clip) if clip else frame
            clip = clip or frame
        if depth >= MAX_DEPTH:
            return
        items, total = self.children(element, role)
        for child in items:
            if self.stopped():
                break
            self.walk(child, depth + 1, indent, clip, around, trail)
        if total > len(items) and self.query is None and not self.cut:
            self.lines.append("%s… %d more inside, not read" % ("  " * min(indent, 12), total - len(items)))


def picture_of(app, window):
    """A picture of a window, and why there is none when there is not."""
    if window["minimized"]:
        return None, "the window is minimized; app_set_value with attribute minimized and false brings it back"
    if app["hidden"]:
        return None, "the app is hidden; open_app with foreground true shows it"
    if not window["number"]:
        return None, "the system gave no number to picture this window by"
    if not CGPreflightScreenCaptureAccess():
        CGRequestScreenCaptureAccess()
        return None, ("seeing the screen is not allowed yet: in System Settings > Privacy & Security > Screen & System "
                      "Audio Recording, turn on the application that runs this tool and start it again")
    shot = capture_window(window["number"])
    if shot is None:
        return None, "the window could not be pictured; it may be on another desktop space"
    return shot, ""


def tool_app_state(arguments):
    need_access()
    app = find_app(arguments.get("app"))
    application = app_element(app["pid"])
    show(app, "查看窗口")
    limit = whole(arguments, "limit", DEFAULT_LIMIT, 20, 800)
    query = arguments.get("query")
    if query is not None and (not isinstance(query, str) or not query.strip()):
        raise Refused("query is a piece of text to look for")
    query = query.strip() if query else None
    start = arguments.get("inside")
    content, lines = [], []
    if start is not None:
        view = need_view(app)
        base = element_at(view, start)
        fresh(base, start)
        walker = Walker(view, limit, query)
        walker.walk(base)
        lines.append("Inside [%d] %s of %s; new numbers follow on from the earlier ones%s:" % (
            start, short(view.notes[start]), app["name"], ", matching " + quoted(query) if query else ""))
        if arguments.get("screenshot") is True and view.window.get("number"):
            shot, why = picture_of(app, view.window)
            if shot:
                content.append(image(shot[0]))
            elif why:
                lines.append("No picture: %s." % why)
    else:
        windows = windows_of(application)
        chosen = pick_window(app, windows, arguments.get("window"), arguments.get("window_title"))
        window = windows[chosen]
        view = View(app, window)
        why = ""
        if window["frame"] and window["frame"][2] > 0 and window["frame"][3] > 0:
            frame = window["frame"]
            shot = None
            if arguments.get("screenshot", True) is not False:
                shot, why = picture_of(app, window)
            if shot:
                content.append(image(shot[0]))
                view.geometry = frame + (shot[1], shot[2])
            else:
                scale = scale_at(frame[0] + frame[2] / 2.0, frame[1] + frame[3] / 2.0)
                view.geometry = frame + measure(round(frame[2] * scale), round(frame[3] * scale))
        VIEWS[app["pid"]] = view
        lines.append("%s (%s, pid %d), %s%s%s." % (
            app["name"], app["bundle_id"] or "no bundle identifier", app["pid"],
            "in front" if app["frontmost"] else "in the background", ", hidden" if app["hidden"] else "",
            ", click_only" if app["access"] == "click_only" else ""))
        lines.append("Windows: " + " · ".join("%d %s%s%s%s" % (
            i, quoted(w["title"]) if w["title"] else "(untitled)",
            " %dx%d" % (w["frame"][2], w["frame"][3]) if w["frame"] else "", " minimized" if w["minimized"] else "",
            " ← this one" if i == chosen else "") for i, w in enumerate(windows)))
        if view.geometry:
            width, height = view.geometry[4], view.geometry[5]
            if content:
                lines.append("Picture of window %d: %dx%d pixels. Positions are element centers in pixels of this "
                             "picture, the same as app_click takes x and y." % (chosen, width, height))
            else:
                lines.append("No picture%s. Positions are element centers in pixels of a %dx%d picture of window %d, "
                             "as app_click takes x and y." % (": " + why if why else "", width, height, chosen))
        walker = Walker(view, limit, query)
        for child in ax_slice(application, "AXChildren", 30) or []:
            if ax_get(child, "AXRole") == "AXMenu":  # a menu that is open now, in front of everything
                lines.append("Open menu:")
                before = len(walker.lines)
                walker.walk(child)
                lines.extend(walker.lines[before:])
        before = len(walker.lines)
        walker.walk(window["element"])
        lines.append("Elements%s (numbers are for the app_ tools):" % (" matching " + quoted(query) if query else ""))
        lines.extend(walker.lines[before:])
        if query and before == len(walker.lines):
            lines.append("(nothing in this window matches)")
    focused = ax_get(application, "AXFocusedUIElement")
    if isinstance(focused, Element):
        number = view.find(focused)
        if number is None:
            values, _ = ax_many(focused, BASE)
            role = values.get("AXRole") or ""
            line = Walker(view, 1).entry(values, role, clean(values.get("AXTitle")) or clean(
                values.get("AXDescription")), "") or ROLE_NAMES.get(role, role[2:].lower() or "element")
            number = view.add(focused, line)
        lines.append("Keyboard focus: [%d] %s" % (number, short(view.notes[number], 160)))
    if walker.cut:
        lines.append("The listing stopped at %d elements%s. Use query to find something, or inside with a number to "
                     "look within one part." % (walker.listed, "" if walker.listed >= limit else " (time or size limit)"))
    content.append(text("\n".join(lines)))
    return content


# ----------------------------------------------------------- mouse and keys
BUTTONS = {"left": (1, 2, 6, 0), "right": (3, 4, 7, 1), "middle": (25, 26, 27, 2)}  # down, up, dragged, number
MOVED = 5
CMD, SHIFT, CTRL, ALT = 0x100000, 0x20000, 0x40000, 0x80000
MODIFIERS = {"ctrl": CTRL, "control": CTRL, "shift": SHIFT, "alt": ALT, "option": ALT, "meta": CMD, "cmd": CMD,
             "command": CMD, "win": CMD, "windows": CMD, "super": CMD, "mod": CMD}
KEYS = {
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
    "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
    "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 117, "insert": 114,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119,
    "pageup": 116, "pagedown": 121, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
    "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
}
SHIFTED = dict(zip('~!@#$%^&*()_+{}|:"<>?', "`1234567890-=[]\\;',./"))
CHUNK = 20  # UTF-16 units carried by one key event when typing


def deliver(event, pid=None):
    """Send an event to one app, or with no pid, to the whole system as if from the real devices."""
    if not event:
        raise Refused("the system did not accept the input")
    try:
        if pid is None:
            CGEventPost(0, event)
        else:
            CGEventPostToPid(pid, event)
    finally:
        CFRelease(event)


def mouse_event(kind, point, button=0, flags=0, press=None, window=None):
    event = CGEventCreateMouseEvent(None, kind, point, button)
    if event:
        CGEventSetFlags(event, flags)
        if press is not None:
            CGEventSetIntegerValueField(event, 1, press)  # which click of a double or triple click
        if window:
            CGEventSetIntegerValueField(event, 91, window)  # the window under the pointer
            CGEventSetIntegerValueField(event, 92, window)  # and the one to handle the event
    return event


def pointer_location():
    event = CGEventCreate(None)
    if not event:
        raise Refused("the pointer cannot be found right now")
    try:
        return CGEventGetLocation(event)
    finally:
        CFRelease(event)


def modifier_flags(names):
    if names is None:
        return 0
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
        raise Refused("modifiers is a list of modifier names, such as [\"shift\"]")
    flags = 0
    for name in names:
        if name.lower() not in MODIFIERS:
            raise Refused("unknown modifier %s; use ctrl, shift, alt, meta or mod" % name)
        flags |= MODIFIERS[name.lower()]
    return flags


def parse_keys(keys):
    """The modifier flags of a combination such as ctrl+shift+a, and its key code or else its one character."""
    if not isinstance(keys, str) or not keys:
        raise Refused("keys is a key, or modifiers and a key joined by +, such as mod+s")
    keys = keys.lower()
    if keys == "+" or keys.endswith("++"):
        names, last = ([n for n in keys[:-2].split("+") if n] if keys != "+" else []), "+"
    else:
        parts = keys.split("+")
        names, last = parts[:-1], parts[-1]
    flags = 0
    for name in names:
        if name not in MODIFIERS:
            raise Refused("unknown modifier %s; use ctrl, shift, alt, meta or mod" % name)
        flags |= MODIFIERS[name]
    if last in KEYS:
        return flags, KEYS[last], None
    if last in SHIFTED:
        return flags | SHIFT, KEYS[SHIFTED[last]], None
    if len(last) == 1 and ord(last) >= 0x20 and not names:
        return 0, None, last
    raise Refused("unknown key %s" % last)


def tap(code, flags, pid=None):
    for pressed in (True, False):
        event = CGEventCreateKeyboardEvent(None, code, pressed)
        if event:
            CGEventSetFlags(event, flags)
        deliver(event, pid)
        time.sleep(0.015)


def unicode_keys(words, pid=None):
    raw = words.encode("utf-16-le")
    units = [int.from_bytes(raw[i:i + 2], "little") for i in range(0, len(raw), 2)]
    start = 0
    while start < len(units):
        end = min(start + CHUNK, len(units))
        if end < len(units) and 0xD800 <= units[end - 1] <= 0xDBFF:
            end -= 1  # keep both halves of a character together
        check_stopped()
        chunk = (c.c_uint16 * (end - start))(*units[start:end])
        for pressed in (True, False):
            event = CGEventCreateKeyboardEvent(None, 0, pressed)
            if event:
                CGEventSetFlags(event, 0)
                CGEventKeyboardSetUnicodeString(event, end - start, chunk)
            deliver(event, pid)
        time.sleep(0.01)
        start = end


def type_keys(words, pid=None):
    run = []
    for character in words + "\0":
        if character in "\n\t\0":
            if run:
                unicode_keys("".join(run), pid)
                run = []
            if character == "\n":
                tap(KEYS["return"], 0, pid)
            elif character == "\t":
                tap(KEYS["tab"], 0, pid)
        elif ord(character) >= 0x20 and not 0x7F <= ord(character) < 0xA0:
            run.append(character)


def wait_front(pid, seconds):
    deadline = time.time() + seconds
    while True:
        if front_pid() == pid:
            return True
        if time.time() > deadline:
            return False
        time.sleep(0.05)


def bring_front(app, window=None):
    application = app_element(app["pid"])
    if app["hidden"]:
        ax_set(application, "AXHidden", False)
    ax_set(application, "AXFrontmost", True)
    if window is not None:
        perform(window, "AXRaise")
    if not wait_front(app["pid"], 1.5):
        command = ["/usr/bin/open", "-b", app["bundle_id"]] if app["bundle_id"] else (
            ["/usr/bin/open", "-a", app["path"]] if app["path"] else None)
        if command:
            subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        if not wait_front(app["pid"], 3):
            raise Refused("%s could not be brought to the front" % app["name"])
        if window is not None:
            perform(window, "AXRaise")
    time.sleep(0.1)


def covering(app, point):
    """The app whose window is on top at a point, when it is not this app."""
    process = _overlay["process"]
    for window in screen_windows():
        if window["alpha"] is not None and window["alpha"] <= 0 or not 0 <= window["layer"] < 1000:
            continue
        if process is not None and window["pid"] == process.pid:
            continue  # Claude's own cursor, which lets clicks through
        if window["owner"] in ("Dock", "程序坞") and any(
                abs(window["frame"][2] - d[2]) < 2 and abs(window["frame"][3] - d[3]) < 2 for d in displays()):
            continue  # the Dock's clear layer over the whole screen, which lets clicks through
        if inside(point, window["frame"]):
            return None if window["pid"] == app["pid"] else (window["owner"] or "another app")
    return None


def window_under(app, point, view=None):
    for window in screen_windows():
        if window["pid"] == app["pid"] and window["layer"] == 0 and inside(point, window["frame"]):
            return window["id"]
    return view.window.get("number") if view else None


def click_in_background(app, view, point, button, count, flags):
    down, up, _, number = BUTTONS[button]
    window = window_under(app, point, view)
    for press in range(1, count + 1):
        for kind in (down, up):
            deliver(mouse_event(kind, point, number, flags, press, window), app["pid"])
            time.sleep(0.03)


def click_with_pointer(point, button, count, flags):
    down, up, _, number = BUTTONS[button]
    back = pointer_location()
    try:
        deliver(mouse_event(MOVED, point, 0, flags))
        time.sleep(0.05)
        for press in range(1, count + 1):
            for kind in (down, up):
                deliver(mouse_event(kind, point, number, flags, press))
                time.sleep(0.02)
    finally:
        time.sleep(0.05)
        CGWarpMouseCursorPosition(back)
        CGAssociateMouseAndMouseCursorPosition(1)


def ax_set_elements(element, attribute, elements):
    items = (vp * len(elements))(*[e.ref for e in elements])
    array = CFArrayCreate(None, items, len(elements), ARRAY_CALLBACKS)
    if not array:
        return -25200
    try:
        return AXUIElementSetAttributeValue(element.ref, cfname(attribute), array)
    finally:
        CFRelease(array)


def select_item(element, add=False):
    """Select an item of a list, column browser, table or outline, through the item or its container; with add,
    keep what was selected already. True when done."""
    node = element
    for _ in range(4):
        if not add and settable(node, "AXSelected"):
            return ax_set(node, "AXSelected", True) == 0
        parent = ax_get(node, "AXParent")
        if not isinstance(parent, Element):
            return False
        for attribute in ("AXSelectedChildren", "AXSelectedRows"):
            if settable(parent, attribute):
                chosen = [node]
                if add:
                    held = ax_get(parent, attribute)
                    chosen = [e for e in (held if isinstance(held, list) else [])
                              if isinstance(e, Element) and not e.same(node)] + [node]
                return ax_set_elements(parent, attribute, chosen) == 0
        node = parent
    return False


def open_item(element):
    """Open an item the way a double click does: select it, then have it, or what holds it, open."""
    select_item(element)
    node = element
    for _ in range(3):
        offered = actions_of(node)
        for action in ("AXOpen", "AXConfirm", "AXPress"):
            if action in offered and perform(node, action) == 0:
                return True
        parent = ax_get(node, "AXParent")
        if not isinstance(parent, Element):
            break
        node = parent
    return False


def press(element, values, button, count=1, flags=0):
    """Do what a click on an element does, through the accessibility interface. What was done, or None."""
    role = values.get("AXRole") or ""
    actions = actions_of(element)
    if button == "right":
        if count == 1 and not flags and "AXShowMenu" in actions and perform(element, "AXShowMenu") == 0:
            return "Opened the menu of"
        return None
    if button != "left":
        return None
    if flags == CMD and count == 1:  # add to a selection, as in a list of files
        return "Added to the selection" if select_item(element, add=True) else None
    if flags:
        return None
    if count == 2:
        return "Opened" if open_item(element) else None
    if count != 1:
        return None
    if "AXPress" in actions and perform(element, "AXPress") == 0:
        return "Pressed"
    editable = role in TEXT_INPUTS and (settable(element, "AXValue") or settable(element, "AXSelectedText"))
    if editable and settable(element, "AXFocused") and ax_set(element, "AXFocused", True) == 0:
        return "Put the keyboard focus in"
    if select_item(element):
        return "Selected"
    for action, done in (("AXPick", "Picked"), ("AXConfirm", "Confirmed"), ("AXOpen", "Opened")):
        if action in actions and perform(element, action) == 0:
            return done
    if role in TEXT_INPUTS and settable(element, "AXFocused") and ax_set(element, "AXFocused", True) == 0:
        return "Put the keyboard focus in"
    return None


def pressable_at(app, point):
    """The element of this app at a point, or the nearest one around it that a click would work on."""
    out = vp()
    if AXUIElementCopyElementAtPosition(app_element(app["pid"]).ref, point.x, point.y, c.byref(out)) != 0 \
            or not out.value:
        return None
    node = Element(out.value, retain=False)
    if pid_of(node) != app["pid"]:
        return None  # another app's window is on top there
    for _ in range(5):
        role = ax_get(node, "AXRole") or ""
        if role in ("AXWindow", "AXSheet", "AXScrollArea", "AXWebArea", "AXSplitGroup"):
            return None
        if "AXPress" in actions_of(node) or role in TEXT_INPUTS or role == "AXRow":
            return node
        parent = ax_get(node, "AXParent")
        if not isinstance(parent, Element):
            return None
        node = parent
    return None


# ------------------------------------------------------------------ overlay
# A cursor of Claude's own and a banner show on screen where and what it is
# doing (overlay/ClaudeOverlay, built from overlay.swift). Esc pressed while the
# banner shows stops the work: for a while every tool but list_apps refuses.
OVERLAY = os.path.join(HERE, "overlay", "ClaudeOverlay")
PAUSE = 90.0  # seconds the tools stay stopped after Esc
_overlay = {"process": None, "failed": False, "stopped_at": 0.0}


def _listen(process):
    for line in process.stdout:
        if line.strip() == b"stop":
            _overlay["stopped_at"] = time.time()


def overlay_send(order):
    if _overlay["failed"] or not os.access(OVERLAY, os.X_OK):
        return False
    process = _overlay["process"]
    if process is None or process.poll() is not None:
        try:
            process = subprocess.Popen([OVERLAY], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL)
        except OSError:
            _overlay["failed"] = True
            return False
        _overlay["process"] = process
        threading.Thread(target=_listen, args=(process,), daemon=True).start()
    try:
        process.stdin.write((json.dumps(order, ensure_ascii=False) + "\n").encode("utf-8"))
        process.stdin.flush()
        return True
    except (OSError, ValueError):
        _overlay["process"] = None
        return False


def brief(note):
    """The name in an element's listing, for the banner."""
    found = re.search(r'"((?:[^"\\]|\\.)*)"', note or "")
    return "「%s」" % clean(found.group(1), 24) if found else ""


def center_of(values):
    frame = frame_of(values) if values else None
    return CGPoint(frame[0] + frame[2] / 2.0, frame[1] + frame[3] / 2.0) if frame and frame[2] > 0 and frame[3] > 0 \
        else None


def show(app, what, point=None, kind="look"):
    """Put the banner up, and move Claude's cursor to where it is about to act."""
    order = {"op": "act", "app": app["name"] if isinstance(app, dict) else app, "what": what, "kind": kind}
    if point is not None:
        order["x"], order["y"] = point.x, point.y
        if isinstance(app, dict):  # the cursor shows only on the window acted in
            order["window"] = window_under(app, point, VIEWS.get(app["pid"])) or 0
    if overlay_send(order) and point is not None and kind != "look":
        time.sleep(0.3)  # let the cursor arrive before the action


def shutdown():
    """End the on-screen sign's program, as when this module is loaded again."""
    process = _overlay["process"]
    if process is not None:
        try:
            process.stdin.close()
        except (OSError, ValueError):
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
        _overlay["process"] = None


def check_stopped():
    if time.time() - _overlay["stopped_at"] < PAUSE:
        raise Refused("The user pressed Esc to stop you working in apps. Stop now and ask the user how to go on; do "
                      "not try again on your own.")


def settle():
    time.sleep(SETTLE)


def tool_app_click(arguments):
    need_access()
    app = find_app(arguments.get("app"))
    button = arguments.get("button") or "left"
    if button not in BUTTONS:
        raise Refused("button is left, right or middle")
    count = arguments.get("count") or 1
    if count not in (1, 2, 3) or isinstance(count, bool):
        raise Refused("count is 1, 2 or 3")
    flags = modifier_flags(arguments.get("modifiers"))
    foreground = arguments.get("foreground") is True
    if button != "left" or flags:
        need_full(app, "a right, middle or modifier click")
    guard(app)
    view = need_view(app)
    number = arguments.get("element")
    if number is not None:
        element = element_at(view, number)
        values = fresh(element, number)
        target = "[%d] %s" % (number, short(view.notes[number]))
        show(app, ("右键点击 " if button == "right" else "点击 ") + brief(view.notes[number]), center_of(values), "click")
        if not foreground and (not flags or flags == CMD):
            done = press(element, values, button, count, flags)
            if done:
                settle()
                return "%s %s in %s, in the background." % (done, target, app["name"])
        frame = frame_of(values)
        if not frame or frame[2] <= 0 or frame[3] <= 0:
            raise Refused("element %d has no place on screen to click; app_action lists what it offers" % number)
        point = CGPoint(frame[0] + frame[2] / 2.0, frame[1] + frame[3] / 2.0)
    else:
        if arguments.get("x") is None or arguments.get("y") is None:
            raise Refused("give element, or x and y in pixels of the latest app_state picture")
        point = picture_point(view, arguments)
        target = "(%g, %g)" % (float(arguments["x"]), float(arguments["y"]))
        show(app, "点击", point, "click")
        if not foreground and (not flags or flags == CMD) and button == "left":
            hit = pressable_at(app, point)
            if hit is not None:
                values, _ = ax_many(hit, BASE)
                done = press(hit, values, "left", count, flags)
                if done:
                    settle()
                    name = Walker(view, 1).entry(values, values.get("AXRole") or "", clean(values.get(
                        "AXTitle")) or clean(values.get("AXDescription")) or clean(values.get("AXValue")), "")
                    return "%s %s at %s in %s, in the background." % (done, name or "the element", target, app["name"])
    if foreground:
        bring_front(app, view.window["element"])
        cover = covering(app, point)
        if cover:
            raise Refused("a window of %s is on top at that spot, so nothing was clicked" % cover)
        click_with_pointer(point, button, count, flags)
        settle()
        return "Clicked %s in %s with the pointer, which then went back to where it was." % (target, app["name"])
    click_in_background(app, view, point, button, count, flags)
    settle()
    return ("Sent a %s click at %s to %s alone, without moving the pointer. Some apps ignore clicks while in the "
            "background: check with app_state, and if nothing changed, click again with foreground true."
            % (button if count == 1 else "%s %s-fold" % (button, count), target, app["name"]))


# -------------------------------------------------------------------- text
def text_argument(arguments, key, empty=False):
    words = arguments.get(key)
    if not isinstance(words, str) or (not words and not empty) or len(words) > MAX_TEXT:
        raise Refused("%s must be %d to %d characters" % (key, 0 if empty else 1, MAX_TEXT))
    if "\0" in words:
        raise Refused("%s cannot hold a NUL character" % key)
    return words.replace("\r\n", "\n").replace("\r", "\n")


def insert_text(element, words):
    """Type through the accessibility interface: how many characters went in and whether return was pressed, or None."""
    values, _ = ax_many(element, ["AXRole", "AXValue", "AXFocused", "AXSelectedText"])
    role = values.get("AXRole") or ""
    if not settable(element, "AXSelectedText"):
        return None
    submit = False
    if role in ONE_LINE:
        if words.endswith("\n"):
            words, submit = words[:-1], True
        if "\n" in words:
            raise Refused("a one-line field takes no line breaks; type each line by itself, or press return with app_key")
    if values.get("AXFocused") is not True and settable(element, "AXFocused"):
        ax_set(element, "AXFocused", True)
    if words:
        before = values.get("AXValue")
        if ax_set(element, "AXSelectedText", words) != 0:
            return None
        after = ax_get(element, "AXValue")
        if isinstance(before, str) and isinstance(after, str) and before == after and values.get(
                "AXSelectedText") != words:
            return None  # the app took no notice
    if submit:
        if not ("AXConfirm" in actions_of(element) and perform(element, "AXConfirm") == 0):
            tap(KEYS["return"], 0, pid_of(element))
    return len(words), submit


def tool_app_type(arguments):
    need_access()
    app = find_app(arguments.get("app"))
    need_full(app, "typing")
    guard(app)
    words = text_argument(arguments, "text")
    foreground = arguments.get("foreground") is True
    application = app_element(app["pid"])
    number = arguments.get("element")
    view = VIEWS.get(app["pid"])
    if number is not None:
        view = need_view(app)
        element = element_at(view, number)
        fresh(element, number)
        target = "[%d] %s" % (number, short(view.notes[number]))
    else:
        element = focused_field(app)
        target = "the keyboard focus"
    show(app, "输入文字", center_of(ax_many(element, ["AXPosition", "AXSize"])[0]) if element is not None else None,
         "type")
    if foreground:
        bring_front(app, view.window["element"] if view else None)
        if element is not None and settable(element, "AXFocused"):
            ax_set(element, "AXFocused", True)
        if front_pid() != app["pid"]:
            raise Refused("%s is not in front, so nothing was typed" % app["name"])
        type_keys(words)
        settle()
        return "Typed %d characters into %s of %s with the keyboard." % (len(words), target, app["name"])
    if element is not None:
        done = insert_text(element, words)
        if done:
            settle()
            return "Typed %d characters into %s of %s%s, in the background." % (
                done[0], target, app["name"], " and pressed return" if done[1] else "")
    type_keys(words, app["pid"])
    settle()
    return ("Sent %d characters to %s alone as key presses, in the background. An input method that is on may catch "
            "them, and some apps ignore keys while in the background: check with app_state, and if nothing arrived, "
            "use foreground true." % (len(words), app["name"]))


def set_range(element, start, length):
    span = CFRange(start, length)
    ref = AXValueCreate(4, c.byref(span))
    if not ref:
        return -25200
    try:
        return AXUIElementSetAttributeValue(element.ref, cfname("AXSelectedTextRange"), ref)
    finally:
        CFRelease(ref)


def focused_field(app):
    """The element with the app's keyboard focus. A minimized or hidden window reports none, so then the text field
    the latest app_state found focused stands in."""
    focused = ax_get(app_element(app["pid"]), "AXFocusedUIElement")
    if isinstance(focused, Element):
        return focused
    view = VIEWS.get(app["pid"])
    fields, areas = [], []
    for element in (view.elements[1:] if view else []):
        values, _ = ax_many(element, ["AXRole", "AXFocused"])
        if values.get("AXRole") in TEXT_INPUTS:
            if values.get("AXFocused") is True:
                return element
            fields.append(element)
            if values.get("AXRole") == "AXTextArea":
                areas.append(element)
    if len(areas) == 1:
        return areas[0]  # a document window: its one text area is where typing goes
    return fields[0] if len(fields) == 1 else None


def edit_key(app, flags, code):
    """Carry out a text-editing key in the focused field through the accessibility interface, which works while the
    app is in the background, where key presses often do not. What was done, or None when it cannot be done so."""
    focused = focused_field(app)
    if focused is None:
        return None
    values, _ = ax_many(focused, ["AXRole", "AXValue", "AXSelectedTextRange"])
    role = values.get("AXRole") or ""
    if code == KEYS["escape"] and not flags:
        return "cancelled" if "AXCancel" in actions_of(focused) and perform(focused, "AXCancel") == 0 else None
    held, span = values.get("AXValue"), values.get("AXSelectedTextRange")
    if role not in TEXT_INPUTS or not isinstance(held, str) or not isinstance(span, dict):
        return None
    units = held.encode("utf-16-le")
    total, start, length = len(units) // 2, span["location"], span["length"]
    unit = lambda at: int.from_bytes(units[at * 2:at * 2 + 2], "little") if 0 <= at < total else 0
    back = lambda at: 2 if at >= 2 and 0xDC00 <= unit(at - 1) <= 0xDFFF else 1  # the character before at
    ahead = lambda at: 2 if 0xD800 <= unit(at) <= 0xDBFF else 1
    remove = lambda a, n: set_range(focused, a, n) == 0 and ax_set(focused, "AXSelectedText", "") == 0
    one_line = role in ONE_LINE
    if code == KEYS["backspace"] and not flags:
        if length:
            return "deleted the selection" if remove(start, length) else None
        return ("deleted a character" if remove(start - back(start), back(start)) else None) if start else "nothing to delete"
    if code == KEYS["delete"] and not flags:
        if length:
            return "deleted the selection" if remove(start, length) else None
        return ("deleted a character" if remove(start, ahead(start)) else None) if start < total else "nothing to delete"
    moves = {(KEYS["left"], 0): lambda: start if length else max(0, start - back(start)),
             (KEYS["right"], 0): lambda: start + length if length else min(total, start + ahead(start)),
             (KEYS["up"], CMD): lambda: 0, (KEYS["down"], CMD): lambda: total}
    if (code, flags) in moves:
        return "moved the text cursor" if set_range(focused, moves[(code, flags)](), 0) == 0 else None
    if code == KEYS["a"] and flags == CMD:
        return "selected all the text" if set_range(focused, 0, total) == 0 else None
    if code == KEYS["return"] and not flags:
        if one_line:
            return "pressed return" if "AXConfirm" in actions_of(focused) and perform(focused, "AXConfirm") == 0 else None
        return "started a new line" if ax_set(focused, "AXSelectedText", "\n") == 0 else None
    if code == KEYS["tab"] and not flags and not one_line:
        return "typed a tab" if ax_set(focused, "AXSelectedText", "\t") == 0 else None
    return None


def short(note, most=90):
    return note if len(note) <= most else note[:most - 1] + "…"


def tool_app_key(arguments):
    need_access()
    app = find_app(arguments.get("app"))
    need_full(app, "pressing keys")
    guard(app)
    flags, code, character = parse_keys(arguments.get("keys"))
    count = whole(arguments, "count", 1, 1, 20)
    show(app, "按键 " + arguments["keys"])
    foreground = arguments.get("foreground") is True
    pid = app["pid"]
    if not foreground and code is not None:
        done = edit_key(app, flags, code)
        if done:
            for _ in range(count - 1):
                done = edit_key(app, flags, code) or done
            settle()
            return "Pressed %s%s in %s through the accessibility interface (%s), in the background." % (
                arguments["keys"], " %d times" % count if count > 1 else "", app["name"], done)
    if foreground:
        view = VIEWS.get(app["pid"])
        bring_front(app, view.window["element"] if view else None)
        if front_pid() != app["pid"]:
            raise Refused("%s is not in front, so no key was pressed" % app["name"])
        pid = None
    for _ in range(count):
        if code is not None:
            tap(code, flags, pid)
        else:
            unicode_keys(character, pid)
        time.sleep(0.03)
    settle()
    if foreground:
        return "Pressed %s%s in %s, in front." % (arguments["keys"], " %d times" % count if count > 1 else "",
                                                 app["name"])
    return ("Pressed %s%s in %s alone, in the background. Some apps ignore keys while in the background: check with "
            "app_state; app_menu or foreground true are the ways round that." % (
                arguments["keys"], " %d times" % count if count > 1 else "", app["name"]))


def tool_app_set_value(arguments):
    need_access()
    app = find_app(arguments.get("app"))
    need_full(app, "setting values")
    guard(app)
    attributes = {"value": "AXValue", "selected": "AXSelected", "focused": "AXFocused", "expanded": "AXExpanded",
                  "minimized": "AXMinimized"}
    attribute = arguments.get("attribute") or "value"
    if attribute not in attributes:
        raise Refused("attribute is one of value, selected, focused, expanded or minimized")
    view = need_view(app)
    number = arguments.get("element")
    element = element_at(view, number)
    values = fresh(element, number)
    show(app, "设置 " + brief(view.notes[number]), center_of(values), "type")
    value = arguments.get("value")
    if attribute != "value":
        if not isinstance(value, bool):
            raise Refused("%s takes true or false" % attribute)
    else:
        current = values.get("AXValue")
        if isinstance(value, str):
            if len(value) > MAX_TEXT:
                raise Refused("a value is at most %d characters" % MAX_TEXT)
            if isinstance(current, (int, float)) and not isinstance(current, bool):
                try:
                    value = float(value) if isinstance(current, float) else int(value)
                except ValueError:
                    raise Refused("element %d holds a number; give a number" % number)
        elif isinstance(value, bool) and isinstance(current, int) and not isinstance(current, bool):
            value = int(value)
        elif not isinstance(value, (int, float)):
            raise Refused("value is text, a number, or true or false")
    name = attributes[attribute]
    if not settable(element, name):
        hint = "; app_type types into it instead" if attribute == "value" and values.get("AXRole") in TEXT_INPUTS else ""
        raise Refused("the app does not let %s of element %d be set%s" % (attribute, number, hint))
    error = ax_set(element, name, value)
    if error != 0:
        raise Refused("the app did not take that %s: %s" % (attribute, ax_error(error)))
    settle()
    after = ax_get(element, name)
    shown = quoted(value) if isinstance(value, str) else json.dumps(value)
    note = "" if after == value or after is None else "; it now reads %s" % (
        quoted(excerpt(after, 200)) if isinstance(after, str) else json.dumps(after))
    return "Set %s of [%d] %s to %s%s, in the background." % (attribute, number, short(view.notes[number]),
                                                              excerpt(shown, 200), note)


def tool_app_select_text(arguments):
    need_access()
    app = find_app(arguments.get("app"))
    need_full(app, "selecting text")
    guard(app)
    view = need_view(app)
    number = arguments.get("element")
    element = element_at(view, number)
    show(app, "选择文字", center_of(fresh(element, number)), "type")
    wanted = arguments.get("text")
    if not isinstance(wanted, str):
        raise Refused("text is the text to select, written as it is in the element")
    where = arguments.get("where") or "select"
    if where not in ("select", "before", "after"):
        raise Refused("where is select, before or after")
    occurrence = whole(arguments, "occurrence", 1, 1, 100000)
    held = ax_get(element, "AXValue")
    if not isinstance(held, str):
        raise Refused("element %d holds no text to select in" % number)
    if wanted:
        at, start = -1, 0
        for _ in range(occurrence):
            at = held.find(wanted, start)
            if at < 0:
                raise Refused("%s is not in element %d%s; it holds %s" % (
                    quoted(wanted), number, " that many times" if occurrence > 1 else "", quoted(excerpt(held, 300))))
            start = at + 1
    else:
        at = len(held) if where == "after" else 0
    units = lambda part: len(part.encode("utf-16-le")) // 2
    begin, length = units(held[:at]), units(wanted)
    if where == "before" or not wanted:
        length = 0
    elif where == "after":
        begin, length = begin + length, 0
    if not settable(element, "AXSelectedTextRange"):
        raise Refused("the app does not let the selection of element %d be set" % number)
    if ax_get(element, "AXFocused") is not True and settable(element, "AXFocused"):
        ax_set(element, "AXFocused", True)
    span = CFRange(begin, length)
    ref = AXValueCreate(4, c.byref(span))
    if not ref:
        raise Refused("the selection could not be made")
    try:
        error = AXUIElementSetAttributeValue(element.ref, cfname("AXSelectedTextRange"), ref)
    finally:
        CFRelease(ref)
    if error != 0:
        raise Refused("the app did not take the selection: %s" % ax_error(error))
    if length:
        return "Selected %s in [%d], in the background; app_type now replaces it." % (quoted(wanted), number)
    return "Put the text cursor %s in [%d], in the background; app_type now inserts there." % (
        ("before " + quoted(wanted) if where == "before" else "after " + quoted(wanted)) if wanted else (
            "at the end" if where == "after" else "at the start"), number)


# ------------------------------------------------------------------ scroll
def scroll_area_around(element):
    node = element
    for _ in range(25):
        if ax_get(node, "AXRole") == "AXScrollArea":
            return node
        parent = ax_get(node, "AXParent")
        if not isinstance(parent, Element):
            break
        node = parent
    return largest_scroll_area(element)


def largest_scroll_area(top):
    best, best_size, queue, seen = None, 0, [top], 0
    while queue and seen < 800:
        node = queue.pop(0)
        seen += 1
        values, _ = ax_many(node, ["AXRole", "AXPosition", "AXSize"])
        role = values.get("AXRole") or ""
        frame = frame_of(values)
        if role == "AXScrollArea" and frame and frame[2] * frame[3] > best_size:
            best, best_size = node, frame[2] * frame[3]
        if role not in LEAVES and role != "AXScrollArea":
            queue.extend(ax_slice(node, "AXChildren", 100) or [])
        elif role == "AXScrollArea" and best is not node:
            queue.extend(ax_slice(node, "AXChildren", 100) or [])
    return best


def tool_app_scroll(arguments):
    need_access()
    app = find_app(arguments.get("app"))
    guard(app)
    direction = arguments.get("direction") or "down"
    if direction not in ("down", "up", "right", "left"):
        raise Refused("direction is down, up, right or left")
    pages = arguments.get("pages", 1)
    if not isinstance(pages, (int, float)) or isinstance(pages, bool) or not 0.1 <= pages <= 20:
        raise Refused("pages is a number from 0.1 to 20")
    foreground = arguments.get("foreground") is True
    view = need_view(app)
    number = arguments.get("element")
    if number is not None:
        element = element_at(view, number)
        fresh(element, number)
        area = scroll_area_around(element)
    else:
        area = largest_scroll_area(view.window["element"])
    if area is None:
        raise Refused("there is no scroll area there; give an element inside the part to scroll")
    vertical = direction in ("down", "up")
    sign = 1 if direction in ("down", "right") else -1
    values, _ = ax_many(area, ["AXPosition", "AXSize", "AXVerticalScrollBar", "AXHorizontalScrollBar", "AXContents"])
    frame = frame_of(values)
    if not frame or frame[2] <= 0 or frame[3] <= 0:
        raise Refused("that scroll area has no place on screen")
    shown = frame[3] if vertical else frame[2]
    show(app, "滚动", CGPoint(frame[0] + frame[2] / 2.0, frame[1] + frame[3] / 2.0), "scroll")
    if not foreground:
        bar = values.get("AXVerticalScrollBar" if vertical else "AXHorizontalScrollBar")
        contents = values.get("AXContents")
        full = None
        if isinstance(contents, list):
            for item in contents:
                if isinstance(item, Element):
                    size = ax_get(item, "AXSize")
                    if isinstance(size, tuple):
                        full = max(full or 0, size[1] if vertical else size[0])
        if isinstance(bar, Element) and full and settable(bar, "AXValue"):
            now = ax_get(bar, "AXValue")
            if isinstance(now, (int, float)) and not isinstance(now, bool):
                if full <= shown + 1:
                    return "Nothing to scroll there: all of it already shows."
                goal = min(1.0, max(0.0, now + sign * pages * shown * 0.9 / (full - shown)))
                if abs(goal - now) < 1e-6:
                    return "Already at the %s, so nothing scrolled." % {
                        "down": "bottom", "up": "top", "right": "right end", "left": "left end"}[direction]
                if ax_set(bar, "AXValue", float(goal)) == 0:
                    after = ax_get(bar, "AXValue")
                    if not isinstance(after, (int, float)) or abs(after - now) > 1e-6:
                        settle()
                        return "Scrolled %s by %g screenful%s in %s, in the background." % (
                            direction, pages, "" if pages == 1 else "s", app["name"])
    point = CGPoint(frame[0] + frame[2] / 2.0, frame[1] + frame[3] / 2.0)
    amount = int(round(pages * shown * 0.9))
    steps = max(1, min(40, amount // 120 + 1))
    if foreground:
        bring_front(app, view.window["element"])
        cover = covering(app, point)
        if cover:
            raise Refused("a window of %s is on top of that area, so nothing scrolled" % cover)
        back = pointer_location()
        try:
            deliver(mouse_event(MOVED, point))
            time.sleep(0.05)
            for _ in range(steps):
                each = -sign * (amount // steps)
                deliver(CGEventCreateScrollWheelEvent2(None, 0, 2, each if vertical else 0, 0 if vertical else each, 0))
                time.sleep(0.01)
        finally:
            time.sleep(0.05)
            CGWarpMouseCursorPosition(back)
            CGAssociateMouseAndMouseCursorPosition(1)
        settle()
        return "Scrolled %s in %s with the wheel, with the app in front; the pointer went back." % (direction,
                                                                                                    app["name"])
    window = window_under(app, point, view)
    for _ in range(steps):
        each = -sign * (amount // steps)
        event = CGEventCreateScrollWheelEvent2(None, 0, 2, each if vertical else 0, 0 if vertical else each, 0)
        if event:
            CGEventSetLocation(event, point)
            if window:
                CGEventSetIntegerValueField(event, 91, window)
                CGEventSetIntegerValueField(event, 92, window)
        deliver(event, app["pid"])
        time.sleep(0.01)
    settle()
    return ("Sent wheel scrolling %s to %s alone, in the background. Some apps ignore it there: check with app_state, "
            "and if nothing moved, scroll with foreground true." % (direction, app["name"]))


# -------------------------------------------------------------------- menus
MENU_ATTRIBUTES = ["AXRole", "AXTitle", "AXEnabled", "AXMenuItemCmdChar", "AXMenuItemCmdModifiers",
                   "AXMenuItemMarkChar"]


def shortcut_of(values):
    key = values.get("AXMenuItemCmdChar")
    if not isinstance(key, str) or not key.strip():
        return ""
    modifiers = values.get("AXMenuItemCmdModifiers") or 0
    names = [name for bit, name in ((4, "ctrl"), (2, "alt"), (1, "shift")) if modifiers & bit]
    if not modifiers & 8:
        names.append("cmd")
    return "+".join(names + [key.lower()])


def menu_items(node):
    """The items one level below a menu bar, a menu title, a menu or a menu item; None below an item with no menu."""
    if ax_get(node, "AXRole") in ("AXMenuBarItem", "AXMenuItem"):
        menus = [child for child in ax_slice(node, "AXChildren", 5) or [] if ax_get(child, "AXRole") == "AXMenu"]
        if not menus:
            return None
        node = menus[0]
    items = []
    for child in ax_slice(node, "AXChildren", 400) or []:
        values, _ = ax_many(child, MENU_ATTRIBUTES)
        title = clean(values.get("AXTitle"), 120)
        if not title:
            continue  # a separator
        items.append({"element": child, "title": title, "enabled": values.get("AXEnabled") is not False,
                      "shortcut": shortcut_of(values), "mark": bool(clean(values.get("AXMenuItemMarkChar"))),
                      "submenu": values.get("AXRole") == "AXMenuBarItem" or ax_count(child, "AXChildren") > 0})
    return items


def menu_name(title):
    return " ".join(title.strip().rstrip("….").split()).lower()


def choose_item(items, wanted, place):
    goal = menu_name(wanted)
    for test in (lambda t: t == goal, lambda t: t.startswith(goal), lambda t: goal in t):
        found = [item for item in items if test(menu_name(item["title"]))]
        if len(found) == 1:
            return found[0]
        if found:
            raise Refused("%s matches several items in %s: %s" % (
                quoted(wanted), place, ", ".join(quoted(item["title"]) for item in found)))
    raise Refused("%s has no item %s. Its items: %s" % (
        place, quoted(wanted), ", ".join(quoted(item["title"]) for item in items) or "none"))


def tool_app_menu(arguments):
    need_access()
    app = find_app(arguments.get("app"))
    path = arguments.get("path") or []
    if isinstance(path, str):
        path = [part for part in re.split(r"\s*>\s*", path) if part.strip()]
    if not isinstance(path, list) or len(path) > 8 or not all(isinstance(p, str) and p.strip() for p in path):
        raise Refused("path is a list of menu titles, such as [\"File\", \"New\"]")
    bar = ax_get(app_element(app["pid"]), "AXMenuBar")
    if not isinstance(bar, Element):
        raise Refused("%s shows no menu bar" % app["name"])
    node, trail, last = bar, [], None
    for step in path:
        items = menu_items(node)
        if items is None:
            raise Refused("%s has no menu below it" % " > ".join(trail))
        last = choose_item(items, step, " > ".join(trail) or "the menu bar of %s" % app["name"])
        trail.append(last["title"])
        node = last["element"]
    if last is not None and not last["submenu"]:
        need_full(app, "choosing menu items")
        guard(app)
        if not last["enabled"]:
            raise Refused("%s is turned off right now (shown greyed out); the app may need something selected first"
                          % " > ".join(trail))
        show(app, "菜单 " + " > ".join(trail))
        error = perform(node, "AXPress")
        if error != 0:
            raise Refused("%s did not take %s: %s" % (app["name"], " > ".join(trail), ax_error(error)))
        settle()
        return "Chose %s in %s, in the background." % (" > ".join(trail), app["name"])
    items = menu_items(node) or []
    lines = ["%s:" % (" > ".join(trail) + " in " + app["name"] if trail else "Menus of " + app["name"])]
    for item in items:
        lines.append("- %s%s%s%s%s" % (item["title"], " ▸" if item["submenu"] and trail else "",
                                       " (%s)" % item["shortcut"] if item["shortcut"] else "",
                                       " ✓" if item["mark"] else "", " (off)" if not item["enabled"] else ""))
    return "\n".join(lines)


def tool_app_action(arguments):
    need_access()
    app = find_app(arguments.get("app"))
    guard(app)
    view = need_view(app)
    number = arguments.get("element")
    element = element_at(view, number)
    values = fresh(element, number)
    offered = actions_of(element)
    wanted = arguments.get("action")
    if not wanted:
        if not offered:
            return "[%d] %s offers no actions." % (number, short(view.notes[number]))
        return "[%d] %s offers:\n%s" % (number, view.notes[number], "\n".join(
            "- %s%s" % (name, ": " + action_description(element, name) if action_description(element, name) else "")
            for name in offered))
    if not isinstance(wanted, str):
        raise Refused("action is one of the names app_action lists without it")
    low = wanted.strip().lower()
    chosen = None
    for name in offered:
        plain = name.lower()
        custom = re.match(r"name:(.*?)\n", name + "\n", re.I | re.S)
        if plain == low or plain == "ax" + low or (custom and custom.group(1).strip().lower() == low):
            chosen = name
            break
    if chosen is None:
        raise Refused("[%d] does not offer %s; it offers %s" % (number, quoted(wanted), ", ".join(offered) or "nothing"))
    if chosen not in ("AXPress", "AXRaise", "AXScrollToVisible"):
        need_full(app, "the action %s" % chosen)
    show(app, "%s %s" % (chosen, brief(view.notes[number])), center_of(values), "click")
    error = perform(element, chosen)
    if error != 0:
        raise Refused("%s did not do %s: %s" % (app["name"], chosen, ax_error(error)))
    settle()
    return "Did %s on [%d] %s, in the background." % (chosen, number, short(view.notes[number]))


# ------------------------------------------------------- apps and clipboard
def windows_by_app():
    counts = {}
    for window in screen_windows():
        if window["layer"] == 0 and window["frame"][2] > 1 and window["frame"][3] > 1:
            counts[window["pid"]] = counts.get(window["pid"], 0) + 1
    return counts


def tool_list_apps(arguments):
    query = arguments.get("query")
    query = query.strip().lower() if isinstance(query, str) else ""
    every = arguments.get("all") is True
    counts, rules, listed = windows_by_app(), policy(), []
    for app in sorted(running_apps(), key=lambda a: (not a["frontmost"], a["policy"], a["name"].lower())):
        if not every and app["policy"] != 0:
            continue
        if query and query not in app["name"].lower() and query not in app["bundle_id"].lower() \
                and query not in app["file"].lower():
            continue
        access = access_of(app, rules)
        listed.append({"name": app["name"], "bundle_id": app["bundle_id"], "pid": app["pid"],
                       "windows": counts.get(app["pid"], 0), "frontmost": app["frontmost"], "hidden": app["hidden"],
                       "access": "blocked" if access == "protected" else access})
    return json.dumps({"apps": listed}, ensure_ascii=False)


BUNDLE_ID = re.compile(r"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$")


def tool_open_app(arguments):
    wanted = arguments.get("app")
    if not isinstance(wanted, str) or not wanted.strip() or len(wanted) > 200:
        raise Refused("app is an app's name, such as Notes, or its bundle identifier")
    wanted = wanted.strip()
    if any(mark in wanted for mark in "/\\\"*") or any(ord(ch) < 0x20 for ch in wanted):
        raise Refused("app is an app's name or bundle identifier, not a path")
    foreground = arguments.get("foreground") is True
    app = lookup_app(wanted)
    if app is not None:
        admit(app)
        if foreground:
            bring_front(app)
            return "%s was running and is now in front." % app["name"]
        return "%s is already running%s." % (app["name"], ", hidden; open_app with foreground true shows it"
                                             if app["hidden"] else "")
    flags = [] if foreground else ["-g"]
    path = None
    if BUNDLE_ID.match(wanted):
        run = subprocess.run(["/usr/bin/open"] + flags + ["-b", wanted], capture_output=True, timeout=30)
    else:
        run = subprocess.run(["/usr/bin/open"] + flags + ["-a", wanted], capture_output=True, timeout=30)
        if run.returncode != 0:  # perhaps a name in the system's language, which Spotlight knows
            found = subprocess.run(["/usr/bin/mdfind", 'kMDItemContentType == "com.apple.application-bundle" && '
                                    'kMDItemDisplayName == "%s"c' % wanted], capture_output=True, timeout=20)
            paths = [line for line in found.stdout.decode("utf-8", "replace").splitlines() if line.endswith(".app")]
            if paths:
                path = sorted(paths, key=len)[0]
                run = subprocess.run(["/usr/bin/open"] + flags + ["-a", path], capture_output=True, timeout=30)
    if run.returncode != 0:
        raise Refused("no app %s could be opened: %s" % (quoted(wanted), clean(run.stderr.decode(
            "utf-8", "replace"), 200) or "the system did not say why"))
    deadline = time.time() + 15
    while True:
        apps = running_apps()
        app = next((a for a in apps if path and a["path"] == path), None) or lookup_app(wanted, apps)
        if app is not None or time.time() > deadline:
            break
        time.sleep(0.25)
    if app is None:
        return "Asked the system to open %s; it is not running yet." % wanted
    app = admit(app)
    deadline = time.time() + 5
    while time.time() < deadline and not windows_by_app().get(app["pid"]):
        time.sleep(0.25)
    show(app, "已打开")
    return "Opened %s (%s, pid %d)%s." % (app["name"], app["bundle_id"], app["pid"],
                                          " in front" if foreground else " in the background")


CLIPBOARD_ENV = dict(os.environ, LANG="en_US.UTF-8", LC_ALL="en_US.UTF-8")


def tool_read_clipboard(_):
    run = subprocess.run(["/usr/bin/pbpaste"], capture_output=True, timeout=10, env=CLIPBOARD_ENV)
    held = run.stdout.decode("utf-8", "replace")
    if not held:
        return "The clipboard holds no text."
    return held if len(held) <= 20000 else held[:20000] + "\n… (%d more characters)" % (len(held) - 20000)


def tool_write_clipboard(arguments):
    words = text_argument(arguments, "text", empty=True)
    subprocess.run(["/usr/bin/pbcopy"], input=words.encode("utf-8"), check=True, timeout=10, env=CLIPBOARD_ENV)
    return "Put %d characters on the clipboard." % len(words)


def whole(arguments, key, default, least, most):
    value = arguments.get(key)
    if value is None:
        return default
    if not isinstance(value, int) or isinstance(value, bool) or not least <= value <= most:
        raise Refused("%s is a whole number from %d to %d" % (key, least, most))
    return value


def tool_app_batch(arguments):
    steps = arguments.get("steps")
    if not isinstance(steps, list) or not 1 <= len(steps) <= 20:
        raise Refused("steps is a list of 1 to 20 steps")
    report, picture = [], None
    for number, step in enumerate(steps, 1):
        try:
            check_stopped()
        except Refused as refusal:
            report.append("%d. %s Stopped here." % (number, refusal))
            return {"content": ([picture] if picture else []) + [text("\n".join(report))], "isError": True}
        if not isinstance(step, dict) or not isinstance(step.get("tool"), str):
            raise Refused("step %d needs a tool name" % number)
        name, given = step["tool"], step.get("arguments") or {}
        if not isinstance(given, dict):
            raise Refused("the arguments of step %d are an object" % number)
        if name == "wait":
            seconds = given.get("seconds", 1)
            if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or not 0 <= seconds <= 10:
                raise Refused("wait takes seconds from 0 to 10")
            time.sleep(seconds)
            report.append("%d. waited %g seconds" % (number, seconds))
            continue
        if name not in HANDLERS or name == "app_batch":
            report.append("%d. %s cannot run in a batch. Stopped here." % (number, name))
            return {"content": ([picture] if picture else []) + [text("\n".join(report))], "isError": True}
        try:
            result = HANDLERS[name](given)
        except Refused as refusal:
            report.append("%d. %s failed: %s Stopped here." % (number, name, refusal))
            return {"content": ([picture] if picture else []) + [text("\n".join(report))], "isError": True}
        parts = result if isinstance(result, list) else [text(result)]
        for part in parts:
            if part.get("type") == "image":
                picture = part
        report.append("%d. %s: %s" % (number, name, "\n".join(p["text"] for p in parts if p.get("type") == "text")))
    return ([picture] if picture else []) + [text("\n\n".join(report))]


HANDLERS = {"list_apps": tool_list_apps, "open_app": tool_open_app, "app_state": tool_app_state,
            "app_click": tool_app_click, "app_type": tool_app_type, "app_key": tool_app_key,
            "app_scroll": tool_app_scroll, "app_menu": tool_app_menu, "app_set_value": tool_app_set_value,
            "app_select_text": tool_app_select_text, "app_action": tool_app_action,
            "read_clipboard": tool_read_clipboard, "write_clipboard": tool_write_clipboard,
            "app_batch": tool_app_batch}


def call(name, arguments):
    """The result of one tool call, as MCP has it."""
    function = HANDLERS.get(name)
    if function is None:
        return {"content": [text("there is no tool %s" % name)], "isError": True}
    pool = objc_autoreleasePoolPush()
    try:
        if name != "list_apps":
            check_stopped()
        result = function(arguments if isinstance(arguments, dict) else {})
        if isinstance(result, dict):
            return result
        return {"content": result if isinstance(result, list) else [text(result)]}
    except Refused as refusal:
        return {"content": [text(str(refusal))], "isError": True}
    except subprocess.TimeoutExpired:
        return {"content": [text("a system program took too long and was stopped")], "isError": True}
    except Exception as failure:  # keep serving; say what broke
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {"content": [text("failed: %s: %s" % (type(failure).__name__, failure))], "isError": True}
    finally:
        objc_autoreleasePoolPop(pool)
