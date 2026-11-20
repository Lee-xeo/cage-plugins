# A complete plugin: an MCP server on standard input and output with one
# tool. It needs nothing beyond Windows PowerShell.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

$Tools = @(@{
    name = 'current_time'
    description = "Return the current local date and time on the user's computer."
    inputSchema = @{ type = 'object'; properties = @{} }
})

function Get-Answer($message) {
    switch ($message.method) {
        'initialize' {
            return @{ protocolVersion = $message.params.protocolVersion; capabilities = @{ tools = @{} }
                      serverInfo = @{ name = 'clock'; version = '0.1.3' } }
        }
        'tools/list' { return @{ tools = $Tools } }
        'tools/call' {
            if ($message.params.name -ne 'current_time') { return $null }
            # The same form as elsewhere: 2026-01-31T09:05:00+08:00.
            $now = [DateTimeOffset]::Now.ToString("yyyy-MM-dd'T'HH:mm:sszzz", [Globalization.CultureInfo]::InvariantCulture)
            return @{ content = @(@{ type = 'text'; text = $now }) }
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
    [Console]::Out.Write((ConvertTo-Json -InputObject $reply -Depth 10 -Compress) + "`n")
    [Console]::Out.Flush()
}
