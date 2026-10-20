# Threat Model

This document describes the threat model for `cdx-hbom`, a small, dependency-free Hardware Bill of Materials (HBOM) collector for Node.js that emits CycloneDX 1.7 JSON documents for supported local hosts. It focuses on the actual package surface: the CLI, the library entrypoints, local host file and command collection, HBOM output generation, and release infrastructure.

Unlike the main `cdxgen` project, `cdx-hbom` does **not** include an HTTP server, Git clone workflow, registry lookups, or outbound network collection during normal runtime. Its primary trust boundary is the local machine it inventories.

## System Overview

`cdx-hbom` operates in two runtime modes:

1. **CLI** (`bin/cdx-hbom.js`): collects hardware inventory from the current host and prints CycloneDX JSON
2. **Library** (`index.js`): exposes:
   - `collectHardware(options)` for live collection on supported hosts
   - `buildHardwareFromSources(options)` for building a BOM from pre-collected data
   - `getCommandPlan(options)` for enumerating planned local command usage, including template entries whose concrete arguments are resolved per device or interface at runtime

Current supported live-collection targets:

- `darwin/arm64`
- `linux/amd64`
- `linux/arm64`
- `win32/amd64`
- `win32/arm64`

Collection sources are intentionally local:

- **Linux baseline**: fixed reads from `/proc`, `/sys`, `/etc`, and device-tree paths
- **Linux optional enrichment**: `lscpu`, `lsblk`, `ip`, `lsmem`, `hostnamectl`, `lshw`, `lspci`, `lsusb`, `ethtool`, `cpupower`, `drm_info`, `upower`, `fwupdmgr`, `boltctl`, `mmcli`, `edid-decode`, and optionally `dmidecode`
- **Darwin baseline**: `system_profiler`, `sysctl`, `networksetup`, `pmset`, and per-interface `ifconfig`
- **Darwin optional enrichment**: `diskutil`, `diskutil apfs list -plist`, and `ioreg`
- **Windows baseline**: the Node `os` module
- **Windows enrichment**: Windows PowerShell 5.1 at `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` running six fixed CIM/registry batches (`windows-cim-platform`, `windows-cim-storage-network`, `windows-cim-display-media`, `windows-pnp-devices`, `windows-cim-trust`, and with `--privileged` `windows-cim-privileged`); every script is generated at module load from a frozen manifest and listed by `getCommandPlan({ platform: "win32" })`

Output is a CycloneDX 1.7 BOM with `cdx:hbom:*` custom properties. Privacy-sensitive identifiers are redacted by default unless the caller explicitly enables `--sensitive` / `includeSensitiveIdentifiers: true`.

## Trust Boundaries

```text
┌──────────────────────────────────────────────────────────────┐
│                      User / Calling Code                     │
│   CLI invocation, scripts, CI jobs, or library consumers     │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               │ Trust boundary 1
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                        cdx-hbom process                      │
│  - option parsing                                            │
│  - local file reads                                          │
│  - optional local command execution                          │
│  - redaction + CycloneDX document construction               │
└───────────────┬───────────────────────────────┬──────────────┘
                │                               │
                │ Trust boundary 2              │ Trust boundary 3
                ▼                               ▼
┌────────────────────────────┐     ┌───────────────────────────┐
│ Host files and kernel data │     │ Host utilities / commands │
│ /proc, /sys, /etc, ioreg   │     │ system_profiler, lsblk,   │
│ diskutil plist output, ... │     │ dmidecode, ifconfig,      │
│                            │     │ powershell.exe (WMI/CIM,  │
│                            │     │ registry), ...            │
└────────────────────────────┘     └───────────────────────────┘

Trust boundary 4: published package / CI/CD pipeline ←→ registries and release consumers
```

## Threat Actors

