# cdx-hbom

`cdx-hbom` is a small, dependency-free Hardware Bill of Materials (HBOM) collector for CycloneDX BOM tools.

It currently supports following OS hosts:

- `darwin/arm64` (Apple Silicon Macs)
- `linux/amd64`
- `linux/arm64`
- `win32/amd64`
- `win32/arm64`

## Install

### npm

```bash
npm install @cdxgen/cdx-hbom
```

### JSR

```bash
npx jsr add @cdxgen/cdx-hbom
```

## CLI

Generate a hardware inventory for the current host:

```bash
npx @cdxgen/cdx-hbom --pretty > host-hbom.json
```

Common options:

- `--pretty` pretty-print the JSON output
- `--dry-run` block command execution and trace planned collection activity
- `--platform <value>` override platform detection
- `--arch <value>` override architecture detection
- `--sensitive` include raw identifiers instead of redacted defaults
- `--no-command-enrichment` disable optional command-based enrichment (Linux commands; on macOS the per-interface `ifconfig` and `pmset` calls are skipped; on Windows only the `windows-cim-platform` batch runs)
- `--privileged` collect sources that need elevated rights. On Linux this enables privileged enrichment and explicit non-interactive `sudo -n` retries for documented permission-sensitive commands that opt in (currently `drm_info`). On Windows it adds the `windows-cim-privileged` batch (TPM, BitLocker, storage reliability counters, `Confirm-SecureBootUEFI`), which only administrators can read; cdx-hbom never elevates itself, so run it from an elevated session to get that data and expect `permission-denied` diagnostics otherwise
- `--plist-enrichment` enable additional Darwin plist-based enrichment
- `--strict` fail instead of returning partial results when enrichment fails
- `--timeout <ms>` set per-command timeout

Examples:

```bash
npx @cdxgen/cdx-hbom --pretty
npx @cdxgen/cdx-hbom --privileged --pretty > host-hbom.json
npx @cdxgen/cdx-hbom --plist-enrichment --pretty > mac-hbom.json
```

## Library usage

```js
import {
  collectHardware,
  createCollectorTrace,
  buildHardwareFromSources,
  getCollectorTrace,
  getCommandPlan,
} from "@cdxgen/cdx-hbom";

const trace = createCollectorTrace();

const bom = await collectHardware({
  dryRun: true,
  includePlistEnrichment: true,
  trace,
});

const collectedTrace = getCollectorTrace(bom) ?? trace;
console.log(collectedTrace.activities);

const plan = getCommandPlan({ platform: "linux", architecture: "amd64" });

// Some plan entries are templates; their final arguments are resolved per
// device or interface at runtime when live collection expands the plan.

const rebuilt = buildHardwareFromSources({
  platform: "linux",
  architecture: "amd64",
  sources: {
    osRelease: { NAME: "Ubuntu", VERSION_ID: "24.04" },
    cpuInfo: [{ processor: "0", "model name": "AMD Ryzen 7" }],
  },
});
```

### Reading command diagnostics from the library

`cdx-hbom` keeps JSON output on the BOM itself and records optional command issues in the attached collector trace and BOM evidence properties.

```js
import {
  collectHardware,
  createCollectorTrace,
  getCollectorTrace,
} from "@cdxgen/cdx-hbom";

const trace = createCollectorTrace();

const bom = await collectHardware({
  platform: "linux",
  architecture: "amd64",
  includeCommandEnrichment: true,
  includePrivilegedEnrichment: true,
  allowPartial: true,
  trace,
});

const collectedTrace = getCollectorTrace(bom) ?? trace;
const commandDiagnostics = collectedTrace.activities.filter(
  (entry) =>
    entry.kind === "command-diagnostic" || entry.kind === "command-warning",
);

for (const entry of commandDiagnostics) {
  if (entry.issue === "missing-command") {
    console.error(
      `Install hint for ${entry.command}: ${entry.hint ?? "see package docs"}`,
    );
  }

  if (entry.issue === "permission-denied") {
    console.error(
      `Privilege hint for ${entry.command}: ${entry.hint ?? "retry with --privileged"}`,
    );
  }
}
```

You can also read serialized command diagnostics from the BOM root by inspecting `cdx:hbom:evidence:commandDiagnostic*` properties.

## Native enrichment currently covered

`cdx-hbom` uses a fixed command registry and array-based process spawning, but upstream wrappers and integrators are responsible for any stricter command allowlisting, `PATH` hardening, or execution policy controls around the collector process.

### Dry-run and trace support

