# Threat Model

This document describes the threat model for `cdx-hbom` — a small, dependency-free Hardware Bill of Materials (HBOM) collector for Node.js that emits CycloneDX 1.7 JSON documents for supported local hosts. It focuses on the actual package surface: the CLI, the library entrypoints, local host file and command collection, HBOM output generation, and release infrastructure.

Unlike the main `cdxgen` project, `cdx-hbom` does **not** include an HTTP server, Git clone workflow, registry lookups, or outbound network collection during normal runtime. Its primary trust boundary is the local machine it inventories.

## System Overview

`cdx-hbom` operates in two runtime modes:

1. **CLI** (`bin/cdx-hbom.js`) — collects hardware inventory from the current host and prints CycloneDX JSON
2. **Library** (`index.js`) — exposes:
   - `collectHardware(options)` for live collection on supported hosts
   - `buildHardwareFromSources(options)` for building a BOM from pre-collected data
   - `getCommandPlan(options)` for enumerating planned local command usage

Current supported live-collection targets:

- `darwin/arm64`
- `linux/amd64`
- `linux/arm64`

Collection sources are intentionally local:

- **Linux baseline** — fixed reads from `/proc`, `/sys`, `/etc`, and device-tree paths
- **Linux optional enrichment** — `lscpu`, `lsblk`, `ip`, `lsmem`, `hostnamectl`, `lshw`, `lspci`, `lsusb`, `ethtool`, and optionally `dmidecode`
- **Darwin baseline** — `system_profiler`, `sysctl`, `networksetup`, `pmset`, and per-interface `ifconfig`
- **Darwin optional enrichment** — `diskutil`, `diskutil apfs list -plist`, and `ioreg`

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
│ diskutil plist output, ... │     │ dmidecode, ifconfig, ...  │
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

#### T1.1 — Command injection or unintended shell execution

**Threat:** User-controlled input or internal data reaches local process execution in a way that escapes intended command boundaries.

**Mitigations:**

- `safeSpawnSync()` uses array-based arguments through `spawnSync`, not shell-joined command strings
- `shell` defaults to `false`
- `runCommand()` routes execution through a small shared wrapper with bounded timeout and max buffer
- `CDX_HBOM_ALLOWED_COMMANDS` (or fallback `CDXGEN_ALLOWED_COMMANDS`) can restrict the effective command set
- Executed commands are tracked through `commandsExecuted` and surfaced in BOM evidence properties
- Darwin uses absolute paths for system utilities, reducing ambiguity about which binary is executed

**Residual risk:** Medium — Linux enrichment commands such as `lscpu` and `lsblk` are resolved by executable name unless the environment constrains them. A hostile local environment can still influence command resolution if the caller has not locked down `PATH` or allowlists.

#### T1.2 — Sensitive identifier leakage in BOM output

**Threat:** Serial numbers, UUIDs, MAC-like addresses, storage identifiers, or similar device-unique values are exposed in generated output unexpectedly.

**Mitigations:**

- `redactIdentifier()` redacts many unique identifiers by default
- Redaction policy is recorded in `cdx:hbom:identifierPolicy`
- The `--sensitive` / `includeSensitiveIdentifiers: true` switch is explicit and opt-in
- Tests cover redacted-by-default behavior for Darwin and Linux collectors
- Hardware-specific properties are namespaced under `cdx:hbom:*`, making privacy review easier

**Residual risk:** Medium — redaction is selective and pragmatic, not a formal anonymization system. The BOM may still contain topology, interface names, file paths, and command evidence that are sensitive in some environments.

#### T1.3 — Denial of service via malformed or oversized local data

**Threat:** Crafted plist output, unexpected sysfs data, or very large command output causes excessive memory usage, long blocking execution, or parser failure.

**Mitigations:**

- `safeSpawnSync()` uses a default 15-second timeout
- command output is bounded by a 10 MB default `maxBuffer`
- `allowPartial` defaults to `true`, so optional enrichment failures degrade gracefully instead of aborting the whole collection
- `--strict` exists for callers that prefer hard failure over partial output
- collection logic uses parser-specific functions instead of arbitrary dynamic evaluation

