param([switch]$RelayOnly)
. (Join-Path $PSScriptRoot 'bridge-paths.ps1')
$ErrorActionPreference = 'Stop'
$runtimeDirectory = Join-Path $ProjectRoot 'runtime'
function Start-ClaudeBridgeProcess([string]$ScriptName, [string]$RuntimeName) {
    $processDirectory = Join-Path $runtimeDirectory $RuntimeName
    New-Item -ItemType Directory -Path $processDirectory -Force | Out-Null
    $connectionPath = Join-Path $processDirectory 'connection.json'
    if (Test-Path -LiteralPath $connectionPath) {
        $existingConnection = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
        try {
            $health = Invoke-RestMethod -Uri "$($existingConnection.baseUrl)/health" -Headers @{Authorization="Bearer $($existingConnection.token)"} -TimeoutSec 2
            if ($health.ok) { Write-Output "$RuntimeName already running (PID $($existingConnection.pid))."; return }
        } catch { }
    }
    $scriptPath = SourceFile $ScriptName
    $process = Start-Process -FilePath (Get-Command node).Source -ArgumentList ('"' + $scriptPath + '"') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $processDirectory 'stdout.log') -RedirectStandardError (Join-Path $processDirectory 'stderr.log')
    for ($attempt=0; $attempt -lt 600; $attempt++) {
        Start-Sleep -Milliseconds 100
        $process.Refresh()
        if ($process.HasExited) { throw "$RuntimeName failed; inspect its stderr.log." }
        if (Test-Path -LiteralPath $connectionPath) {
            $currentConnection = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
            if ($currentConnection.pid -eq $process.Id) { Write-Output "$RuntimeName ready (PID $($process.Id))."; return }
        }
    }
    throw "$RuntimeName readiness unknown. Do not duplicate; inspect its logs."
}
Start-ClaudeBridgeProcess 'claude-file-relay.mjs' 'claude-relay'
if ($RelayOnly) { return }
$attachDirectory = Join-Path $runtimeDirectory 'claude-attach'
$attachConnectionPath = Join-Path $attachDirectory 'connection.json'
$attachRunning = $false
if (Test-Path -LiteralPath $attachConnectionPath) {
    $attachConnection = Get-Content -LiteralPath $attachConnectionPath -Raw | ConvertFrom-Json
    $attachProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($attachConnection.pid)"
    $attachRunning = $attachProcess -and $attachProcess.CommandLine.Contains((SourceFile 'claude-autoattach.py'))
}
if ($attachRunning) { Write-Output "Claude auto-attach already running (PID $($attachConnection.pid))." }
else {
    New-Item -ItemType Directory -Path $attachDirectory -Force | Out-Null
    $pythonPath = (Get-Command python).Source
    & $pythonPath -c 'import frida' 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'The selected Python needs frida. Install the version in claude-attach-compatibility.json.' }
    $attachArguments = @((SourceFile 'claude-autoattach.py'))
    $claudePackage = Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1
    if ($claudePackage) {
        $applicationPath = Join-Path $claudePackage.InstallLocation 'app/Claude.exe'
        if (Test-Path -LiteralPath $applicationPath) { $attachArguments += @('--launch', $applicationPath) }
    }
    $quotedArguments = $attachArguments | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }
    $attachProcess = Start-Process -FilePath $pythonPath -ArgumentList $quotedArguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $attachDirectory 'stdout.log') -RedirectStandardError (Join-Path $attachDirectory 'stderr.log')
    for ($attempt=0; $attempt -lt 100; $attempt++) {
        Start-Sleep -Milliseconds 100
        $attachProcess.Refresh()
        if ($attachProcess.HasExited) { throw 'Claude auto-attach failed; inspect runtime/claude-attach/stderr.log.' }
        if ((Test-Path -LiteralPath $attachConnectionPath) -and ((Get-Content -LiteralPath $attachConnectionPath -Raw | ConvertFrom-Json).pid -eq $attachProcess.Id)) { break }
    }
    Write-Output "Claude auto-attach running (PID $($attachProcess.Id))."
}
Start-ClaudeBridgeProcess 'claude-bridge.mjs' 'claude'
