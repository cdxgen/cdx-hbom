# Security Policy

## Reporting Security Issues

The OWASP cdxgen and `cdx-hbom` maintainers take security bugs seriously. We appreciate responsible disclosure and will make every effort to acknowledge valid reports and coordinate remediation.

To report a security issue, email [security@cyclonedx.org](mailto:security@cyclonedx.org) and include the word **"SECURITY"** in the subject line.

After the initial reply, the maintainers will share next steps, request any additional reproduction details needed for triage, and keep you informed about remediation and coordinated disclosure.

Please report vulnerabilities in third-party modules, operating-system utilities, or runtimes to the respective maintainers as well.

## Service Level Agreements (SLAs)

These are best-effort targets, not contractual guarantees.

| Severity                                                                                                                                | Initial Response | Triage / Confirmation | Remediation Target | Disclosure                |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------- | ------------------ | ------------------------- |
| **Critical** (arbitrary code execution in `cdx-hbom`, published artifact compromise, default-mode identifier leakage with clear impact) | 48 hours         | 5 business days       | 15 business days   | Coordinated with reporter |
| **High** (command allowlist bypass, unintended privileged command execution, unsafe filesystem behavior, severe output disclosure)      | 5 business days  | 10 business days      | 30 business days   | Coordinated with reporter |
| **Medium** (denial of service, parser crashes on crafted local outputs, incomplete redaction edge cases, hardening gaps)                | 10 business days | 15 business days      | 60 business days   | Next scheduled release    |
| **Low** (minor hardening improvements, verbose error handling, defense-in-depth findings)                                               | 15 business days | 30 business days      | Best effort        | Next scheduled release    |

After a fix is available, we may publish a GitHub Security Advisory (GHSA) and request a CVE where appropriate.

## What Counts as a Genuine Security Issue

### In scope

The following are generally considered genuine security issues in `cdx-hbom`:

- **Command injection or unintended shell execution**: attacker-controlled input reaches `safeSpawnSync` or other process-execution paths in a way that escapes intended command boundaries.
- **Allowlist bypass**: bypassing `CDX_HBOM_ALLOWED_COMMANDS` or `CDXGEN_ALLOWED_COMMANDS` so that non-approved commands execute.
- **Unsafe privileged enrichment**: `--privileged` / `includePrivilegedEnrichment: true` triggers behavior beyond the documented SMBIOS and permission-sensitive enrichment flow or unexpectedly broadens host access.
- **Unexpected identifier disclosure in default mode**: serial numbers, UUIDs, MAC-like addresses, storage identifiers, or similar unique host identifiers are emitted raw when redaction should have applied.
- **Unsafe filesystem behavior**: collector logic reads or writes outside its intended discovery scope because of a package defect rather than because the user explicitly called the low-level helper APIs with arbitrary paths.
- **Parser vulnerabilities with demonstrated impact**: crafted plist, sysfs, `/proc`, or command output causes algorithmic denial of service, unbounded resource consumption, or unsafe behavior in `cdx-hbom` itself.
- **Supply-chain integrity**: tampering with the published npm/JSR package, GitHub Actions release workflow, provenance, or tagged release artifacts.

### Out of scope

The following are generally **not** considered security issues in `cdx-hbom`:

- **Vulnerabilities in operating-system tools**: bugs in `system_profiler`, `diskutil`, `ioreg`, `ifconfig`, `lscpu`, `lsblk`, `ip`, `dmidecode`, `lspci`, `lsusb`, `ethtool`, `drm_info`, `upower`, `fwupdmgr`, `boltctl`, `mmcli`, `edid-decode`, or similar host utilities belong to the OS or tool vendor.
- **Host compromise that predates `cdx-hbom`**: if an attacker already controls the host, kernel, root filesystem, or runtime environment, they can tamper with inventory inputs. That is a deployment integrity problem unless a specific `cdx-hbom` safeguard can be bypassed.
- **Disclosure when explicitly opting in to raw identifiers**: using `--sensitive` or `includeSensitiveIdentifiers: true` intentionally disables default redaction.
- **Inventory accuracy disagreements**: incomplete or imperfect hardware detection, unsupported devices, or differences between `cdx-hbom` output and vendor tools are product-quality issues unless they create a security impact.
- **Expected evidence metadata**: `cdx-hbom` intentionally emits `cdx:hbom:evidence:file*`, `cdx:hbom:evidence:command*`, and `cdx:hbom:evidence:commandDiagnostic*` properties to document collection provenance. Reports that these fields exist are not security findings by themselves.
- **Automated scanner output without exploitability**: dependency or workflow warnings without a demonstrated path to impact in `cdx-hbom`.
- **Social engineering or phishing**: attacks that require tricking a maintainer or user into manually running malicious commands.

### Grey areas

These are evaluated case by case:

