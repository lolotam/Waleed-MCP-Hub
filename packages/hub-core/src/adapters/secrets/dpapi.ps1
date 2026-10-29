$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$bytes = $null
$entropy = $null
$result = $null
# Autoloading is off for the same reason as in the process host (host.ps1).
$PSModuleAutoloadingPreference = 'None'
try {
    Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1'))
    Add-Type -AssemblyName System.Security
    $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($inputData.action -eq 'acl') {
        $path = [string]$inputData.path
        if (-not [IO.Path]::IsPathRooted($path) -or $path.StartsWith('\\')) { throw 'invalid' }
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $existing = [IO.Directory]::GetAccessControl($path)
        if ($existing.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetAccessRuleProtection($true, $false)
        $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
        $propagate = [Security.AccessControl.PropagationFlags]::None
        $allow = [Security.AccessControl.AccessControlType]::Allow
        $rights = [Security.AccessControl.FileSystemRights]::FullControl
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, $rights, $inherit, $propagate, $allow)))
        $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, $rights, $inherit, $propagate, $allow)))
        [IO.Directory]::SetAccessControl($path, $acl)
        [Console]::Out.Write('ok')
    } else {
        $bytes = [Convert]::FromBase64String([string]$inputData.data)
        $entropy = [Convert]::FromBase64String([string]$inputData.entropy)
        if ($bytes.Length -gt 32768 -or $entropy.Length -ne 32) { throw 'invalid' }
        $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
        if ($inputData.action -eq 'protect') {
            $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
        } elseif ($inputData.action -eq 'unprotect') {
            $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)
        } else { throw 'invalid' }
        [Console]::Out.Write([Convert]::ToBase64String($result))
    }
} catch {
    # Never print DPAPI/provider exceptions or input/ciphertext/plaintext.
    [Console]::Error.Write('Protected credential operation unavailable.')
    exit 1
} finally {
    if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($entropy) { [Array]::Clear($entropy, 0, $entropy.Length) }
    if ($result) { [Array]::Clear($result, 0, $result.Length) }
    $inputData = $null
}
