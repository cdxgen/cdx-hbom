import { readlinkSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { runCommand } from "../../common/command.js";
import { createHbomDocument } from "../../common/schema.js";
import {
  compact,
  createComponent,
  createHardwareComponent,
  createProperty,
  redactIdentifier,
} from "../../common/shape.js";
import {
  safeExistsSync,
  safeReadFileSync,
  safeReaddirSync,
} from "../../common/safe.js";
import { LINUX_COMMON_COMMANDS } from "./commands.js";

/**
 * Return a copy of the Linux command plan.
 *
 * @returns {ReadonlyArray<object>} Command descriptors.
 */
export function getLinuxCommandPlan() {
  return LINUX_COMMON_COMMANDS.map((spec) => ({
    ...spec,
    args: [...spec.args],
    sensitiveFields: spec.sensitiveFields ? [...spec.sensitiveFields] : undefined,
  }));
}

/**
 * Parse `/etc/os-release` style content.
 *
 * @param {string} stdout File contents.
 * @returns {Record<string, string>} Parsed values.
 */
export function parseOsRelease(stdout) {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .reduce((result, line) => {
      const equalsIndex = line.indexOf("=");
      const key = line.slice(0, equalsIndex);
      result[key] = unquoteOsReleaseValue(line.slice(equalsIndex + 1));
      return result;
    }, /** @type {Record<string, string>} */ ({}));
}

/**
 * Parse `/proc/cpuinfo` into per-processor records.
 *
 * @param {string} stdout File contents.
 * @returns {Array<Record<string, string>>} Parsed processor records.
 */
export function parseCpuInfo(stdout) {
  return stdout
    .trim()
    .split(/\n\s*\n/u)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) =>
      block.split(/\r?\n/u).reduce((result, line) => {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex === -1) {
          return result;
        }
        const key = line.slice(0, separatorIndex).trim();
        result[key] = line.slice(separatorIndex + 1).trim();
        return result;
      }, /** @type {Record<string, string>} */ ({})),
    );
}

/**
 * Parse `/proc/meminfo` into a key/value map.
 *
 * @param {string} stdout File contents.
 * @returns {Record<string, { value: number, unit?: string }>} Parsed values.
 */
export function parseMemInfo(stdout) {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((result, line) => {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex === -1) {
        return result;
      }
      const key = line.slice(0, separatorIndex).trim();
      const rawValue = line.slice(separatorIndex + 1).trim();
      const match = rawValue.match(/^(\d+)(?:\s+(\S+))?$/u);
      if (!match) {
        return result;
      }
      result[key] = {
        value: Number.parseInt(match[1], 10),
        unit: match[2],
      };
      return result;
    }, /** @type {Record<string, { value: number, unit?: string }>} */ ({}));
}

/**
 * Parse `lscpu -J` output.
 *
 * @param {string} stdout Command stdout.
 * @returns {Record<string, string>} Parsed values.
 */
export function parseLscpuJson(stdout) {
  const parsed = JSON.parse(stdout);
  const rows = Array.isArray(parsed?.lscpu) ? parsed.lscpu : [];

  return rows.reduce((result, row) => {
    const field = typeof row?.field === "string" ? row.field : "";
    const data = typeof row?.data === "string" ? row.data : "";
    if (!field) {
      return result;
    }
    result[field.replace(/:\s*$/u, "").trim()] = data.trim();
    return result;
  }, /** @type {Record<string, string>} */ ({}));
}

/**
 * Parse `lsblk -J -b -O` output.
 *
 * @param {string} stdout Command stdout.
 * @returns {Array<Record<string, unknown>>} Flattened block devices.
 */
export function parseLsblkJson(stdout) {
  const parsed = JSON.parse(stdout);
  const devices = Array.isArray(parsed?.blockdevices) ? parsed.blockdevices : [];
  return flattenLsblkDevices(devices);
}

/**
 * Parse `ip -j link show` output.
 *
 * @param {string} stdout Command stdout.
 * @returns {Array<Record<string, unknown>>} Parsed interfaces.
 */
export function parseIpLinkJson(stdout) {
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Parse `hostnamectl --json=short status` output.
 *
 * @param {string} stdout Command stdout.
 * @returns {Record<string, string>} Parsed values.
 */
export function parseHostnamectlJson(stdout) {
  const parsed = JSON.parse(stdout);

  return Object.entries(parsed ?? {}).reduce((result, [key, value]) => {
    if (typeof value === "string") {
      result[key] = value;
    }
    return result;
  }, /** @type {Record<string, string>} */ ({}));
}

/**
 * Parse `lspci -Dvmmnn` output.
 *
 * @param {string} stdout Command stdout.
 * @returns {Array<Record<string, string>>} Parsed PCI records.
 */
export function parseLspciVmmnn(stdout) {
  return stdout
    .trim()
    .split(/\n\s*\n/u)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) =>
      block.split(/\r?\n/u).reduce((result, line) => {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex === -1) {
          return result;
        }
        const key = line.slice(0, separatorIndex).trim();
        result[key] = line.slice(separatorIndex + 1).trim();
        return result;
      }, /** @type {Record<string, string>} */ ({})),
    );
}

/**
 * Parse `lsusb` output.
 *
 * @param {string} stdout Command stdout.
 * @returns {Array<Record<string, string>>} Parsed USB records.
 */
export function parseLsusbText(stdout) {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(
        /^Bus\s+(\d+)\s+Device\s+(\d+):\s+ID\s+([0-9a-f]{4}):([0-9a-f]{4})\s*(.*)$/iu,
      );
      if (!match) {
        return [];
      }
      return [
        {
          bus: match[1],
          device: match[2],
          vendorId: match[3].toLowerCase(),
          productId: match[4].toLowerCase(),
          description: match[5].trim(),
        },
      ];
    });
}

