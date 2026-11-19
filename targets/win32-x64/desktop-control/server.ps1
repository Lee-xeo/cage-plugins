# An MCP server on standard input and output that takes pictures of the
# screen and sends mouse and keyboard input. Windows only; it needs nothing
# beyond Windows PowerShell and the system's own libraries.
$ErrorActionPreference = 'Stop'
$Version = '0.2.1'
# The longest edge of a picture handed back, in pixels.
$Longest = 1456

$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class DesktopInput {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }

    const uint KEYUP = 0x2, UNICODE = 0x4, EXTENDED = 0x1;

    // Pictures and positions in the screen's own pixels, whatever the
    // display scaling.
    public static void Aware() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) { }
        SetProcessDPIAware();
    }

    static void Send(INPUT[] inputs) {
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length) throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows did not accept the input");
    }

    public static void MoveTo(int x, int y) {
        if (!SetCursorPos(x, y)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows did not move the pointer");
    }

    public static void Mouse(uint flags, int data) {
        INPUT[] input = new INPUT[1];
        input[0].type = 0;
        input[0].u.mi.dwFlags = flags;
        input[0].u.mi.mouseData = unchecked((uint)data);
        Send(input);
    }

    public static void Key(ushort vk, bool up, bool extended) {
        INPUT[] input = new INPUT[1];
        input[0].type = 1;
        input[0].u.ki.wVk = vk;
        input[0].u.ki.dwFlags = (up ? KEYUP : 0) | (extended ? EXTENDED : 0);
        Send(input);
    }

    // Each character as itself, not as keys of a layout, so the active input
    // method and keyboard layout do not change it.
    public static void Text(string text) {
        foreach (char c in text) {
            INPUT[] input = new INPUT[2];
            input[0].type = input[1].type = 1;
            input[0].u.ki.wScan = input[1].u.ki.wScan = c;
            input[0].u.ki.dwFlags = UNICODE;
            input[1].u.ki.dwFlags = UNICODE | KEYUP;
            Send(input);
            System.Threading.Thread.Sleep(2);
        }
    }
}
'@

[DesktopInput]::Aware()
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

$ButtonFlags = @{ left = @(0x2, 0x4); right = @(0x8, 0x10); middle = @(0x20, 0x40) }
$ModifierCodes = @{ ctrl = 0x11; control = 0x11; cmd = 0x11; command = 0x11; shift = 0x10; alt = 0x12; option = 0x12; win = 0x5B; windows = 0x5B }
$KeyCodes = @{
    return = 0x0D; enter = 0x0D; tab = 0x09; space = 0x20; backspace = 0x08; escape = 0x1B; esc = 0x1B
    ';' = 0xBA; '=' = 0xBB; ',' = 0xBC; '-' = 0xBD; '.' = 0xBE; '/' = 0xBF; '`' = 0xC0
    '[' = 0xDB; '\' = 0xDC; ']' = 0xDD; "'" = 0xDE
}
# Keys outside the main block, which Windows tells apart by a flag.
$ExtendedCodes = @{
    delete = 0x2E; insert = 0x2D; left = 0x25; up = 0x26; right = 0x27; down = 0x28
    home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22
}
foreach ($c in [char[]]'abcdefghijklmnopqrstuvwxyz0123456789') { $KeyCodes[[string]$c] = [int][char]::ToUpper($c) }
for ($i = 1; $i -le 12; $i++) { $KeyCodes["f$i"] = 0x6F + $i }

function Refuse([string]$message) { throw [System.ArgumentException]::new($message) }

function Get-Size {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $shrink = [Math]::Max(1.0, [Math]::Max($bounds.Width, $bounds.Height) / $Longest)
    $width = [int][Math]::Round($bounds.Width / $shrink)
    $height = [int][Math]::Round($bounds.Height / $shrink)
    return @{ Bounds = $bounds; Width = $width; Height = $height; Scale = $bounds.Width / $width }
}

