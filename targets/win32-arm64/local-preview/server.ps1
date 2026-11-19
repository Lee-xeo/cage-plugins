# An MCP server on standard input and output that opens pages served on this
# computer's loopback address in a Chromium-based browser (Chrome, Edge or
# Chromium) and reads back which tab shows them. The browser runs with its own
# profile folder and is driven through its remote debugging HTTP endpoints, so
# the user's everyday browser profile is left alone. Windows only; it needs
# nothing beyond Windows PowerShell.
$ErrorActionPreference = 'Stop'
$Version = '0.1.0'
$Name = 'local-preview'
$MaxUrl = 2048
# A path set here is used before any browser found on the computer.
$OverrideName = 'LOCAL_PREVIEW_BROWSER'

$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

function Refuse([string]$message) { throw [System.ArgumentException]::new($message) }

function Get-Browsers {
    $found = @()
    $override = [Environment]::GetEnvironmentVariable($OverrideName)
    if ($override -and $override.Trim()) { $found += $override.Trim() }
    $relative = @('Google\Chrome\Application\chrome.exe', 'Microsoft\Edge\Application\msedge.exe', 'Chromium\Application\chrome.exe')
    foreach ($path in $relative) {
        foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
            if ($root) { $found += (Join-Path $root $path) }
        }
    }
    # Where installers register the program, wherever it was put.
    foreach ($exe in @('chrome.exe', 'msedge.exe')) {
        foreach ($hive in @('HKCU:', 'HKLM:')) {
            $key = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe"
            try { $value = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).'(default)'; if ($value) { $found += $value.Trim('"') } } catch { }
        }
    }
    return $found
}

function Find-Browser {
    foreach ($path in Get-Browsers) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    }
    $override = [Environment]::GetEnvironmentVariable($OverrideName)
    if ($override -and $override.Trim()) { Refuse "$override is not a program that can be run." }
    Refuse "No Chrome, Edge or Chromium browser was found on this computer. Install one of them, or set $OverrideName to the path of a Chromium-based browser."
}

function Get-ProfileFolder {
    $root = $env:LOCALAPPDATA
    if (-not $root) { $root = Join-Path $HOME '.local/share' }
    return (Join-Path (Join-Path $root $Name) 'browser')
}

$script:Port = $null
$script:LastTab = $null

function Invoke-Browser([string]$path, [string]$method = 'GET', [int]$timeout = 3000) {
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$($script:Port)$path")
    $request.Method = $method
    $request.Timeout = $timeout
    # The debugging endpoints are on this computer; never ask a proxy.
    $request.Proxy = $null
    $response = $request.GetResponse()
    try {
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), $utf8)
        $text = $reader.ReadToEnd()
    } finally { $response.Close() }
    $value = ConvertFrom-Json -InputObject $text
    return , $value
}

function Test-Port($port) {
    $script:Port = $port
    try { $version = Invoke-Browser '/json/version' 'GET' 1000; return [bool]$version.Browser } catch { return $false }
}

function Get-RunningPort([string]$folder) {
    try {
        $first = @(Get-Content -LiteralPath (Join-Path $folder 'DevToolsActivePort') -ErrorAction Stop)[0]
        $port = [int]$first
    } catch { return $null }
    if (Test-Port $port) { return $port }
    return $null
}

