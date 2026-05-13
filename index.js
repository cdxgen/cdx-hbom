import process from "node:process";

export {
  parsePlist,
  parsePlistArray,
  parsePlistDict,
} from "./src/common/plist.js";
export {
  commandsExecuted,
  safeExistsSync,
  safeMkdirSync,
  safeReaddirSync,
  safeReadFileSync,
  safeReadlinkSync,
  safeSpawnSync,
} from "./src/common/safe.js";
export {
  createHbomDocument,
  HBOM_BOM_FORMAT,
  HBOM_SCHEMA_URL,
  HBOM_SPEC_VERSION,
} from "./src/common/schema.js";
export {
  createCollectorTrace,
  getCollectorTrace,
  HBOM_TRACE_SYMBOL,
} from "./src/common/trace.js";

import {
  attachCollectorTrace,
  createCollectorTrace,
  withCollectorTrace,
} from "./src/common/trace.js";
import {
  buildDarwinArm64Hbom,
  collectDarwinArm64Hardware,
  getDarwinArm64CommandPlan,
} from "./src/darwin/arm64/index.js";
import {
  buildLinuxAmd64Hbom,
  collectLinuxAmd64Hardware,
  getLinuxAmd64CommandPlan,
} from "./src/linux/amd64/index.js";
import {
  buildLinuxArm64Hbom,
  collectLinuxArm64Hardware,
  getLinuxArm64CommandPlan,
} from "./src/linux/arm64/index.js";

/**
 * Supported hardware discovery targets.
 *
 * @type {ReadonlyArray<{ platform: string, architecture: string }>}
 */
export const SUPPORTED_TARGETS = Object.freeze([
  Object.freeze({
    platform: "darwin",
    architecture: "arm64",
  }),
  Object.freeze({
    platform: "linux",
    architecture: "amd64",
  }),
  Object.freeze({
    platform: "linux",
    architecture: "arm64",
  }),
]);

/**
 * Return the command plan for a target.
 *
 * @param {{ platform?: string, architecture?: string }} [options={}] Target selector.
 * @returns {ReadonlyArray<object>} Command descriptors.
 */
export function getCommandPlan(options = {}) {
  const platform = normalizePlatform(options.platform ?? process.platform);
  const architecture = normalizeArchitecture(
    options.architecture ?? process.arch,
  );

  if (platform === "darwin" && architecture === "arm64") {
    return getDarwinArm64CommandPlan();
  }
  if (platform === "linux" && architecture === "amd64") {
    return getLinuxAmd64CommandPlan();
  }
  if (platform === "linux" && architecture === "arm64") {
    return getLinuxArm64CommandPlan();
  }

  throw new Error(`Unsupported HBOM target: ${platform}/${architecture}`);
}

/**
 * Collect hardware inventory for the requested target.
 *
 * On Linux, `includePrivilegedEnrichment: true` enables SMBIOS enrichment via
 * `dmidecode` and allows an explicit non-interactive `sudo -n` retry for
 * commands that opt in to permission-denied retry behavior (currently
 * `drm_info`). Upstream callers should expect that this usually requires root
 * privileges or passwordless sudo on the target host.
 *
 * @param {{
 *   platform?: string,
 *   architecture?: string,
 *   includeSensitiveIdentifiers?: boolean,
 *   includeCommandEnrichment?: boolean,
 *   includePlistEnrichment?: boolean,
 *   timeoutMs?: number,
 *   allowPartial?: boolean
 * }} [options={}] Collector options.
 * @returns {Promise<object>} HBOM-like inventory object.
 */
export async function collectHardware(options = {}) {
  const platform = normalizePlatform(options.platform ?? process.platform);
  const architecture = normalizeArchitecture(
    options.architecture ?? process.arch,
  );
  const trace = options.trace ?? createCollectorTrace();

  return withCollectorTrace(trace, async () => {
    let bom;

    if (platform === "darwin" && architecture === "arm64") {
      bom = await collectDarwinArm64Hardware({
        ...options,
        trace,
      });
    } else if (platform === "linux" && architecture === "amd64") {
      bom = await collectLinuxAmd64Hardware({
        ...options,
        trace,
      });
    } else if (platform === "linux" && architecture === "arm64") {
      bom = await collectLinuxArm64Hardware({
        ...options,
        trace,
      });
    } else {
      throw new Error(`Unsupported HBOM target: ${platform}/${architecture}`);
    }

    return attachCollectorTrace(bom, trace);
  });
}