| Actor                                 | Capability                                                                       | Motivation                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Malicious local user**              | Can influence CLI flags, environment variables, or calling code on the same host | Trigger unsafe command execution, widen access, leak identifiers      |
| **Malicious library caller**          | Controls `collectHardware()` or `buildHardwareFromSources()` inputs              | Cause unsafe behavior, malformed BOM output, or privacy leaks         |
| **Compromised host utility**          | Controls output from `system_profiler`, `diskutil`, `lsblk`, `dmidecode`, etc.   | Mislead inventory, crash the collector, or exploit parser assumptions |
| **Compromised host OS / kernel data** | Controls `/proc`, `/sys`, `/etc`, or device-tree contents                        | Poison collected inventory or trigger parser edge cases               |
| **Supply-chain attacker**             | Can tamper with npm/JSR artifacts or CI/CD workflows                             | Publish a malicious package or alter released output                  |
| **Over-sharing consumer**             | Publishes the generated BOM without reviewing it                                 | Leak host identifiers, topology, or evidence metadata                 |

## Threats and Mitigations by Component

### 1. CLI and Library (`bin/cdx-hbom.js`, `index.js`)

#### T1.1: Command injection or unintended shell execution

**Threat:** User-controlled input or internal data reaches local process execution in a way that escapes intended command boundaries.

**Mitigations:**

- `safeSpawnSync()` uses array-based arguments through `spawnSync`, not shell-joined command strings
- `shell` defaults to `false`
- `runCommand()` routes execution through a small shared wrapper with bounded timeout and max buffer
- Linux collectors use a fixed internal command registry rather than caller-supplied command strings
- Executed commands are tracked through `commandsExecuted` and surfaced in BOM evidence properties
- Darwin uses absolute paths for system utilities, reducing ambiguity about which binary is executed
- Windows runs only `powershell.exe` by absolute path with static, single-quoted scripts generated from frozen manifests; manifest values that could break out of a single-quoted literal (`"`, backtick, `$`, `;`, newlines) are rejected when the registry is built, and no caller input ever reaches a script (see section 5)
- upstream wrappers and integrators are expected to enforce any stricter command allowlisting or trusted-`PATH` policy around the collector process

**Residual risk:** Medium. Linux enrichment commands such as `lscpu` and `lsblk` are resolved by executable name unless the surrounding environment constrains them. A hostile local environment can still influence command resolution if the upstream caller or integrator has not locked down `PATH` and execution policy.

#### T1.2: Sensitive identifier leakage in BOM output

**Threat:** Serial numbers, UUIDs, MAC-like addresses, storage identifiers, or similar device-unique values are exposed in generated output unexpectedly.

**Mitigations:**

- `redactIdentifier()` redacts many unique identifiers by default
- Redaction policy is recorded in `cdx:hbom:identifierPolicy`
- The `--sensitive` / `includeSensitiveIdentifiers: true` switch is explicit and opt-in
- Tests cover redacted-by-default behavior for Darwin and Linux collectors
- Hardware-specific properties are namespaced under `cdx:hbom:*`, making privacy review easier

**Residual risk:** Medium. Redaction is selective and pragmatic, not a formal anonymization system. The BOM may still contain topology, interface names, file paths, command evidence, and command diagnostics that are sensitive in some environments.

#### T1.3: Denial of service via malformed or oversized local data

**Threat:** Crafted plist output, unexpected sysfs data, or very large command output causes excessive memory usage, long blocking execution, or parser failure.

**Mitigations:**

- `safeSpawnSync()` uses a default 15-second timeout
- command output is bounded by a 10 MB default `maxBuffer`
- `allowPartial` defaults to `true`, so optional enrichment failures degrade gracefully instead of aborting the whole collection
- `--strict` exists for callers that prefer hard failure over partial output
- collection logic uses parser-specific functions instead of arbitrary dynamic evaluation

**Residual risk:** Medium. The package intentionally parses diverse host-produced data formats, including plist and sysfs content. Unusual hosts can still expose edge cases.

#### T1.4: Misuse of Linux privileged enrichment

**Threat:** Privileged collection runs more than intended, or uses privilege in a surprising way.

**Mitigations:**

- privileged enrichment is off by default
- Linux privileged mode is explicit through `--privileged` / `includePrivilegedEnrichment: true`
- non-interactive `sudo -n` retry is explicitly opt-in per command and limited to documented permission-sensitive commands instead of every optional command
- the command plan exposes which commands are expected and which ones may need privilege, including template entries that expand to concrete per-device or per-interface arguments during live collection
- failures in privileged enrichment can be isolated through `allowPartial`
- the CLI and BOM can surface install and privilege diagnostics without corrupting JSON output

