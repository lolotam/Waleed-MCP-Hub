param(
    [Parameter(Mandatory = $true)][string]$SessionId,
    [Parameter(Mandatory = $true)][string]$PromptFile,
    [string]$OpenCodeBin = $env:OPENCODE_BIN
)
$ErrorActionPreference = 'Stop'
# Share argument handling with the Node entrypoint; do not hand-escape JSON for PowerShell.
$arguments = @((Join-Path $PSScriptRoot 'dispatch.mjs'), '--session', $SessionId, '--prompt-file', $PromptFile)
if ($OpenCodeBin) { $arguments += @('--bin', $OpenCodeBin) }
& node @arguments
exit $LASTEXITCODE
