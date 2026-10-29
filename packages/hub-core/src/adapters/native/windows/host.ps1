$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
try {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $request = [Console]::In.ReadLine()
    Add-Type -Path (Join-Path $PSScriptRoot 'ProcessHost.cs') -ReferencedAssemblies 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'
    exit ([WaleedHub.ProcessHost]::Run($request))
} catch {
    # Never emit compiler exceptions, executable paths, request data, or secrets.
    [Console]::Out.WriteLine('{"event":"error","code":"host_unavailable"}')
    exit 1
}
