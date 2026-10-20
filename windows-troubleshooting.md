# Windows troubleshooting

cdx-hbom reads Windows hardware through Windows Management Instrumentation
(WMI/CIM) using the built-in Windows PowerShell 5.1 at
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`. It never
elevates: no UAC prompt, no `sudo.exe`. This page explains what each
permission level yields, what to do when PowerShell is restricted, and how to
read the diagnostics the BOM carries.

## How a Windows collection runs

1. A baseline from Node's `os` module (processor model and count, memory,
   OS release) is always produced, even with `--dry-run` or when PowerShell is
   unavailable.
2. `windows-cim-platform` runs one PowerShell process: system, product, BIOS,
   board, enclosure, processors, memory modules and the OS.
3. Unless `--no-command-enrichment` is given, one PowerShell process per
   domain follows: `windows-cim-storage-network`, `windows-cim-display-media`,
   `windows-pnp-devices` and `windows-cim-trust`.
4. With `--privileged`, `windows-cim-privileged` runs as well. It queries the
   classes that only administrators can read; cdx-hbom does not try to become
   one.

Every process runs a fixed, single-line script with `-NoLogo -NoProfile
-NonInteractive -Command`. `cdx-hbom --dry-run` lists the exact command lines
without running them, and `getCommandPlan({ platform: "win32" })` returns the
same plan to a library caller. The README lists every CIM class and registry
key per command id.

## Permissions

**Run it as a normal local user.** That yields nearly the whole inventory.
Administrator rights add TPM details, BitLocker status, the firmware-confirmed
Secure Boot state and disk reliability counters. A non-administrator over SSH
or WinRM gets only the baseline.

| Session | Result |
| --- | --- |
| Normal user, local session (interactive desktop, scheduled task, CI service account) | System, firmware, board, chassis, processors, memory modules; disks and volumes; network adapters; graphics adapters and monitors, audio, cameras; USB, PCI and Bluetooth devices with driver versions and signing; virtualization-based security status; the Secure Boot registry setting; batteries |
| Administrator (`Run as administrator`), with `--privileged` | Everything above plus TPM version, manufacturer and state; BitLocker protection per volume; Secure Boot confirmed through `Confirm-SecureBootUEFI`; disk wear, temperature and power-on hours |
| Non-administrator over SSH or WinRM | Baseline only: every WMI query is denied (see below) |

Details that need `--privileged` **and** administrator rights, and what a
standard user gets instead:

| Detail | Without administrator |
| --- | --- |
| TPM version, manufacturer and state (`Win32_Tpm`) | The TPM's presence, name and driver are still reported from the PnP tree |
| BitLocker protection status per volume (`Win32_EncryptableVolume`) | Volumes are listed without encryption status |
| Secure Boot confirmed by the firmware (`Confirm-SecureBootUEFI`) | The Windows Secure Boot registry setting is still reported, with `cdx:hbom:secureBootSource` = `registry` |
| Disk wear, temperature and power-on hours (`MSFT_StorageReliabilityCounter`) | Disks are listed without them |

Two further degradations were measured for a standard local user and need no
`--privileged`:

- **Disk bus type (NVMe/SATA/USB), SSD vs HDD and health** come from
  `MSFT_PhysicalDisk`. Windows returns them to a standard user only while the
  *Microsoft Storage Spaces SMP* service (`smphost`) is already running, and a
  standard user cannot start it. When it is not running, the class answers
  with zero instances and no error; disks are still listed from
  `Win32_DiskDrive` and the BOM carries one `partial-support` diagnostic
  (`windows-cim-storage-network:physical-disk`).
- **The network adapter driver file name** (`MSFT_NetAdapter.DriverName`) is
  null for a standard user. The driver service name is reported instead, from
  `Win32_NetworkAdapter.ServiceName`.

With `--privileged` and no administrator rights, cdx-hbom records one
`permission-denied` diagnostic per denied class plus one summary diagnostic
(`windows-cim-privileged`), each carrying the hint "Re-run from an elevated
(Run as administrator) prompt; cdx-hbom never requests elevation on Windows",
and finishes normally. It does not fail unless `--strict` is given.

### Measured matrix

The table below is generated from the captured fixtures under
`test/fixtures/windows/` by `scripts/windows/permissions-matrix.mjs`; a test
fails when it drifts from the fixtures. Columns are capture labels: `admin`
is an elevated session on the Windows 11 ARM64 VM, `std-local` a standard
user's local (batch) logon on the same VM, `std-network` the same user over
SSH, and the GitHub columns are the elevated hosted runners. `ok` means data
was returned, `empty` that the class answered with no instances, `denied`
that WMI refused the query, `absent` that the class or registry key does not
exist on that host, and `not captured` that the label has no capture of that
command yet.

<!-- permissions-matrix:start -->
| Source | admin | std-local | std-local, smphost stopped | std-network | GitHub windows-2025 (admin) | GitHub windows-11-arm (admin) |
| --- | --- | --- | --- | --- | --- | --- |
| `windows-cim-platform:computerSystem` | ok | ok | ok | denied | ok | ok |
| `windows-cim-platform:computerSystemProduct` | ok | ok | ok | denied (short-circuited) | ok | ok |
| `windows-cim-platform:bios` | ok | ok | ok | denied (short-circuited) | ok | ok |
| `windows-cim-platform:baseBoard` | ok | ok | ok | denied (short-circuited) | ok | ok |
| `windows-cim-platform:systemEnclosure` | ok | ok | ok | denied (short-circuited) | ok | ok |
| `windows-cim-platform:processor` | ok | ok | ok | denied (short-circuited) | ok | ok |
| `windows-cim-platform:physicalMemory` | ok | ok | ok | denied (short-circuited) | ok | ok |
| `windows-cim-platform:physicalMemoryArray` | ok | ok | ok | denied (short-circuited) | ok | ok |
| `windows-cim-platform:operatingSystem` | ok | ok | ok | denied (short-circuited) | ok | ok |
| `windows-cim-platform:msSystemInformation` | ok | ok | ok | denied | ok | ok |
| `windows-cim-storage-network:physicalDisk` | ok | ok | empty | denied | ok | ok |
| `windows-cim-storage-network:diskDrive` | ok | ok | ok | denied | ok | ok |
| `windows-cim-storage-network:volume` | ok | ok | ok | denied (short-circuited) | ok | ok |
| `windows-cim-storage-network:netAdapter` | ok | ok | ok | denied | ok | ok |
| `windows-cim-storage-network:netAdapterHardware` | ok | ok | ok | denied (short-circuited) | ok | ok |
| `windows-cim-storage-network:networkAdapterLegacy` | ok | ok | ok | denied (short-circuited) | ok | ok |
| `windows-cim-display-media:videoController` | ok | ok | not captured | denied | ok | ok |
| `windows-cim-display-media:monitorId` | ok | ok | not captured | denied | ok | ok |
| `windows-cim-display-media:monitorBasic` | ok | ok | not captured | denied (short-circuited) | ok | ok |
| `windows-cim-display-media:monitorConnection` | ok | ok | not captured | denied (short-circuited) | ok | ok |
| `windows-cim-display-media:soundDevice` | ok | ok | not captured | denied (short-circuited) | empty | empty |
| `windows-cim-display-media:mediaPnp` | ok | ok | not captured | denied (short-circuited) | empty | empty |
| `windows-pnp-devices:pnpEntity` | ok | ok | not captured | denied | ok | ok |
| `windows-pnp-devices:pnpProperties` | ok | ok | not captured | denied (short-circuited) | ok | ok |
| `windows-pnp-devices:signedDriver` | ok | ok | not captured | denied (short-circuited) | ok | ok |
| `windows-cim-trust:deviceGuard` | ok | ok | not captured | denied | ok | ok |
| `windows-cim-trust:secureBootState` | ok | ok | not captured | ok | ok | ok |
| `windows-cim-trust:firmwareResources` | absent | absent | not captured | absent | absent | absent |
| `windows-cim-trust:battery` | empty | empty | not captured | denied | empty | empty |
| `windows-cim-privileged:tpm` | ok | denied | not captured | denied | empty | empty |
| `windows-cim-privileged:encryptableVolume` | ok | denied | not captured | denied | ok | ok |
| `windows-cim-privileged:storageReliability` | empty | denied | not captured | denied | empty | empty |
| `windows-cim-privileged:secureBootCmdlet` | ok (true) | denied | not captured | denied | ok (false) | ok (false) |
<!-- permissions-matrix:end -->

### Remote shells as a non-administrator

Windows treats WMI calls from a network logon (OpenSSH, WinRM, PowerShell
remoting) as remote calls, which by default only administrators may make. As a
non-administrator over SSH or WinRM every hardware query fails with
`AccessDenied`, and each denied namespace costs about five seconds. cdx-hbom
stops after the first denial per namespace, skips the later WMI batches, and
reports one diagnostic:

```json
{"id":"windows-cim-platform:network-logon","issue":"permission-denied","code":"AccessDenied","message":"every WMI query was denied by the namespace","privilegeHint":"WMI denied for a network logon (SSH/WinRM) without administrator rights; run cdx-hbom from a local session or elevated"}
```

The registry remains readable in that session, so the Secure Boot setting is
still reported. Your options:

- run cdx-hbom in a local session, for example as a scheduled task or a CI
  service;
- run it as an administrator;
- grant the account WMI remote access to the namespaces cdx-hbom reads.
  <!-- TODO(Claude): verify the minimal permission set ("Enable Account" +
  "Remote Enable" on root/cimv2, root/wmi, root/StandardCimv2,
  root/Microsoft/Windows/Storage, root/Microsoft/Windows/DeviceGuard) on
  win11-vm with a reversible tools/ script, then document exactly what worked.
  Until then this bullet is a hypothesis, not a verified instruction. -->

## PowerShell missing or restricted

**PowerShell blocked entirely** (AppLocker or WDAC denying
`powershell.exe`, or a missing `%SystemRoot%\System32\WindowsPowerShell`):
every batch fails, the BOM contains only the Node baseline, and each command
records a diagnostic with `issue` `missing-command` (the executable could not
be started) or `command-error` (it started and exited non-zero). Nothing is
retried through another shell.

**Constrained Language Mode or a restrictive WDAC policy**: the scripts use
only cmdlets and syntax allowed in Constrained Language Mode, except for one
guarded line that switches the console to UTF-8. The BOM records what it saw:

- `cdx:hbom:evidence:languageMode` is the session's language mode
  (`FullLanguage` or `ConstrainedLanguage`);
- `cdx:hbom:evidence:powershellVersion` is `$PSVersionTable.PSVersion`;
- when the UTF-8 switch was refused, every batch adds a `partial-support`
  diagnostic `<command>:output-encoding` saying that non-ASCII text may be
  lossy (device names with `™` or accented letters can arrive mangled);
- when the elevation probe was refused, `cdx:hbom:evidence:elevated` is
  simply absent.

cdx-hbom never passes `-ExecutionPolicy` (a `-Command` invocation does not
need one) and never uses `-EncodedCommand`.

## Running elevated

`--privileged` adds the `windows-cim-privileged` batch and nothing else. It is
a request for data, not for elevation: start cdx-hbom from an elevated prompt
(or a scheduled task that runs with highest privileges) to get TPM, BitLocker,
reliability-counter and `Confirm-SecureBootUEFI` data. The BOM records whether
the PowerShell process was elevated in `cdx:hbom:evidence:elevated`.

Windows 11 ships a `sudo.exe`. cdx-hbom never invokes it: the Linux
`sudo -n` retry is disabled for every Windows command
(`sudoRetryOnPermissionDenied: false`, `privilege: "none"`).

## EDR and command allowlisting

Security agents may flag a Node process starting PowerShell. What they see is
always the same:

- the absolute path `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
  (no PATH lookup; `SystemRoot` is validated and falls back to `C:\Windows`);
