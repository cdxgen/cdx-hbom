# Windows troubleshooting

cdx-hbom reads Windows hardware through Windows Management Instrumentation
(WMI/CIM) using the built-in Windows PowerShell 5.1 at
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`. It never
elevates: no UAC prompt, no `sudo.exe`. When PowerShell cannot run at all,
the device inventory still comes from `pnputil`, and the rest degrades to the
Node baseline. This page explains what each permission level yields, what to
do when PowerShell is restricted, and how to read the diagnostics the BOM
carries.

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
5. When no PowerShell batch ran at all (PowerShell missing, blocked, or in
   Constrained Language Mode), `windows-pnputil-devices` enumerates connected
   PnP devices without PowerShell; see below.

Every process runs a fixed, single-line script with `-NoLogo -NoProfile
-NonInteractive -Command`. `getCommandPlan({ platform: "win32" })` returns the
exact command lines to a library caller without running them. `cdx-hbom
--dry-run` produces a baseline BOM without running anything; it does not print
the command lines. The README lists every CIM class and registry
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

One further degradation was measured for a standard local user and needs no
`--privileged`:

- **Disk bus type (NVMe/SATA/USB), SSD vs HDD and health** come from
  `MSFT_PhysicalDisk`. Windows returns them to a standard user only while the
  *Microsoft Storage Spaces SMP* service (`smphost`) is already running, and a
  standard user cannot start it. When it is not running, the class answers
  with zero instances and no error; disks are still listed from
  `Win32_DiskDrive` and the BOM carries one `partial-support` diagnostic
  (`windows-cim-storage-network:physical-disk`). That diagnostic means
  `smphost` was not running for a standard user, or the run was a network
  logon, which never gets these details.

With `--privileged` and no administrator rights, cdx-hbom records one
`permission-denied` diagnostic per denied class plus one summary diagnostic
(`windows-cim-privileged`), each carrying the hint "Re-run from an elevated
(Run as administrator) prompt; cdx-hbom never requests elevation on Windows",
and finishes normally. Per-class denials are recorded as diagnostics, never
thrown, so `--strict` does not change this.

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

The BOM then holds only the baseline (processors and memory). Every later
batch is skipped, including the Secure Boot registry read in
`windows-cim-trust`. Your options:

- run cdx-hbom in a local session, for example as a scheduled task or a CI
  service;
- run it as an administrator;
- grant the account WMI "Remote Enable" on the namespaces cdx-hbom reads
  (see below).

**Granting WMI remote access.** This was measured on Windows 11 ARM64 build
26200 with a standard user over OpenSSH. Authenticated Users already hold
"Enable Account". Granting the account "Remote Enable"
(`WBEM_REMOTE_ACCESS`, `0x20`) on these five namespaces gives a network-logon
run the same inventory as a local standard-user run:

- `root/cimv2`
- `root/wmi`
- `root/StandardCimv2`
- `root/Microsoft/Windows/Storage`
- `root/Microsoft/Windows/DeviceGuard`

Two things are still missing:

- monitors: the `root/wmi` `WmiMonitor*` classes still deny network logons,
  class by class;
- disk bus, media and health: `MSFT_PhysicalDisk` returns no disks to a
  network logon, even while `smphost` runs.

`root/cimv2` alone is not enough: the classes in the other namespaces are then
denied one by one. The TPM and BitLocker classes stay administrator-only
whatever you grant.

To grant it, run `wmimgmt.msc`, right-click **WMI Control**, choose
**Properties**, open the **Security** tab, select the namespace, click
**Security**, add the account and allow **Remote Enable**. Repeat for each
namespace. This widens who can query WMI over the network, so it is a
security decision for the administrator, not something cdx-hbom needs.

## PowerShell missing or restricted

**PowerShell blocked entirely** (AppLocker or WDAC denying
`powershell.exe`, or a missing `%SystemRoot%\System32\WindowsPowerShell`):
every PowerShell batch fails and each command records a diagnostic with
`issue` `missing-command` (the executable could not be started) or
`command-error` (it started and exited non-zero). No other shell is tried,
but the device inventory does not stop: cdx-hbom then reads PnP devices with
`%SystemRoot%\System32\pnputil.exe /enum-devices /connected /relations /drivers`,
which needs no PowerShell, and turns its output into the same envelope the
`windows-pnp-devices` batch fills, so USB, PCI and Bluetooth devices keep
their parent links and installed drivers. Processor and memory come from the
Node baseline, and board, firmware, storage, network, display, media and
trust details are missing. One `windows-fallback` diagnostic with `issue`
`partial-support` names the reason PowerShell was unavailable and that split.

The pnputil fallback has floors: `/relations` needs Windows 10 1903
(build 18362) and `/drivers` needs 2004 (build 19041), so older builds run
the command without `/drivers`, and a build older than 1903 gets no pnputil
run at all and only the Node baseline. The run honours
`--no-command-enrichment` and is skipped with it. pnputil's field labels are
localized, so on a host whose pnputil speaks another language the output is
recorded but not parsed: the PnP inventory is skipped and a
`windows-pnputil-devices` diagnostic with `issue` `partial-support` says so,
rather than the labels being misread. The fallback command is not part of the
command plan, so `getCommandPlan` does not return it and an allowlist that
should permit it must name `pnputil.exe` explicitly.

**Constrained Language Mode or a restrictive WDAC policy**: the scripts use
only cmdlets and syntax allowed in Constrained Language Mode, except for two
guarded `.NET` calls: one switches the console to UTF-8 and one probes the
Administrator role. Each sits in its own `try/catch`. This has not been
exercised under a real AppLocker or WDAC policy. When the session reports a
language mode other than `FullLanguage`, the pnputil fallback described above
runs as well, so the device inventory survives even there. The BOM records
what it saw:

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
- read-only data cmdlets: `Get-CimClass`, `Get-CimInstance`,
  `Get-ItemProperty`, `Get-ChildItem`, `Get-PnpDevice`,
  `Get-PnpDeviceProperty`, `Confirm-SecureBootUEFI`;
- pipeline cmdlets: `Select-Object`, `Where-Object`, `ConvertTo-Json`;
- `Remove-Item` on `Alias:` drive entries only, to remove any aliases that
  would shadow the script's own one-letter helper functions.

When PowerShell is blocked and the pnputil fallback runs, the Node process
starts `pnputil.exe` from the absolute System32 path with the read-only
`/enum-devices` flags instead. The fallback command is not in the command
plan, so an allowlist that should permit it must name `pnputil.exe`.

To review or allowlist the scripts, call `getCommandPlan({ platform: "win32" })`
from the library; it returns the complete command lines. `cdx-hbom --dry-run`
does not print them. Allowlisting `powershell.exe` by path is coarse (it admits any
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

An x64 Node build runs under emulation on ARM64 Windows: `process.arch` is
`x64` and `os.machine()` returns `x86_64`. cdx-hbom therefore takes the
architecture from `Win32_Processor.Architecture` (9 is amd64, 12 is arm64) and
sets `cdx:hbom:architectureSource` to `Win32_Processor`. When the Node process
architecture differs from the hardware, `cdx:hbom:collectorProcessArchitecture`
carries the process value.

When WMI is unavailable (a network logon, `--dry-run`, blocked PowerShell) the
architecture comes from the Node process instead and
`cdx:hbom:architectureSource` is `process`. x64 Node on an ARM64 host then
reports `amd64`. Use `--arch` to override it. x86 Windows is not a supported target and is reported as
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