# Positions are given in pixels of a picture; this turns them into pixels of
# the screen. Set again with every picture, as the screen may have changed.
$script:Scale = (Get-Size).Scale

function Get-Place($arguments, [string]$x = 'x', [string]$y = 'y') {
    $px = $arguments.$x; $py = $arguments.$y
    if ($px -isnot [ValueType] -or $py -isnot [ValueType]) { Refuse "$x and $y must be numbers, in pixels of the latest screenshot" }
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $sx = [int][Math]::Round([double]$px * $script:Scale) + $bounds.X
    $sy = [int][Math]::Round([double]$py * $script:Scale) + $bounds.Y
    if ($sx -lt $bounds.Left -or $sx -gt $bounds.Right -or $sy -lt $bounds.Top -or $sy -gt $bounds.Bottom) { Refuse 'that position is outside the screen' }
    return @($sx, $sy)
}

function Invoke-Screenshot($arguments) {
    $size = Get-Size
    $script:Scale = $size.Scale
    $bounds = $size.Bounds
    $full = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $small = New-Object System.Drawing.Bitmap $size.Width, $size.Height
    $stream = New-Object System.IO.MemoryStream
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($full)
        try { $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size) }
        catch { Refuse 'The screen cannot be seen right now; it may be locked.' }
        finally { $graphics.Dispose() }
        $graphics = [System.Drawing.Graphics]::FromImage($small)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.DrawImage($full, 0, 0, $size.Width, $size.Height)
        $graphics.Dispose()
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        $parameters = New-Object System.Drawing.Imaging.EncoderParameters 1
        $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]80)
        $small.Save($stream, $codec, $parameters)
        $data = [Convert]::ToBase64String($stream.ToArray())
    } finally { $full.Dispose(); $small.Dispose(); $stream.Dispose() }
    return @(
        @{ type = 'image'; data = $data; mimeType = 'image/jpeg' },
        @{ type = 'text'; text = "$($size.Width)x$($size.Height) pixels. Positions for the other tools are pixels of this picture." }
    )
}

function Invoke-Move($arguments) {
    $at = Get-Place $arguments
    [DesktopInput]::MoveTo($at[0], $at[1])
    return 'moved'
}

function Invoke-Click($arguments) {
    $at = Get-Place $arguments
    $button = if ($null -eq $arguments.button) { 'left' } else { [string]$arguments.button }
    $count = if ($null -eq $arguments.count) { 1 } else { $arguments.count }
    if (-not $ButtonFlags.ContainsKey($button) -or @(1, 2, 3) -notcontains $count) { Refuse 'button is left, right or middle; count is 1, 2 or 3' }
    [DesktopInput]::MoveTo($at[0], $at[1])
    Start-Sleep -Milliseconds 50
    for ($press = 0; $press -lt $count; $press++) {
        [DesktopInput]::Mouse($ButtonFlags[$button][0], 0)
        Start-Sleep -Milliseconds 20
        [DesktopInput]::Mouse($ButtonFlags[$button][1], 0)
        Start-Sleep -Milliseconds 20
    }
    return 'clicked'
}

function Invoke-Drag($arguments) {
    $start = Get-Place $arguments 'from_x' 'from_y'
    $end = Get-Place $arguments 'to_x' 'to_y'
    [DesktopInput]::MoveTo($start[0], $start[1])
    Start-Sleep -Milliseconds 50
    [DesktopInput]::Mouse(0x2, 0)
    try {
        for ($step = 1; $step -le 10; $step++) {
            Start-Sleep -Milliseconds 20
            [DesktopInput]::MoveTo([int]($start[0] + ($end[0] - $start[0]) * $step / 10), [int]($start[1] + ($end[1] - $start[1]) * $step / 10))
        }
        Start-Sleep -Milliseconds 50
    } finally { [DesktopInput]::Mouse(0x4, 0) }
    return 'dragged'
}

