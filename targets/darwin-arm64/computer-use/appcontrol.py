# The Computer Use tools on macOS. They read an app's windows through the
# accessibility interface and act on them, mostly in the background, so the
# user keeps the pointer and the keyboard. server.py hands each call to call().
#
# Only Python's standard library and the system's own frameworks are used.
import base64
import ctypes as c
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import unquote, urlparse

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
CFHash = _fn(_CF, "CFHash", c.c_ulong, vp)
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
CFURLCopyAbsoluteURL = _fn(_CF, "CFURLCopyAbsoluteURL", vp, vp)
CFURLIsFileReferenceURL = _fn(_CF, "CFURLIsFileReferenceURL", c.c_bool, vp)
CFURLCreateFilePathURL = _fn(_CF, "CFURLCreateFilePathURL", vp, vp, vp, vp)
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
CGEventSourceSecondsSinceLastEventType = _fn(_AS, "CGEventSourceSecondsSinceLastEventType", c.c_double, c.c_int32,
                                             c.c_uint32)
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
    if kind == T_URL:  # a file list's items name their files by reference, or relative to the folder
        if CFURLIsFileReferenceURL(ref):
            path = CFURLCreateFilePathURL(None, ref, None)
            if path:
                try:
                    return cf_text(CFURLGetString(path))
                finally:
                    CFRelease(path)
        absolute = CFURLCopyAbsoluteURL(ref)
        if not absolute:
            return cf_text(CFURLGetString(ref))
        try:
            return cf_text(CFURLGetString(absolute))
        finally:
            CFRelease(absolute)
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
    """Let in the system's news of apps that started, quit or came to the front. That news comes in on the main
    thread; while calls run on threads of their own, the server's main thread keeps it coming in."""
    if threading.current_thread() is not threading.main_thread():
        return
    for _ in range(50):
        if CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.0, True) != 4:  # 4: a source was handled
            break