/**
 * Build an HBOM-like object from pre-collected sources.
 *
 * @param {{
 *   platform?: string,
 *   architecture?: string,
 *   sources: {
 *     profiler?: Record<string, unknown>,
 *     sysctl?: Record<string, string>,
 *     networksetup?: Array<Record<string, string>>,
 *     ifconfig?: Record<string, { flags?: string[], mtu?: number, macAddress?: string, ipv4Count: number, ipv6Count: number, media?: string, status?: string }>,
 *     pmsetBattery?: Record<string, unknown> | null,
 *     diskutilPlists?: Record<string, unknown>[],
 *     ioregPlatform?: Record<string, unknown>[] | Record<string, unknown> | null,
 *     usb?: unknown[],
 *     airport?: unknown[],
 *     audio?: unknown[],
 *     camera?: unknown[],
 *     apfsTopology?: Record<string, unknown>,
 *     osRelease?: Record<string, string>,
 *     cpuInfo?: Array<Record<string, string>>,
 *     memInfo?: Record<string, { value: number, unit?: string }>,
 *     dmiInfo?: Record<string, string>,
 *     deviceTree?: {
 *       model?: string,
 *       compatible?: string[],
 *       serialNumber?: string,
 *       linuxRevision?: string,
 *       linuxSerial?: string
 *     },
 *     networkInterfaces?: Array<Record<string, unknown>>,
 *     blockDevices?: Array<Record<string, unknown>>,
 *     powerSupplies?: Array<Record<string, unknown>>,
 *     hwmonDevices?: Array<Record<string, unknown>>,
 *     thermalZones?: Array<Record<string, unknown>>,
 *     tpmDevices?: Array<Record<string, unknown>>,
 *     nvmeControllers?: Array<Record<string, unknown>>,
 *     audioCards?: Array<Record<string, unknown>>,
 *     audioPcm?: Array<Record<string, unknown>>,
 *     videoDevices?: Array<Record<string, unknown>>,
 *     mmcDevices?: Array<Record<string, unknown>>,
 *     lscpu?: Record<string, string>,
 *     lsblk?: Array<Record<string, unknown>>,
 *     ipLink?: Array<Record<string, unknown>>,
 *     hostnamectl?: Record<string, string>,
 *     pciDevices?: Array<Record<string, string>>,
 *     pciSysfsDevices?: Array<Record<string, unknown>>,
 *     usbDevices?: Array<Record<string, string>>,
 *     usbSysfsDevices?: Array<Record<string, unknown>>,
 *     dmidecode?: { system: Record<string, string>, baseboard: Record<string, string>, bios: Record<string, string> },
 *     lsmem?: Array<Record<string, unknown>>,
 *     lshw?: Array<Record<string, unknown>>,
 *     ethtool?: Record<string, Record<string, string>>,
 *     drmDevices?: Array<Record<string, unknown>>
 *   },
 *   includeSensitiveIdentifiers?: boolean,
 *   collectedAt?: string
 * }} options Build inputs.
 * @returns {object} HBOM-like inventory object.
 */
export function buildHardwareFromSources(options) {
  const platform = normalizePlatform(options?.platform ?? process.platform);
  const architecture = normalizeArchitecture(
    options?.architecture ?? process.arch,
  );
  let bom;

  if (platform === "darwin" && architecture === "arm64") {
    bom = buildDarwinArm64Hbom(options);
  } else if (platform === "linux" && architecture === "amd64") {
    bom = buildLinuxAmd64Hbom(options);
  } else if (platform === "linux" && architecture === "arm64") {
    bom = buildLinuxArm64Hbom(options);
  } else {
    throw new Error(`Unsupported HBOM target: ${platform}/${architecture}`);
  }

  return attachCollectorTrace(bom, options?.trace);
}

/**
 * Normalize a platform string for target routing.
 *
 * @param {string | undefined} platform Platform value.
 * @returns {string} Normalized platform.
 */
function normalizePlatform(platform) {
  return String(platform ?? "").toLowerCase();
}

/**
 * Normalize architecture aliases used by Node.js, uname, and user input.
 *
 * Examples:
 *
 * - `x64` -> `amd64`
 * - `x86_64` -> `amd64`
 * - `aarch64` -> `arm64`
 *
 * @param {string | undefined} architecture Architecture value.
 * @returns {string} Normalized architecture.
 */
function normalizeArchitecture(architecture) {
  const normalized = String(architecture ?? "").toLowerCase();

  if (["x64", "x86_64", "x86-64"].includes(normalized)) {
    return "amd64";
  }
  if (["aarch64", "armv8", "arm64e"].includes(normalized)) {
    return "arm64";
  }

  return normalized;
}
