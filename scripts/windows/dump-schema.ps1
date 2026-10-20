# Dump live CIM class schemas (property names, CIM types and ValueMap
# qualifiers) for classes that have no instances on win11-vm, so derived
# fixtures can be generated from real schema (PLAN.md §5.4). Output is JSON,
# labelled provenance "schema", and holds no instance data.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\dump-schema.ps1 -Out tmp\schema
#
# Copy the resulting *.schema.json files to test/fixtures/windows/schema/.
param([string]$Out = 'tmp\schema')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
$targets = @(
  @{ Namespace = 'root/cimv2'; ClassName = 'Win32_Battery' },
  @{ Namespace = 'root/Microsoft/Windows/Storage'; ClassName = 'MSFT_StorageReliabilityCounter' },
  @{ Namespace = 'root/cimv2/Security/MicrosoftTpm'; ClassName = 'Win32_Tpm' },
  @{ Namespace = 'root/cimv2/Security/MicrosoftVolumeEncryption'; ClassName = 'Win32_EncryptableVolume' },
  @{ Namespace = 'root/Microsoft/Windows/DeviceGuard'; ClassName = 'Win32_DeviceGuard' }
)
foreach ($t in $targets) {
  $cls = Get-CimClass -Namespace $t.Namespace -ClassName $t.ClassName
  $props = @()
  foreach ($p in $cls.CimClassProperties) {
    $entry = [ordered]@{ name = $p.Name; cimType = [string]$p.CimType }
    $vm = $p.Qualifiers | Where-Object { $_.Name -eq 'ValueMap' }
    $vals = $p.Qualifiers | Where-Object { $_.Name -eq 'Values' }
    if ($vm) { $entry.valueMap = @($vm.Value) }
    if ($vals) { $entry.values = @($vals.Value) }
    $units = $p.Qualifiers | Where-Object { $_.Name -eq 'Units' }
    if ($units) { $entry.units = [string]$units.Value }
    $props += ,$entry
  }
  $doc = [ordered]@{
    provenance = 'schema'
    capturedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    host = 'win11-vm'
    osBuild = [string](Get-CimInstance -ClassName Win32_OperatingSystem -Property BuildNumber).BuildNumber
    namespace = $t.Namespace
    className = $t.ClassName
    instanceCount = @(Get-CimInstance -Namespace $t.Namespace -ClassName $t.ClassName -ErrorAction SilentlyContinue).Count
    properties = $props
  }
  $file = Join-Path $Out ($t.ClassName + '.schema.json')
  # WriteAllText with an explicit encoding avoids the UTF-8 BOM that
  # Set-Content -Encoding UTF8 writes on Windows PowerShell 5.1.
  [IO.File]::WriteAllText((Join-Path (Get-Location) $file), (ConvertTo-Json -InputObject $doc -Depth 5), [Text.UTF8Encoding]::new($false))
  Write-Output ("{0}: {1} properties, {2} instances -> {3}" -f $t.ClassName, $props.Count, $doc.instanceCount, $file)
}