def idle():
    """Called again and again on the main thread by the server while it waits."""
    pool = objc_autoreleasePoolPush()
    try:
        pump()
    finally:
        objc_autoreleasePoolPop(pool)


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
PROTECTED_PROGRAMS = {"ClaudeOverlay", "osascript", "SecurityAgent", "coreautha", "universalAccessAuthWarn", "UserNotificationCenter",
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


# ------------------------------------------------- the user's say over apps
# The user chooses which apps Claude may use. The first time one is wanted, a
# question shows on screen with three answers: always, for an hour, or no. Only
# a real click of the user's answers it; clicks posted by programs, these tools
# among them, are ignored. "Always" and "no" are kept in app-grants.json beside
# these tools, which the user may edit at any time; an hour is kept in memory.
GRANTS = os.path.join(HERE, "app-grants.json")
GRANTS_NOTE = ("always：Claude 可以直接操作的应用；never：你拒绝过的应用。条目是 bundle identifier（没有的写应用路径）。"
               "删掉一条，下次用到时会重新问你。改完立即生效。")
HOUR = 3600
ASK_WAIT = 120
_hour_grants = {}
_grants_lock = threading.Lock()
_asks = {}


def app_key(app):
    return app["bundle_id"] or app["path"] or app["name"]


def grants():
    try:
        with open(GRANTS, encoding="utf-8") as file:
            data = json.load(file)
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    return {key: [item for item in data.get(key, []) if isinstance(item, str)]
            if isinstance(data.get(key), list) else [] for key in ("always", "never")}


def remember(key, answer):
    with _grants_lock:
        data = grants()
        for name in ("always", "never"):
            data[name] = [item for item in data[name] if item != key]
        data[answer].append(key)
        body = {"_说明": GRANTS_NOTE, "always": sorted(data["always"]), "never": sorted(data["never"])}
        temporary = GRANTS + ".tmp"
        with open(temporary, "w", encoding="utf-8") as file:
            json.dump(body, file, ensure_ascii=False, indent=2)
            file.write("\n")
        os.replace(temporary, GRANTS)


def consent_of(app, data=None):
    """allowed, refused or ask: what the user has said about Claude using this app."""
    key = app_key(app)
    data = data or grants()
    if key in data["never"]:
        return "refused"
    if key in data["always"] or _hour_grants.get(key, 0) > time.time():
        return "allowed"
    return "ask"


def ask_user(app):
    """Put the question on screen and wait for the user's answer: always, hour, no, or None when there was none."""
    key = app_key(app)
    with _grants_lock:
        pending = _asks.get(key)
        if pending is None:
            pending = _asks[key] = {"id": "%x" % random.getrandbits(48), "done": threading.Event(), "answer": None}
            fresh_ask = True
        else:
            fresh_ask = False
    if fresh_ask and not overlay_send({"op": "ask", "id": pending["id"], "app": app["name"], "bundle": key}):
        with _grants_lock:
            _asks.pop(key, None)
        return "unasked"
    pending["done"].wait(ASK_WAIT)
    with _grants_lock:
        if _asks.get(key) is pending:
            _asks.pop(key, None)
    if pending["answer"] is None and fresh_ask:
        overlay_send({"op": "unask", "id": pending["id"]})
    return pending["answer"]


def answered(ask_id, answer):
    with _grants_lock:
        pending = next((p for p in _asks.values() if p["id"] == ask_id), None)
    if pending is None or answer not in ("always", "hour", "no", "later"):
        return
    pending["answer"] = answer
    pending["done"].set()


def consent(app):
    state = consent_of(app)
    if state == "allowed":
        return
    if state == "refused":
        raise Refused("the user has chosen not to let Claude use %s. Do not try it another way; if it is needed, ask "
                      "the user, who can change this in app-grants.json beside these tools." % app["name"])
    answer = ask_user(app)
    key = app_key(app)
    if answer == "always":
        remember(key, "always")
        return
    if answer == "hour":
        _hour_grants[key] = time.time() + HOUR
        return
    if answer == "no":
        remember(key, "never")
        raise Refused("the user answered on screen that Claude may not use %s. Do not try it another way; ask the "
                      "user how to go on." % app["name"])
    if answer == "later":
        raise Refused("the user put away the question whether Claude may use %s without answering it. Ask the user in "
                      "the conversation before calling for it again." % app["name"])
    if answer == "unasked":
        raise Refused("the user has not yet allowed Claude to use %s, and the question could not be shown on screen. "
                      "Ask the user to add %s to always in app-grants.json beside these tools." % (
                          app["name"], quoted(key)))
    raise Refused("the user has not yet answered the question on screen whether Claude may use %s. Tell the user it "
                  "is waiting there, and call again once they have answered." % app["name"])


def admit(app):
    app["access"] = access_of(app)
    if app["access"] == "protected":
        raise Refused("%s cannot be used through these tools: it shows the user's permission questions and security "
                      "prompts, which only the user may answer." % app["name"])
    if app["access"] == "blocked":
        raise Refused("%s is blocked for these tools because it keeps passwords or other secrets (policy.json beside "
                      "the tools lists it). Ask the user to do this part themselves." % app["name"])
    consent(app)
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
        exact = [i for i in found if windows[i]["title"].strip().lower() == title.strip().lower()]
        if len(found) > 1 and len(exact) == 1:
            found = exact
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
LISTED = {}  # (process id, window): the lines of the latest full listing of that window, by element number
ACTED_AT = {}  # process id: when a tool last acted in that app
QUIET_AFTER = 0.8  # seconds an app is given after an action before app_state reads it
QUIET_MOST = 5.0  # the longest app_state waits, from the action, for an app that shows it is still busy
NUMBERED = re.compile(r"^(\s*)\[(\d+)\]")


def changes(key, lines):
    """The lines of a full listing that differ from the previous listing of the same window: added or changed
    elements, each with the element that holds it, and those gone. None when there is no earlier listing, or when
    so much changed that the whole listing says it better."""
    numbered, order, holders, stack = {}, [], {}, []
    for line in lines:
        found = NUMBERED.match(line)
        if not found:
            continue
        depth, number = len(found.group(1)), int(found.group(2))
        while stack and stack[-1][0] >= depth:
            stack.pop()
        holders[number] = stack[-1][1] if stack else None
        stack.append((depth, number))
        numbered[number] = line.strip()
        order.append(number)
    before = LISTED.get(key)
    LISTED[key] = numbered
    if before is None:
        return None
    added = [n for n in order if n not in before]
    changed = [n for n in order if n in before and before[n] != numbered[n]]
    gone = [n for n in before if n not in numbered]
    if len(added) + len(changed) + len(gone) > max(12, len(order) // 2):
        return None
    out = []
    for n in order:
        if n in added or n in changed:
            holder = holders.get(n)
            out.append("%s %s%s" % ("+" if n in added else "~", numbered[n],
                                    "  (in [%d])" % holder if holder is not None else ""))
    for n in gone:
        out.append("- %s" % short(before[n], 120))
    return out


BUSY_ROLES = {"AXBusyIndicator"}


def busy(element, most=600, seconds=0.4):
    """Whether a window shows that it is still working: a spinning indicator, a progress bar with no value, or a
    web page that has not finished loading."""
    deadline, queue, seen = time.time() + seconds, [element], 0
    while queue and seen < most and time.time() < deadline:
        node = queue.pop(0)
        seen += 1
        values, _ = ax_many(node, ["AXRole", "AXValue", "AXLoaded"])
        role = values.get("AXRole")
        if role in BUSY_ROLES or (role == "AXProgressIndicator" and values.get("AXValue") is None):
            return True
        if role == "AXWebArea" and values.get("AXLoaded") is False:
            return True
        queue.extend(ax_slice(node, "AXChildren", 60) or [])
    return False


def wait_quiet(pid, window):
    """Before reading an app just acted in, give it the moment it needs to show the result, and longer, up to a
    few seconds from the action, while it shows it is busy. The seconds waited, or 0."""
    acted = ACTED_AT.get(pid)
    if acted is None:
        return 0.0
    start = time.time()
    if start - acted < QUIET_AFTER:
        time.sleep(QUIET_AFTER - (start - acted))
    while time.time() - acted < QUIET_MOST and window is not None and busy(window):
        time.sleep(0.25)
    ACTED_AT.pop(pid, None)
    return time.time() - start
NUMBERS = {}  # process id: the numbers given to that app's elements
KEPT = 5000  # elements of one app kept by number; the oldest numbers go first


class Numbers(object):
    """The numbers of one app's elements. An element keeps its number for as long as it is there, from one app_state
    to the next, and a number never goes to another element, so an old number can fail but not hit the wrong thing."""

    def __init__(self):
        self.elements, self.notes, self.keys, self.by_key, self.next = {}, {}, {}, {}, 1

    def lookup(self, element):
        for number in self.by_key.get(CFHash(element.ref), ()):
            if self.elements[number].same(element):
                return number
        return None

    def number(self, element, note):
        found = self.lookup(element)
        if found is not None:
            self.notes[found] = note
            return found
        number, self.next = self.next, self.next + 1
        key = CFHash(element.ref)
        self.elements[number], self.notes[number], self.keys[number] = element, note, key
        self.by_key.setdefault(key, []).append(number)
        if len(self.elements) > KEPT:
            for old in sorted(self.elements)[:len(self.elements) - KEPT]:
                held = self.by_key.get(self.keys[old], [])
                if old in held:
                    held.remove(old)
                if not held:
                    self.by_key.pop(self.keys[old], None)
                del self.elements[old], self.notes[old], self.keys[old]
        return number


class View(object):
    def __init__(self, app, window):
        self.pid, self.name, self.window = app["pid"], app["name"], window
        self.numbers = NUMBERS.setdefault(app["pid"], Numbers())
        self.notes = self.numbers.notes
        self.shown = []  # the numbers this app_state listed
        self.geometry = None  # window left, top, width, height in points; picture width, height

    def add(self, element, note):
        number = self.numbers.number(element, note)
        self.shown.append(number)
        return number

    def find(self, element):
        return self.numbers.lookup(element)

    def listed(self):
        return [self.numbers.elements[n] for n in self.shown if n in self.numbers.elements]


def need_view(app):
    view = VIEWS.get(app["pid"])
    if view is None:
        raise Refused("call app_state for %s first: element numbers and picture positions come from it" % app["name"])
    return view


def element_at(view, number):
    if not isinstance(number, int) or isinstance(number, bool) or number not in view.numbers.elements:
        raise Refused("there is no element %s for %s now; call app_state for the numbers of what is there"
                      % (number, view.name))
    return view.numbers.elements[number]


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
        self.visited, self.listed, self.cut, self.hidden = 0, 0, False, 0
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
            if key == "AXURL" and values.get("AXRole") != "AXLink":
                continue  # an item of a file list holds its whole path there
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

    def walk(self, element, depth=0, indent=0, clip=None, around="", trail=(), unseen=False):
        if self.stopped():
            return
        values = self.values(element)
        role = values.get("AXRole") or ""
        if role in SKIPPED:
            return
        frame = frame_of(values)
        if not unseen and frame and frame[2] > 0 and frame[3] > 0 and clip and not overlap(frame, clip):
            if self.query is None:
                self.hidden += 1
                return  # scrolled out of sight; a query still finds it
            unseen = True
        name = self.label(element, values, role)
        line = self.entry(values, role, name, around)
        if line is not None:
            if self.query is None or self.matches(values, name):
                number = self.view.add(element, line)
                where = "(scrolled out of sight)" if unseen else self.place(frame, role)
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
            self.walk(child, depth + 1, indent, clip, around, trail, unseen)
        if total > len(items) and self.query is None and not self.cut:
            self.lines.append("%s… %d more inside, not read" % ("  " * min(indent, 12), total - len(items)))


def picture_of(app, window):
    """A picture of a window, and why there is none when there is not."""
    if window["minimized"]:
        return None, ("the user has minimized the window; its controls can still be read and used, and if a "
                      "picture is needed, ask the user to bring it back")
    if app["hidden"]:
        return None, ("the user has hidden the app; its controls can still be read and used, and if a picture "
                      "is needed, ask the user to show it")
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
    query = arguments.get("app")
    if isinstance(query, str) and lookup_app(query) is None:
        tool_open_app({"app": query})  # not running: start it in the background, as the user would by opening it
    app = find_app(query)
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
        lines.extend(walker.lines)
        if query and not walker.lines:
            lines.append("(nothing in it matches)")
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
        waited = wait_quiet(app["pid"], window["element"])
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
            "in front, where the user is working: foreground true may be used here"
            if window_in_front(app, view.window.get("number")) else
            "in the background: work on it in the background only", ", hidden by the user" if app["hidden"] else "",
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
        listing = walker.lines[before:]
        diff = None
        if query is None:
            key = (app["pid"], window.get("number") or window["title"])
            diff = changes(key, listing)
            if arguments.get("full") is True:
                diff = None
        if waited >= 1.5:
            lines.append("Waited %.1f seconds for the app to finish showing the last action." % waited)
        if diff is not None:
            lines.append("Elements: only what changed since the last app_state of this window, + added, ~ changed, "
                         "- gone; every other element is as it was, with the same number (full true lists all):")
            lines.extend(diff or ["(nothing changed)"])
        else:
            lines.append("Elements%s (numbers are for the app_ tools):" % (" matching " + quoted(query) if query else ""))
            lines.extend(listing)
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
        span = ax_get(focused, "AXSelectedTextRange")
        where = ""
        if isinstance(span, dict):
            if span.get("length"):
                picked = ax_get(focused, "AXSelectedText")
                where = "; selected: characters %d to %d%s" % (span["location"], span["location"] + span["length"],
                                                              " " + quoted(short(picked, 60)) if picked else "")
            else:
                where = "; text cursor after character %d" % span["location"]
        lines.append("Keyboard focus: [%d] %s%s" % (number, short(view.notes[number], 160), where))
    if walker.hidden and query is None:
        lines.append("Parts scrolled out of sight are left out; query finds what is in them too, and the app_ tools "
                     "act on such elements without scrolling.")
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


def tap(code, flags, pid=None, hold=0.0):
    for pressed in (True, False):
        event = CGEventCreateKeyboardEvent(None, code, pressed)
        if event:
            CGEventSetFlags(event, flags)
        deliver(event, pid)
        time.sleep(hold if pressed and hold else 0.015)


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


FRONT_RULE = ("the user decides what is in front by where they keep their windows: foreground true is for the "
              "window the user already has in front, and any other is worked on in the background only, never "
              "brought forward. Do it in the background, or tell the user what needs the front and ask them to "
              "bring that window forward themselves")


def window_in_front(app, number=None):
    """Whether the user has this app in front and, given a window's number, that window frontmost of it."""
    if app["hidden"] or front_pid() != app["pid"]:
        return False
    if number is None:
        return True
    for entry in screen_windows():
        if entry["layer"] == 0 and entry["pid"] == app["pid"]:
            return entry["id"] == number
    return False


def need_front(app, window=None):
    """Foreground work is the user's choice, made by where they keep the window: allowed on the window they have
    in front, refused on one behind others, minimized or hidden, which is not brought forward."""
    number = window.get("number") if window else None
    if window_in_front(app, number):
        return
    if app["hidden"]:
        where = "hidden"
    elif front_pid() != app["pid"]:
        where = "behind the app the user has in front"
    else:
        where = "open in a window behind another of its own"
    raise Refused("%s is %s, so nothing was done: %s." % (app["name"], where, FRONT_RULE))


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


def window_under(app, point, view=None, strict=False):
    for window in screen_windows():
        if window["pid"] == app["pid"] and window["layer"] == 0 and inside(point, window["frame"]):
            return window["id"]
    return None if strict or view is None else view.window.get("number")


# ------------------------------------------------------- background input
# Clicks, drags and command keys for a window the user does not have in front,
# without bringing it forward or touching the user's pointer and keyboard.
# AppKit takes a mouse event posted to an app only when the event names the
# window (field 51) and the place in it, and takes clicks in text and command
# keys only while it believes it is active. So for the moment of the input the
# app is told, by the same messages the window server and AppKit send it, that
# its window is key and that it is active; the system's front app stays the
# user's, and afterwards the app is told it is inactive again. These messages
# go through the window server's private interface (SkyLight); where it is
# missing, input falls back to what the public interface can do.
class PSN(c.Structure):
    _fields_ = [("high", c.c_uint32), ("low", c.c_uint32)]


_sky = {}


def sky_post():
    """SkyLight's SLPSPostEventRecordTo, or None."""
    if "post" not in _sky:
        try:
            function = c.CDLL("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight").SLPSPostEventRecordTo
            function.restype, function.argtypes = c.c_int32, [c.POINTER(PSN), c.c_void_p]
            _sky["post"] = function
        except (OSError, AttributeError):
            _sky["post"] = None
    return _sky["post"]


def window_location_setter():
    """The private CGEventSetWindowLocation, or None."""
    if "where" not in _sky:
        _sky["where"] = None
        for path in ("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
                     "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"):
            try:
                function = c.CDLL(path).CGEventSetWindowLocation
                function.restype, function.argtypes = None, [vp, CGPoint]
                _sky["where"] = function
                break
            except (OSError, AttributeError):
                continue
    return _sky["where"]


def psn_of(pid):
    function = _AS.GetProcessForPID
    function.restype, function.argtypes = c.c_int32, [c.c_int32, c.POINTER(PSN)]
    psn = PSN()
    return psn if function(pid, c.byref(psn)) == 0 else None


def event_record(kind, window, extra):
    raw = (c.c_uint8 * 0xf8)()
    raw[0x04], raw[0x08] = 0xf8, kind
    for at, value in extra.items():
        raw[at] = value
    for i, byte in enumerate(int(window).to_bytes(4, "little")):
        raw[0x3c + i] = byte
    return raw


def uptime():
    return send(send(objc_getClass(b"NSProcessInfo"), "processInfo"), "systemUptime", result=c.c_double)


def tell_active(pid, window, active):
    """The AppKit event an app gets when it becomes active or inactive, posted to that app alone."""
    event = send(objc_getClass(b"NSEvent"),
                 "otherEventWithType:location:modifierFlags:timestamp:windowNumber:context:subtype:data1:data2:",
                 13, CGPoint(0, 0), 0, uptime(), window, None, 1 if active else 2, 0, 0,
                 types=(c.c_ulong, CGPoint, c.c_ulong, c.c_double, c.c_long, vp, c.c_short, c.c_long, c.c_long))
    made = send(event, "CGEvent") if event else None
    if made:
        CGEventPostToPid(pid, made)
    return bool(made)


class BackgroundInput(object):
    """For the moment of some input, have an app take it in one of its windows as if that window were key and the
    app active, while the user's front app stays in front."""

    def __init__(self, app, view):
        self.app, self.view, self.told = app, view, False
        self.window = view.window.get("number") if view else None

    def __enter__(self):
        pid = self.app["pid"]
        if not self.window or window_in_front(self.app, self.window):
            return self  # the user has it in front already: nothing to pretend
        if front_pid() == pid:
            raise Refused("the user is working in another window of %s, so input was not sent to this one, which "
                          "would take the keyboard from the user's window. Ask the user, or wait until they leave "
                          "the app." % self.app["name"])
        element = self.view.window["element"]
        if ax_get(element, "AXMain") is False:
            ax_set(element, "AXMain", True)  # first among the app's own windows; the app stays behind the user's
            time.sleep(0.08)
        post, psn = sky_post(), psn_of(pid)
        if post is not None and psn is not None:
            held = ax_get(app_element(pid), "AXFocusedWindow")
            former = window_number(held) if isinstance(held, Element) else None
            if former and former != self.window:  # the app's own key window lets go, as when another is clicked
                post(c.byref(psn), event_record(0x0d, former, {0x8a: 0x02}))
            post(c.byref(psn), event_record(0x0d, self.window, {0x8a: 0x01}))
            for kind in (1, 2):  # the window becomes key in its app, as when clicked
                raw = event_record(kind, self.window, {0x3a: 0x10})
                for i in range(0x20, 0x30):
                    raw[i] = 0xFF
                post(c.byref(psn), raw)
        self.told = tell_active(pid, self.window, True)
        time.sleep(0.03)
        return self

    def __exit__(self, *_):
        if self.told:
            time.sleep(0.05)
            tell_active(self.app["pid"], self.window, False)
        return False


def window_frame(view):
    values, _ = ax_many(view.window["element"], ["AXPosition", "AXSize"])
    return frame_of(values) or view.window["frame"]


def placed_mouse(kind, view, point, button=0, flags=0, press=1, frame=None):
    """A mouse event for one window: the window's number and the place in it go with it, as AppKit needs."""
    x, y = (frame or window_frame(view))[:2]
    event = CGEventCreateMouseEvent(None, kind, point, button)
    if not event:
        raise Refused("the system did not accept the input")
    CGEventSetFlags(event, flags)
    CGEventSetIntegerValueField(event, 1, press)  # which click of a double or triple click
    for field in (51, 91, 92):
        CGEventSetIntegerValueField(event, field, view.window["number"])
    setter = window_location_setter()
    if setter:
        setter(event, CGPoint(point.x - x, point.y - y))
    return event


def click_in_background(app, view, point, button, count, flags, hold=0.0):
    down, up, _, number = BUTTONS[button]
    frame = window_frame(view)
    with BackgroundInput(app, view):
        for press in range(1, count + 1):
            for kind in (down, up):
                deliver(placed_mouse(kind, view, point, number, flags, press, frame), app["pid"])
                time.sleep(hold if kind == down and hold else 0.03)


SAFE_ROLES = {"AXWindow", "AXGroup", "AXToolbar", "AXSplitGroup", "AXUnknown", "AXStaticText", "AXLayoutArea",
              "AXScrollArea", "AXSplitter"}


def quiet_spot(view, frame):
    """A place on the window's title bar where a click does nothing but make the window key: no control there."""
    x, y, width, height = frame
    blocked, queue, seen = [], [view.window["element"]], 0
    while queue and seen < 400:
        node = queue.pop(0)
        seen += 1
        values, _ = ax_many(node, ["AXRole", "AXPosition", "AXSize"])
        place = frame_of(values)
        if place and place[1] > y + 40:
            continue  # below the title bar
        if values.get("AXRole") not in SAFE_ROLES and place:
            blocked.append(place)
        queue.extend(ax_slice(node, "AXChildren", 80) or [])
    for top in (5, 12):
        for share in (0.62, 0.72, 0.82, 0.52, 0.9, 0.42):
            spot = CGPoint(x + width * share, y + top)
            if not any(b[0] - 4 <= spot.x <= b[0] + b[2] + 4 and b[1] - 4 <= spot.y <= b[1] + b[3] + 4
                       for b in blocked):
                return spot
    return None


def prime_window(app, view, frame):
    """A click on a quiet spot of the title bar, after which AppKit routes command keys to the window. False when
    the window shows no such spot."""
    spot = quiet_spot(view, frame)
    if spot is None:
        return False
    for kind in (1, 2):
        deliver(placed_mouse(kind, view, spot, 0, 0, 1, frame), app["pid"])
        time.sleep(0.03)
    time.sleep(0.15)
    return True


def chord_in_background(app, view, code, flags, hold=0.0, count=1):
    """Press a key with command, control or option in a window in the background. True when it was sent with the
    window ready for it."""
    frame = window_frame(view)
    with BackgroundInput(app, view) as scope:
        primed = True if not scope.told else prime_window(app, view, frame)
        for _ in range(count):
            tap(code, flags, app["pid"], hold)
            time.sleep(0.03)
    return primed


def click_with_pointer(point, button, count, flags, hold=0.0):
    down, up, _, number = BUTTONS[button]
    back = pointer_location()
    try:
        deliver(mouse_event(MOVED, point, 0, flags))
        time.sleep(0.05)
        for press in range(1, count + 1):
            for kind in (down, up):
                deliver(mouse_event(kind, point, number, flags, press))
                time.sleep(hold if kind == down and hold else 0.02)
    finally:
        time.sleep(0.05)
        CGWarpMouseCursorPosition(back)
        CGAssociateMouseAndMouseCursorPosition(1)


def drag_path(start, end, steps):
    return [CGPoint(start.x + (end.x - start.x) * i / steps, start.y + (end.y - start.y) * i / steps)
            for i in range(1, steps + 1)]


def drag_in_background(app, view, start, end, flags, hold):
    """A left-button drag sent to one window alone: press, a short hold so the app takes it as a drag, moves along
    the way, and release."""
    down, up, dragged, number = BUTTONS["left"]
    frame = window_frame(view)
    with BackgroundInput(app, view):
        deliver(placed_mouse(down, view, start, number, flags, 1, frame), app["pid"])
        time.sleep(max(hold, 0.12))
        for point in drag_path(start, end, 16):
            deliver(placed_mouse(dragged, view, point, number, flags, 1, frame), app["pid"])
            time.sleep(0.015)
        time.sleep(0.08)
        deliver(placed_mouse(up, view, end, number, flags, 1, frame), app["pid"])


def drag_with_pointer(start, end, flags, hold):
    down, up, dragged, number = BUTTONS["left"]
    back = pointer_location()
    try:
        deliver(mouse_event(MOVED, start, 0, flags))
        time.sleep(0.05)
        deliver(mouse_event(down, start, number, flags, 1))
        time.sleep(max(hold, 0.12))
        for point in drag_path(start, end, 16):
            deliver(mouse_event(dragged, point, number, flags, 1))
            time.sleep(0.015)
        time.sleep(0.08)
        deliver(mouse_event(up, end, number, flags, 1))
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
                if ax_set_elements(parent, attribute, chosen) == 0:
                    return True
                # a list shown for another process, as in an open dialog, can report a failure and still select
                for _ in range(6):
                    held = ax_get(parent, attribute)
                    if isinstance(held, list) and any(isinstance(e, Element) and e.same(node) for e in held):
                        return True
                    time.sleep(0.05)
                return False
        node = parent
    return False


def holder(element, roles, most=12):
    """The nearest element around this one with one of these roles."""
    node = element
    for _ in range(most):
        node = ax_get(node, "AXParent")
        if not isinstance(node, Element):
            return None
        if ax_get(node, "AXRole") in roles:
            return node
    return None


def file_of(element):
    """The file or folder an item of a file list stands for, as a path, or None."""
    for node in (element, ax_get(element, "AXParent")):
        url = ax_get(node, "AXURL") if isinstance(node, Element) else None
        if isinstance(url, str) and url.startswith("file://"):
            return unquote(urlparse(url).path)
    return None


def default_button(dialog):
    """The button of a dialog that return presses. An open or save dialog shown for another app does not say which
    it is, but names it OKButton."""
    button = ax_get(dialog, "AXDefaultButton")
    if isinstance(button, Element):
        return button
    layer = [dialog]
    for _ in range(3):
        below = []
        for node in layer:
            for child in ax_slice(node, "AXChildren", 80) or []:
                values, _ = ax_many(child, ["AXRole", "AXIdentifier"])
                if values.get("AXRole") == "AXButton" and values.get("AXIdentifier") == "OKButton":
                    return child
                if values.get("AXRole") in ("AXSplitGroup", "AXGroup"):
                    below.append(child)
        layer = below[:20]
    return None


def press_dialog_button(button):
    """Press the button of an open or save dialog. A dialog shown for an app in the background shows what was
    selected in it and still keeps its button off until the app is active; macOS gives no way round that, and the
    app is not brought forward behind the user's back: the user is asked to. True when pressed."""
    if ax_get(button, "AXEnabled") is not False:
        return perform(button, "AXPress") == 0
    pid = pid_of(button)
    if pid is None:
        return False
    view = VIEWS.get(pid)
    if front_pid() != pid and view is not None and sky_post():
        with BackgroundInput({"pid": pid, "name": view.name, "hidden": False}, view):
            deadline = time.time() + 1.5
            while ax_get(button, "AXEnabled") is False and time.time() < deadline:
                time.sleep(0.03)
            if ax_get(button, "AXEnabled") is not False:
                return perform(button, "AXPress") == 0
    if front_pid() != pid:
        raise Refused("what was chosen is selected in the dialog, but macOS keeps the dialog's %s button off while "
                      "its app is in the background, and %s. Ask the user to click that app's window once to bring "
                      "it forward, then press the button again." % (quoted(clean(ax_get(button, "AXTitle")) or "OK"),
                                                                     FRONT_RULE.split(": ")[0]))
    deadline = time.time() + 2.0
    while ax_get(button, "AXEnabled") is False and time.time() < deadline:
        time.sleep(0.03)
    return ax_get(button, "AXEnabled") is not False and perform(button, "AXPress") == 0


def open_item(element):
    """Open an item the way a double click does: select it, then have it, or what holds it, open. In an open or
    save dialog this is done without the actions that would bring the app to the front: a place in the sidebar or a
    folder in column view opens once selected, and a file is chosen with the dialog's default button."""
    path = file_of(element)
    selected = select_item(element)
    dialog = holder(element, {"AXSheet", "AXWindow"})
    button = default_button(dialog) if dialog is not None else None
    if selected and isinstance(button, Element):
        folder = path is not None and os.path.isdir(path) and not path.rstrip("/").endswith(
            (".app", ".bundle", ".pkg"))
        if path is None or (folder and holder(element, {"AXBrowser"}) is not None):
            time.sleep(0.2)
            return True
        if not folder and "AXPress" in actions_of(button):
            deadline = time.time() + 0.6  # the button turns on once the dialog has taken in the selection
            while ax_get(button, "AXEnabled") is False and time.time() < deadline:
                time.sleep(0.05)
            return press_dialog_button(button)
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
    if role == "AXButton" and values.get("AXIdentifier") == "OKButton" and values.get("AXEnabled") is False:
        return "Pressed" if press_dialog_button(element) else None  # an open or save dialog's own button
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
_overlay_lock = threading.Lock()


def _listen(process):
    for line in process.stdout:
        words = line.decode("utf-8", "replace").split()
        if words == ["stop"]:
            _overlay["stopped_at"] = time.time()
        elif len(words) == 3 and words[0] == "answer":
            answered(words[1], words[2])


def overlay_send(order):
    with _overlay_lock:
        return _overlay_write(order)


def _overlay_write(order):
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
    if isinstance(app, dict):
        _acted.pid = app["pid"]
    order = {"op": "act", "app": app["name"] if isinstance(app, dict) else app, "what": what, "kind": kind,
             "cursor": getattr(_acted, "cursor", None) or DEFAULT_CURSOR}
    if point is not None and isinstance(app, dict):
        # The cursor shows only on the window acted in, just above it, so whatever covers that window covers the
        # cursor too; a place outside the app's windows, such as an element scrolled out of sight, gets none.
        window = window_under(app, point, strict=True)
        point = point if window else None
        if window:
            order["x"], order["y"], order["window"] = point.x, point.y, window
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


_acted = threading.local()  # per call: the app it works in (pid) and the name of its cursor
UNGUARDED = {"list_apps", "read_clipboard", "write_clipboard", "app_batch"}
DEFAULT_CURSOR = "Claude"
WATCH = 3.0  # seconds after a call during which an app that jumps in front on its own is put back


def user_idle():
    """Seconds since the user last pressed a key or a mouse button, which is how a person brings an app forward;
    moving the pointer does not count. Events these tools send to one app alone do not count either."""
    # The hardware's state: left, right and other mouse button down, key down.
    return min(CGEventSourceSecondsSinceLastEventType(1, kind) for kind in (1, 3, 25, 10))


def front_state():
    """The app in front, its frontmost window, and the windows above that one: what a call in the background must
    leave as it found it."""
    pid = front_pid()
    if pid is None:
        return None
    above, top = set(), None
    for window in screen_windows():
        if window["layer"] != 0:
            continue
        if window["pid"] == pid:
            top = window["id"]
            break
        above.add(window["id"])
    ax_window = None
    if top is not None:
        for attribute in ("AXFocusedWindow", "AXMainWindow"):
            found = ax_get(app_element(pid), attribute)
            if isinstance(found, Element):
                ax_window = found
                break
    return {"pid": pid, "top": top, "above": above if top is not None else set(), "window": ax_window,
            "since": time.time()}


def newly_over(state, acted):
    """Whether a window of the app acted in has come over the user's front window since the call began."""
    if state["top"] is None:
        return False
    for window in screen_windows():
        if window["layer"] != 0:
            continue
        if window["id"] == state["top"]:
            return False
        if window["pid"] == acted and window["id"] not in state["above"]:
            return True
    return False


def jumped(state, acted):
    return front_pid() == acted or newly_over(state, acted)


def put_back(state, acted):
    """Put the user's app and window back on top of the app acted in. Not when the user has touched the keyboard or
    pointer since the call began: then what is in front may be the user's own doing."""
    if user_idle() < time.time() - state["since"]:
        return False
    if front_pid() != state["pid"]:
        ax_set(app_element(state["pid"]), "AXFrontmost", True)
        time.sleep(0.05)
    if state["window"] is not None and newly_over(state, acted):
        perform(state["window"], "AXRaise")
    return True


def keep_front(state, acted):
    """When the app a background call worked in came to the front, or put a window over the user's, as some do when
    a dialog opens, an item is opened or a page is loaded, put the user's app and window back on top. True when that
    was needed."""
    if state is None or acted is None or state["pid"] == acted:
        return False
    for wait in (0.0, 0.1):
        time.sleep(wait)
        if jumped(state, acted):
            return put_back(state, acted)
    return False


def watch_front(state, acted, seconds=WATCH):
    """Some apps come forward a second or more after they were asked to do something. Keep watching for a while
    after the call, on a thread of its own, and put the user's work back on top if they do."""
    if state is None or acted is None or state["pid"] == acted:
        return

    def watch():
        pool = objc_autoreleasePoolPush()
        try:
            deadline = time.time() + seconds
            while time.time() < deadline:
                time.sleep(0.12)
                if jumped(state, acted) and not put_back(state, acted):
                    return  # the user is at work; leave it to them
        except Exception:
            pass
        finally:
            objc_autoreleasePoolPop(pool)
    threading.Thread(target=watch, daemon=True).start()


_locks, _locks_guard = {}, threading.Lock()


def lock_for(arguments):
    """Calls for one app take turns; calls for different apps run at the same time."""
    wanted = arguments.get("app")
    key = None
    if isinstance(wanted, (str, int)) and not isinstance(wanted, bool):
        found = lookup_app(str(wanted).strip()) if str(wanted).strip() else None
        key = found["pid"] if found else str(wanted).strip().lower()
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


def cursor_name(arguments, inherited=None):
    name = arguments.get("cursor", inherited)
    if name is None:
        return inherited
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 24 or any(
            ord(ch) < 0x20 for ch in name):
        raise Refused("cursor is a short name, up to 24 characters, such as A or 搜索")
    return name.strip()


def run_tool(name, arguments, inherited=None):
    """One tool, keeping the user's app and window in front: whatever the call does, what the user has in front
    stays there."""
    function = HANDLERS[name]
    _acted.cursor = cursor_name(arguments, inherited)
    if name == "app_batch":
        return function(arguments)
    if name in UNGUARDED:
        return function(arguments)
    with lock_for(arguments):
        state, _acted.pid = front_state(), None
        try:
            result = function(arguments)
        except Refused:
            acted = getattr(_acted, "pid", None)
            keep_front(state, acted)
            watch_front(state, acted)
            raise
        acted = getattr(_acted, "pid", None)
        if acted is not None and name not in ("app_state", "list_apps"):
            ACTED_AT[acted] = time.time()
        put = keep_front(state, acted)
        watch_front(state, acted)
    if put:
        note = "The app came in front of the user's work on its own; the user's app and window were put back on top."
        if isinstance(result, str):
            result += " " + note
        elif isinstance(result, list):
            result = result + [text(note)]
    return result


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
    hold = seconds_argument(arguments, "duration")
    if button != "left" or flags or hold:
        need_full(app, "a right, middle, modifier or long click")
    guard(app)
    view = need_view(app)
    number = arguments.get("element")
    if number is not None:
        element = element_at(view, number)
        values = fresh(element, number)
        target = "[%d] %s" % (number, short(view.notes[number]))
        show(app, ("右键点击 " if button == "right" else "点击 ") + brief(view.notes[number]), center_of(values), "click")
        if not foreground and not hold and (not flags or flags == CMD):
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
        if not foreground and not hold and (not flags or flags == CMD) and button == "left":
            hit = pressable_at(app, point)
            if hit is not None and ax_get(hit, "AXRole") in TEXT_INPUTS and sky_post():
                hit = None  # a click in text puts the cursor where it lands, which focusing it does not
            if hit is not None:
                values, _ = ax_many(hit, BASE)
                done = press(hit, values, "left", count, flags)
                if done:
                    settle()
                    name = Walker(view, 1).entry(values, values.get("AXRole") or "", clean(values.get(
                        "AXTitle")) or clean(values.get("AXDescription")) or clean(values.get("AXValue")), "")
                    return "%s %s at %s in %s, in the background." % (done, name or "the element", target, app["name"])
    if foreground:
        need_front(app, view.window)
        cover = covering(app, point)
        if cover:
            raise Refused("a window of %s is on top at that spot, so nothing was clicked" % cover)
        click_with_pointer(point, button, count, flags, hold)
        settle()
        return "Clicked %s%s in %s with the pointer, which then went back to where it was." % (
            target, held_for(hold), app["name"])
    click_in_background(app, view, point, button, count, flags, hold)
    settle()
    return ("Clicked %s%s in %s, sent to its window alone without moving the pointer, in the background%s. Check "
            "with app_state that it took effect." % (
                target if count == 1 else "%s (%d-fold)" % (target, count), held_for(hold), app["name"],
                "" if sky_post() else "; some apps ignore such clicks on this system"))


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
    values, _ = ax_many(element, ["AXRole", "AXValue", "AXFocused", "AXSelectedText", "AXSelectedTextRange"])
    role = values.get("AXRole") or ""
    # A field of a web page is given its new value whole: focusing it, or typing into it, can bring the browser
    # to the front.
    if not settable(element, "AXSelectedText") or holder(element, {"AXWebArea"}, most=40) is not None:
        done = set_text(element, values, role, words)
        if done or not settable(element, "AXSelectedText"):
            return done
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
            return set_text(element, values, role, words)
        after = ax_get(element, "AXValue")
        if isinstance(before, str) and isinstance(after, str) and before == after and values.get(
                "AXSelectedText") != words:
            return set_text(element, values, role, words)  # the app took no notice
    if submit:
        if not ("AXConfirm" in actions_of(element) and perform(element, "AXConfirm") == 0):
            tap(KEYS["return"], 0, pid_of(element))
    return len(words), submit


def set_text(element, values, role, words):
    """Type by setting the whole value, for fields that take a value but not a replacement of their selection, as
    the text fields of web pages do. Nothing is focused, so the app is not drawn to the front. The text goes where
    the selection is, or at the end."""
    if role not in TEXT_INPUTS or not settable(element, "AXValue"):
        return None
    submit = False
    if role in ONE_LINE:
        if words.endswith("\n"):
            words, submit = words[:-1], True
        if "\n" in words:
            raise Refused("a one-line field takes no line breaks; type each line by itself, or press return with app_key")
    held = values.get("AXValue") if isinstance(values.get("AXValue"), str) else ""
    span = values.get("AXSelectedTextRange")
    start, length = ((span["location"], span["length"]) if isinstance(span, dict) and values.get("AXFocused") is True
                     else (len(held), 0))  # a field without the focus has no cursor of its own: add at the end
    start = max(0, min(int(start), len(held)))
    length = max(0, min(int(length), len(held) - start))
    wanted = held[:start] + words + held[start + length:]
    if words and (ax_set(element, "AXValue", wanted) != 0 or ax_get(element, "AXValue") != wanted):
        return None
    if submit:
        if not ("AXConfirm" in actions_of(element) and perform(element, "AXConfirm") == 0):
            return len(words), False
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
        need_front(app, view.window if view else None)
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
            "foreground true works if the user has this window in front; otherwise tell the user." % (len(words), app["name"]))


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
    for element in (view.listed() if view else []):
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
    hold = seconds_argument(arguments, "duration")
    if hold and code is None:
        raise Refused("duration needs a named key or a letter, digit or sign key, not another character")
    show(app, "按键 " + arguments["keys"])
    foreground = arguments.get("foreground") is True
    pid = app["pid"]
    if not foreground and not hold and code is not None:
        done = edit_key(app, flags, code)
        if done:
            for _ in range(count - 1):
                done = edit_key(app, flags, code) or done
            settle()
            return "Pressed %s%s in %s through the accessibility interface (%s), in the background." % (
                arguments["keys"], " %d times" % count if count > 1 else "", app["name"], done)
    view = VIEWS.get(app["pid"])
    if not foreground and code is not None and flags & (CMD | CTRL | ALT) and view is not None:
        primed = chord_in_background(app, view, code, flags, hold, count)
        settle()
        return ("Pressed %s%s%s in %s, sent to its window alone, in the background%s. Check with app_state." % (
            arguments["keys"], " %d times" % count if count > 1 else "", held_for(hold), app["name"],
            "" if primed else "; the window showed no quiet spot to ready it, so the app may have let it pass"))
    if foreground:
        need_front(app, view.window if view else None)
        if front_pid() != app["pid"]:
            raise Refused("%s is not in front, so no key was pressed" % app["name"])
        pid = None
    for _ in range(count):
        if code is not None:
            tap(code, flags, pid, hold)
        else:
            unicode_keys(character, pid)
        time.sleep(0.03)
    settle()
    if foreground:
        return "Pressed %s%s in %s, in front." % (arguments["keys"], " %d times" % count if count > 1 else "",
                                                 app["name"])
    return ("Pressed %s%s in %s alone, in the background. Some apps ignore keys while in the background: check with "
            "app_state; app_menu is the way round that, or foreground true if the user has this window in front." % (
                arguments["keys"], " %d times" % count if count > 1 else "", app["name"]))


def tool_app_set_value(arguments):
    need_access()
    app = find_app(arguments.get("app"))
    need_full(app, "setting values")
    guard(app)
    attributes = {"value": "AXValue", "selected": "AXSelected", "focused": "AXFocused", "expanded": "AXExpanded",
                  "minimized": "AXMinimized", "position": "AXPosition", "size": "AXSize"}
    attribute = arguments.get("attribute") or "value"
    if attribute not in attributes:
        raise Refused("attribute is one of value, selected, focused, expanded, minimized, position or size")
    view = need_view(app)
    number = arguments.get("element")
    element = element_at(view, number)
    values = fresh(element, number)
    if attribute in ("position", "size"):
        return place_window(app, view, number, element, values, attribute, arguments.get("value"))
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


def place_window(app, view, number, element, values, attribute, value):
    """Move a window, or change its size, in the background: value is "x,y" for where its top left goes, in points
    from the top left of the main display, or "width,height" in points."""
    found = re.match(r"^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$", value if isinstance(value, str) else "")
    if not found:
        raise Refused('%s takes two numbers in points, such as "%s"' % (
            attribute, "100,80" if attribute == "position" else "800,600"))
    a, b = float(found.group(1)), float(found.group(2))
    if attribute == "size" and (a < 50 or b < 50):
        raise Refused("a size is at least 50 points each way")
    name = "AXPosition" if attribute == "position" else "AXSize"
    if not settable(element, name):
        raise Refused("the app does not let element %d be %s" % (number, "moved" if attribute == "position" else
                                                                   "resized"))
    held = CGPoint(a, b) if attribute == "position" else CGSize(a, b)
    ref = AXValueCreate(1 if attribute == "position" else 2, c.byref(held))
    if not ref:
        raise Refused("that value could not be handed to the app")
    show(app, ("移动 " if attribute == "position" else "调整大小 ") + brief(view.notes[number]), center_of(values), "click")
    try:
        error = AXUIElementSetAttributeValue(element.ref, cfname(name), ref)
    finally:
        CFRelease(ref)
    if error != 0:
        raise Refused("the app did not take that %s: %s" % (attribute, ax_error(error)))
    settle()
    frame = frame_of(ax_many(element, ["AXPosition", "AXSize"])[0])
    now = (" It is now at %d,%d, %dx%d." % tuple(round(v) for v in frame)) if frame else ""
    return "Set %s of [%d] %s to %g,%g, in the background.%s Call app_state again: places in its picture have moved." \
        % (attribute, number, short(view.notes[number]), a, b, now)


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
        need_front(app, view.window)
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
            "and if nothing moved, foreground true works if the user has this window in front; otherwise tell the user." % (direction, app["name"]))


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
        view = VIEWS.get(app["pid"])
        if front_pid() != app["pid"]:
            # An app in the background shows its menus as they were when it was last active, and may take no
            # notice of an item chosen there. An item with a shortcut is chosen by pressing that, which the app
            # takes in the background.
            keys = last["shortcut"]
            if keys and view is not None:
                try:
                    flags, code, _ = parse_keys(keys)
                except Refused:
                    code = None
                if code is not None:
                    show(app, "菜单 " + " > ".join(trail))
                    chord_in_background(app, view, code, flags)
                    settle()
                    return "Chose %s in %s by its shortcut %s, in the background. Check with app_state." % (
                        " > ".join(trail), app["name"], keys)
            if view is not None:
                show(app, "菜单 " + " > ".join(trail))
                with BackgroundInput(app, view):
                    time.sleep(0.1)
                    error = perform(node, "AXPress")
                if error == 0:
                    settle()
                    return ("Chose %s in %s in the background. An app in the background does not always act on a menu "
                            "item chosen so: check with app_state." % (" > ".join(trail), app["name"]))
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
    counts, rules, given, listed = windows_by_app(), policy(), grants(), []
    for app in sorted(running_apps(), key=lambda a: (not a["frontmost"], a["policy"], a["name"].lower())):
        if not every and app["policy"] != 0:
            continue
        if query and query not in app["name"].lower() and query not in app["bundle_id"].lower() \
                and query not in app["file"].lower():
            continue
        access = access_of(app, rules)
        if access in ("full", "click_only"):
            said = consent_of(app, given)
            access = {"refused": "refused_by_user", "ask": access + ", ask_first"}.get(said, access)
        listed.append({"name": app["name"], "bundle_id": app["bundle_id"], "pid": app["pid"],
                       "windows": counts.get(app["pid"], 0), "frontmost": app["frontmost"], "hidden": app["hidden"],
                       "access": "blocked" if access == "protected" else access})
    result = {"apps": listed}
    if arguments.get("installed") is True:
        running = {app["bundle_id"] for app in running_apps() if app["bundle_id"]}
        others = []
        for app in installed_apps():
            if app["bundle_id"] in running:
                continue
            if query and query not in app["name"].lower() and query not in app["bundle_id"].lower():
                continue
            access = access_of(app, rules)
            if access in ("full", "click_only"):
                said = consent_of(app, given)
                access = {"refused": "refused_by_user", "ask": access + ", ask_first"}.get(said, access)
            others.append({"name": app["name"], "bundle_id": app["bundle_id"], "last_used": app["last_used"],
                           "use_count": app["use_count"], "access": "blocked" if access == "protected" else access})
        result["not_running"] = others[:80]
        if len(others) > 80:
            result["note"] = "%d more installed apps not listed; query narrows the list" % (len(others) - 80)
    return json.dumps(result, ensure_ascii=False)


