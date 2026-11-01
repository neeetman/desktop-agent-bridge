param([switch]$NoStart, [switch]$WithoutDeepSeek)
. (Join-Path $PSScriptRoot 'bridge-paths.ps1')
$ErrorActionPreference = 'Stop'
$directory = Join-Path $ProjectRoot 'runtime/supervisor'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$suffix = $sid.Split('-')[-1]
$taskName = "DesktopSessionBridge-$suffix"
$watchdogName = "$taskName-Watchdog"
$nodePath = (Get-Command node).Source
$pythonPath = (Get-Command python).Source
$pythonwPath = Join-Path (Split-Path $pythonPath) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonwPath)) { throw 'pythonw.exe is required for console-free startup.' }
& $pythonPath -c 'import frida' 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Python must have the validated Frida dependency installed.' }
$powershellPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$codexPackage = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
$claudePackage = Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1
if (-not $codexPackage -or -not $claudePackage) { throw 'Both installed desktop packages are required.' }
$connection = Get-Content -LiteralPath (Join-Path $ProjectRoot 'runtime/connection.json') -Raw | ConvertFrom-Json
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
$config = [ordered]@{version=1;taskName=$taskName;watchdogTaskName=$watchdogName;userSid=$sid;node=$nodePath;python=$pythonPath;pythonw=$pythonwPath;powershell=$powershellPath;codexHome=$codexHome;callerThread=$connection.callerThread;apps=@{codex=@{executable=(Join-Path $codexPackage.InstallLocation 'app/ChatGPT.exe')};claude=@{executable=(Join-Path $claudePackage.InstallLocation 'app/Claude.exe')}}}
$deepseekExecutable = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/DeepSeek Harness.exe'
if (-not $WithoutDeepSeek -and (Test-Path -LiteralPath $deepseekExecutable)) { $config.apps.deepseek = @{executable=$deepseekExecutable} }
$configPath = Join-Path $directory 'config.json'
if (Test-Path -LiteralPath $configPath) { Copy-Item -LiteralPath $configPath -Destination (Join-Path $directory 'config.previous.json') -Force }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($configPath,($config | ConvertTo-Json -Depth 8),$utf8)
$escape = { param($value) [Security.SecurityElement]::Escape([string]$value) }
$runner = SourceFile 'supervisor-task.pyw'
$backup = Join-Path $directory ('task-backups/' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($name in @($taskName,$watchdogName)) {
    $old = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($old) {
        if ($old.Description -notlike 'Desktop Session Bridge*') { throw "Task name is owned by a different application: $name" }
        [IO.File]::WriteAllText((Join-Path $backup ($name+'.xml')),(Export-ScheduledTask -TaskName $name),$utf8)
    }
}
function TaskXml([bool]$Watchdog) {
    $arguments = '"' + $runner + '"' + $(if ($Watchdog) { ' --watchdog' } else { '' })
    $delay = if ($Watchdog) {'PT30S'} else {'PT10S'}
    $repeat = if ($Watchdog) {
        '<TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>' + (Get-Date).AddSeconds(45).ToString('s') + '</StartBoundary><Enabled>true</Enabled></TimeTrigger>'
    } else {''}
    @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Desktop Session Bridge: per-user startup and automatic recovery</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$(& $escape $sid)</UserId><Delay>$delay</Delay></LogonTrigger>$repeat</Triggers>
  <Principals><Principal id="Author"><UserId>$(& $escape $sid)</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
  <Actions Context="Author"><Exec><Command>$(& $escape $pythonwPath)</Command><Arguments>$(& $escape $arguments)</Arguments><WorkingDirectory>$(& $escape $ProjectRoot)</WorkingDirectory></Exec></Actions>
</Task>
"@
}
$mainXml = TaskXml $false
$watchXml = TaskXml $true
[IO.File]::WriteAllText((Join-Path $directory 'supervisor-task.xml'),$mainXml,$utf8)
[IO.File]::WriteAllText((Join-Path $directory 'watchdog-task.xml'),$watchXml,$utf8)
Register-ScheduledTask -TaskName $taskName -Xml $mainXml -Force | Out-Null
Register-ScheduledTask -TaskName $watchdogName -Xml $watchXml -Force | Out-Null
$proof = [ordered]@{installedAt=(Get-Date).ToUniversalTime().ToString('o');taskName=$taskName;watchdogTaskName=$watchdogName;userSid=$sid;logonType='InteractiveToken';runLevel='LeastPrivilege';passwordStored=$false;backupDirectory=$backup}
[IO.File]::WriteAllText((Join-Path $directory 'installation.json'),($proof | ConvertTo-Json),$utf8)
if (-not $NoStart) { Start-ScheduledTask -TaskName $taskName }
Write-Output "Installed user-logon startup: $taskName; recovery watchdog: $watchdogName."
