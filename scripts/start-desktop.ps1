param([string]$NodePath = $env:HUB_NODE_PATH)
$ErrorActionPreference = 'Stop'
if (-not $NodePath) {
    $bundled = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime\node.exe'
    if (Test-Path -LiteralPath $bundled) { $NodePath = $bundled }
    elseif (Test-Path -LiteralPath 'E:\Dev\Tools_and_Utilities\nodejs24\node.exe') { $NodePath = 'E:\Dev\Tools_and_Utilities\nodejs24\node.exe' }
    else { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
}
if (-not [IO.Path]::IsPathRooted($NodePath) -or [IO.Path]::GetExtension($NodePath) -ne '.exe') { throw 'An absolute Node executable is required.' }
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $root 'apps\server\dist\main.js'))) { throw 'Build the workspace with npm run build before starting desktop mode.' }
& $NodePath (Join-Path $PSScriptRoot 'desktop.mjs')
exit $LASTEXITCODE