/**
 * Parse `lsmem --json` output.
 *
 * @param {string} stdout Command stdout.
 * @returns {Array<Record<string, unknown>>} Parsed memory ranges.
 */
export function parseLsmemJson(stdout) {
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed?.memory) ? parsed.memory : [];
}

/**
 * Parse `lshw -json` output.
 *
 * @param {string} stdout Command stdout.
 * @returns {Array<Record<string, unknown>>} Parsed lshw roots.
 */
export function parseLshwJson(stdout) {
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
}

/**
 * Parse `ethtool -i <iface>` output.
 *
 * @param {string} stdout Command stdout.
 * @returns {Record<string, string>} Parsed driver info.
 */
export function parseEthtoolDriverInfo(stdout) {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((result, line) => {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex === -1) {
        return result;
      }
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (value) {
        result[key] = value;
      }
      return result;
    }, /** @type {Record<string, string>} */ ({}));
}

/**
 * Parse `dmidecode` text output for selected handles.
 *
 * @param {string} stdout Command stdout.
 * @returns {{ system: Record<string, string>, baseboard: Record<string, string>, bios: Record<string, string> }} Parsed values.
 */
export function parseDmidecodeText(stdout) {
  const sections = {
    system: {},
    baseboard: {},
    bios: {},
  };
  let currentSection;

  stdout.split(/\r?\n/u).forEach((line) => {
    const trimmed = line.trimEnd();
    if (trimmed === "System Information") {
      currentSection = "system";
      return;
    }
    if (trimmed === "Base Board Information") {
      currentSection = "baseboard";
      return;
    }
    if (trimmed === "BIOS Information") {
      currentSection = "bios";
      return;
    }
    if (!currentSection || !trimmed.startsWith("\t")) {
      return;
    }
    const normalized = trimmed.trim();
    const separatorIndex = normalized.indexOf(":");
    if (separatorIndex === -1) {
      return;
    }
    const key = normalized.slice(0, separatorIndex).trim();
    const value = normalized.slice(separatorIndex + 1).trim();
    if (value) {
      sections[currentSection][key] = value;
    }
  });

  return sections;
}

/**
 * Build a Linux hardware BOM from pre-collected sources.
 *
 * @param {{
 *   architecture: string,
 *   sources: {
 *     osRelease?: Record<string, string>,
 *     cpuInfo?: Array<Record<string, string>>,
 *     memInfo?: Record<string, { value: number, unit?: string }>,
 *     dmiInfo?: Record<string, string>,
 *     networkInterfaces?: Array<Record<string, unknown>>,
 *     blockDevices?: Array<Record<string, unknown>>,
 *     powerSupplies?: Array<Record<string, unknown>>,
 *     lscpu?: Record<string, string>,
 *     lsblk?: Array<Record<string, unknown>>,
 *     ipLink?: Array<Record<string, unknown>>,
 *     hostnamectl?: Record<string, string>,
 *     pciDevices?: Array<Record<string, string>>,
 *     usbDevices?: Array<Record<string, string>>,
 *     dmidecode?: { system: Record<string, string>, baseboard: Record<string, string>, bios: Record<string, string> },
 *     lsmem?: Array<Record<string, unknown>>,
 *     lshw?: Array<Record<string, unknown>>,
 *     ethtool?: Record<string, Record<string, string>>
 *   },
 *   includeSensitiveIdentifiers?: boolean,
 *   collectedAt?: string,
 *   executedCommands?: Array<{ id: string, category: string, command: string, args: string[] }>,
 *   observedFiles?: string[]
 * }} options Build inputs.
 * @returns {object} CycloneDX BOM.
 */
