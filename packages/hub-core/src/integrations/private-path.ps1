$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Autoloading is off for the same reason as in the process host (host.ps1).
$PSModuleAutoloadingPreference = 'None'
try {
    foreach ($module in 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Security') {
        Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules', $module, "$module.psd1"))
    }
    $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $path = [string]$inputData.path
    if (-not [IO.Path]::IsPathRooted($path) -or $path.StartsWith('\\')) { throw 'invalid' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $sid = $identity.User
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'invalid' }
    $existing = Get-Acl -LiteralPath $path
    # Accept the token's default owner too, as in dpapi.ps1 (elevated tokens).
    $owner = $existing.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $sid.Value -and $owner -ne $identity.Owner.Value) { throw 'owner' }
    if ($item.PSIsContainer) {
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    } else {
        $acl = New-Object Security.AccessControl.FileSecurity
        $inherit = [Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetAccessRuleProtection($true, $false)
    $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    foreach ($identity in @($sid, $system)) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', $inherit, 'None', 'Allow')))
    }
    # Persist the DACL only. Set-Acl can attempt SACL persistence on an already
    # protected directory and require SeSecurityPrivilege; never request elevation.
    if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($path, $acl) }
    else { [IO.File]::SetAccessControl($path, $acl) }
    [Console]::Out.Write('ok')
} catch { [Console]::Error.Write('Private path protection unavailable.'); exit 1 }
