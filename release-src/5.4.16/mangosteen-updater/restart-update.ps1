[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VaultPath,

    [Parameter(Mandatory = $true)]
    [int]$WaitProcessId,

    [string]$ObsidianExecutable = '',

    [switch]$SkipRelaunch,

    [switch]$SkipProgressUi
)

$ErrorActionPreference = 'Stop'
$updaterRoot = Join-Path $VaultPath '.mangosteen-updater'
$stagingRoot = Join-Path $updaterRoot 'staging'
$extractedRoot = Join-Path $stagingRoot 'extracted'
$pluginsRoot = Join-Path $VaultPath '.obsidian\plugins'
$backupRoot = Join-Path $updaterRoot 'backup'
$resultPath = Join-Path $updaterRoot 'result.json'
$progressStatusPath = Join-Path $updaterRoot 'progress.json'
$pluginIds = @('mangosteen-media-core', 'mangosteen-claudian', 'mangosteen-image', 'mangosteen-video', 'mangosteen-workbench', 'mangosteen-updater')
$legacyPluginIds = @('mangosteen-agent')
$communityPath = Join-Path $VaultPath '.obsidian\community-plugins.json'
$communityBackupPath = Join-Path $backupRoot 'community-plugins.json'
$journalPath = Join-Path $backupRoot 'journal.json'
$journal = New-Object System.Collections.ArrayList
$communityExisted = $false
$backupReady = $false
$relaunchStarted = $false
$obsidianExecutableHint = $null

function Wait-ForObsidianExit {
    param([ValidateRange(10, 300)][int]$TimeoutSeconds = 120)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while (@(Get-Process -Name 'Obsidian' -ErrorAction SilentlyContinue).Count -gt 0) {
        if ((Get-Date) -ge $deadline) { throw 'OBSIDIAN_EXIT_TIMEOUT：请关闭全部 Obsidian 窗口后重新更新。' }
        Set-UpdateStatus -State 'waiting' -Message '正在等待 Obsidian 完全退出，请勿手动重新打开…'
        Start-Sleep -Milliseconds 300
    }
}

function Get-FreeLoopbackPort {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    try { $listener.Start(); return ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
    finally { $listener.Stop() }
}

function Resolve-ObsidianExecutable {
    $candidates = @(
        $ObsidianExecutable,
        $script:obsidianExecutableHint,
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\Obsidian\Obsidian.exe' }),
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Obsidian\Obsidian.exe' }),
        $(if ($env:ProgramW6432) { Join-Path $env:ProgramW6432 'Obsidian\Obsidian.exe' }),
        $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Obsidian\Obsidian.exe' })
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    if ($candidates) { return [string]($candidates | Select-Object -First 1) }
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Obsidian.exe')
        if ($key) {
            try {
                $candidate = [string]$key.GetValue('', '')
                if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
            } finally { $key.Dispose() }
        }
    } catch { }
    return $null
}

function Resolve-NodeExecutable {
    $candidates = @(
        $(if ($env:ProgramW6432) { Join-Path $env:ProgramW6432 'nodejs\node.exe' }),
        $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'nodejs\node.exe' })
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    if ($candidates) { return [string]($candidates | Select-Object -First 1) }
    $command = Get-Command 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return [string]$command.Source }
    return $null
}

