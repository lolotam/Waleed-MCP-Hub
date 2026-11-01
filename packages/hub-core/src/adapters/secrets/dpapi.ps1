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
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $sid = $identity.User
        $existing = [IO.Directory]::GetAccessControl($path)
        # An elevated token creates objects owned by BUILTIN\Administrators, so also
        # accept the token's default owner: the owner this process's own folders get.
        $owner = $existing.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -ne $sid.Value -and $owner -ne $identity.Owner.Value) { throw 'owner' }
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
    } elseif ($inputData.action -eq 'unprotect_many') {
        # One line per item, in order; an empty line for an item DPAPI refuses,
        # so one bad credential never fails the reads batched with it.
        $items = @($inputData.items)
        if ($items.Count -lt 1 -or $items.Count -gt 64) { throw 'invalid' }
        $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
        $lines = New-Object 'System.Collections.Generic.List[string]'
        foreach ($item in $items) {
            try {
                $bytes = [Convert]::FromBase64String([string]$item.data)
                $entropy = [Convert]::FromBase64String([string]$item.entropy)
                if ($bytes.Length -gt 32768 -or $entropy.Length -ne 32) { throw 'invalid' }
                $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)
                $lines.Add([Convert]::ToBase64String($result))
            } catch {
                $lines.Add('')
            } finally {
                if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
                if ($entropy) { [Array]::Clear($entropy, 0, $entropy.Length) }
                if ($result) { [Array]::Clear($result, 0, $result.Length) }
                $bytes = $null; $entropy = $null; $result = $null
            }
        }
        [Console]::Out.Write(($lines -join "`n"))
    } elseif ($inputData.action -eq 'protect') {
        $bytes = [Convert]::FromBase64String([string]$inputData.data)
        $entropy = [Convert]::FromBase64String([string]$inputData.entropy)
        if ($bytes.Length -gt 32768 -or $entropy.Length -ne 32) { throw 'invalid' }
        $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
        $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
        [Console]::Out.Write([Convert]::ToBase64String($result))
    } else { throw 'invalid' }
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
