. (Join-Path $PSScriptRoot 'bridge-paths.ps1')
$ErrorActionPreference = 'Stop'
$configPath = Join-Path $ProjectRoot 'runtime/supervisor/config.json'
if (-not (Test-Path -LiteralPath $configPath)) { return }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
# Disable recovery before stopping its main task, so the watchdog cannot undo an explicit uninstall.
foreach ($name in @($config.watchdogTaskName,$config.taskName)) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) { continue }
    if ($task.Description -notlike 'Desktop Session Bridge*') { throw "Task belongs to a different application: $name" }
    Disable-ScheduledTask -TaskName $name | Out-Null
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
Write-Output 'User-logon startup and recovery tasks removed. Bridge state and backups were retained.'