**Residual risk:** Medium. `dmidecode` and some permission-sensitive Linux enrichments may still need root or passwordless sudo. Users need to decide whether the additional host exposure is acceptable and whether `sudo -n` is appropriate in their environment.

#### T1.5: Unsafe behavior in `buildHardwareFromSources()`

**Threat:** A caller passes untrusted pre-collected data designed to crash parsers, induce malformed BOM output, or bypass expectations built around live collection.

**Mitigations:**

- `buildHardwareFromSources()` does not execute external commands on its own
- data is normalized into explicit component and property builders
- CycloneDX envelope creation is centralized in `createHbomDocument()`

**Residual risk:** Low to Medium. This mode removes process-execution risk, but consumers still need to treat untrusted source objects as untrusted input.

### 2. Host Filesystem and Local Commands (`src/common/*`, platform collectors)

#### T2.1: Unexpected filesystem access

**Threat:** Collector code reads or writes paths outside the intended hardware-discovery scope.

**Mitigations:**

- Linux file collection uses a fixed set of known locations under `/proc`, `/sys`, `/etc`, and `/proc/device-tree`
- Darwin collection relies primarily on documented system utilities instead of arbitrary file traversal
- helper wrappers (`safeExistsSync`, `safeReadFileSync`, `safeReaddirSync`, `safeMkdirSync`) centralize error handling
- the CLI does not accept arbitrary file paths as input

**Residual risk:** Low. Current collection paths are fixed and local. Library consumers can still call low-level helpers themselves, but that is outside normal collector behavior.

#### T2.2: PATH manipulation or substituted binaries

**Threat:** A local attacker causes `cdx-hbom` to execute a different binary than intended.

**Mitigations:**

- Darwin commands use explicit absolute paths such as `/usr/sbin/system_profiler` and `/usr/bin/pmset`
- Windows resolves `powershell.exe` under `SystemRoot` without a `PATH` lookup; the value is validated against a drive-absolute path pattern and falls back to `C:\Windows`, so `SystemRoot` is the environment variable that selects the executable on Windows (T5.1)
- known limitation: PowerShell autoloads modules for bare cmdlet names through `PSModulePath`, whose first entry is the invoking user's `Documents\WindowsPowerShell\Modules`; `-NoProfile` does not prevent that. Anyone who can write that folder can already run code as that user, but an administrator running cdx-hbom also trusts their own module folder
- `shell: false` prevents shell metacharacter expansion
- the safe wrapper contains a Windows shell-hijack guard for current-working-directory shadowing when shell mode is enabled
- upstream wrappers and integrators are responsible for enforcing strict command allowlisting and a trusted `PATH` where deployment policy requires it

**Residual risk:** Medium. Linux commands are generally executed by basename, so a compromised local environment can still alter resolution if the upstream caller or integrator does not lock down `PATH` and execution policy.

#### T2.3: Poisoned local command or kernel data

**Threat:** A compromised host returns malicious or misleading data through sysfs, `/proc`, plist outputs, or local utilities.

**Mitigations:**

- Linux collection combines baseline file reads with optional command enrichment rather than trusting only one source
- Darwin collection cross-checks `system_profiler`, `sysctl`, `networksetup`, `ifconfig`, and optional plist sources
- `buildHardwareFromSources()` allows offline reconstruction from trusted captured data when live execution is undesirable

**Residual risk:** High on compromised hosts. `cdx-hbom` cannot establish trust in the host it is inventorying. It can only report what the local system presents.

### 3. Release and Supply Chain

#### T3.1: Malicious published package or tampered CI workflow

**Threat:** An attacker modifies the package or release workflow so consumers install a malicious `cdx-hbom` artifact.

**Mitigations:**

- runtime design is intentionally dependency-free, reducing supply-chain breadth
- GitHub Actions workflows use pinned SHA digests
- workflow-level `permissions: {}` enforces least privilege by default
- npm publish uses provenance attestation
- release automation is centralized in the repository workflow

**Residual risk:** Low to Medium. Any public package ecosystem and hosted CI system remains a supply-chain trust boundary.

#### T3.2: Compromised Node.js runtime

**Threat:** The Node.js runtime itself is malicious or vulnerable.

**Mitigations:**

