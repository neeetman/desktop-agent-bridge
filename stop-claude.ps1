$ErrorActionPreference = 'Stop'
$attachConnectionPath = Join-Path $PSScriptRoot 'runtime/claude-attach/connection.json'
if (Test-Path -LiteralPath $attachConnectionPath) {
    $attachConnection = Get-Content -LiteralPath $attachConnectionPath -Raw | ConvertFrom-Json
    $attachProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($attachConnection.pid)"
    if ($attachProcess -and $attachProcess.CommandLine.Contains((Join-Path $PSScriptRoot 'claude-autoattach.py'))) {
        Stop-Process -Id $attachConnection.pid
        Write-Output "Claude auto-attach stopped (PID $($attachConnection.pid))."
    } elseif ($attachProcess) { throw 'Auto-attach PID belongs to a different process; refusing to stop it.' }
}
foreach ($runtimeName in @('claude', 'claude-relay')) {
    $connectionPath = Join-Path $PSScriptRoot "runtime/$runtimeName/connection.json"
    if (-not (Test-Path -LiteralPath $connectionPath)) { continue }
    $connection = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.pid)"
    $scriptName = if ($runtimeName -eq 'claude') {'claude-bridge.mjs'} else {'claude-file-relay.mjs'}
    $expectedScript = Join-Path $PSScriptRoot $scriptName
    $normalizedCommand = if ($process) { $process.CommandLine.Replace('/', '\') } else { '' }
    $scriptMatches = $normalizedCommand -match ('(?:"|\s)' + [regex]::Escape($expectedScript) + '(?:"|\s|$)')
    if ($process -and $process.Name -eq 'node.exe' -and ($scriptMatches -or ($process.CommandLine -match ('^.*node(?:\.exe)?"?\s+' + [regex]::Escape($scriptName) + '$')))) {
        Stop-Process -Id $connection.pid
        Write-Output "$runtimeName stopped (PID $($connection.pid))."
    } elseif ($process) { throw "PID $($connection.pid) no longer belongs to $scriptName; refusing to stop it." }
}