**Residual risk:** Medium — the package intentionally parses diverse host-produced data formats, including plist and sysfs content. Unusual hosts can still expose edge cases.

#### T1.4 — Misuse of Linux privileged enrichment

**Threat:** Privileged collection runs more than intended, or uses privilege in a surprising way.

**Mitigations:**

- privileged enrichment is off by default
- Linux privileged mode is explicitly documented as SMBIOS enrichment via `dmidecode`
- the command plan exposes that behavior in advance
- failures in privileged enrichment can be isolated through `allowPartial`

**Residual risk:** Medium — `dmidecode` typically needs root or passwordless sudo, so users must decide whether the additional host exposure is acceptable.

#### T1.5 — Unsafe behavior in `buildHardwareFromSources()`

**Threat:** A caller passes untrusted pre-collected data designed to crash parsers, induce malformed BOM output, or bypass expectations built around live collection.

**Mitigations:**

- `buildHardwareFromSources()` does not execute external commands on its own
- data is normalized into explicit component and property builders
- CycloneDX envelope creation is centralized in `createHbomDocument()`

**Residual risk:** Low to Medium — this mode removes process-execution risk, but consumers still need to treat untrusted source objects as untrusted input.

### 2. Host Filesystem and Local Commands (`src/common/*`, platform collectors)

#### T2.1 — Unexpected filesystem access

**Threat:** Collector code reads or writes paths outside the intended hardware-discovery scope.

**Mitigations:**

- Linux file collection uses a fixed set of known locations under `/proc`, `/sys`, `/etc`, and `/proc/device-tree`
- Darwin collection relies primarily on documented system utilities instead of arbitrary file traversal
- helper wrappers (`safeExistsSync`, `safeReadFileSync`, `safeReaddirSync`, `safeMkdirSync`) centralize error handling
- the CLI does not accept arbitrary file paths as input

**Residual risk:** Low — current collection paths are fixed and local. Library consumers can still call low-level helpers themselves, but that is outside normal collector behavior.

#### T2.2 — PATH manipulation or substituted binaries

**Threat:** A local attacker causes `cdx-hbom` to execute a different binary than intended.

**Mitigations:**

- Darwin commands use explicit absolute paths such as `/usr/sbin/system_profiler` and `/usr/bin/pmset`
- `CDX_HBOM_ALLOWED_COMMANDS` can enforce a strict local allowlist
- `shell: false` prevents shell metacharacter expansion
- the safe wrapper contains a Windows shell-hijack guard for current-working-directory shadowing when shell mode is enabled

**Residual risk:** Medium — Linux commands are generally executed by basename, so a compromised local environment can still alter resolution if the caller does not lock down `PATH` or allowlists.

#### T2.3 — Poisoned local command or kernel data

**Threat:** A compromised host returns malicious or misleading data through sysfs, `/proc`, plist outputs, or local utilities.

**Mitigations:**

- Linux collection combines baseline file reads with optional command enrichment rather than trusting only one source
- Darwin collection cross-checks `system_profiler`, `sysctl`, `networksetup`, `ifconfig`, and optional plist sources
- `buildHardwareFromSources()` allows offline reconstruction from trusted captured data when live execution is undesirable

**Residual risk:** High on compromised hosts — `cdx-hbom` cannot establish trust in the host it is inventorying. It can only report what the local system presents.

### 3. Release and Supply Chain

#### T3.1 — Malicious published package or tampered CI workflow

**Threat:** An attacker modifies the package or release workflow so consumers install a malicious `cdx-hbom` artifact.

**Mitigations:**

- runtime design is intentionally dependency-free, reducing supply-chain breadth
- GitHub Actions workflows use pinned SHA digests
- workflow-level `permissions: {}` enforces least privilege by default
- npm publish uses provenance attestation
- release automation is centralized in the repository workflow

**Residual risk:** Low to Medium — any public package ecosystem and hosted CI system remains a supply-chain trust boundary.

#### T3.2 — Compromised Node.js runtime

**Threat:** The Node.js runtime itself is malicious or vulnerable.

**Mitigations:**