function Start-PostUpdateActivation {
    $activator = Join-Path $PSScriptRoot 'post-update-activation.cjs'
    if (-not (Test-Path -LiteralPath $activator -PathType Leaf)) { throw 'POST_UPDATE_ACTIVATOR_MISSING' }
    $obsidian = Resolve-ObsidianExecutable
    if (-not $obsidian) { throw 'OBSIDIAN_EXECUTABLE_MISSING' }
    $node = Resolve-NodeExecutable
    if (-not $node) { throw 'NODE_EXECUTABLE_MISSING' }
    $port = Get-FreeLoopbackPort
    $uri = 'obsidian://open?path=' + [Uri]::EscapeDataString($VaultPath)
    Set-UpdateStatus -State 'activating' -Message '更新完成，正在启动 Obsidian 并自动开启山竹插件…'
    $started = Start-Process -FilePath $obsidian -ArgumentList @("--remote-debugging-port=$port", $uri) -PassThru
    if (-not $started -or $started.Id -le 0) { throw 'OBSIDIAN_RELAUNCH_FAILED' }
    $script:relaunchStarted = $true
    $output = @(& $node $activator $port $VaultPath 90 ($pluginIds -join ',') 2>&1)
    if ($LASTEXITCODE -ne 0) { throw ('PLUGIN_AUTO_ENABLE_FAILED：' + (($output | ForEach-Object { [string]$_ }) -join ' ')) }
    $confirmation = (($output | ForEach-Object { [string]$_ }) -join '').Trim() | ConvertFrom-Json
    if ([string]$confirmation.status -ne 'ok' -or -not [bool]$confirmation.enabled -or @($confirmation.missingPlugins).Count -gt 0) {
        throw ('PLUGIN_AUTO_ENABLE_FAILED：' + ($confirmation | ConvertTo-Json -Compress -Depth 5))
    }
    return $confirmation
}

function Write-ActivationDiagnostic {
    param([string]$Detail)
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop -or -not (Test-Path -LiteralPath $desktop)) { $desktop = $VaultPath }
    $diagnostic = Join-Path $desktop ("Mangosteen-Update-Warning-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    @(
        "时间：$((Get-Date).ToString('s'))",
        "版本：$version",
        '结果：插件文件已更新，但自动启用没有通过最终校验。',
        "原因：$Detail",
        '处理：请保持 Obsidian 打开，把本文件发给售后老师。不要重复安装或删除知识库。'
    ) | Set-Content -LiteralPath $diagnostic -Encoding UTF8
    return $diagnostic
}

function Set-UpdateStatus {
    param([string]$State, [string]$Message)
    if ($SkipProgressUi) { return }
    New-Item -ItemType Directory -Path $updaterRoot -Force | Out-Null
    $temporary = "$progressStatusPath.tmp"
    [ordered]@{ state = $State; message = $Message; time = (Get-Date).ToString('s') } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $progressStatusPath -Force
}

function Start-UpdateProgressWindow {
    if ($SkipProgressUi) { return }
    $progressScript = Join-Path $PSScriptRoot 'update-progress.ps1'
    if (-not (Test-Path -LiteralPath $progressScript)) { return }
    Set-UpdateStatus -State 'waiting' -Message '正在关闭后台服务，请勿手动重新打开 Obsidian…'
    $escapedScript = $progressScript.Replace("'", "''")
    $escapedStatus = $progressStatusPath.Replace("'", "''")
    $command = "& '$escapedScript' -StatusPath '$escapedStatus'"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded
    ) -WindowStyle Hidden | Out-Null
}

function Remove-PluginDirectoryWithRetry {
    param([string]$Path, [string]$PluginId)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $deadline = (Get-Date).AddMinutes(2)
    while ($true) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force
            return
        }
        catch {
            if ((Get-Date) -ge $deadline) {
                throw "等待后台服务释放文件超时（2 分钟）：$PluginId；$($_.Exception.Message)"
            }
            Set-UpdateStatus -State 'waiting' -Message '正在等待后台服务完全退出，较慢电脑可能需要 1–2 分钟…'
            Start-Sleep -Seconds 1
        }
    }
}

function Copy-PluginDirectoryWithRetry {
    param([string]$Source, [string]$Destination, [string]$PluginId)
    $deadline = (Get-Date).AddSeconds(30)
    while ($true) {
        try {
            if (Test-Path -LiteralPath $Destination) {
                Remove-PluginDirectoryWithRetry -Path $Destination -PluginId $PluginId
            }
            Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force -ErrorAction Stop
            return
        }
        catch {
            if ((Get-Date) -ge $deadline) {
                throw "安全软件持续阻止写入插件（30 秒）：$PluginId；$($_.Exception.Message)"
            }
            Set-UpdateStatus -State 'waiting' -Message "正在等待安全软件完成扫描：$PluginId…"
            Start-Sleep -Seconds 2
        }
    }
}