export function buildLinuxHbom(options) {
  const sources = options.sources ?? {};
  const architecture = options.architecture;
  const osRelease = sources.osRelease ?? {};
  const cpuInfo = sources.cpuInfo ?? [];
  const memInfo = sources.memInfo ?? {};
  const dmiInfo = sources.dmiInfo ?? {};
  const dmidecode = sources.dmidecode ?? { system: {}, baseboard: {}, bios: {} };
  const networkInterfaces = mergeNetworkSources(
    sources.networkInterfaces ?? [],
    sources.ipLink ?? [],
  );
  const blockDevices = mergeBlockSources(sources.blockDevices ?? [], sources.lsblk ?? []);
  const powerSupplies = sources.powerSupplies ?? [];
  const lscpu = sources.lscpu ?? {};
  const hostnamectl = sources.hostnamectl ?? {};
  const pciDevices = sources.pciDevices ?? [];
  const usbDevices = sources.usbDevices ?? [];
  const lsmem = sources.lsmem ?? [];
  const lshw = sources.lshw ?? [];
  const ethtool = sources.ethtool ?? {};
  const timestamp = options.collectedAt ?? new Date().toISOString();
  const identifierPolicy = options.includeSensitiveIdentifiers
    ? "raw-identifiers-enabled"
    : "redacted-by-default";
  const manufacturer =
    hostnamectl.HardwareVendor ??
    dmiInfo.sys_vendor ??
    dmidecode.system.Manufacturer ??
    findLshwSystemField(lshw, "vendor") ??
    dmiInfo.board_vendor ??
    dmiInfo.chassis_vendor ??
    "Linux";
  const modelName =
    hostnamectl.HardwareModel ??
    dmiInfo.product_name ??
    dmidecode.system["Product Name"] ??
    findLshwSystemField(lshw, "product") ??
    osRelease.NAME ??
    "Linux Device";
  const modelVersion =
    dmiInfo.product_version ??
    dmidecode.system.Version ??
    findLshwCpuField(lshw, "version") ??
    architecture;
  const processorName =
    lscpu["Model name"] ??
    cpuInfo[0]?.["model name"] ??
    cpuInfo[0]?.Hardware ??
    cpuInfo[0]?.Processor ??
    "Processor";
  const memoryBytes = memInfo.MemTotal?.unit === "kB"
    ? memInfo.MemTotal.value * 1024
    : memInfo.MemTotal?.value;
  const lshwMemoryBytes = findLshwMemorySize(lshw);
  const normalizedMemoryBytes = memoryBytes ?? lshwMemoryBytes;
  const memoryDisplay = normalizedMemoryBytes ? formatBytes(normalizedMemoryBytes) : undefined;
  const deviceComponent = createComponent({
    type: "device",
    name: modelName,
    version: modelVersion,
    manufacturer: { name: manufacturer },
    description: processorName,
    properties: compact([
      createProperty("hbom:platform", "linux"),
      createProperty("hbom:architecture", architecture),
      createProperty("hbom:chip", processorName),
      createProperty("hbom:memory", memoryDisplay),
      createProperty(
        "hbom:serialNumber",
        redactIdentifier(
          dmiInfo.product_serial ??
            dmidecode.system["Serial Number"] ??
            findLshwSystemField(lshw, "serial"),
          options,
        ),
      ),
      createProperty(
        "hbom:platformUuid",
        redactIdentifier(dmiInfo.product_uuid, options),
      ),
      createProperty("hbom:boardVendor", dmiInfo.board_vendor),
      createProperty("hbom:boardName", dmiInfo.board_name),
      createProperty("hbom:biosVendor", dmiInfo.bios_vendor),
      createProperty("hbom:biosVersion", dmiInfo.bios_version),
      createProperty(
        "hbom:firmwareDate",
        normalizeHostnamectlFirmwareDate(hostnamectl.FirmwareDate) ??
          dmiInfo.bios_date ??
          dmidecode.bios["Release Date"],
      ),
      createProperty("hbom:chassisType", dmiInfo.chassis_type ?? hostnamectl.Chassis),
      createProperty("hbom:identifierPolicy", identifierPolicy),
    ]),
  });
  const components = compact([
    createHardwareComponent("processor", {
      name: processorName,
      version: architecture,
      manufacturer: {
        name:
          lscpu["Vendor ID"] ??
          cpuInfo[0]?.vendor_id ??
          cpuInfo[0]?.["CPU implementer"] ??
          manufacturer,
      },
      properties: compact([
        createProperty(
          "hbom:architecture",
          lscpu.Architecture ?? architecture,
        ),
        createProperty("hbom:addressSizes", lscpu["Address sizes"]),
        createProperty("hbom:byteOrder", lscpu["Byte Order"]),
        createProperty(
          "hbom:coreCount",
          derivePhysicalCoreCount(lscpu, cpuInfo),
        ),
        createProperty(
          "hbom:logicalCpuCount",
          lscpu["CPU(s)"] ?? cpuInfo.length,
        ),
        createProperty("hbom:socketCount", lscpu["Socket(s)"]),
        createProperty("hbom:threadsPerCore", lscpu["Thread(s) per core"]),
        createProperty("hbom:vendorId", lscpu["Vendor ID"] ?? cpuInfo[0]?.vendor_id),
        createProperty("hbom:cpuFamily", cpuInfo[0]?.["cpu family"]),
        createProperty("hbom:model", cpuInfo[0]?.model),
        createProperty("hbom:stepping", cpuInfo[0]?.stepping),
      ]),
    }),
    normalizedMemoryBytes
      ? createHardwareComponent("memory", {
          name: "System Memory",
          properties: compact([
            createProperty("hbom:size", memoryDisplay),
            createProperty("hbom:sizeBytes", normalizedMemoryBytes),
            createProperty("hbom:memoryRangeCount", lsmem.length || undefined),
            createProperty(
              "hbom:memoryOnlineSize",
              summarizeLsmemOnlineMemory(lsmem),
            ),
          ]),
        })
      : undefined,
    ...collectFirmwareAndBoardComponents(
      dmiInfo,
      dmidecode,
      hostnamectl,
      lshw,
      options,
    ),
    ...blockDevices.map((device) =>
      createHardwareComponent("storage", {
        name:
          getStringValue(device.model) ??
          getStringValue(device.name) ??
          "Block Device",
        version: getStringValue(device.name),
        manufacturer: getStringValue(device.vendor)
          ? { name: getStringValue(device.vendor) }
          : undefined,
        properties: compact([
          createProperty("hbom:capacityBytes", getNumberValue(device.size)),
          createProperty(
            "hbom:capacity",
            formatBytes(getNumberValue(device.size)),
          ),
          createProperty(
            "hbom:deviceSerial",
            redactIdentifier(getStringValue(device.serial), options),
          ),
          createProperty("hbom:subsystem", getStringValue(device.subsystem)),
          createProperty("hbom:isRemovable", getBooleanValue(device.removable)),
          createProperty("hbom:isRotational", getBooleanValue(device.rotational)),
          createProperty("hbom:transport", getStringValue(device.transport)),
          createProperty("hbom:blockSize", getNumberValue(device.logicalBlockSize)),
        ]),
      }),
    ),
    ...networkInterfaces.map((device) =>
      createHardwareComponent("network-interface", {
        name: getStringValue(device.name) ?? "Network Interface",
        version: getStringValue(device.ifname),
        properties: compact([
          createProperty(
            "hbom:driver",
            ethtool[getStringValue(device.ifname)]?.driver,
          ),
          createProperty(
            "hbom:macAddress",
            redactIdentifier(getStringValue(device.address)?.toLowerCase(), options),
          ),
          createProperty(
            "hbom:firmwareVersion",
            normalizeEmptyString(
              ethtool[getStringValue(device.ifname)]?.["firmware-version"],
            ),
          ),
          createProperty(
            "hbom:busInfo",
            normalizeEmptyString(ethtool[getStringValue(device.ifname)]?.["bus-info"]),
          ),
          createProperty(
            "hbom:kernelVersion",
            normalizeEmptyString(ethtool[getStringValue(device.ifname)]?.version),
          ),
          createProperty("hbom:operState", getStringValue(device.operstate)),
          createProperty("hbom:mtu", getNumberValue(device.mtu)),
          createProperty("hbom:speedMbps", getNumberValue(device.speedMbps)),
          createProperty("hbom:duplex", getStringValue(device.duplex)),
          createProperty("hbom:ifindex", getNumberValue(device.ifindex)),
          createProperty("hbom:linkType", getStringValue(device.linkType)),
        ]),
      }),
    ),
    ...powerSupplies.flatMap((supply) =>
      toPowerComponents(supply, options),
    ),
    ...pciDevices.map((device) => createPciComponent(device)),
    ...usbDevices.map((device) => createUsbComponent(device)),
  ]);

  return createHbomDocument({
    metadata: {
      timestamp,
      lifecycles: [{ phase: "operations" }],
      component: deviceComponent,
      tools: {
        components: [
          {
            type: "application",
            name: "cdx-hbom",
          },
        ],
      },
      properties: [],
    },
    components,
    properties: compact([
      createProperty("hbom:targetPlatform", "linux"),
      createProperty("hbom:targetArchitecture", architecture),
      createProperty("hbom:identifierPolicy", identifierPolicy),
      createProperty("hbom:collectorProfile", `linux-${architecture}-v1`),
      createProperty("hbom:osName", osRelease.NAME),
      createProperty("hbom:osVersion", osRelease.VERSION_ID ?? osRelease.VERSION),
      createProperty(
        "hbom:evidence:fileCount",
        options.observedFiles?.length ?? 0,
      ),
      ...(options.observedFiles ?? []).map((filePath) =>
        createProperty("hbom:evidence:file", filePath),
      ),
      createProperty(
        "hbom:evidence:commandCount",
        options.executedCommands?.length ?? 0,
      ),
      ...collectCommandProperties(options.executedCommands ?? []),
    ]),
  });
}