- `package.json` declares supported Node.js versions
- the CI matrix tests the package across supported operating systems

**Residual risk:** Shared — runtime vulnerabilities are the responsibility of Node.js maintainers and deployers.

### 4. HBOM Output and Downstream Use

#### T4.1 — Unintended disclosure through evidence properties

**Threat:** The BOM reveals host paths, command provenance, disk identifiers, interface names, or other local details that are operationally sensitive.

**Mitigations:**

- identifier redaction is enabled by default for many unique IDs
- sensitive mode is explicit rather than implicit
- the evidence properties are namespaced (`cdx:hbom:evidence:*`) and documented in `docs/hardware-properties.md`

**Residual risk:** Medium — provenance is intentionally preserved for auditability. Users should review BOMs before sharing them outside trusted boundaries.

#### T4.2 — Schema-valid but semantically surprising consumer behavior

**Threat:** A downstream tool misinterprets `cdx:hbom:*` properties or the `device` component type.

**Mitigations:**

- output is wrapped in an official CycloneDX 1.7 document envelope
- hardware roles are carried in an explicit `cdx:hbom:hardwareClass` namespace rather than pretending unsupported CycloneDX component types exist
- property naming is documented in `docs/hardware-properties.md`

**Residual risk:** Low — downstream ecosystem understanding varies, but the package uses explicit namespaced metadata rather than ambiguous hidden fields.

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
└───────────────┘        └────────────────────┘
        \                       /
         \                     /
          └──────► HBOM JSON ◄─┘
                    for caller
```

## Security Controls Summary

| Control                            | Implementation                                                              | Threat(s) Addressed                 |
| ---------------------------------- | --------------------------------------------------------------------------- | ----------------------------------- |
| Command allowlisting               | `CDX_HBOM_ALLOWED_COMMANDS` / `CDXGEN_ALLOWED_COMMANDS` + `safeSpawnSync()` | T1.1, T2.2                          |
| Array-based spawn, shell off       | `spawnSync(command, args, { shell: false })` via `safeSpawnSync()`          | T1.1                                |
| Timeout and output bounds          | 15-second default timeout, 10 MB `maxBuffer`                                | T1.3                                |
| Default identifier redaction       | `redactIdentifier()` and explicit `--sensitive` opt-in                      | T1.2, T4.1                          |
| Fixed Linux discovery roots        | Local reads limited to known `/proc`, `/sys`, `/etc`, and device-tree paths | T2.1                                |
| Absolute Darwin command paths      | `/usr/sbin/*`, `/usr/bin/*`, `/sbin/*` in command registry                  | T2.2                                |
| Partial collection mode            | `allowPartial` default behavior                                             | T1.3, T1.4                          |
| Evidence tracking                  | `commandsExecuted`, `cdx:hbom:evidence:file*`, `cdx:hbom:evidence:command*` | Auditability across runtime actions |
| Minimal runtime dependency surface | dependency-free package design                                              | T3.1                                |
| Hardened release workflow          | pinned Actions SHAs, `permissions: {}`, npm provenance                      | T3.1                                |

## Recommendations for Deployers

1. **Collect on trusted hosts** — `cdx-hbom` can only be as trustworthy as the host it inventories.
2. **Keep default redaction enabled** — only use `--sensitive` when you have a clear need for raw identifiers.
3. **Review output before sharing** — especially `cdx:hbom:evidence:file*`, `cdx:hbom:evidence:command*`, serial-like properties, and topology details.
4. **Use command allowlists in controlled environments** — set `CDX_HBOM_ALLOWED_COMMANDS` to the exact commands you permit.
5. **Use Linux privileged enrichment sparingly** — enable `--privileged` only when SMBIOS detail is required and the environment is appropriately hardened.
6. **Prefer `buildHardwareFromSources()` for offline reconstruction** — when live command execution is undesirable, capture and vet the source data first.
7. **Pin package and Node.js versions in CI** — combine reproducible installs with provenance verification where available.
8. **Stay current** — use the latest published `cdx-hbom` release for security fixes.

For coordinated vulnerability disclosure, see [`../SECURITY.md`](../SECURITY.md).