APP_FOLDERS = ["/Applications", "/System/Applications", os.path.expanduser("~/Applications")]


def installed_apps():
    """The apps in the usual folders, most recently used first, as Spotlight knows them."""
    found = subprocess.run(["/usr/bin/mdfind"] + [x for folder in APP_FOLDERS if os.path.isdir(folder)
                                                  for x in ("-onlyin", folder)]
                           + ['kMDItemContentType == "com.apple.application-bundle"'],
                           capture_output=True, timeout=20)
    paths = [line for line in found.stdout.decode("utf-8", "replace").splitlines()
             if line.endswith(".app") and ".app/" not in line]
    apps = []
    for start in range(0, len(paths), 200):
        part = paths[start:start + 200]
        read = subprocess.run(["/usr/bin/mdls", "-raw", "-nullMarker", "", "-name", "kMDItemCFBundleIdentifier",
                               "-name", "kMDItemDisplayName", "-name", "kMDItemLastUsedDate", "-name",
                               "kMDItemUseCount"] + part, capture_output=True, timeout=30)
        values = read.stdout.decode("utf-8", "replace").split("\0")
        for index, path in enumerate(part):
            bundle, name, used, count = (values[index * 4: index * 4 + 4] + ["", "", "", ""])[:4]
            name = name[:-4] if name.endswith(".app") else name
            apps.append({"name": name or os.path.basename(path)[:-4], "bundle_id": bundle, "path": path,
                         "executable": "", "last_used": used[:10] or None,
                         "use_count": int(count) if count.isdigit() else 0})
    apps.sort(key=lambda a: a["last_used"] or "", reverse=True)
    return apps