- `package.json` declares supported Node.js versions
- the CI matrix tests the package across supported operating systems

**Residual risk:** Shared. Runtime vulnerabilities are the responsibility of Node.js maintainers and deployers.

### 4. HBOM Output and Downstream Use

#### T4.1: Unintended disclosure through evidence properties

**Threat:** The BOM reveals host paths, command provenance, disk identifiers, interface names, or other local details that are operationally sensitive.

**Mitigations:**

- identifier redaction is enabled by default for many unique IDs
- sensitive mode is explicit rather than implicit
- the evidence properties are namespaced (`cdx:hbom:evidence:*`) and documented in `docs/hardware-properties.md`
- command diagnostics are surfaced separately from JSON stdout, reducing the risk of broken output while keeping operators informed

**Residual risk:** Medium. Provenance is intentionally preserved for auditability. Users should review BOMs before sharing them outside trusted boundaries.

#### T4.2: Schema-valid but semantically surprising consumer behavior

**Threat:** A downstream tool misinterprets `cdx:hbom:*` properties or the `device` component type.

**Mitigations:**

- output is wrapped in an official CycloneDX 1.7 document envelope
- hardware roles are carried in an explicit `cdx:hbom:hardwareClass` namespace rather than pretending unsupported CycloneDX component types exist
- property naming is documented in `docs/hardware-properties.md`

**Residual risk:** Low. Downstream ecosystem understanding varies, but the package uses explicit namespaced metadata rather than ambiguous hidden fields.

### 5. Windows collector (`src/windows/*`)

#### T5.1: `powershell.exe` as the only Windows executable

**Threat:** The Windows collector is redirected to a substituted PowerShell, or its scripts are altered to run something else.

**Mitigations:**

- the executable is `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe`, an absolute path with no `PATH` lookup; `SystemRoot` is read from the environment, validated (`^[A-Za-z]:\\[^\0-\x1f"*?<>|/:]+$`) and otherwise replaced by `C:\Windows`, which makes `SystemRoot` the Windows counterpart of the `PATH` trust input
- every script is built once, at module load, from a frozen manifest by `buildCimScript()`; the registry is frozen and `getCommandPlan({ platform: "win32" })` returns the exact command lines, so an integrator can allowlist or audit them before anything runs
- scripts are one line, at most 8,000 characters, contain no double quotes and are passed with `-NoLogo -NoProfile -NonInteractive -Command`; `-EncodedCommand` (opaque to reviewers and EDR) and `-ExecutionPolicy` (unnecessary for `-Command`, often flagged) are never used
- the scripts call read-only data cmdlets (`Get-CimClass`, `Get-CimInstance`, `Get-ItemProperty`, `Get-ChildItem`, `Get-PnpDevice`, `Get-PnpDeviceProperty`, `Confirm-SecureBootUEFI`), pipeline cmdlets (`Select-Object`, `Where-Object`, `ConvertTo-Json`) and `Remove-Item` on `Alias:` drive entries only, to remove aliases that would shadow the script's own helper-function names; the `cmdlet-scalar` manifest kind accepts only an allowlisted cmdlet name and no arguments
- `--dry-run` blocks every PowerShell spawn and traces the planned command lines

**Residual risk:** Medium. Allowlisting `powershell.exe` by path is coarse: it admits any PowerShell invocation, not only cdx-hbom's. Integrators who need a tight policy should allowlist the exact command lines from the plan. A `SystemRoot` pointing at an attacker-controlled drive-absolute directory would be honoured; that requires control of the collector's environment, which already implies control of the process.

#### T5.2: No elevation path

**Threat:** The collector escalates privileges, or is used to launder an elevation request.

**Mitigations:**

- every Windows command carries `privilege: "none"` and `sudoRetryOnPermissionDenied: false`, and `runCommand()` never wraps a Windows command in `sudo`; Windows 11 ships a `sudo.exe`, and this is the reason it is never reached
- `--privileged` only adds the `windows-cim-privileged` batch (Win32_Tpm, Win32_EncryptableVolume, MSFT_StorageReliabilityCounter, `Confirm-SecureBootUEFI`); it does not trigger UAC or any token change
- the envelope reports whether the PowerShell process was already elevated (`cdx:hbom:evidence:elevated`), and a non-elevated privileged run yields `permission-denied` diagnostics with the hint to re-run from an elevated prompt