/**
 * Collect Linux hardware inventory for a specific architecture.
 *
 * @param {{
 *   architecture: string,
 *   includeSensitiveIdentifiers?: boolean,
 *   includeCommandEnrichment?: boolean,
 *   // When true, the collector attempts `dmidecode` SMBIOS enrichment.
 *   // On most Linux hosts this requires root privileges or passwordless sudo.
 *   includePrivilegedEnrichment?: boolean,
 *   timeoutMs?: number,
 *   allowPartial?: boolean,
 *   allowedCommands?: string[]
 * }} options Collector options.
 * @returns {Promise<object>} CycloneDX BOM.
 */
export async function collectLinuxHardware(options) {
  if (process.platform !== "linux") {
    throw new Error(
      `Linux collector must run on linux. Current host is ${process.platform}/${process.arch}.`,
    );
  }

  const allowPartial = options.allowPartial ?? true;
  const executedCommands = [];
  const observedFiles = [];
  const sources = collectLinuxFileSources(observedFiles);

  if (options.includeCommandEnrichment !== false) {
    await attemptCollection(
      async () => {
        sources.lscpu = parseLscpuJson(
          await runCommand(getRequiredLinuxCommand("lscpu-json"), options),
        );
        executedCommands.push(toEvidenceCommand(getRequiredLinuxCommand("lscpu-json")));
      },
      allowPartial,
    );
    await attemptCollection(
      async () => {
        sources.lsblk = parseLsblkJson(
          await runCommand(getRequiredLinuxCommand("lsblk-json"), options),
        );
        executedCommands.push(toEvidenceCommand(getRequiredLinuxCommand("lsblk-json")));
      },
      allowPartial,
    );
    await attemptCollection(
      async () => {
        sources.ipLink = parseIpLinkJson(
          await runCommand(getRequiredLinuxCommand("ip-link-json"), options),
        );
        executedCommands.push(toEvidenceCommand(getRequiredLinuxCommand("ip-link-json")));
      },
      allowPartial,
    );
    await attemptCollection(
      async () => {
        sources.lsmem = parseLsmemJson(
          await runCommand(getRequiredLinuxCommand("lsmem-json"), options),
        );
        executedCommands.push(toEvidenceCommand(getRequiredLinuxCommand("lsmem-json")));
      },
      allowPartial,
    );
    await attemptCollection(
      async () => {
        sources.hostnamectl = parseHostnamectlJson(
          await runCommand(getRequiredLinuxCommand("hostnamectl-json"), options),
        );
        executedCommands.push(
          toEvidenceCommand(getRequiredLinuxCommand("hostnamectl-json")),
        );
      },
      allowPartial,
    );
    await attemptCollection(
      async () => {
        sources.lshw = parseLshwJson(
          await runCommand(getRequiredLinuxCommand("lshw-json"), options),
        );
        executedCommands.push(toEvidenceCommand(getRequiredLinuxCommand("lshw-json")));
      },
      allowPartial,
    );
    await attemptCollection(
      async () => {
        sources.pciDevices = parseLspciVmmnn(
          await runCommand(getRequiredLinuxCommand("lspci-vmmnn"), options),
        );
        executedCommands.push(toEvidenceCommand(getRequiredLinuxCommand("lspci-vmmnn")));
      },
      allowPartial,
    );
    await attemptCollection(
      async () => {
        sources.usbDevices = parseLsusbText(
          await runCommand(getRequiredLinuxCommand("lsusb"), options),
        );
        executedCommands.push(toEvidenceCommand(getRequiredLinuxCommand("lsusb")));
      },
      allowPartial,
    );
    sources.ethtool = {};
    const interfaceNames = [
      ...new Set(
        [
          ...(sources.networkInterfaces ?? []).map((entry) => getStringValue(entry.name)),
          ...(sources.ipLink ?? []).map((entry) => getStringValue(entry.ifname)),
        ].filter(Boolean),
      ),
    ];
    for (const interfaceName of interfaceNames) {
      await attemptCollection(
        async () => {
          const spec = createEthtoolCommand(interfaceName);
          sources.ethtool[interfaceName] = parseEthtoolDriverInfo(
            await runCommand(spec, options),
          );
          executedCommands.push(toEvidenceCommand(spec));
        },
        allowPartial,
      );
    }
  }

  if (options.includePrivilegedEnrichment === true) {
    await attemptCollection(
      async () => {
        sources.dmidecode = parseDmidecodeText(
          await runCommand(
            getRequiredLinuxCommand("dmidecode-firmware-board"),
            options,
          ),
        );
        executedCommands.push(
          toEvidenceCommand(getRequiredLinuxCommand("dmidecode-firmware-board")),
        );
      },
      allowPartial,
    );
  }

  return buildLinuxHbom({
    architecture: options.architecture,
    sources,
    includeSensitiveIdentifiers: options.includeSensitiveIdentifiers,
    executedCommands,
    observedFiles,
  });
}