function Invoke-Scroll($arguments) {
    $at = Get-Place $arguments
    $down = if ($null -eq $arguments.down) { 0 } else { $arguments.down }
    $right = if ($null -eq $arguments.right) { 0 } else { $arguments.right }
    if ($down -isnot [ValueType] -or $right -isnot [ValueType] -or [int]$down -ne $down -or [int]$right -ne $right) { Refuse 'down and right must be whole numbers of wheel steps' }
    if ([Math]::Abs($down) -gt 100 -or [Math]::Abs($right) -gt 100 -or ($down -eq 0 -and $right -eq 0)) { Refuse 'give down or right, between -100 and 100 wheel steps' }
    [DesktopInput]::MoveTo($at[0], $at[1])
    Start-Sleep -Milliseconds 50
    if ($down -ne 0) { [DesktopInput]::Mouse(0x0800, -120 * [int]$down) }
    if ($right -ne 0) { [DesktopInput]::Mouse(0x1000, 120 * [int]$right) }
    return 'scrolled'
}

function Send-Key([int]$code, [bool]$extended = $false) {
    [DesktopInput]::Key($code, $false, $extended)
    Start-Sleep -Milliseconds 20
    [DesktopInput]::Key($code, $true, $extended)
}

function Invoke-Type($arguments) {
    $text = $arguments.text
    if ($text -isnot [string] -or $text.Length -eq 0 -or $text.Length -gt 5000) { Refuse 'text must be 1 to 5000 characters' }
    foreach ($part in ($text -replace "`r`n", "`n") -split '([\n\t])') {
        if ($part -eq "`n") { Send-Key 0x0D }
        elseif ($part -eq "`t") { Send-Key 0x09 }
        elseif ($part.Length -gt 0) { [DesktopInput]::Text($part) }
    }
    return 'typed'
}

function Invoke-Key($arguments) {
    $keys = $arguments.keys
    if ($keys -isnot [string] -or $keys.Length -eq 0) { Refuse 'keys is a key, or modifiers and a key joined by +, such as ctrl+c' }
    $keys = $keys.ToLowerInvariant()
    if ($keys -eq '+' -or $keys.EndsWith('++')) {
        $names = @($keys.Substring(0, $keys.Length - 1).Split('+') | Select-Object -SkipLast 1) + @('shift', '=')
    } else {
        $names = $keys.Split('+')
    }
    $held = @()
    if ($names.Count -gt 1) {
        foreach ($name in $names[0..($names.Count - 2)]) {
            if (-not $ModifierCodes.ContainsKey($name)) { Refuse "unknown modifier $name; use ctrl, shift, alt or win" }
            $held += $ModifierCodes[$name]
        }
    }
    $last = $names[-1]
    if ($KeyCodes.ContainsKey($last)) { $code = $KeyCodes[$last]; $extended = $false }
    elseif ($ExtendedCodes.ContainsKey($last)) { $code = $ExtendedCodes[$last]; $extended = $true }
    else { Refuse "unknown key $last" }
    foreach ($modifier in $held) { [DesktopInput]::Key($modifier, $false, $modifier -eq 0x5B) }
    try { Send-Key $code $extended }
    finally {
        [array]::Reverse($held)
        foreach ($modifier in $held) { [DesktopInput]::Key($modifier, $true, $modifier -eq 0x5B) }
    }
    return 'pressed'
}

function Number([string]$description) { return @{ type = 'number'; description = $description } }

$Spot = @{ x = (Number 'pixels from the left edge of the latest screenshot'); y = (Number 'pixels from the top edge of the latest screenshot') }
function With($base, $more) { $all = @{}; foreach ($k in $base.Keys) { $all[$k] = $base[$k] }; foreach ($k in $more.Keys) { $all[$k] = $more[$k] }; return $all }