**Residual risk:** Low. The user decides what token cdx-hbom runs under; the tool cannot change it.

#### T5.3: Restricted PowerShell (Constrained Language Mode, AppLocker, WDAC)

**Threat:** A hardened host blocks or restricts PowerShell and the collector fails unsafely or misreports.

**Mitigations:**

- the scripts use only cmdlets and syntax permitted in Constrained Language Mode; the two `.NET` touches (switching the console to UTF-8, probing the Administrator role) sit in their own `try/catch` and degrade to `outputEncoding='default'` and `elevated=null`
- the envelope records `psVersion`, `languageMode` and `outputEncoding`; the BOM carries them as `cdx:hbom:evidence:powershellVersion` and `cdx:hbom:evidence:languageMode`, and a non-UTF-8 console adds a `partial-support` diagnostic
- when `powershell.exe` cannot start at all, each batch records a `missing-command` or `command-error` diagnostic and the BOM is built from the Node baseline

**Residual risk:** Low. Behaviour under a real WDAC policy was reasoned from the language-mode rules and not exercised on the test VM.

#### T5.4: PII and per-machine identifiers in CIM data

**Threat:** WMI classes carry host names, user names and device serials that end up in the BOM.

**Mitigations:**

- PII properties are never selected: `Win32_ComputerSystem.{Name, DNSHostName, Domain, Workgroup, UserName, PrimaryOwnerName, PrimaryOwnerContact, Roles}`, `Win32_OperatingSystem.{CSName, RegisteredUser, Organization, SerialNumber}`, `Win32_DeviceGuard.InstanceIdentifier`, `Win32_Battery.DeviceID` and `SystemName` on every class; a test scans every manifest for them
- serials, UUIDs and MAC addresses go through `redactIdentifier()`; PnP device instance IDs go through `redactInstanceId()`, which keeps the enumerator and device-ID segments (model identity) and redacts the instance segment (a USB serial, a Bluetooth address or an instance GUID); hardware IDs that echo the instance segment and Bluetooth hardware IDs that embed the radio address go through `redactHardwareIds()`; EDID serials stored as uint16 code arrays are decoded and redacted
- `bom-ref` values are built from the redacted device-ID segment plus an ordinal, never from the instance segment, so the dependency graph carries no identifier
- fixtures are redacted by `scripts/windows/redact-fixtures.mjs`, which fails closed when a literal or instance segment survives

**Residual risk:** Medium. Redaction keeps the last four characters of an identifier, and device names, driver INF names and location paths are emitted as reported.

#### T5.5: Slow or denied WMI as a denial of service

**Threat:** A standard user over a network logon (SSH, WinRM) is denied every WMI class, and each denial costs about five seconds; a slow third-party WMI provider stalls a batch.

**Mitigations:**

- the script records the first `AccessDenied` per namespace and short-circuits the remaining classes in that namespace without querying
- the collector detects an all-denied platform batch and skips the later WMI batches entirely, emitting one diagnostic with the network-logon hint
- every batch has its own timeout (60 s for CIM batches, 90 s for `windows-pnp-devices`), overridable with `--timeout`, and a timed-out batch records a `timeout` diagnostic while the rest continues
- PnP properties are read per device, because the bulk `Get-PnpDeviceProperty` form was measured to return duplicated and missing rows; the per-device loop is bounded by the present-device count

**Residual risk:** Low. Worst case is a bounded delay and a baseline-only BOM.

## Data Flow Diagram

```text
┌─────────────────────┐
│ CLI / calling code  │
└──────────┬──────────┘
           │ options
           ▼
┌─────────────────────────────────────────────┐
│                cdx-hbom core                │
│  parse options → collect sources → redact   │
│  identifiers → build CycloneDX document     │
└───────┬───────────────────────┬─────────────┘
        │                       │
        │ local file reads      │ local commands
        ▼                       ▼
┌───────────────┐        ┌────────────────────┐
│ /proc /sys    │        │ system_profiler    │
│ /etc / plist  │        │ diskutil / ifconfig│
│ device tree   │        │ lsblk / dmidecode  │
│ Node os (win) │        │ powershell.exe     │
│               │        │  (CIM, registry)   │
└───────────────┘        └────────────────────┘
        \                       /
         \                     /
          └──────► HBOM JSON ◄─┘
                    for caller
```