/**
 * Collect Linux file-backed sources from `/proc`, `/sys`, and `/etc`.
 *
 * @param {string[]} observedFiles Mutable list of successfully observed files.
 * @returns {object} Collected sources.
 */
function collectLinuxFileSources(observedFiles) {
  return {
    osRelease: parseOsRelease(
      readFirstExistingTextFile(["/etc/os-release", "/usr/lib/os-release"], observedFiles) ??
        "",
    ),
    cpuInfo: parseCpuInfo(readObservedTextFile("/proc/cpuinfo", observedFiles) ?? ""),
    memInfo: parseMemInfo(readObservedTextFile("/proc/meminfo", observedFiles) ?? ""),
    dmiInfo: readDmiInfo(observedFiles),
    networkInterfaces: readSysfsNetworkInterfaces(observedFiles),
    blockDevices: readSysfsBlockDevices(observedFiles),
    powerSupplies: readPowerSupplies(observedFiles),
  };
}

function readDmiInfo(observedFiles) {
  const basePath = ["/sys/devices/virtual/dmi/id", "/sys/class/dmi/id"].find((candidate) =>
    safeExistsSync(candidate),
  );

  if (!basePath) {
    return {};
  }

  return [
    "product_name",
    "product_version",
    "product_serial",
    "product_uuid",
    "sys_vendor",
    "board_vendor",
    "board_name",
    "board_version",
    "board_serial",
    "bios_vendor",
    "bios_version",
    "bios_date",
    "chassis_vendor",
    "chassis_type",
  ].reduce((result, field) => {
    const value = readObservedTextFile(join(basePath, field), observedFiles);
    if (value) {
      result[field] = value;
    }
    return result;
  }, /** @type {Record<string, string>} */ ({}));
}

function readSysfsNetworkInterfaces(observedFiles) {
  return safeReaddirSync("/sys/class/net")
    .filter((name) => name !== "lo")
    .map((name) => {
      const basePath = join("/sys/class/net", name);
      return {
        name,
        ifname: name,
        address: readObservedTextFile(join(basePath, "address"), observedFiles),
        operstate: readObservedTextFile(join(basePath, "operstate"), observedFiles),
        mtu: toNumber(readObservedTextFile(join(basePath, "mtu"), observedFiles)),
        speedMbps: toNumber(
          readObservedTextFile(join(basePath, "speed"), observedFiles),
        ),
        duplex: readObservedTextFile(join(basePath, "duplex"), observedFiles),
        ifindex: toNumber(
          readObservedTextFile(join(basePath, "ifindex"), observedFiles),
        ),
        linkType: readObservedTextFile(join(basePath, "type"), observedFiles),
      };
    });
}

function readSysfsBlockDevices(observedFiles) {
  return safeReaddirSync("/sys/block")
    .filter((name) => !name.startsWith("loop") && !name.startsWith("ram"))
    .map((name) => {
      const basePath = join("/sys/block", name);
      const sectors = toNumber(readObservedTextFile(join(basePath, "size"), observedFiles));
      const logicalBlockSize = toNumber(
        readObservedTextFile(join(basePath, "queue", "logical_block_size"), observedFiles),
      );
      return {
        name,
        model: readObservedTextFile(join(basePath, "device", "model"), observedFiles),
        vendor: readObservedTextFile(join(basePath, "device", "vendor"), observedFiles),
        serial: readObservedTextFile(join(basePath, "device", "serial"), observedFiles),
        removable:
          readObservedTextFile(join(basePath, "removable"), observedFiles) === "1",
        rotational:
          readObservedTextFile(join(basePath, "queue", "rotational"), observedFiles) === "1",
        subsystem: readObservedLinkBaseName(join(basePath, "subsystem")),
        transport: inferBlockTransport(name, basePath),
        logicalBlockSize,
        size:
          sectors !== undefined
            ? sectors * (logicalBlockSize ?? 512)
            : undefined,
      };
    });
}

function readPowerSupplies(observedFiles) {
  return safeReaddirSync("/sys/class/power_supply").map((name) => {
    const basePath = join("/sys/class/power_supply", name);
    return {
      name,
      type: readObservedTextFile(join(basePath, "type"), observedFiles),
      status: readObservedTextFile(join(basePath, "status"), observedFiles),
      capacity: toNumber(
        readObservedTextFile(join(basePath, "capacity"), observedFiles),
      ),
      cycleCount: toNumber(
        readObservedTextFile(join(basePath, "cycle_count"), observedFiles),
      ),
      manufacturer: readObservedTextFile(
        join(basePath, "manufacturer"),
        observedFiles,
      ),
      modelName: readObservedTextFile(join(basePath, "model_name"), observedFiles),
      serialNumber: readObservedTextFile(
        join(basePath, "serial_number"),
        observedFiles,
      ),
      technology: readObservedTextFile(join(basePath, "technology"), observedFiles),
      online: toNumber(readObservedTextFile(join(basePath, "online"), observedFiles)),
    };
  });
}

