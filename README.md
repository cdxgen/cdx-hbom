# cdx-hbom

`cdx-hbom` is a small, dependency-free Hardware Bill of Materials (HBOM) collector for CycloneDX BOM tools.

It currently supports following OS hosts:

- `darwin/arm64` (Apple Silicon Macs)
- `linux/amd64`
- `linux/arm64`

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
- `--no-command-enrichment` disable optional command-based enrichment on Linux
- `--privileged` enable privileged Linux SMBIOS enrichment via `dmidecode`
- `--plist-enrichment` enable additional Darwin plist-based enrichment
- `--strict` fail instead of returning partial results when enrichment fails
- `--timeout <ms>` set per-command timeout

Examples:

```bash
npx @cdxgen/cdx-hbom --pretty
npx @cdxgen/cdx-hbom --privileged --pretty > linux-hbom.json
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

const rebuilt = buildHardwareFromSources({
  platform: "linux",
  architecture: "amd64",
  sources: {
    osRelease: { NAME: "Ubuntu", VERSION_ID: "24.04" },
    cpuInfo: [{ processor: "0", "model name": "AMD Ryzen 7" }],
  },
});
```

## Native enrichment currently covered

## Dry-run and trace support

- `dryRun: true` blocks command execution inside `cdx-hbom` itself instead of relying on a caller-side fallback.
- Successful file reads and directory discovery, plus completed/blocked/failed command attempts, are recorded in the collector trace.
- Pass `trace: createCollectorTrace()` to collect activity into a caller-owned ledger, or read it later via `getCollectorTrace(bom)`.
- The attached trace is non-enumerable, so `JSON.stringify(bom)` still emits a normal CycloneDX document.

### Linux

- `/proc` and `/sys` baseline discovery
- CPU, memory, storage, PCI, USB, DRM display, audio, MMC/SDIO, and network inventory
- `hwmon`, thermal zones, TPM, and NVMe controller enrichment
- optional command enrichment via `lscpu`, `lsblk`, `ip`, `lsmem`, `hostnamectl`, `lspci`, `lsusb`, and `ethtool`

### Darwin arm64

- `system_profiler` hardware, storage, display, Wi-Fi, USB, audio, camera, Bluetooth, Thunderbolt, and power data
- `networksetup` hardware-port mapping
- live `ifconfig` network-interface enrichment
- optional plist enrichment via `diskutil`, `diskutil apfs list -plist`, and `ioreg`

## Development

```bash
npm test
```

## License

MIT