## Security Controls Summary

| Control                            | Implementation                                                                                                      | Threat(s) Addressed                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Upstream command policy            | Integrator-enforced allowlisting and trusted-`PATH` policy around `cdx-hbom`                                        | T1.1, T2.2                          |
| Array-based spawn, shell off       | `spawnSync(command, args, { shell: false })` via `safeSpawnSync()`                                                  | T1.1                                |
| Timeout and output bounds          | 15-second default timeout, 10 MB `maxBuffer`                                                                        | T1.3                                |
| Default identifier redaction       | `redactIdentifier()` and explicit `--sensitive` opt-in                                                              | T1.2, T4.1                          |
| Fixed Linux discovery roots        | Local reads limited to known `/proc`, `/sys`, `/etc`, and device-tree paths                                         | T2.1                                |
| Absolute Darwin command paths      | `/usr/sbin/*`, `/usr/bin/*`, `/sbin/*` in command registry                                                          | T2.2                                |
| Absolute, validated PowerShell path | `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe`, `SystemRoot` validated with fallback `C:\Windows` | T2.2, T5.1                          |
| Static Windows scripts             | Frozen manifests, `buildCimScript()` invariants (one line, no `"`, ≤ 8,000 chars, `cmdlet-scalar` kind limited to `WINDOWS_SCALAR_CMDLETS`), `getCommandPlan()` | T1.1, T5.1                          |
| No Windows elevation               | `privilege: "none"`, `sudoRetryOnPermissionDenied: false`, `--privileged` adds a batch only                          | T5.2                                |
| PII never selected, instance IDs redacted | Manifest PII guard test, `redactInstanceId()`, `redactHardwareIds()`, redacted `bom-ref`s                      | T1.2, T5.4                          |
| WMI denial short-circuit           | Per-namespace `AccessDenied` memo in the script, batch skip after an all-denied platform batch                      | T5.5                                |
| Partial collection mode            | `allowPartial` default behavior                                                                                     | T1.3, T1.4                          |
| Evidence tracking                  | `commandsExecuted`, `cdx:hbom:evidence:file*`, `cdx:hbom:evidence:command*`, `cdx:hbom:evidence:commandDiagnostic*` | Auditability across runtime actions |
| Minimal runtime dependency surface | dependency-free package design                                                                                      | T3.1                                |
| Hardened release workflow          | pinned Actions SHAs, `permissions: {}`, npm provenance                                                              | T3.1                                |

## Recommendations for Deployers

1. **Collect on trusted hosts**: `cdx-hbom` can only be as trustworthy as the host it inventories.
2. **Keep default redaction enabled**: only use `--sensitive` when you have a clear need for raw identifiers.
3. **Review output before sharing**: especially `cdx:hbom:evidence:file*`, `cdx:hbom:evidence:command*`, `cdx:hbom:evidence:commandDiagnostic*`, serial-like properties, and topology details.
4. **Enforce command policy in the parent environment**: if your deployment requires strict execution control, apply command allowlisting and a trusted `PATH` in the calling wrapper, CI job, or parent application.
5. **Use privileged enrichment sparingly**: on Linux enable `--privileged` only when additional SMBIOS or permission-gated hardware detail is required and the environment is appropriately hardened for `sudo -n`; on Windows it only adds the admin-only batch, so decide deliberately whether to run cdx-hbom from an elevated session.
6. **On Windows, allowlist the command lines, not just `powershell.exe`**: `getCommandPlan({ platform: "win32" })` gives the exact static scripts (`cdx-hbom --dry-run` builds a BOM without running anything but does not print them); treat `SystemRoot` as a trust input of the collector's environment.
7. **Prefer `buildHardwareFromSources()` for offline reconstruction**: when live command execution is undesirable, capture and vet the source data first.
8. **Pin package and Node.js versions in CI**: combine reproducible installs with provenance verification where available.
9. **Stay current**: use the latest published `cdx-hbom` release for security fixes.

For coordinated vulnerability disclosure, see [`../SECURITY.md`](../SECURITY.md).