BUNDLE_ID = re.compile(r"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$")


def settle_opening(pid, seconds=2.5):
    """Give an app that was asked to open something the time to show it. Some come to the front while they do,
    a second or more later, even when asked not to; this waits for that too, so it can be undone."""
    deadline = time.time() + seconds
    time.sleep(0.4)
    while time.time() < deadline:
        if front_pid() == pid or next((w["pid"] for w in screen_windows() if w["layer"] == 0), None) == pid:
            return
        time.sleep(0.1)


def tool_open_app(arguments):
    wanted = arguments.get("app")
    if not isinstance(wanted, str) or not wanted.strip() or len(wanted) > 200:
        raise Refused("app is an app's name, such as Notes, or its bundle identifier")
    wanted = wanted.strip()
    if any(mark in wanted for mark in "/\\\"*") or any(ord(ch) < 0x20 for ch in wanted):
        raise Refused("app is an app's name or bundle identifier, not a path")
    foreground = arguments.get("foreground") is True
    url = arguments.get("url")
    if url is not None:
        if not isinstance(url, str) or not re.match(r"^https?://[^\s]+$", url.strip()) or len(url) > 4000:
            raise Refused("url is a web address that starts with http:// or https://")
        url = url.strip()
    flags = [] if foreground else ["-g"]
    app = lookup_app(wanted)
    if app is not None and url is not None:
        admit(app)
        target = ["-b", app["bundle_id"]] if app["bundle_id"] else ["-a", app["path"]]
        run = subprocess.run(["/usr/bin/open"] + flags + target + [url], capture_output=True, timeout=30)
        if run.returncode != 0:
            raise Refused("%s could not open that address: %s" % (app["name"], clean(run.stderr.decode(
                "utf-8", "replace"), 200) or "the system did not say why"))
        show(app, "打开网址")
        settle_opening(app["pid"])
        return "%s is opening %s%s." % (app["name"], url, " in front" if foreground else " in the background")
    if app is not None:
        admit(app)
        if foreground:  # the description limits this to the user's own request
            bring_front(app)
            return "%s was running and is now in front, as the user asked." % app["name"]
        return "%s is already running%s." % (app["name"], ", hidden by the user" if app["hidden"] else "")
    path = None
    extra = [url] if url else []
    if BUNDLE_ID.match(wanted):
        run = subprocess.run(["/usr/bin/open"] + flags + ["-b", wanted] + extra, capture_output=True, timeout=30)
    else:
        run = subprocess.run(["/usr/bin/open"] + flags + ["-a", wanted] + extra, capture_output=True, timeout=30)
        if run.returncode != 0:  # perhaps a name in the system's language, which Spotlight knows
            found = subprocess.run(["/usr/bin/mdfind", 'kMDItemContentType == "com.apple.application-bundle" && '
                                    'kMDItemDisplayName == "%s"c' % wanted], capture_output=True, timeout=20)
            paths = [line for line in found.stdout.decode("utf-8", "replace").splitlines() if line.endswith(".app")]
            if paths:
                path = sorted(paths, key=len)[0]
                run = subprocess.run(["/usr/bin/open"] + flags + ["-a", path] + extra, capture_output=True,
                                     timeout=30)
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


