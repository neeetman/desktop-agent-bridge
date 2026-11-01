param([string]$StateDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'runtime'))
. (Join-Path $PSScriptRoot 'bridge-paths.ps1')
$ErrorActionPreference = 'Stop'
$connectionPath = Join-Path $StateDirectory 'connection.json'
if (-not (Test-Path -LiteralPath $connectionPath)) { Write-Output 'No bridge connection file.'; return }
$connection = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
$bridgeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$connection.pid)"
if (-not $bridgeProcess) { Write-Output 'Bridge is already stopped.'; return }
$scriptPath = SourceFile 'bridge.mjs'
if (-not $bridgeProcess.CommandLine.Replace('\','/').Contains($scriptPath.Replace('\','/'))) { throw 'PID belongs to a different process; refusing to stop it.' }
Stop-Process -Id $connection.pid
Write-Output "Stopped bridge PID $($connection.pid). State and event journal retained."