$Tools = @(
    @{ name = 'screenshot'; run = 'Invoke-Screenshot'; description = "Take a picture of the main screen of the user's computer."; properties = @{}; required = @() },
    @{ name = 'click'; run = 'Invoke-Click'; description = 'Click the mouse at a position on the screen.'
       properties = (With $Spot @{ button = @{ type = 'string'; enum = @('left', 'right', 'middle'); description = 'default left' }
                                   count = @{ type = 'integer'; enum = @(1, 2, 3); description = '2 for a double click; default 1' } })
       required = @('x', 'y') },
    @{ name = 'move_pointer'; run = 'Invoke-Move'; description = 'Move the mouse pointer to a position on the screen without clicking.'; properties = $Spot; required = @('x', 'y') },
    @{ name = 'drag'; run = 'Invoke-Drag'; description = 'Press the left mouse button at one position, move to another and let go.'
       properties = @{ from_x = (Number 'start, pixels from the left'); from_y = (Number 'start, pixels from the top')
                       to_x = (Number 'end, pixels from the left'); to_y = (Number 'end, pixels from the top') }
       required = @('from_x', 'from_y', 'to_x', 'to_y') },
    @{ name = 'scroll'; run = 'Invoke-Scroll'; description = 'Turn the mouse wheel at a position on the screen.'
       properties = (With $Spot @{ down = @{ type = 'integer'; description = 'wheel steps to scroll down; negative scrolls up' }
                                   right = @{ type = 'integer'; description = 'wheel steps to scroll right; negative scrolls left' } })
       required = @('x', 'y') },
    @{ name = 'type_text'; run = 'Invoke-Type'; description = 'Enter text into whatever has the keyboard focus.'
       properties = @{ text = @{ type = 'string'; description = 'the text to type' } }; required = @('text') },
    @{ name = 'press_key'; run = 'Invoke-Key'; description = 'Press one key, alone or with modifiers, such as return, escape, ctrl+c or ctrl+shift+tab.'
       properties = @{ keys = @{ type = 'string'; description = 'a key name or character, with any of ctrl, shift, alt, win before it joined by +' } }
       required = @('keys') }
)

function Get-Answer($message) {
    switch ($message.method) {
        'initialize' {
            return @{ protocolVersion = $message.params.protocolVersion; capabilities = @{ tools = @{} }
                      serverInfo = @{ name = 'desktop-control'; version = $Version } }
        }
        'tools/list' {
            return @{ tools = @($Tools | ForEach-Object {
                @{ name = $_.name; description = $_.description
                   inputSchema = @{ type = 'object'; properties = $_.properties; required = $_.required } } }) }
        }
        'tools/call' {
            $tool = $Tools | Where-Object { $_.name -eq $message.params.name } | Select-Object -First 1
            if ($null -eq $tool) { return $null }
            $arguments = if ($null -eq $message.params.arguments) { [pscustomobject]@{} } else { $message.params.arguments }
            try {
                $result = & $tool.run $arguments
            } catch [System.ArgumentException] {
                return @{ content = @(@{ type = 'text'; text = $_.Exception.Message }); isError = $true }
            } catch {
                return @{ content = @(@{ type = 'text'; text = "failed: $($_.Exception.Message)" }); isError = $true }
            }
            if ($result -is [string]) { $result = @(@{ type = 'text'; text = $result }) }
            return @{ content = @($result) }
        }
        'ping' { return @{} }
    }
    return $null
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ($line.Trim().Length -eq 0) { continue }
    $request = $line | ConvertFrom-Json
    if ($null -eq $request.PSObject.Properties['id']) { continue }  # a notification needs no reply
    $result = Get-Answer $request
    $reply = @{ jsonrpc = '2.0'; id = $request.id }
    if ($null -eq $result) { $reply.error = @{ code = -32601; message = 'method not found' } } else { $reply.result = $result }
    [Console]::Out.Write((ConvertTo-Json -InputObject $reply -Depth 20 -Compress) + "`n")
    [Console]::Out.Flush()
}