function Save-Result {
    param([string]$Status, [string]$Version, [string]$Message, [string]$Diagnostic = '')
    [ordered]@{
        status = $Status
        version = $Version
        message = $Message
        diagnostic = $Diagnostic
        time = (Get-Date).ToString('s')
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultPath -Encoding UTF8
}

function Restore-CommunityPluginList {
    if ($communityExisted) {
        if (-not (Test-Path -LiteralPath $communityBackupPath -PathType Leaf)) {
            throw 'ROLLBACK_COMMUNITY_BACKUP_MISSING'
        }
        try {
            $backupValue = Get-Content -LiteralPath $communityBackupPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($backupValue -isnot [array]) { throw 'not-array' }
        } catch {
            throw 'ROLLBACK_COMMUNITY_BACKUP_INVALID'
        }
        $restoreTemporaryPath = "$communityPath.mangosteen-restore.tmp"
        Copy-Item -LiteralPath $communityBackupPath -Destination $restoreTemporaryPath -Force
        try {
            $restoredValue = Get-Content -LiteralPath $restoreTemporaryPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($restoredValue -isnot [array]) { throw 'ROLLBACK_COMMUNITY_VERIFY_FAILED' }
            Move-Item -LiteralPath $restoreTemporaryPath -Destination $communityPath -Force
        } finally {
            if (Test-Path -LiteralPath $restoreTemporaryPath) {
                Remove-Item -LiteralPath $restoreTemporaryPath -Force
            }
        }
    } elseif (Test-Path -LiteralPath $communityPath) {
        Remove-Item -LiteralPath $communityPath -Force
    }
}

function Restore-Backup {
    for ($index = $journal.Count - 1; $index -ge 0; $index--) {
        $item = $journal[$index]
        $destination = Join-Path $pluginsRoot $item.Id
        if (Test-Path -LiteralPath $destination) {
            Remove-Item -LiteralPath $destination -Recurse -Force
        }
        if ($item.HadOriginal) {
            Copy-Item -LiteralPath (Join-Path (Join-Path $backupRoot 'plugins') $item.Id) -Destination $destination -Recurse -Force
        }
    }
    Restore-CommunityPluginList
}

function Write-RollbackJournal {
    param([ValidateSet('ready', 'applying', 'completed')][string]$State)
    [ordered]@{
        state = $State
        plugins = @($journal)
        communityExisted = $communityExisted
    } | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $journalPath -Encoding UTF8
}

function Recover-InterruptedUpdate {
    if (-not (Test-Path -LiteralPath $journalPath -PathType Leaf)) { return }
    $saved = Get-Content -LiteralPath $journalPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$saved.state -ne 'applying') { return }
    $journal.Clear()
    foreach ($item in @($saved.plugins)) {
        [void]$journal.Add([pscustomobject]@{ Id = [string]$item.Id; HadOriginal = [bool]$item.HadOriginal })
    }
    $script:communityExisted = [bool]$saved.communityExisted
    $script:backupReady = $true
    Restore-Backup
    Remove-Item -LiteralPath $journalPath -Force
    $journal.Clear()
    $script:backupReady = $false
}

