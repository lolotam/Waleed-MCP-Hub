$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Command autoloading searches every module folder on first use, which takes
# 20+ seconds on some machines and could load a module from a user-writable path.
# Import the one system module this script needs from $PSHOME instead.
$PSModuleAutoloadingPreference = 'None'
try {
    Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1'))
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $request = [Console]::In.ReadLine()
    Add-Type -Path ([IO.Path]::Combine($PSScriptRoot, 'ProcessHost.cs')) -ReferencedAssemblies 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'
    exit ([WaleedHub.ProcessHost]::Run($request))
} catch {
    # Never emit compiler exceptions, executable paths, request data, or secrets.
    [Console]::Out.WriteLine('{"event":"error","code":"host_unavailable"}')
    exit 1
}