- `-NoLogo -NoProfile -NonInteractive -Command` followed by one readable,
  static script per batch, at most 8,000 characters, with no double quotes and
  no encoded payload;
- read-only cmdlets: `Get-CimClass`, `Get-CimInstance`, `Get-ItemProperty`,
  `Get-ChildItem`, `Get-PnpDevice`, `Get-PnpDeviceProperty`,
  `Confirm-SecureBootUEFI`, `ConvertTo-Json`.

To review or allowlist the scripts, run `cdx-hbom --dry-run` or call
`getCommandPlan({ platform: "win32" })`; both return the complete command
lines. Allowlisting `powershell.exe` by path is coarse (it admits any
PowerShell invocation), so prefer allowlisting the exact command lines where
your tooling supports it. In cdxgen secure mode, allow `powershell.exe`.

The BOM's `cdx:hbom:evidence:command` properties and the diagnostics never
contain the script itself; they record `<id> script sha256:<12 hex>`, the
digest of the script that ran, so the plan can be matched against the output.

## Slow WMI providers and timeouts

Each CIM batch has a 60 second timeout and the PnP batch 90 seconds; override
them with `--timeout <ms>`, which applies to every command. A batch that times
out records a `timeout` diagnostic and the rest of the collection continues.
Expected durations on a small VM: about 1.3 seconds per CIM batch and about
3.5 seconds for `windows-pnp-devices`, most of it the per-device property
queries (`Get-PnpDeviceProperty` is called once per present device; the bulk
form that takes an array of instance IDs was measured to return duplicated and
missing rows on build 26200 and is not used). Hosts with hundreds of devices or
slow third-party WMI providers take longer. A denied namespace under a network
logon costs about five seconds before the short-circuit kicks in.

## x64 Node on ARM64 Windows

An x64 Node build runs under emulation on ARM64 Windows and reports `x64` for
`process.arch` and `os.machine()`. cdx-hbom therefore takes the architecture
from `Win32_Processor.Architecture` (9 is amd64, 12 is arm64) and records the
source in `cdx:hbom:architectureSource`. When the Node process architecture
differs from the hardware, `cdx:hbom:collectorProcessArchitecture` carries
the process value. x86 Windows is not a supported target and is reported as
`Unsupported HBOM target`.

## Reading diagnostics

Diagnostics are JSON strings in `cdx:hbom:evidence:commandDiagnostic`
properties. `id` is `<command id>:<result key>` for one failed class or
`<command id>` for a whole batch; `issue` is one of `missing-command`,
`permission-denied`, `partial-support`, `timeout` or `command-error`; `code`
is the CIM error name (`AccessDenied`, `NotSupported`) or the first token of
the PowerShell error id (`SetPrivilegeFailed`); `privilegeHint` tells you how
to get the data. Classes that simply do not exist on a host (no battery, no
`FirmwareResources` registry key) never produce a diagnostic.
