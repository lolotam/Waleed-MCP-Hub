param([switch]$Replace)
$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$path = Join-Path $desktop 'Waleed MCP Hub.lnk'
if ((Test-Path -LiteralPath $path) -and -not $Replace) { throw 'Shortcut already exists. Pass -Replace explicitly to replace this one shortcut.' }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($path)
$root = Split-Path -Parent $PSScriptRoot
$exePath = Join-Path $root 'WaleedMcpHub.exe'
if (Test-Path -LiteralPath $exePath) {
    $shortcut.TargetPath = $exePath
    $shortcut.Arguments = ''
} else {
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = '-NoLogo -NoProfile -File "' + (Join-Path $PSScriptRoot 'start-desktop.ps1') + '"'
}
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'Waleed MCP Hub - same-user Windows App Mode'
$shortcut.WindowStyle = 7
$shortcut.Save()
Write-Output 'Waleed MCP Hub desktop shortcut installed. No startup registration or agent configuration changed.'
