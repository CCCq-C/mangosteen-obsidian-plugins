[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$StatusPath
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = '山竹智能体更新'
$form.ClientSize = New-Object System.Drawing.Size(720, 190)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(248, 247, 252)

$title = New-Object System.Windows.Forms.Label
$title.Text = '正在更新山竹智能体'
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 18, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::FromArgb(39, 35, 48)
$title.SetBounds(42, 28, 636, 42)
$form.Controls.Add($title)

$status = New-Object System.Windows.Forms.Label
$status.Text = '正在关闭后台服务，请稍候…'
$status.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10.5)
$status.ForeColor = [System.Drawing.Color]::FromArgb(88, 81, 102)
$status.AutoEllipsis = $true
$status.SetBounds(44, 78, 632, 30)
$form.Controls.Add($status)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Style = 'Marquee'
$progress.MarqueeAnimationSpeed = 28
$progress.SetBounds(44, 126, 632, 18)
$form.Controls.Add($progress)

$script:closeAt = $null
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$timer.Add_Tick({
    if (Test-Path -LiteralPath $StatusPath) {
        $current = Get-Content -LiteralPath $StatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($current.message) { $status.Text = [string]$current.message }
        if ($current.state -in @('success', 'failed', 'activation_warning')) {
            $progress.Style = 'Blocks'
            $progress.Value = if ($current.state -eq 'failed') { 0 } else { 100 }
            if ($null -eq $script:closeAt) {
                $delay = if ($current.state -eq 'success') { 2 } elseif ($current.state -eq 'activation_warning') { 12 } else { 8 }
                $script:closeAt = (Get-Date).AddSeconds($delay)
            }
        }
    }
    if ($null -ne $script:closeAt -and (Get-Date) -ge $script:closeAt) { $form.Close() }
})

$form.Add_Shown({ $timer.Start() })
$form.Add_FormClosed({ $timer.Stop() })
[void]$form.ShowDialog()