def seconds_argument(arguments, key, most=10.0):
    value = arguments.get(key)
    if value is None:
        return 0.0
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= most:
        raise Refused("%s is a number of seconds from 0 to %g" % (key, most))
    return float(value)


def held_for(hold):
    return " held for %g seconds" % hold if hold else ""


def place_of(app, view, arguments, prefix):
    """A point in an app from an element number or x and y of the latest picture, given with a prefix such as
    from_ or to_, with what it is called."""
    number = arguments.get(prefix + "element")
    if number is not None:
        element = element_at(view, number)
        values = fresh(element, number)
        frame = frame_of(values)
        if not frame or frame[2] <= 0 or frame[3] <= 0:
            raise Refused("element %d has no place on screen" % number)
        return CGPoint(frame[0] + frame[2] / 2.0, frame[1] + frame[3] / 2.0), "[%d] %s" % (
            number, short(view.notes[number]))
    if arguments.get(prefix + "x") is None or arguments.get(prefix + "y") is None:
        raise Refused("give %selement, or %sx and %sy in pixels of the latest app_state picture" % (
            prefix, prefix, prefix))
    point = picture_point(view, {"x": arguments[prefix + "x"], "y": arguments[prefix + "y"]})
    return point, "(%g, %g)" % (float(arguments[prefix + "x"]), float(arguments[prefix + "y"]))