# Makes sure the browser runs. Returns $true when it was started with url open.
function Start-Browser([string]$url) {
    $path = Find-Browser
    $folder = Get-ProfileFolder
    if ($null -ne $script:Port -and (Test-Port $script:Port)) { return $false }
    $port = Get-RunningPort $folder
    if ($port) { $script:Port = $port; return $false }
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    Remove-Item -LiteralPath (Join-Path $folder 'DevToolsActivePort') -Force -ErrorAction SilentlyContinue
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $path
    # The url holds no spaces or quotes, and a folder name cannot hold quotes.
    $info.Arguments = "`"--user-data-dir=$folder`" --remote-debugging-port=0 --no-first-run --no-default-browser-check --new-window $url"
    # Started by the shell, the browser does not inherit this server's
    # standard input and output, which carry the MCP messages.
    $info.UseShellExecute = $true
    try { $process = [System.Diagnostics.Process]::Start($info) }
    catch { Refuse "The browser at $path could not be started: $($_.Exception.Message)" }
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        $port = Get-RunningPort $folder
        if ($port) { $script:Port = $port; $script:LastTab = $null; return $true }
        if ($null -ne $process -and $process.HasExited -and $process.ExitCode -ne 0) {
            Refuse "The browser at $path stopped before it was ready (exit status $($process.ExitCode))."
        }
        Start-Sleep -Milliseconds 100
    }
    Refuse "The browser at $path did not become ready within 20 seconds."
}

function Get-Pages {
    $list = Invoke-Browser '/json/list'
    return @(@($list) | Where-Object { $_.type -eq 'page' })
}

# A page without a title of its own is listed under its address.
function Test-Untitled($tab) {
    $url = [string]$tab.url
    $bare = $url
    $at = $url.IndexOf('://')
    if ($at -ge 0) { $bare = $url.Substring($at + 3) }
    $title = [string]$tab.title
    return ($title -ceq $url -or $title -ceq $bare -or $title -ceq $bare.TrimEnd('/') -or $url -eq 'about:blank')
}

# The tab once its page has a title of its own, or as it is after a few seconds.
function Wait-Tab([string]$id) {
    $deadline = (Get-Date).AddSeconds(3)
    while ($true) {
        $tab = Get-Pages | Where-Object { $_.id -eq $id } | Select-Object -First 1
        if ($null -eq $tab -or ($tab.title -and -not (Test-Untitled $tab)) -or (Get-Date) -gt $deadline) { return $tab }
        Start-Sleep -Milliseconds 100
    }
}

function Get-FirstPage {
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
        $pages = Get-Pages
        if ($pages.Count -gt 0) {
            $tab = Wait-Tab $pages[0].id
            if ($null -eq $tab) { $tab = $pages[0] }
            return $tab
        }
        Start-Sleep -Milliseconds 100
    }
    Refuse 'The browser started, but its tab could not be found.'
}

function Get-Description($tab) {
    return [ordered]@{ id = [string]$tab.id; title = [string]$tab.title; url = [string]$tab.url }
}

function Test-Url($url) {
    if ($url -isnot [string] -or $url.Length -eq 0) { Refuse 'url is required.' }
    if ($url.Length -gt $MaxUrl) { Refuse "url must be at most $MaxUrl characters." }
    if ($url -match '[\s"\\\x00-\x1f\x7f]') { Refuse 'url must not contain spaces, quotes, backslashes or control characters.' }
    if ($url -inotmatch '^(https?)://([^/?#]*)') { Refuse 'url must start with http:// or https://.' }
    $authority = $Matches[2]
    if ($authority.Contains('@')) { Refuse 'url must not contain a user name or password.' }
    if ($authority -inotmatch '^(127\.0\.0\.1|localhost|\[::1\])(:(\d*))?$') {
        if ($authority -imatch '^(127\.0\.0\.1|localhost|\[::1\]):') { Refuse 'url has a port that is not a number from 1 to 65535.' }
        Refuse 'Only pages on 127.0.0.1, localhost or [::1] can be opened.'
    }
    $port = $Matches[3]
    if ($port -and ($port.Length -gt 5 -or [int]$port -lt 1 -or [int]$port -gt 65535)) { Refuse 'url has a port that is not a number from 1 to 65535.' }
}

function Invoke-OpenPage($arguments) {
    $extra = @($arguments.PSObject.Properties | ForEach-Object { $_.Name } | Where-Object { $_ -ne 'url' })
    if ($extra.Count) { Refuse "open_page takes only url, not $($extra -join ', ')." }
    $url = $arguments.url
    Test-Url $url
    try {
        if (Start-Browser $url) {
            # The first window opened with the page as its only tab.
            $tab = Get-FirstPage
        } else {
            $created = Invoke-Browser ('/json/new?' + [Uri]::EscapeDataString($url)) 'PUT'
            try { Invoke-Browser ('/json/activate/' + $created.id) | Out-Null } catch { }  # only brings the tab to the front
            $tab = Wait-Tab $created.id
            if ($null -eq $tab) { $tab = $created }
        }
    } catch [System.Net.WebException] {
        Refuse "The browser did not answer: $($_.Exception.Message)"
    }
    $script:LastTab = [string]$tab.id
    return Get-Description $tab
}

function Invoke-ReadTab($arguments) {
    $extra = @($arguments.PSObject.Properties | ForEach-Object { $_.Name } | Where-Object { $_ -ne 'id' })
    if ($extra.Count) { Refuse "read_tab takes only id, not $($extra -join ', ')." }
    $id = $arguments.id
    if ($null -ne $id -and ($id -isnot [string] -or $id -cnotmatch '^[A-Za-z0-9_-]{1,64}$')) { Refuse 'id must be a tab id returned by open_page.' }
    if (-not $id) { $id = $script:LastTab }
    if (-not $id) { Refuse 'No tab has been opened yet; open a page with open_page first.' }
    $null = Find-Browser
    if (-not ($null -ne $script:Port -and (Test-Port $script:Port)) -and -not (Get-RunningPort (Get-ProfileFolder))) {
        Refuse 'The browser is not running; open the page again with open_page.'
    }
    try {
        $tab = Get-Pages | Where-Object { $_.id -eq $id } | Select-Object -First 1
    } catch [System.Net.WebException] {
        Refuse "The browser did not answer: $($_.Exception.Message)"
    }
    if ($null -eq $tab) { Refuse 'That tab has been closed; open the page again with open_page.' }
    return Get-Description $tab
}

$Tools = @(
    [ordered]@{ name = 'open_page'
       description = "Open a page served on this computer at 127.0.0.1, localhost or [::1] in a browser window on this computer, and return the tab's id, title and address once it has loaded."
       inputSchema = [ordered]@{ type = 'object'
           properties = @{ url = [ordered]@{ type = 'string'; maxLength = $MaxUrl; description = 'http or https address on 127.0.0.1, localhost or [::1], such as http://localhost:5173/' } }
           required = @('url'); additionalProperties = $false } },
    [ordered]@{ name = 'read_tab'
       description = 'Return the id, title and address that a browser tab opened by open_page shows now.'
       inputSchema = [ordered]@{ type = 'object'
           properties = @{ id = [ordered]@{ type = 'string'; maxLength = 64; description = 'tab id returned by open_page; default the tab opened most recently' } }
           additionalProperties = $false } }
)
$Run = @{ open_page = 'Invoke-OpenPage'; read_tab = 'Invoke-ReadTab' }

function Get-Answer($message) {
    switch ($message.method) {
        'initialize' {
            return @{ protocolVersion = $message.params.protocolVersion; capabilities = @{ tools = @{} }
                      serverInfo = @{ name = $Name; version = $Version } }
        }
        'tools/list' { return @{ tools = $Tools } }
        'tools/call' {
            $run = $Run[[string]$message.params.name]
            if ($null -eq $run) { return $null }
            $arguments = $message.params.arguments
            if ($null -eq $arguments) { $arguments = [pscustomobject]@{} }
            try {
                if ($arguments -isnot [System.Management.Automation.PSCustomObject]) { Refuse 'arguments must be an object.' }
                $tab = & $run $arguments
            } catch [System.ArgumentException] {
                return @{ content = @(@{ type = 'text'; text = $_.Exception.Message }); isError = $true }
            } catch {
                return @{ content = @(@{ type = 'text'; text = "failed: $($_.Exception.Message)" }); isError = $true }
            }
            return @{ content = @(@{ type = 'text'; text = (ConvertTo-Json -InputObject $tab -Compress) }) }
        }
        'ping' { return @{} }
    }
    return $null
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ($line.Trim().Length -eq 0) { continue }
    try { $request = $line | ConvertFrom-Json } catch { continue }
    if ($null -eq $request -or $null -eq $request.PSObject.Properties['id']) { continue }  # a notification needs no reply
    $result = Get-Answer $request
    $reply = @{ jsonrpc = '2.0'; id = $request.id }
    if ($null -eq $result) { $reply.error = @{ code = -32601; message = 'method not found' } } else { $reply.result = $result }
    [Console]::Out.Write((ConvertTo-Json -InputObject $reply -Depth 20 -Compress) + "`n")
    [Console]::Out.Flush()
}
