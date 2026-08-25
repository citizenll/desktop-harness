[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $BinPath,
  [switch] $Remove
)

$normalizedBin = [IO.Path]::GetFullPath($BinPath).TrimEnd('\')
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @(
  ($current -split ';') |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_.Length -gt 0 }
)

function Test-SamePath([string] $Candidate) {
  try {
    $expanded = [Environment]::ExpandEnvironmentVariables($Candidate.Trim('"'))
    return [string]::Equals(
      [IO.Path]::GetFullPath($expanded).TrimEnd('\'),
      $normalizedBin,
      [StringComparison]::OrdinalIgnoreCase
    )
  } catch {
    return [string]::Equals(
      $Candidate.Trim('"').TrimEnd('\'),
      $normalizedBin,
      [StringComparison]::OrdinalIgnoreCase
    )
  }
}

$present = @($entries | Where-Object { Test-SamePath $_ }).Count -gt 0
if ($Remove) {
  $nextEntries = @($entries | Where-Object { -not (Test-SamePath $_) })
} elseif ($present) {
  $nextEntries = $entries
} else {
  $nextEntries = @($entries) + $normalizedBin
}

$next = $nextEntries -join ';'
if ($next -cne $current) {
  [Environment]::SetEnvironmentVariable('Path', $next, 'User')
}

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshEnvironmentBroadcast {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint message, UIntPtr wParam, string lParam,
    uint flags, uint timeout, out UIntPtr result);
}
'@
  [UIntPtr] $result = [UIntPtr]::Zero
  [void] [DshEnvironmentBroadcast]::SendMessageTimeout(
    [IntPtr] 0xffff,
    0x001a,
    [UIntPtr]::Zero,
    'Environment',
    0x0002,
    5000,
    [ref] $result
  )
} catch {
  # New shells still receive the updated user PATH even if broadcasting fails.
}