def tool_app_drag(arguments):
    need_access()
    app = find_app(arguments.get("app"))
    need_full(app, "dragging")
    guard(app)
    view = need_view(app)
    flags = modifier_flags(arguments.get("modifiers"))
    hold = seconds_argument(arguments, "duration", 5.0)
    start, first = place_of(app, view, arguments, "from_")
    end, last = place_of(app, view, arguments, "to_")
    show(app, "拖拽", start, "click")
    if arguments.get("foreground") is True:
        need_front(app, view.window)
        cover = covering(app, start) or covering(app, end)
        if cover:
            raise Refused("a window of %s is on top on the way, so nothing was dragged" % cover)
        drag_with_pointer(start, end, flags, hold)
        show(app, "拖拽", end, "click")
        settle()
        return "Dragged from %s to %s in %s with the pointer, which then went back to where it was." % (
            first, last, app["name"])
    drag_in_background(app, view, start, end, flags, hold)
    show(app, "拖拽", end, "click")
    settle()
    return ("Dragged from %s to %s in %s, sent to its window alone without moving the pointer, in the background. "
            "Check with app_state that it took effect." % (first, last, app["name"]))


# ---------------------------------------------------------------- pasting
def ns_string(words):
    return send(objc_getClass(b"NSString"), "stringWithUTF8String:", words.encode("utf-8"), types=(c.c_char_p,))