function mergeNetworkSources(sysfsInterfaces, ipLinkInterfaces) {
  const ipIndex = new Map(
    ipLinkInterfaces.map((entry) => [getStringValue(entry.ifname), entry]),
  );

  const merged = sysfsInterfaces.map((entry) => {
    const ipEntry = ipIndex.get(getStringValue(entry.name));
    return {
      ...entry,
      address: entry.address ?? getStringValue(ipEntry?.address),
      ifindex: entry.ifindex ?? getNumberValue(ipEntry?.ifindex),
      mtu: entry.mtu ?? getNumberValue(ipEntry?.mtu),
      linkType: getStringValue(ipEntry?.link_type) ?? entry.linkType,
      operstate: getStringValue(ipEntry?.operstate) ?? entry.operstate,
    };
  });

  const existingNames = new Set(
    merged.map((entry) => getStringValue(entry.name)).filter(Boolean),
  );
  const ipOnly = ipLinkInterfaces
    .filter((entry) => {
      const name = getStringValue(entry.ifname);
      return Boolean(name) && name !== "lo" && !existingNames.has(name);
    })
    .map((entry) => ({
      name: getStringValue(entry.ifname),
      ifname: getStringValue(entry.ifname),
      address: getStringValue(entry.address),
      operstate: getStringValue(entry.operstate),
      mtu: getNumberValue(entry.mtu),
      ifindex: getNumberValue(entry.ifindex),
      linkType: getStringValue(entry.link_type),
    }));

  return [...merged, ...ipOnly];
}

function mergeBlockSources(sysfsDevices, lsblkDevices) {
  const lsblkIndex = new Map(
    lsblkDevices
      .map((device) => [getStringValue(device.name), device])
      .filter(([name]) => Boolean(name)),
  );
  const merged = sysfsDevices.map((device) => {
    const lsblk = lsblkIndex.get(getStringValue(device.name));
    return {
      ...device,
      model: device.model ?? getStringValue(lsblk?.model),
      vendor: device.vendor ?? getStringValue(lsblk?.vendor),
      serial: device.serial ?? getStringValue(lsblk?.serial),
      transport: device.transport ?? getStringValue(lsblk?.tran),
      size: device.size ?? getNumberValue(lsblk?.size),
      removable:
        device.removable ?? normalizeBooleanLike(getStringValue(lsblk?.rm)),
      rotational:
        device.rotational ?? normalizeBooleanLike(getStringValue(lsblk?.rota)),
    };
  });

  const existingNames = new Set(
    merged.map((device) => getStringValue(device.name)).filter(Boolean),
  );
  const lsblkOnly = lsblkDevices
    .filter((device) => {
      const name = getStringValue(device.name);
      const type = getStringValue(device.type);
      return Boolean(name) && !existingNames.has(name) && type === "disk";
    })
    .map((device) => ({
      name: getStringValue(device.name),
      model: getStringValue(device.model),
      vendor: getStringValue(device.vendor),
      serial: getStringValue(device.serial),
      transport: getStringValue(device.tran),
      size: getNumberValue(device.size),
      removable: normalizeBooleanLike(getStringValue(device.rm)),
      rotational: normalizeBooleanLike(getStringValue(device.rota)),
      logicalBlockSize: getNumberValue(device.log_sec),
      subsystem: undefined,
    }));

  return [...merged, ...lsblkOnly];
}

function toPowerComponents(supply, options) {
  const type = getStringValue(supply.type)?.toLowerCase();

  if (type === "battery") {
    return [
      createHardwareComponent("power", {
        name: getStringValue(supply.modelName) ?? getStringValue(supply.name) ?? "Battery",
        manufacturer: getStringValue(supply.manufacturer)
          ? { name: getStringValue(supply.manufacturer) }
          : undefined,
        properties: compact([
          createProperty("hbom:chargePercent", getNumberValue(supply.capacity)),
          createProperty("hbom:isCharging", getStringValue(supply.status) === "Charging"),
          createProperty("hbom:status", getStringValue(supply.status)),
          createProperty("hbom:cycleCount", getNumberValue(supply.cycleCount)),
          createProperty("hbom:technology", getStringValue(supply.technology)),
          createProperty(
            "hbom:batterySerialNumber",
            redactIdentifier(getStringValue(supply.serialNumber), options),
          ),
        ]),
      }),
    ];
  }

  return [
    createHardwareComponent("power-adapter", {
      name: getStringValue(supply.name) ?? "Power Supply",
      properties: compact([
        createProperty("hbom:powerSupplyType", getStringValue(supply.type)),
        createProperty("hbom:connected", getNumberValue(supply.online) === 1),
      ]),
    }),
  ];
}