- **PATH and environment poisoning**: if a local attacker can already control `PATH`, shell startup files, or the `node` process environment, they often already have substantial access. However, a bypass of documented safeguards such as allowlisting or absolute-command routing may still be in scope.
- **Redaction sufficiency**: `cdx-hbom` defaults to a pragmatic suffix-preserving redaction style for several identifiers. Reports that show a real privacy or correlation risk beyond the documented behavior are welcome.
- **Malicious local data sources**: fake or tampered files under `/proc`, `/sys`, `/etc`, or device trees are usually a symptom of an already-compromised host. If such data can trigger unsafe behavior inside `cdx-hbom`, that is in scope.

## Shared Responsibility Model

`cdx-hbom` inventories local hardware state. Security responsibility is shared between the package, its users, the host operating system, and release infrastructure.

### What `cdx-hbom` is responsible for

| Area                          | Responsibility                                                                  | Key Controls                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Own code safety**           | Preventing unintended command execution and unsafe parsing in `cdx-hbom` itself | `safeSpawnSync`, array-based arguments, `shell: false` by default, bounded timeouts and buffers, parser tests                                                                                            |
| **Command restriction**       | Giving users a way to restrict local command execution                          | `CDX_HBOM_ALLOWED_COMMANDS` / `CDXGEN_ALLOWED_COMMANDS`, exported command plans, executed-command tracking                                                                                               |
| **Identifier redaction**      | Redacting privacy-sensitive identifiers by default                              | `redactIdentifier()`, `identifierPolicy` metadata, tests covering default vs explicit sensitive mode                                                                                                     |
| **Least-surprise collection** | Keeping default collection scoped to documented local files and commands        | fixed Linux discovery roots, explicit Darwin command registry, opt-in plist enrichment, opt-in Linux privileged enrichment, and scoped `sudo -n` retry only for documented permission-sensitive commands |
| **Graceful degradation**      | Failing safely when optional enrichment is unavailable                          | `allowPartial` default behavior, `--strict` opt-in for hard failure                                                                                                                                      |
| **Supply-chain integrity**    | Protecting published artifacts and release automation                           | pinned GitHub Actions SHAs, `permissions: {}`, npm provenance, minimal dependency surface                                                                                                                |

### What users are responsible for

| Area                     | Responsibility                                                                       | Guidance                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Host trust**           | Running `cdx-hbom` on systems whose local files and system utilities are trustworthy | Use trusted hosts or ephemeral CI runners for collection. Treat host compromise as outside the tool's control.                                                                |
| **Privilege management** | Deciding whether Linux privileged enrichment is appropriate                          | Only use `--privileged` when you need SMBIOS or other permission-gated enrichment and understand the host permissions involved, including non-interactive `sudo -n` behavior. |
| **Command policy**       | Restricting local command execution where needed                                     | Set `CDX_HBOM_ALLOWED_COMMANDS` to the exact commands you permit in your environment.                                                                                         |
| **Privacy review**       | Reviewing BOM content before sharing                                                 | Keep default redaction on unless raw identifiers are required. Review `cdx:hbom:evidence:file*` and `cdx:hbom:evidence:command*` fields before distribution.                  |
| **Runtime hardening**    | Securing Node.js and the host runtime                                                | Keep Node.js updated and avoid running collection from compromised shells or untrusted login environments.                                                                    |
| **Update hygiene**       | Applying package updates that contain security fixes                                 | Stay on the latest published version; older releases should be considered unsupported unless explicitly noted otherwise.                                                      |

### What upstream projects are responsible for

| Area                                                                   | Responsible Party                     |
| ---------------------------------------------------------------------- | ------------------------------------- |
| Vulnerabilities in Darwin and Linux host utilities used for enrichment | Operating-system and tool maintainers |
| Vulnerabilities in Node.js                                             | Node.js maintainers                   |
| Compromise of npm or JSR infrastructure                                | Registry operators                    |
| Vulnerabilities in GitHub Actions runners or hosted CI infrastructure  | GitHub                                |

## Security Features Reference

`cdx-hbom` is intentionally small, but it still includes several built-in safety controls:

- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md): detailed threat model for CLI, library, local collectors, and release flow
- [`docs/hardware-properties.md`](docs/hardware-properties.md): property namespace and privacy-sensitive fields emitted in HBOM output
- [`README.md`](README.md): documented CLI flags including `--sensitive`, `--privileged`, `--plist-enrichment`, `--strict`, and `--no-command-enrichment`

## Supported Versions

Security fixes are targeted at the latest published `cdx-hbom` release. Older releases should be considered unsupported unless a specific advisory states otherwise.

| Version                  | Supported   |
| ------------------------ | ----------- |
| Latest published release | ✅          |
| Current `main` branch    | Best effort |
| Older releases           | ❌          |
