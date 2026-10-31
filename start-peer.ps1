$ErrorActionPreference = 'Stop'
$supervisorConfig = Join-Path $PSScriptRoot 'runtime/supervisor/config.json'
if (Test-Path -LiteralPath $supervisorConfig) {
    $managed = Get-Content -LiteralPath $supervisorConfig -Raw | ConvertFrom-Json
    $task = Get-ScheduledTask -TaskName $managed.taskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -ne 'Disabled') {
        Start-ScheduledTask -TaskName $managed.taskName
        for ($attempt=0;$attempt -lt 80;$attempt++) {
            try {
                $connection = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime/router/connection.json') -Raw | ConvertFrom-Json
                $health = Invoke-RestMethod -Uri "$($connection.baseUrl)/health" -Headers @{Authorization="Bearer $($connection.token)"} -TimeoutSec 1
                if ($health.ok) { Write-Output 'Desktop peer bridge is managed by Windows startup supervision.'; return }
            } catch { }
            Start-Sleep -Milliseconds 250
        }
        throw 'Windows bridge supervision is still starting; inspect runtime/supervisor/state.json.'
    }
}
& (Join-Path $PSScriptRoot 'start.ps1')
& (Join-Path $PSScriptRoot 'start-codex-mcp.ps1')
& (Join-Path $PSScriptRoot 'start-claude.ps1')
$directory = Join-Path $PSScriptRoot 'runtime/router'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$connectionPath = Join-Path $directory 'connection.json'
if (Test-Path -LiteralPath $connectionPath) {
    $connection = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
    try {
        $health = Invoke-RestMethod -Uri "$($connection.baseUrl)/health" -Headers @{Authorization="Bearer $($connection.token)"} -TimeoutSec 2
        if ($health.ok) { Write-Output "Desktop peer router already running (PID $($connection.pid))."; return }
    } catch { }
}
$scriptPath = Join-Path $PSScriptRoot 'peer-router.mjs'
$process = Start-Process -FilePath (Get-Command node).Source -ArgumentList ('"'+$scriptPath+'"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $directory 'stdout.log') -RedirectStandardError (Join-Path $directory 'stderr.log')
for ($attempt=0; $attempt -lt 100; $attempt++) {
    Start-Sleep -Milliseconds 100
    $process.Refresh()
    if ($process.HasExited) { throw 'Peer router failed; inspect runtime/router/stderr.log.' }
    if ((Test-Path -LiteralPath $connectionPath) -and ((Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json).pid -eq $process.Id)) { Write-Output "Desktop peer router ready (PID $($process.Id))."; return }
}
throw 'Peer router startup outcome unknown; inspect logs before retrying.'
