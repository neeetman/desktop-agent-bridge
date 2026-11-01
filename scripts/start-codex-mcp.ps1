. (Join-Path $PSScriptRoot 'bridge-paths.ps1')
$ErrorActionPreference = 'Stop'
$directory = Join-Path $ProjectRoot 'runtime/codex-mcp'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$connectionPath = Join-Path $directory 'connection.json'
$scriptPath = SourceFile 'codex-mcp-autoattach.py'
if (Test-Path -LiteralPath $connectionPath) {
    $connection = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.pid)"
    if ($process -and $process.CommandLine.Contains($scriptPath)) { Write-Output "Codex MCP auto-reload monitor already running (PID $($connection.pid))."; return }
}
$process = Start-Process -FilePath (Get-Command python).Source -ArgumentList ('"'+$scriptPath+'"') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $directory 'stdout.log') -RedirectStandardError (Join-Path $directory 'stderr.log')
for ($attempt=0;$attempt -lt 100;$attempt++) {
    Start-Sleep -Milliseconds 100
    $process.Refresh()
    if ($process.HasExited) { throw 'Codex MCP monitor failed; inspect runtime/codex-mcp/stderr.log.' }
    if ((Test-Path -LiteralPath $connectionPath) -and ((Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json).pid -eq $process.Id)) { Write-Output "Codex MCP auto-reload monitor ready (PID $($process.Id))."; return }
}
throw 'Codex MCP monitor readiness unknown; inspect logs before retrying.'
