param(
    [string]$CallerThread = $env:CODEX_THREAD_ID,
    [string]$PipePath = $env:CODEX_APP_TOOLS_PIPE_PATH,
    [int]$Port = 43127,
    [string]$StateDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'runtime')
)
. (Join-Path $PSScriptRoot 'bridge-paths.ps1')
$ErrorActionPreference = 'Stop'
$StateDirectory = [IO.Path]::GetFullPath($StateDirectory)
New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
if (-not $CallerThread) {
    $previousConnection = Join-Path $StateDirectory 'connection.json'
    if (Test-Path -LiteralPath $previousConnection) { $CallerThread = (Get-Content -LiteralPath $previousConnection -Raw | ConvertFrom-Json).callerThread }
}
if (-not $CallerThread) { throw 'Provide -CallerThread with the dispatcher chat ID.' }
$connectionPath = Join-Path $StateDirectory 'connection.json'
if (Test-Path -LiteralPath $connectionPath) {
    $existing = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
    try {
        $health = Invoke-RestMethod -Uri "$($existing.baseUrl)/health" -Headers @{Authorization="Bearer $($existing.token)"} -TimeoutSec 2
        if ($health.ok -and $existing.baseUrl -eq "http://127.0.0.1:$Port") {
            Write-Output "Bridge already running: PID $($existing.pid), port $Port."
            return
        }
    } catch { }
}
$arguments = @((SourceFile 'bridge.mjs'), '--state', $StateDirectory, '--port', $Port, '--caller-thread', $CallerThread)
if ($PipePath) { $arguments += @('--pipe', $PipePath) }
# Start-Process joins arguments into a Windows command line; quote paths explicitly.
$quotedArguments = $arguments | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }
$process = Start-Process -FilePath (Get-Command node).Source -ArgumentList $quotedArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $StateDirectory 'server.stdout.log') -RedirectStandardError (Join-Path $StateDirectory 'server.stderr.log')
for ($attempt = 0; $attempt -lt 50; $attempt++) {
    Start-Sleep -Milliseconds 100
    $process.Refresh()
    if ($process.HasExited) { throw "Bridge failed to start. Read $(Join-Path $StateDirectory 'server.stderr.log')" }
    if (Test-Path -LiteralPath $connectionPath) {
        $current = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
        if ($current.pid -eq $process.Id) {
            Write-Output "Bridge ready: PID $($process.Id), port $Port."
            return
        }
    }
}
throw 'Bridge startup not confirmed within five seconds; inspect logs before retrying.'