function collectFirmwareAndBoardComponents(
  dmiInfo,
  dmidecode,
  hostnamectl,
  lshw,
  options,
) {
  return compact([
    hasBoardData(dmiInfo, dmidecode, lshw)
      ? createHardwareComponent("board", {
          name:
            dmiInfo.board_name ??
            dmidecode.baseboard["Product Name"] ??
            findLshwMotherboardField(lshw, "product") ??
            findLshwMotherboardField(lshw, "description") ??
            "System Board",
          version:
            dmiInfo.board_version ??
            dmidecode.baseboard.Version ??
            findLshwMotherboardField(lshw, "version"),
          manufacturer:
            dmiInfo.board_vendor ??
            dmidecode.baseboard.Manufacturer ??
            findLshwMotherboardField(lshw, "vendor") ??
            dmiInfo.sys_vendor
              ? {
                  name:
                    dmiInfo.board_vendor ??
                    dmidecode.baseboard.Manufacturer ??
                    findLshwMotherboardField(lshw, "vendor") ??
                    dmiInfo.sys_vendor,
                }
              : undefined,
          properties: compact([
            createProperty(
              "hbom:serialNumber",
              redactIdentifier(
                dmiInfo.board_serial ??
                  dmidecode.baseboard["Serial Number"] ??
                  findLshwMotherboardField(lshw, "serial"),
                options,
              ),
            ),
            createProperty(
              "hbom:assetTag",
              redactIdentifier(dmidecode.baseboard["Asset Tag"], options),
            ),
          ]),
        })
      : undefined,
    hasFirmwareData(dmiInfo, dmidecode, hostnamectl)
      ? createComponent({
          type: "firmware",
          name:
            hostnamectl.FirmwareVersion ??
            dmiInfo.bios_vendor ??
            dmidecode.bios.Vendor ??
            "Firmware",
          version:
            hostnamectl.FirmwareVersion ??
            dmiInfo.bios_version ??
            dmidecode.bios.Version,
          manufacturer: {
            name:
              dmiInfo.bios_vendor ?? dmidecode.bios.Vendor ?? manufacturerFromHost(hostnamectl, dmiInfo),
          },
          properties: compact([
            createProperty(
              "hbom:hardwareClass",
              "firmware",
            ),
            createProperty(
              "hbom:firmwareDate",
              normalizeHostnamectlFirmwareDate(hostnamectl.FirmwareDate) ??
                dmiInfo.bios_date ??
                dmidecode.bios["Release Date"],
            ),
            createProperty(
              "hbom:biosRevision",
              dmidecode.bios["BIOS Revision"],
            ),
          ]),
        })
      : undefined,
    (hostnamectl.Chassis ?? dmiInfo.chassis_type)
      ? createHardwareComponent("chassis", {
          name: hostnamectl.Chassis ?? dmiInfo.chassis_type,
          manufacturer: manufacturerFromHost(hostnamectl, dmiInfo)
            ? { name: manufacturerFromHost(hostnamectl, dmiInfo) }
            : undefined,
        })
      : undefined,
  ]);
}

function createPciComponent(device) {
  const vendorMatch = device.Vendor?.match(/^(.*?)(?:\s+\[([0-9a-f]{4})\])?$/iu);
  const deviceMatch = device.Device?.match(/^(.*?)(?:\s+\[([0-9a-f]{4})\])?$/iu);
  const classMatch = device.Class?.match(/^(.*?)(?:\s+\[([0-9a-f]{4})\])?$/iu);

  return createHardwareComponent("pci-device", {
    name: deviceMatch?.[1]?.trim() || device.Device || "PCI Device",
    version: device.Slot,
    manufacturer: vendorMatch?.[1]?.trim()
      ? { name: vendorMatch[1].trim() }
      : undefined,
    description: classMatch?.[1]?.trim() || device.Class,
    properties: compact([
      createProperty("hbom:pciSlot", device.Slot),
      createProperty("hbom:pciClass", classMatch?.[1]?.trim()),
      createProperty("hbom:pciClassCode", classMatch?.[2]?.toLowerCase()),
      createProperty("hbom:vendorId", vendorMatch?.[2]?.toLowerCase()),
      createProperty("hbom:productId", deviceMatch?.[2]?.toLowerCase()),
      createProperty("hbom:subsystemVendor", device.SVendor),
      createProperty("hbom:subsystemDevice", device.SDevice),
      createProperty("hbom:revision", device.Rev),
      createProperty("hbom:driver", device.Driver),
      createProperty("hbom:kernelModule", device.Module),
    ]),
  });
}

function createUsbComponent(device) {
  return createHardwareComponent("usb-device", {
    name: device.description || `USB ${device.vendorId}:${device.productId}`,
    version: `bus-${device.bus}-device-${device.device}`,
    properties: compact([
      createProperty("hbom:usbBus", device.bus),
      createProperty("hbom:usbDevice", device.device),
      createProperty("hbom:vendorId", device.vendorId),
      createProperty("hbom:productId", device.productId),
    ]),
  });
}

function createEthtoolCommand(interfaceName) {
  return {
    ...getRequiredLinuxCommand("ethtool-driver-info"),
    id: `ethtool-driver-info:${interfaceName}`,
    args: ["-i", interfaceName],
  };
}

function collectCommandProperties(commands) {
  return commands.map((entry) =>
    createProperty(
      "hbom:evidence:command",
      `${entry.id}|${entry.category}|${entry.command}${entry.args.length ? ` ${entry.args.join(" ")}` : ""}`,
    ),
  );
}

async function attemptCollection(action, allowPartial) {
  try {
    await action();
  } catch (error) {
    if (!allowPartial) {
      throw error;
    }
  }
}

function toEvidenceCommand(spec) {
  return {
    id: spec.id,
    category: spec.category,
    command: spec.command,
    args: [...spec.args],
  };
}

function getRequiredLinuxCommand(id) {
  const spec = LINUX_COMMON_COMMANDS.find((candidate) => candidate.id === id);

  if (!spec) {
    throw new Error(`Unknown Linux command: ${id}`);
  }

  return spec;
}

function readObservedTextFile(filePath, observedFiles) {
  const value = safeReadFileSync(filePath, { encoding: "utf8" });

  if (typeof value === "string") {
    observedFiles.push(filePath);
    return value.trim();
  }

  return undefined;
}

