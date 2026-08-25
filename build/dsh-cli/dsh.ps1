[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $DshArguments
)

$usage = 'dsh plugin --profile web add <plugin-source>'
$source = $null

if (
  $DshArguments.Count -eq 5 -and
  $DshArguments[0] -ceq 'plugin' -and
  $DshArguments[1] -ceq '--profile' -and
  $DshArguments[2] -ceq 'web' -and
  $DshArguments[3] -ceq 'add'
) {
  $source = $DshArguments[4]
} elseif (
  $DshArguments.Count -eq 4 -and
  $DshArguments[0] -ceq 'plugin' -and
  $DshArguments[1] -ceq '--profile=web' -and
  $DshArguments[2] -ceq 'add'
) {
  $source = $DshArguments[3]
}

if (
  [string]::IsNullOrWhiteSpace($source) -or
  $source.Length -gt 2048 -or
  $source -match '["\s\x00-\x1f\x7f]'
) {
  [Console]::Error.WriteLine('DSH Desktop CLI supports direct plugin installation through the Desktop app.')
  [Console]::Error.WriteLine("Usage: $usage")
  exit 2
}

$desktopExecutable = [IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot '..\..\DSH Desktop.exe')
)
if (-not (Test-Path -LiteralPath $desktopExecutable -PathType Leaf)) {
  [Console]::Error.WriteLine("DSH Desktop is not installed at: $desktopExecutable")
  exit 3
}

$protocolRequest = 'dsh-desktop://plugin/install?source=' + [Uri]::EscapeDataString($source)

try {
  # A terminal may define Node.js development flags such as
  # NODE_OPTIONS=--no-deprecation. Packaged Electron rejects most NODE_OPTIONS,
  # so the Desktop launcher must not leak the caller's Node environment into
  # the GUI process.
  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Start-Process `
    -FilePath $desktopExecutable `
    -ArgumentList @($protocolRequest) `
    -WorkingDirectory (Split-Path -Parent $desktopExecutable) `
    -ErrorAction Stop | Out-Null
  [Console]::Out.WriteLine('Opened DSH Desktop. Confirm the direct plugin installation.')
  exit 0
} catch {
  [Console]::Error.WriteLine("Unable to open DSH Desktop: $($_.Exception.Message)")
  exit 4
}