$version = ''
Start-UpdateProgressWindow
try {
    if ($WaitProcessId -gt 0) {
        $waitProcess = Get-Process -Id $WaitProcessId -ErrorAction SilentlyContinue
        if ($waitProcess) {
            try {
                $candidateExecutable = [string]$waitProcess.Path
                if ($candidateExecutable -and (Test-Path -LiteralPath $candidateExecutable -PathType Leaf)) {
                    $script:obsidianExecutableHint = $candidateExecutable
                }
            } catch { }
        }
        $deadline = (Get-Date).AddMinutes(2)
        while (Get-Process -Id $WaitProcessId -ErrorAction SilentlyContinue) {
            if ((Get-Date) -ge $deadline) { throw 'Timed out waiting for Obsidian to exit.' }
            Start-Sleep -Milliseconds 250
        }
    }
    Wait-ForObsidianExit -TimeoutSeconds 120
    Recover-InterruptedUpdate
    $manifest = Get-Content -LiteralPath (Join-Path $stagingRoot 'pending.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $version = [string]$manifest.version
    if ($manifest.schemaVersion -ne 2 -or $version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid update manifest.' }

    foreach ($id in $pluginIds) {
        $source = Join-Path $extractedRoot $id
        $pluginManifestPath = Join-Path $source 'manifest.json'
        if (-not (Test-Path -LiteralPath (Join-Path $source 'main.js')) -or -not (Test-Path -LiteralPath $pluginManifestPath)) {
            throw "Missing plugin in update package: $id"
        }
        $pluginManifest = Get-Content -LiteralPath $pluginManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$pluginManifest.id -ne $id -or [string]$pluginManifest.version -ne [string]$manifest.components.$id) {
            throw "Plugin manifest mismatch: $id"
        }
    }

    if (Test-Path -LiteralPath $backupRoot) { Remove-Item -LiteralPath $backupRoot -Recurse -Force }
    Set-UpdateStatus -State 'working' -Message '后台服务已关闭，正在备份当前插件…'
    New-Item -ItemType Directory -Path (Join-Path $backupRoot 'plugins') -Force | Out-Null
    New-Item -ItemType Directory -Path $pluginsRoot -Force | Out-Null

    $communityExisted = Test-Path -LiteralPath $communityPath -PathType Leaf
    if ($communityExisted) { Copy-Item -LiteralPath $communityPath -Destination $communityBackupPath -Force }

    foreach ($id in @($pluginIds + $legacyPluginIds)) {
        $destination = Join-Path $pluginsRoot $id
        $hadOriginal = Test-Path -LiteralPath $destination
        if ($hadOriginal) {
            Copy-Item -LiteralPath $destination -Destination (Join-Path (Join-Path $backupRoot 'plugins') $id) -Recurse -Force
        }
        [void]$journal.Add([pscustomobject]@{ Id = $id; HadOriginal = $hadOriginal })
    }

    Write-RollbackJournal -State 'ready'
    $backupReady = $true
    Write-RollbackJournal -State 'applying'
    Wait-ForObsidianExit -TimeoutSeconds 120

    foreach ($id in $pluginIds) {
        $source = Join-Path $extractedRoot $id
        $destination = Join-Path $pluginsRoot $id
        $hadOriginal = Test-Path -LiteralPath $destination
        Set-UpdateStatus -State 'working' -Message "正在更新插件：$id"
        if ($hadOriginal) { Remove-PluginDirectoryWithRetry -Path $destination -PluginId $id }
        Copy-PluginDirectoryWithRetry -Source $source -Destination $destination -PluginId $id
        $oldData = Join-Path (Join-Path (Join-Path $backupRoot 'plugins') $id) 'data.json'
        if ($hadOriginal -and (Test-Path -LiteralPath $oldData)) {
            Copy-Item -LiteralPath $oldData -Destination (Join-Path $destination 'data.json') -Force
        }
        $installed = Get-Content -LiteralPath (Join-Path $destination 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$installed.id -ne $id -or [string]$installed.version -ne [string]$manifest.components.$id) {
            throw "Installed plugin verification failed: $id"
        }
    }

    $enabled = @()
    if ($communityExisted) {
        $enabledValue = Get-Content -LiteralPath $communityPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($enabledValue -isnot [array]) { throw 'Community plugin list is invalid.' }
        $enabled = @($enabledValue | ForEach-Object { [string]$_ } | Where-Object { $legacyPluginIds -notcontains $_ -and $pluginIds -notcontains $_ })
    }
    $enabled = @($pluginIds + $enabled)
    $communityTemporaryPath = "$communityPath.mangosteen.tmp"
    ConvertTo-Json -InputObject @($enabled) | Set-Content -LiteralPath $communityTemporaryPath -Encoding UTF8
    $verifiedValue = Get-Content -LiteralPath $communityTemporaryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $verifiedEnabled = @()
    foreach ($value in @($verifiedValue)) { $verifiedEnabled += [string]$value }
    $missingEnabledPlugins = @($pluginIds | Where-Object { $verifiedEnabled -notcontains $_ })
    if ($missingEnabledPlugins.Count -gt 0) {
        throw ('COMMUNITY_PLUGIN_ENABLE_VERIFY_FAILED：' + ($missingEnabledPlugins -join ','))
    }
    Move-Item -LiteralPath $communityTemporaryPath -Destination $communityPath -Force

    foreach ($id in $legacyPluginIds) {
        Remove-PluginDirectoryWithRetry -Path (Join-Path $pluginsRoot $id) -PluginId $id
    }

    Write-RollbackJournal -State 'completed'
    $backupReady = $false
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    if ($SkipRelaunch) {
        Save-Result -Status 'success' -Version $version -Message 'Update complete.'
        Set-UpdateStatus -State 'success' -Message '更新完成。'
    } else {
        try {
            [void](Start-PostUpdateActivation)
            Save-Result -Status 'success' -Version $version -Message 'Update complete and plugins enabled.'
            Set-UpdateStatus -State 'success' -Message '更新完成，山竹插件已自动开启。'
        } catch {
            $activationDetail = [string]$_.Exception.Message
            $activationDiagnostic = Write-ActivationDiagnostic -Detail $activationDetail
            Save-Result -Status 'activation_warning' -Version $version -Message $activationDetail -Diagnostic $activationDiagnostic
            Set-UpdateStatus -State 'activation_warning' -Message '插件已更新，但自动开启未完成。请把桌面警告日志发给售后老师。'
        }
    }
}
catch {
    $failure = $_.Exception
    $rollbackError = ''
    if ($backupReady) {
        try {
            Restore-Backup
            if (Test-Path -LiteralPath $journalPath) { Remove-Item -LiteralPath $journalPath -Force }
            $backupReady = $false
        } catch {
            $rollbackError = $_.Exception.Message
        }
    }
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop -or -not (Test-Path -LiteralPath $desktop)) { $desktop = $VaultPath }
    $diagnostic = Join-Path $desktop ("Mangosteen-Update-Error-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    @(
        "时间：$((Get-Date).ToString('s'))",
        "版本：$version",
        "错误：$($failure.Message)",
        $(if ($rollbackError) { "自动恢复：失败（ROLLBACK_FAILED）- $rollbackError" } else { '自动恢复：已完成或无需恢复' }),
        '处理：请把本文件发给售后老师。不要重复安装或删除知识库。'
    ) | Set-Content -LiteralPath $diagnostic -Encoding UTF8
    $failureMessage = if ($rollbackError) { "更新失败且自动恢复未完成（ROLLBACK_FAILED）：$rollbackError" } else { $failure.Message }
    Save-Result -Status 'failed' -Version $version -Message $failureMessage -Diagnostic $diagnostic
    Set-UpdateStatus -State 'failed' -Message $(if ($rollbackError) { '更新失败，自动恢复未完成，请把桌面日志发给售后老师。' } else { '更新失败，已安全恢复旧版本。' })
    exit 1
}
finally {
    if (-not $SkipRelaunch -and -not $relaunchStarted) {
        Start-Process -FilePath ('obsidian://open?path=' + [Uri]::EscapeDataString($VaultPath))
    }
}