def ns_data(raw):
    return send(objc_getClass(b"NSData"), "dataWithBytes:length:", raw, len(raw), types=(c.c_char_p, c.c_ulong))


def board_items():
    """Everything on the general pasteboard, item by item, as (type, bytes) pairs, to be put back later."""
    board = send(objc_getClass(b"NSPasteboard"), "generalPasteboard")
    items = send(board, "pasteboardItems")
    saved = []
    for i in range(send(items, "count", result=c.c_ulong) if items else 0):
        item = send(items, "objectAtIndex:", i, types=(c.c_ulong,))
        kinds = send(item, "types")
        pairs = []
        for j in range(send(kinds, "count", result=c.c_ulong) if kinds else 0):
            kind = send(kinds, "objectAtIndex:", j, types=(c.c_ulong,))
            data = send(item, "dataForType:", kind, types=(vp,))
            if data:
                size = send(data, "length", result=c.c_ulong)
                pairs.append((nsstring(kind), c.string_at(send(data, "bytes"), size) if size else b""))
        if pairs:
            saved.append(pairs)
    return saved


def put_on_board(items):
    board = send(objc_getClass(b"NSPasteboard"), "generalPasteboard")
    send(board, "clearContents", result=c.c_long)
    if not items:
        return
    array = send(objc_getClass(b"NSMutableArray"), "array")
    for pairs in items:
        item = send(send(objc_getClass(b"NSPasteboardItem"), "alloc"), "init")
        for kind, raw in pairs:
            send(item, "setData:forType:", ns_data(raw), ns_string(kind), result=c.c_bool, types=(vp, vp))
        send(array, "addObject:", item, result=None, types=(vp,))
        send(item, "release", result=None)
    send(board, "writeObjects:", array, result=c.c_bool, types=(vp,))


def inline_markdown(words):
    import html as html_module
    words = html_module.escape(words, quote=False)
    words = re.sub(r"`([^`]+)`", r"<code>\1</code>", words)
    words = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', words)
    words = re.sub(r"\*\*([^*]+)\*\*|__([^_]+)__", lambda m: "<b>%s</b>" % (m.group(1) or m.group(2)), words)
    words = re.sub(r"(?<![*\w])\*([^*\n]+)\*(?!\*)|(?<![_\w])_([^_\n]+)_(?!\w)",
                   lambda m: "<i>%s</i>" % (m.group(1) or m.group(2)), words)
    words = re.sub(r"~~([^~]+)~~", r"<s>\1</s>", words)
    return words