- `dryRun: true` blocks command execution inside `cdx-hbom` itself instead of relying on a caller-side fallback.
- `getCommandPlan()` exposes the static command registry, including template entries whose concrete arguments are resolved per device or interface at runtime.
- Successful file reads and directory discovery, plus completed/blocked/failed command attempts, are recorded in the collector trace.
- Pass `trace: createCollectorTrace()` to collect activity into a caller-owned ledger, or read it later via `getCollectorTrace(bom)`.
- The attached trace is non-enumerable, so `JSON.stringify(bom)` still emits a normal CycloneDX document.

### Linux

- `/proc` and `/sys` baseline discovery
- CPU, memory, storage, PCI, USB, DRM display, audio, MMC/SDIO, and network inventory
- USB device topology showing the hub hierarchy, with per-device driver, lanes, and interface drivers
- USB-C connectors, electronically marked cables, and the peer on the far end from `/sys/class/typec`, with decoded data rate, current, delivery wattage, advertised power profiles, alternate modes, and charging verdicts
- USB-C peers correlated to their enumerated USB device and power delivery node, and live charging readouts from the UCSI power supply when available
- `hwmon`, thermal zones, TPM, and NVMe controller enrichment
- optional command enrichment via `lscpu`, `lsblk`, `ip`, `lsmem`, `hostnamectl`, `lspci`, `lsusb`, `ethtool`, `cpupower`, `drm_info`, `upower`, `fwupdmgr`, `boltctl`, `mmcli`, and `edid-decode`
- command diagnostics for missing utilities, partial support, and permission-sensitive enrichments

If you want to improve Linux enrichment coverage by installing the optional host tools, see [`linux-troubleshooting.md`](linux-troubleshooting.md).

### Darwin arm64

- `system_profiler` hardware, storage, display, Wi-Fi, USB, audio, camera, Bluetooth, Thunderbolt, and power data
- `networksetup` hardware-port mapping
- live `ifconfig` network-interface enrichment
- optional plist enrichment via `diskutil`, `diskutil apfs list -plist`, and `ioreg`

### Windows (`win32/amd64`, `win32/arm64`)