function readFirstExistingTextFile(paths, observedFiles) {
  for (const candidate of paths) {
    const value = readObservedTextFile(candidate, observedFiles);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readObservedLinkBaseName(linkPath) {
  try {
    const target = safeExistsSync(linkPath) ? readlinkSync(linkPath) : undefined;
    return target?.split("/").filter(Boolean).at(-1);
  } catch {
    return undefined;
  }
}

function inferBlockTransport(deviceName, basePath) {
  if (deviceName.startsWith("nvme")) {
    return "nvme";
  }
  if (deviceName.startsWith("sd")) {
    return "scsi";
  }
  if (safeExistsSync(join(basePath, "device", "ieee1394_id"))) {
    return "firewire";
  }
  return undefined;
}

function hasBoardData(dmiInfo, dmidecode, lshw) {
  return Boolean(
    dmiInfo.board_name ||
      dmiInfo.board_vendor ||
      dmiInfo.board_version ||
      dmiInfo.board_serial ||
      dmidecode.baseboard?.["Product Name"] ||
      dmidecode.baseboard?.Manufacturer ||
      findLshwMotherboardField(lshw, "product") ||
      findLshwMotherboardField(lshw, "vendor") ||
      findLshwMotherboardField(lshw, "description"),
  );
}

function hasFirmwareData(dmiInfo, dmidecode, hostnamectl) {
  return Boolean(
    hostnamectl.FirmwareVersion ||
      hostnamectl.FirmwareDate ||
      dmiInfo.bios_vendor ||
      dmiInfo.bios_version ||
      dmiInfo.bios_date ||
      dmidecode.bios?.Vendor ||
      dmidecode.bios?.Version,
  );
}

function manufacturerFromHost(hostnamectl, dmiInfo) {
  return hostnamectl.HardwareVendor ?? dmiInfo.sys_vendor ?? dmiInfo.board_vendor;
}

function findLshwSystemField(roots, field) {
  const system = roots.find((entry) => getStringValue(entry.class) === "system") ?? roots[0];
  const value = system?.[field];
  return typeof value === "string" ? value : undefined;
}

function findLshwMemorySize(roots) {
  const memoryNode = walkLshwNodes(roots).find(
    (entry) => getStringValue(entry.class) === "memory" && typeof entry.size === "number",
  );
  return typeof memoryNode?.size === "number" ? memoryNode.size : undefined;
}

function findLshwCpuField(roots, field) {
  const cpuNode = walkLshwNodes(roots).find(
    (entry) => getStringValue(entry.class) === "processor",
  );
  const value = cpuNode?.[field];
  return typeof value === "string" ? value : undefined;
}

function findLshwMotherboardField(roots, field) {
  const boardNode = walkLshwNodes(roots).find(
    (entry) =>
      getStringValue(entry.class) === "bus" &&
      getStringValue(entry.description)?.toLowerCase() === "motherboard",
  );
  const value = boardNode?.[field];
  return typeof value === "string" ? value : undefined;
}

function walkLshwNodes(nodes) {
  return nodes.flatMap((node) => {
    const children = Array.isArray(node?.children) ? node.children : [];
    return [node, ...walkLshwNodes(children)];
  });
}

function summarizeLsmemOnlineMemory(ranges) {
  const totalBytes = ranges.reduce((sum, range) => {
    if (getStringValue(range.state)?.toLowerCase() !== "online") {
      return sum;
    }
    const sizeValue = parseHumanSize(getStringValue(range.size));
    return sum + (sizeValue ?? 0);
  }, 0);

  return totalBytes > 0 ? formatBytes(totalBytes) : undefined;
}

function parseHumanSize(value) {
  if (!value) {
    return undefined;
  }

  const match = value.match(/^(\d+(?:\.\d+)?)\s*([KMGTP]?)(?:i?B)?$/iu);
  if (!match) {
    return undefined;
  }

  const scalar = Number.parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier = {
    "": 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
    P: 1024 ** 5,
  }[unit];

  return Math.round(scalar * multiplier);
}

function normalizeEmptyString(value) {
  if (!value || value === "N/A") {
    return undefined;
  }
  return value;
}

function normalizeHostnamectlFirmwareDate(value) {
  if (!value) {
    return undefined;
  }

  if (/^\d+$/u.test(value)) {
    const asNumber = Number.parseInt(value, 10);
    const milliseconds = value.length >= 16 ? Math.floor(asNumber / 1000) : asNumber;
    if (!Number.isNaN(milliseconds)) {
      return new Date(milliseconds).toISOString().slice(0, 10);
    }
  }

  return value;
}

function derivePhysicalCoreCount(lscpu, cpuInfo) {
  const sockets = toNumber(lscpu["Socket(s)"]);
  const coresPerSocket = toNumber(lscpu["Core(s) per socket"]);
  if (sockets !== undefined && coresPerSocket !== undefined) {
    return sockets * coresPerSocket;
  }

  const cpuCores = toNumber(cpuInfo[0]?.["cpu cores"]);
  const physicalIds = new Set(
    cpuInfo.map((entry) => entry["physical id"]).filter(Boolean),
  );
  if (cpuCores !== undefined && physicalIds.size > 0) {
    return cpuCores * physicalIds.size;
  }
  return cpuCores;
}

function flattenLsblkDevices(devices) {
  return devices.flatMap((device) => {
    const children = Array.isArray(device?.children) ? device.children : [];
    const current =
      getStringValue(device?.type) === "disk"
        ? [device]
        : [];
    return [...current, ...flattenLsblkDevices(children)];
  });
}

function normalizeBooleanLike(value) {
  if (value === undefined) {
    return undefined;
  }
  return value === "1" || value.toLowerCase() === "true";
}

function getStringValue(value) {
  return typeof value === "string" ? value.trim() : undefined;
}

function getNumberValue(value) {
  return typeof value === "number"
    ? value
    : typeof value === "string" && value !== ""
      ? toNumber(value)
      : undefined;
}

function getBooleanValue(value) {
  return typeof value === "boolean" ? value : undefined;
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function formatBytes(bytes) {
  if (!bytes || Number.isNaN(bytes)) {
    return undefined;
  }

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

function unquoteOsReleaseValue(value) {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed;
  }

  return trimmed
    .slice(1, -1)
    .replace(/\\"/gu, '"')
    .replace(/\\\\/gu, "\\")
    .replace(/\\n/gu, "\n");
}