def markdown_html(source):
    """Common Markdown as HTML: headings, paragraphs, bold, italic, strikethrough, code, links, lists, quotes and
    code blocks."""
    import html as html_module
    out, paragraph, lists, block = [], [], [], None

    def end_paragraph():
        if paragraph:
            out.append("<p>%s</p>" % "<br>".join(inline_markdown(line) for line in paragraph))
            del paragraph[:]

    def end_lists():
        while lists:
            out.append("</%s>" % lists.pop())

    for line in source.split("\n"):
        if block is not None:
            if line.strip().startswith("```"):
                out.append("<pre><code>%s</code></pre>" % html_module.escape("\n".join(block), quote=False))
                block = None
            else:
                block.append(line)
            continue
        if line.strip().startswith("```"):
            end_paragraph()
            end_lists()
            block = []
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        item = re.match(r"^\s*([-*+]|\d+[.)])\s+(.*)$", line)
        if heading:
            end_paragraph()
            end_lists()
            level = len(heading.group(1))
            out.append("<h%d>%s</h%d>" % (level, inline_markdown(heading.group(2)), level))
        elif item:
            end_paragraph()
            kind = "ol" if item.group(1)[0].isdigit() else "ul"
            if not lists or lists[-1] != kind:
                end_lists()
                out.append("<%s>" % kind)
                lists.append(kind)
            out.append("<li>%s</li>" % inline_markdown(item.group(2)))
        elif line.startswith(">"):
            end_paragraph()
            end_lists()
            out.append("<blockquote>%s</blockquote>" % inline_markdown(line.lstrip("> ")))
        elif re.match(r"^\s*(-{3,}|\*{3,})\s*$", line):
            end_paragraph()
            end_lists()
            out.append("<hr>")
        elif not line.strip():
            end_paragraph()
            end_lists()
        else:
            end_lists()
            paragraph.append(line)
    if block is not None:
        out.append("<pre><code>%s</code></pre>" % html_module.escape("\n".join(block), quote=False))
    end_paragraph()
    end_lists()
    return "\n".join(out)


def plain_of_html(markup):
    import html as html_module
    markup = re.sub(r"(?i)<li>", "• ", markup)
    markup = re.sub(r"(?i)<br\s*/?>|</p>|</h\d>|</li>|</div>|</tr>|</pre>|</blockquote>", "\n", markup)
    return html_module.unescape(re.sub(r"<[^>]+>", "", markup)).strip("\n ")


def rich_items(words, kind):
    """What to put on the pasteboard for text in a format: plain text, and for HTML and Markdown also HTML and RTF,
    so that apps that take formatted text get it formatted."""
    if kind == "text":
        return [[("public.utf8-plain-text", words.encode("utf-8"))]]
    single = kind == "md" and "\n" not in words.strip("\n") and not re.match(r"^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```)", words.strip("\n"))
    if single:  # one line of text goes in as it is, without becoming a paragraph of its own
        core = words.strip("\n")
        markup = inline_markdown(core.strip(" "))
        markup = "&nbsp;" * (len(core) - len(core.lstrip(" "))) + markup + "&nbsp;" * (len(core) - len(core.rstrip(" ")))
    else:
        markup = markdown_html(words) if kind == "md" else words
    if kind == "md":  # blank lines before and after the text are kept as line breaks
        markup = "<br>" * (len(words) - len(words.lstrip("\n"))) + markup + "<br>" * max(
            0, len(words) - len(words.rstrip("\n")) - 1)
    page = ('<html><head><meta charset="utf-8"><style>body{font-family:-apple-system,"PingFang SC","Helvetica Neue",'
            'sans-serif}code,pre{font-family:Menlo,monospace}</style></head><body>%s</body></html>' % markup)
    plain = words if kind == "md" else plain_of_html(markup)
    pairs = [("public.html", page.encode("utf-8"))]
    rtf = subprocess.run(["/usr/bin/textutil", "-convert", "rtf", "-format", "html", "-inputencoding", "UTF-8",
                          "-stdin", "-stdout"], input=page.encode("utf-8"), capture_output=True, timeout=20)
    if rtf.returncode == 0 and rtf.stdout:
        pairs.append(("public.rtf", rtf.stdout))
    pairs.append(("public.utf8-plain-text", plain.encode("utf-8")))
    return [pairs]


def paste_item(app):
    """The app's own Paste menu item, the one for command V, which works with the app in the background. Taken
    even when it says it is off: an app in the background does not bring its menus up to date."""
    bar = ax_get(app_element(app["pid"]), "AXMenuBar")
    if not isinstance(bar, Element):
        return None
    for title in menu_items(bar) or []:
        for item in menu_items(title["element"]) or []:
            if item["shortcut"] == "cmd+v":
                return title["element"], item["element"]
    return None


def text_size(element):
    if element is None:
        return None
    count = ax_get(element, "AXNumberOfCharacters")
    if isinstance(count, int):
        return count
    value = ax_get(element, "AXValue")
    return len(value) if isinstance(value, str) else None


def view_of_element(app, view, element):
    """A view of the window an element is in, when that is not the window of the latest app_state."""
    window = ax_get(element, "AXWindow")
    if not isinstance(window, Element) or (view is not None and view.window["element"].same(window)):
        return view
    for entry in windows_of(app_element(app["pid"])):
        if entry["element"].same(window):
            return View(app, entry)
    return view


def tool_app_paste(arguments):
    need_access()
    app = find_app(arguments.get("app"))
    need_full(app, "pasting")
    guard(app)
    words = text_argument(arguments, "text")
    kind = arguments.get("format") or "text"
    if kind not in ("text", "md", "html"):
        raise Refused("format is text, md or html")
    number = arguments.get("element")
    view = VIEWS.get(app["pid"])
    target = "the keyboard focus"
    if number is not None:
        view = need_view(app)
        element = element_at(view, number)
        values = fresh(element, number)
        target = "[%d] %s" % (number, short(view.notes[number]))
        show(app, "粘贴", center_of(values), "type")
        view = view_of_element(app, view, element)
        window = view.window["element"]
        if front_pid() != app["pid"] and ax_get(window, "AXMain") is False:
            ax_set(window, "AXMain", True)  # within the app only: it stays where it is among the user's apps
            time.sleep(0.1)
        if ax_get(element, "AXFocused") is not True and ax_set(element, "AXFocused", True) != 0:
            raise Refused("element %d cannot take the keyboard focus; app_click it or app_select_text in it first"
                          % number)
    else:
        element = focused_field(app)
        show(app, "粘贴")
    before = text_size(element)
    in_front = window_in_front(app, view.window.get("number") if view else None)

    def arrived():
        if before is None:
            return None  # nothing to measure by
        for _ in range(10):
            if text_size(element) != before:
                return True
            time.sleep(0.05)
        return False

    items = rich_items(words, kind)
    saved = board_items()
    how = None
    try:
        put_on_board(items)
        time.sleep(0.05)
        tries = []
        if in_front:
            tries.append(("with command V on the keyboard, the window being in front", lambda: tap(KEYS["v"], CMD)))
        elif view is not None:
            tries.append(("with command V sent to its window alone, in the background",
                          lambda: chord_in_background(app, view, KEYS["v"], CMD)))
        found = paste_item(app)
        if found is not None:
            item = found[1]
            tries.append(("with its Paste menu item", lambda: perform(item, "AXPress")))
        for name, attempt in tries:
            attempt()
            done = arrived()
            if done is not False:
                how = name if done else name + " (whether it arrived cannot be read back here: check with app_state)"
                break
        time.sleep(0.3)  # an app may still be reading the pasteboard
    finally:
        put_on_board(saved)
    label = {"text": "plain text", "md": "formatted text from Markdown", "html": "formatted text from HTML"}[kind]
    if how is not None:
        settle()
        return ("Pasted %d characters as %s into %s of %s %s; the clipboard holds what it held before." % (
            len(words), label, target, app["name"], how))
    plain = words if kind == "text" else plain_of_html(markdown_html(words) if kind == "md" else words)
    if kind == "md":
        plain = "\n" * (len(words) - len(words.lstrip("\n"))) + plain + "\n" * (len(words) - len(words.rstrip("\n")))
    if element is not None and insert_text(element, plain):
        settle()
        return ("%s did not take a paste while in the background, so the text went in as plain text, without its "
                "formatting, through the accessibility interface. For the formatting, the user can bring this window "
                "forward and the paste be done again." % app["name"]) if kind != "text" else (
            "Typed %d characters into %s of %s through the accessibility interface, as it took no paste in the "
            "background." % (len(plain), target, app["name"]))
    raise Refused("%s took no paste in the background, and %s cannot take text another way. Ask the user to bring "
                  "the window forward, then paste again." % (app["name"], target))


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
            result = run_tool(name, given, getattr(_acted, "cursor", None))
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
            "app_drag": tool_app_drag, "app_paste": tool_app_paste,
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
        result = run_tool(name, arguments if isinstance(arguments, dict) else {})
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