Windows inventory comes from CIM/WMI classes and a few registry keys, read by
the built-in Windows PowerShell 5.1 (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`)
running one fixed, single-line script per batch. The platform value emitted in
the BOM is `windows`; `--platform windows` and `--platform win32` both route to
it. A Node `os`-module baseline (processor, memory, OS release) is always
produced, so a host where PowerShell is blocked still yields a valid BOM.

The command ids and their sources (the list is checked against the registry by
a test, and `getCommandPlan({ platform: "win32" })` returns the full command
lines):

<!-- windows-sources:start -->
- `windows-cim-platform`: `root/cimv2`: `Win32_ComputerSystem`, `Win32_ComputerSystemProduct`, `Win32_BIOS`, `Win32_BaseBoard`, `Win32_SystemEnclosure`, `Win32_Processor`, `Win32_PhysicalMemory`, `Win32_PhysicalMemoryArray`, `Win32_OperatingSystem`; `root/wmi`: `MS_SystemInformation`
- `windows-cim-storage-network`: `root/Microsoft/Windows/Storage`: `MSFT_PhysicalDisk`; `root/cimv2`: `Win32_DiskDrive`, `Win32_Volume`, `Win32_NetworkAdapter`; `root/StandardCimv2`: `MSFT_NetAdapter`, `MSFT_NetAdapterHardwareInfoSettingData`
- `windows-cim-display-media`: `root/cimv2`: `Win32_VideoController`, `Win32_SoundDevice`, `Win32_PnPEntity`; `root/wmi`: `WmiMonitorID`, `WmiMonitorBasicDisplayParams`, `WmiMonitorConnectionParams`
- `windows-pnp-devices`: `root/cimv2`: `Win32_PnPEntity`, `Win32_PnPSignedDriver`; `Get-PnpDevice -PresentOnly` and `Get-PnpDeviceProperty` (`DEVPKEY_Device_Parent`, `DEVPKEY_Device_LocationPaths`, `DEVPKEY_Device_DriverVersion`, `DEVPKEY_Device_DriverProvider`, `DEVPKEY_Device_DriverDate`, `DEVPKEY_Device_BusReportedDeviceDesc`, `DEVPKEY_Device_BusNumber`, `DEVPKEY_Device_Address`)
- `windows-cim-trust`: `root/Microsoft/Windows/DeviceGuard`: `Win32_DeviceGuard`; `root/cimv2`: `Win32_Battery`; registry `HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State` (`UEFISecureBootEnabled`); registry subkeys of `HKLM:\SYSTEM\CurrentControlSet\Control\FirmwareResources` (`LastAttemptStatus`, `LastAttemptVersion`, `Version`)
- `windows-cim-privileged`: `root/cimv2/Security/MicrosoftTpm`: `Win32_Tpm`; `root/cimv2/Security/MicrosoftVolumeEncryption`: `Win32_EncryptableVolume`; `root/Microsoft/Windows/Storage`: `MSFT_StorageReliabilityCounter`; cmdlet `Confirm-SecureBootUEFI`
<!-- windows-sources:end -->

Component coverage: host metadata, processor, memory and memory modules,
board, firmware (BIOS) and chassis; storage (`Win32_DiskDrive` enriched from
`MSFT_PhysicalDisk`) and volumes; network and wireless adapters; display
adapters and monitors; audio controllers and endpoints; cameras; USB
controllers and devices, PCI devices and Bluetooth radios and devices with
driver versions and signing and a parent/child `dependencies` graph; TPM,
firmware (ESRT) devices and batteries; and a host security posture
(virtualization-based security, code integrity, Secure Boot, BitLocker per
volume with `--privileged`). Property names are documented in
[`docs/hardware-properties.md`](docs/hardware-properties.md).

Option semantics on Windows:

- `--privileged` adds the `windows-cim-privileged` batch (TPM, BitLocker,
  storage reliability counters, `Confirm-SecureBootUEFI`). Those classes deny
  non-administrators; cdx-hbom never elevates, never calls `sudo.exe` and
  never prompts, so run it from an elevated session to get the data. Without
  elevation the batch records `permission-denied` diagnostics and the run
  still succeeds.
- `--no-command-enrichment` keeps only `windows-cim-platform` (and the Node
  baseline).
- `--dry-run` produces the Node baseline only and traces every planned
  PowerShell command as `blocked`.
- `--plist-enrichment` does not apply to Windows.
- `--timeout <ms>` overrides the per-batch timeouts (60 s per CIM batch,
  90 s for `windows-pnp-devices`).
- When `powershell.exe` cannot start (missing, blocked by AppLocker, WDAC or
  the command allowlist) or runs in Constrained Language Mode, a fallback
  reads board, firmware and processor from `reg.exe query
  HKLM\HARDWARE\DESCRIPTION\System\{BIOS,CentralProcessor\0}` and the
  device inventory from `pnputil /enum-devices /connected /relations
  /drivers`, and records a `windows-fallback` `partial-support` diagnostic.
  The registry value names are not documented by Microsoft. pnputil labels are
  localized, so on a non-English host only the registry part applies. The
  fallback commands are not in the command plan; an allowlist must name
  `reg.exe` and `pnputil.exe` to permit them.
- Command allowlist entries match Windows commands case-insensitively
  (`POWERSHELL.EXE` allows `powershell.exe`); POSIX commands match exactly.

Permissions, PowerShell restrictions, EDR allowlisting, slow providers and the
x64-on-ARM64 case are covered in
[`windows-troubleshooting.md`](windows-troubleshooting.md).

## Permissions

Short answer: **run cdx-hbom as a normal local user.** That gives nearly the
whole hardware inventory on every supported OS. Elevation (administrator or
root) adds a few security- and health-related details. cdx-hbom never prompts
for a password and never elevates on Windows; on Linux, `--privileged` retries
a few documented commands with non-interactive `sudo -n`.

| Platform | Normal user, local session | Administrator or root | Non-admin over SSH or WinRM |
| --- | --- | --- | --- |
| **macOS** (Apple Silicon) | Full inventory; every collector command runs as a normal user | Nothing extra | Not measured; expected same as local |
| **Linux** | `/proc` and `/sys` baseline plus the optional tools that are installed | `--privileged` runs `dmidecode` and retries `drm_info` with non-interactive `sudo -n` (see [`linux-troubleshooting.md`](linux-troubleshooting.md)) | Not measured; expected same as local |
| **Windows** | Nearly everything; see the measured matrix in [`windows-troubleshooting.md`](windows-troubleshooting.md#measured-matrix) | `--privileged` adds TPM details, BitLocker status, the firmware-confirmed Secure Boot state and disk reliability counters | Every WMI query is denied; only the baseline (processors and memory) is produced, with one `permission-denied` diagnostic that says why. Granting the account WMI "Remote Enable" on five namespaces restores most of the local inventory (see the troubleshooting page) |

On Windows one more detail depends on state rather than rights: disk bus
type, media type and health (`MSFT_PhysicalDisk`) reach a standard user only
while the Storage Spaces SMP service (`smphost`) is already running. This is
explained in the troubleshooting page.

Privacy defaults on every platform: serial numbers, UUIDs, MAC addresses and
PnP instance segments are redacted to `redacted:<last 4>`; host names, user
names and domain names are never collected. Pass `--sensitive` only when raw
identifiers are needed.

## Development

```bash
npm test
```

## License

MIT
