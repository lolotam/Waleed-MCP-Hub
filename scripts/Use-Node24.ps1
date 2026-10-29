# Dot-source in a PowerShell terminal: . .\scripts\Use-Node24.ps1
param([string]$NodeDirectory = 'E:\Dev\Tools_and_Utilities\nodejs24')
$node = Join-Path $NodeDirectory 'node.exe'
if (-not (Test-Path $node)) { throw 'Node 24 was not found. Pass -NodeDirectory with its installation directory.' }
$version = & $node --version
if ($version -notmatch '^v24\.') { throw "Expected Node 24; found $version" }
$env:PATH = "$NodeDirectory;$env:PATH"
Write-Host "Using $version for this terminal only. No system settings changed."
