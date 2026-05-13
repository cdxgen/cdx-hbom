import { Buffer } from "node:buffer";
import { join } from "node:path";
import process from "node:process";

import { runCommand } from "../../common/command.js";
import {
  safeExistsSync,
  safeReaddirSync,
  safeReadFileSync,
  safeReadlinkSync,
} from "../../common/safe.js";
import { createHbomDocument } from "../../common/schema.js";
import {
  compact,
  createComponent,
  createHardwareComponent,
  createProperty,
  redactIdentifier,
} from "../../common/shape.js";
import { attachCollectorTrace } from "../../common/trace.js";
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
    sensitiveFields: spec.sensitiveFields
      ? [...spec.sensitiveFields]
      : undefined,
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
    .reduce(
      (result, line) => {
        const equalsIndex = line.indexOf("=");
        const key = line.slice(0, equalsIndex);
        result[key] = unquoteOsReleaseValue(line.slice(equalsIndex + 1));
        return result;
      },
      /** @type {Record<string, string>} */ ({}),
    );
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
      block.split(/\r?\n/u).reduce(
        (result, line) => {
          const separatorIndex = line.indexOf(":");
          if (separatorIndex === -1) {
            return result;
          }
          const key = line.slice(0, separatorIndex).trim();
          result[key] = line.slice(separatorIndex + 1).trim();
          return result;
        },
        /** @type {Record<string, string>} */ ({}),
      ),
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
    .reduce(
      (result, line) => {
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
      },
      /** @type {Record<string, { value: number, unit?: string }>} */ ({}),
    );
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

  return rows.reduce(
    (result, row) => {
      const field = typeof row?.field === "string" ? row.field : "";
      const data = typeof row?.data === "string" ? row.data : "";
      if (!field) {
        return result;
      }
      result[field.replace(/:\s*$/u, "").trim()] = data.trim();
      return result;
    },
    /** @type {Record<string, string>} */ ({}),
  );
}

/**
 * Parse `lsblk -J -b -O` output.
 *
 * @param {string} stdout Command stdout.
 * @returns {Array<Record<string, unknown>>} Flattened block devices.
 */
export function parseLsblkJson(stdout) {
  const parsed = JSON.parse(stdout);
  const devices = Array.isArray(parsed?.blockdevices)
    ? parsed.blockdevices
    : [];
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

  return Object.entries(parsed ?? {}).reduce(
    (result, [key, value]) => {
      if (typeof value === "string") {
        result[key] = value;
      }
      return result;
    },
    /** @type {Record<string, string>} */ ({}),
  );
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
      block.split(/\r?\n/u).reduce(
        (result, line) => {
          const separatorIndex = line.indexOf(":");
          if (separatorIndex === -1) {
            return result;
          }
          const key = line.slice(0, separatorIndex).trim();
          result[key] = line.slice(separatorIndex + 1).trim();
          return result;
        },
        /** @type {Record<string, string>} */ ({}),
      ),
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
    .reduce(
      (result, line) => {
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
      },
      /** @type {Record<string, string>} */ ({}),
    );
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
 * Parse `/proc/asound/cards` output.
 *
 * @param {string} stdout File contents.
 * @returns {Array<Record<string, unknown>>} Parsed ALSA cards.
 */
export function parseAsoundCards(stdout) {
  const cards = [];
  let currentCard;

  stdout.split(/\r?\n/u).forEach((line) => {
    const headerMatch = line.match(
      /^\s*(\d+)\s+\[(.*?)\s*\]:\s*(.*?)\s+-\s+(.*)$/u,
    );
    if (headerMatch) {
      currentCard = {
        number: Number.parseInt(headerMatch[1], 10),
        id: headerMatch[2].trim(),
        interfaceType: headerMatch[3].trim(),
        name: headerMatch[4].trim(),
      };
      cards.push(currentCard);
      return;
    }

    if (currentCard && line.trim()) {
      currentCard.longName = currentCard.longName
        ? `${currentCard.longName} ${line.trim()}`
        : line.trim();
    }
  });

  return cards;
}

/**
 * Parse `/proc/asound/pcm` output.
 *
 * @param {string} stdout File contents.
 * @returns {Array<Record<string, unknown>>} Parsed ALSA PCM entries.
 */
export function parseAsoundPcm(stdout) {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(
        /^(\d+)-(\d+):\s*(.*?)\s*:\s*(.*?)(?:\s*:\s*(.*))?$/u,
      );
      if (!match) {
        return [];
      }

      const properties = (match[5] ?? "")
        .split(/\s*:\s*/u)
        .map((entry) => entry.trim())
        .filter(Boolean);

      return [
        {
          cardNumber: Number.parseInt(match[1], 10),
          deviceNumber: Number.parseInt(match[2], 10),
          id: match[3].trim(),
          name: match[4].trim(),
          playbackCount: extractTrailingCount(
            properties.find((entry) => entry.startsWith("playback")),
          ),
          captureCount: extractTrailingCount(
            properties.find((entry) => entry.startsWith("capture")),
          ),
        },
      ];
    });
}

/**
 * Parse a DRM EDID blob.
 *
 * @param {Buffer | undefined} buffer Raw EDID bytes.
 * @returns {Record<string, unknown> | undefined} Parsed EDID summary.
 */
export function parseEdidBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 128) {
    return undefined;
  }

  if (buffer.subarray(0, 8).toString("hex") !== "00ffffffffffff00") {
    return undefined;
  }

  const descriptorBlocks = Array.from({ length: 4 }, (_, index) =>
    buffer.subarray(54 + index * 18, 54 + (index + 1) * 18),
  );
  const serialNumberNumeric = buffer.readUInt32LE(12);
  const serialDescriptor = descriptorBlocks
    .map((block) => decodeEdidTextDescriptor(block, 0xff))
    .find(Boolean);

  return {
    manufacturerId: decodeEdidManufacturerId(buffer[8], buffer[9]),
    productId: buffer.readUInt16LE(10).toString(16).padStart(4, "0"),
    serialNumber:
      serialDescriptor ??
      (serialNumberNumeric > 0 ? String(serialNumberNumeric) : undefined),
    name: descriptorBlocks
      .map((block) => decodeEdidTextDescriptor(block, 0xfc))
      .find(Boolean),
    weekOfManufacture: buffer[16] || undefined,
    yearOfManufacture: buffer[17] ? 1990 + buffer[17] : undefined,
    version: `${buffer[18]}.${buffer[19]}`,
    widthCm: buffer[21] || undefined,
    heightCm: buffer[22] || undefined,
    preferredResolution: decodeEdidPreferredTiming(buffer.subarray(54, 72)),
  };
}

/**
 * Parse Linux hwmon chip attributes from a name/value map.
 *
 * @param {Record<string, string | number | undefined>} input Hwmon attribute map.
 * @returns {Record<string, unknown>} Normalized hwmon summary.
 */
export function parseHwmonAttributes(input) {
  const temperatureSensors = collectIndexedSensors(
    input,
    "temp",
    "input",
    1000,
  );
  const fanSensors = collectIndexedSensors(input, "fan", "input", 1);

  return {
    name: getStringValue(input.name),
    temperatureSensors,
    fanSensors,
    pwmValues: collectIndexedScalarValues(input, "pwm"),
  };
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
  const deviceTree = sources.deviceTree ?? {};
  const dmidecode = sources.dmidecode ?? {
    system: {},
    baseboard: {},
    bios: {},
  };
  const networkInterfaces = mergeNetworkSources(
    sources.networkInterfaces ?? [],
    sources.ipLink ?? [],
  );
  const blockDevices = mergeBlockSources(
    sources.blockDevices ?? [],
    sources.lsblk ?? [],
  );
  const powerSupplies = sources.powerSupplies ?? [];
  const hwmonDevices = sources.hwmonDevices ?? [];
  const thermalZones = sources.thermalZones ?? [];
  const tpmDevices = sources.tpmDevices ?? [];
  const nvmeControllers = sources.nvmeControllers ?? [];
  const audioCards = sources.audioCards ?? [];
  const audioPcm = sources.audioPcm ?? [];
  const videoDevices = sources.videoDevices ?? [];
  const mmcDevices = sources.mmcDevices ?? [];
  const lscpu = sources.lscpu ?? {};
  const hostnamectl = sources.hostnamectl ?? {};
  const pciDevices = mergePciSources(
    sources.pciDevices ?? [],
    sources.pciSysfsDevices ?? [],
  );
  const usbDevices = mergeUsbSources(
    sources.usbDevices ?? [],
    sources.usbSysfsDevices ?? [],
  );
  const lsmem = sources.lsmem ?? [];
  const lshw = sources.lshw ?? [];
  const lshwNodes = walkLshwNodes(lshw);
  const ethtool = sources.ethtool ?? {};
  const drmDevices = sources.drmDevices ?? [];
  const timestamp = options.collectedAt ?? new Date().toISOString();
  const identifierPolicy = options.includeSensitiveIdentifiers
    ? "raw-identifiers-enabled"
    : "redacted-by-default";
  const manufacturer =
    normalizeIdentityString(hostnamectl.HardwareVendor) ??
    normalizeIdentityString(dmiInfo.sys_vendor) ??
    normalizeIdentityString(dmidecode.system.Manufacturer) ??
    normalizeIdentityString(findLshwSystemField(lshw, "vendor")) ??
    normalizeIdentityString(dmiInfo.board_vendor) ??
    normalizeIdentityString(dmiInfo.chassis_vendor) ??
    inferVendorFromDeviceTree(deviceTree.compatible, deviceTree.model) ??
    "Linux";
  const modelName =
    normalizeIdentityString(hostnamectl.HardwareModel) ??
    normalizeIdentityString(dmiInfo.product_name) ??
    normalizeIdentityString(dmidecode.system["Product Name"]) ??
    normalizeIdentityString(deviceTree.model) ??
    normalizeIdentityString(findLshwSystemField(lshw, "product")) ??
    osRelease.NAME ??
    "Linux Device";
  const modelVersion =
    normalizeIdentityString(dmiInfo.product_version) ??
    normalizeIdentityString(dmidecode.system.Version) ??
    normalizeIdentityString(findLshwCpuField(lshw, "version")) ??
    architecture;
  const processorName =
    lscpu["Model name"] ??
    cpuInfo[0]?.["model name"] ??
    cpuInfo[0]?.Hardware ??
    cpuInfo[0]?.Processor ??
    normalizeProcessorIdentity(findLshwCpuField(lshw, "product")) ??
    normalizeProcessorIdentity(findLshwCpuField(lshw, "description")) ??
    "Processor";
  const cpuNode = findLshwCpuNode(lshwNodes);
  const cpuFeatures = collectCpuFeatures(lscpu, cpuInfo, cpuNode);
  const memoryBytes =
    memInfo.MemTotal?.unit === "kB"
      ? memInfo.MemTotal.value * 1024
      : memInfo.MemTotal?.value;
  const lshwMemoryBytes = findLshwMemorySize(lshw);
  const normalizedMemoryBytes = memoryBytes ?? lshwMemoryBytes;
  const memoryDisplay = normalizedMemoryBytes
    ? formatBytes(normalizedMemoryBytes)
    : undefined;
  const deviceComponent = createComponent({
    type: "device",
    name: modelName,
    version: modelVersion,
    manufacturer: { name: manufacturer },
    description: processorName,
    properties: compact([
      createProperty("cdx:hbom:platform", "linux"),
      createProperty("cdx:hbom:architecture", architecture),
      createProperty("cdx:hbom:chip", processorName),
      createProperty("cdx:hbom:memory", memoryDisplay),
      createProperty(
        "cdx:hbom:serialNumber",
        redactIdentifier(
          dmiInfo.product_serial ??
            dmidecode.system["Serial Number"] ??
            deviceTree.serialNumber ??
            findLshwSystemField(lshw, "serial"),
          options,
        ),
      ),
      createProperty(
        "cdx:hbom:platformUuid",
        redactIdentifier(dmiInfo.product_uuid, options),
      ),
      createProperty(
        "cdx:hbom:boardVendor",
        normalizeIdentityString(dmiInfo.board_vendor),
      ),
      createProperty(
        "cdx:hbom:boardName",
        normalizeIdentityString(dmiInfo.board_name),
      ),
      createProperty(
        "cdx:hbom:biosVendor",
        normalizeIdentityString(dmiInfo.bios_vendor),
      ),
      createProperty(
        "cdx:hbom:biosVersion",
        normalizeIdentityString(dmiInfo.bios_version),
      ),
      createProperty(
        "cdx:hbom:firmwareDate",
        normalizeHostnamectlFirmwareDate(hostnamectl.FirmwareDate) ??
          dmiInfo.bios_date ??
          dmidecode.bios["Release Date"],
      ),
      createProperty("cdx:hbom:deviceTreeRevision", deviceTree.linuxRevision),
      createProperty(
        "cdx:hbom:deviceTreeLinuxSerial",
        redactIdentifier(deviceTree.linuxSerial, options),
      ),
      createProperty(
        "cdx:hbom:chassisType",
        normalizeChassisType(hostnamectl.Chassis ?? dmiInfo.chassis_type),
      ),
      createProperty("cdx:hbom:identifierPolicy", identifierPolicy),
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
          normalizeIdentityString(findLshwCpuField(lshw, "vendor")) ??
          cpuInfo[0]?.["CPU implementer"] ??
          manufacturer,
      },
      properties: compact([
        createProperty(
          "cdx:hbom:architecture",
          lscpu.Architecture ?? architecture,
        ),
        createProperty("cdx:hbom:addressSizes", lscpu["Address sizes"]),
        createProperty("cdx:hbom:byteOrder", lscpu["Byte Order"]),
        createProperty(
          "cdx:hbom:coreCount",
          derivePhysicalCoreCount(lscpu, cpuInfo),
        ),
        createProperty(
          "cdx:hbom:logicalCpuCount",
          lscpu["CPU(s)"] ?? cpuInfo.length,
        ),
        createProperty("cdx:hbom:socketCount", lscpu["Socket(s)"]),
        createProperty("cdx:hbom:threadsPerCore", lscpu["Thread(s) per core"]),
        createProperty(
          "cdx:hbom:vendorId",
          lscpu["Vendor ID"] ?? cpuInfo[0]?.vendor_id,
        ),
        createProperty("cdx:hbom:cpuFamily", cpuInfo[0]?.["cpu family"]),
        createProperty("cdx:hbom:model", cpuInfo[0]?.model),
        createProperty("cdx:hbom:stepping", cpuInfo[0]?.stepping),
        createProperty("cdx:hbom:currentClockHz", getNumberValue(cpuNode?.size)),
        createProperty("cdx:hbom:maxClockHz", getNumberValue(cpuNode?.capacity)),
        createProperty(
          "cdx:hbom:microcodeVersion",
          getScalarStringValue(cpuNode?.configuration?.microcode),
        ),
        createProperty("cdx:hbom:featureCount", cpuFeatures.length || undefined),
        createProperty(
          "cdx:hbom:cpuFeatures",
          cpuFeatures.length ? cpuFeatures.join(", ") : undefined,
        ),
      ]),
    }),
    normalizedMemoryBytes
      ? createHardwareComponent("memory", {
          name: "System Memory",
          properties: compact([
            createProperty("cdx:hbom:size", memoryDisplay),
            createProperty("cdx:hbom:sizeBytes", normalizedMemoryBytes),
            createProperty(
              "cdx:hbom:memoryRangeCount",
              lsmem.length || undefined,
            ),
            createProperty(
              "cdx:hbom:memoryOnlineSize",
              summarizeLsmemOnlineMemory(lsmem),
            ),
          ]),
        })
      : undefined,
    ...collectFirmwareAndBoardComponents(
      dmiInfo,
      deviceTree,
      dmidecode,
      hostnamectl,
      lshw,
      options,
    ),
    ...blockDevices.filter(isPhysicalStorageDevice).map((device) => {
      const lshwStorage = findLshwStorageContext(lshwNodes, device);
      const storageNode = lshwStorage.exactNode ?? lshwStorage.controllerNode;
      return createHardwareComponent("storage", {
        name:
          pickHardwareName(
            getStringValue(device.model),
            getStringValue(lshwStorage.exactNode?.product),
            getStringValue(lshwStorage.controllerNode?.product),
            getStringValue(device.name),
            getStringValue(storageNode?.description),
          ) ?? "Block Device",
        version: getStringValue(device.name),
        manufacturer:
          pickHardwareName(
            getStringValue(device.vendor),
            getStringValue(lshwStorage.exactNode?.vendor),
            getStringValue(lshwStorage.controllerNode?.vendor),
          )
            ? {
                name: pickHardwareName(
                  getStringValue(device.vendor),
                  getStringValue(lshwStorage.exactNode?.vendor),
                  getStringValue(lshwStorage.controllerNode?.vendor),
                ),
              }
            : undefined,
        description: getStringValue(storageNode?.description),
        properties: compact([
          createProperty("cdx:hbom:capacityBytes", getNumberValue(device.size)),
          createProperty(
            "cdx:hbom:capacity",
            formatBytes(getNumberValue(device.size)),
          ),
          createProperty(
            "cdx:hbom:deviceSerial",
            redactIdentifier(
              getStringValue(device.serial) ??
                getStringValue(lshwStorage.exactNode?.serial) ??
                getStringValue(lshwStorage.controllerNode?.serial),
              options,
            ),
          ),
          createProperty(
            "cdx:hbom:subsystem",
            getStringValue(device.subsystem),
          ),
          createProperty(
            "cdx:hbom:isRemovable",
            getBooleanValue(device.removable),
          ),
          createProperty(
            "cdx:hbom:isRotational",
            getBooleanValue(device.rotational),
          ),
          createProperty(
            "cdx:hbom:transport",
            getStringValue(device.transport),
          ),
          createProperty(
            "cdx:hbom:blockSize",
            getNumberValue(device.logicalBlockSize),
          ),
          createProperty(
            "cdx:hbom:firmwareVersion",
            getStringValue(lshwStorage.controllerNode?.version) ??
              getStringValue(lshwStorage.exactNode?.version),
          ),
          createProperty(
            "cdx:hbom:busInfo",
            getStringValue(lshwStorage.controllerNode?.businfo) ??
              getStringValue(lshwStorage.exactNode?.businfo),
          ),
          createProperty(
            "cdx:hbom:driver",
            getScalarStringValue(lshwStorage.controllerNode?.configuration?.driver) ??
              getScalarStringValue(lshwStorage.exactNode?.configuration?.driver),
          ),
          createProperty(
            "cdx:hbom:state",
            getScalarStringValue(lshwStorage.controllerNode?.configuration?.state),
          ),
          createProperty(
            "cdx:hbom:nqn",
            getScalarStringValue(lshwStorage.controllerNode?.configuration?.nqn),
          ),
          createProperty(
            "cdx:hbom:wwid",
            getScalarStringValue(lshwStorage.exactNode?.configuration?.wwid),
          ),
          createProperty(
            "cdx:hbom:capabilities",
            formatCapabilities(lshwStorage.controllerNode?.capabilities) ??
              formatCapabilities(lshwStorage.exactNode?.capabilities),
          ),
        ]),
      });
    }),
    ...networkInterfaces
      .filter((device) => isPhysicalNetworkInterface(device, ethtool))
      .map((device) => {
        const interfaceName = getStringValue(device.ifname) ?? getStringValue(device.name);
        const ethtoolInfo = ethtool[interfaceName];
        const lshwNetworkNode = findLshwNetworkNode(
          lshwNodes,
          device,
          ethtoolInfo,
        );
        return createHardwareComponent("network-interface", {
          name:
            pickHardwareName(
              getStringValue(lshwNetworkNode?.product),
              getStringValue(device.name),
              getStringValue(lshwNetworkNode?.description),
              interfaceName,
            ) ?? "Network Interface",
          version: interfaceName,
          manufacturer: getStringValue(lshwNetworkNode?.vendor)
            ? { name: getStringValue(lshwNetworkNode?.vendor) }
            : undefined,
          description: getStringValue(lshwNetworkNode?.description),
          properties: compact([
            createProperty(
              "cdx:hbom:driver",
              ethtoolInfo?.driver ??
                getScalarStringValue(lshwNetworkNode?.configuration?.driver),
            ),
            createProperty(
              "cdx:hbom:macAddress",
              redactIdentifier(
                getStringValue(device.address)?.toLowerCase() ??
                  getStringValue(lshwNetworkNode?.serial)?.toLowerCase(),
                options,
              ),
            ),
            createProperty(
              "cdx:hbom:firmwareVersion",
              normalizeEmptyString(ethtoolInfo?.["firmware-version"]) ??
                getScalarStringValue(lshwNetworkNode?.configuration?.firmware),
            ),
            createProperty(
              "cdx:hbom:busInfo",
              normalizeEmptyString(ethtoolInfo?.["bus-info"]) ??
                getStringValue(lshwNetworkNode?.businfo),
            ),
            createProperty(
              "cdx:hbom:kernelVersion",
              normalizeEmptyString(ethtoolInfo?.version) ??
                getScalarStringValue(
                  lshwNetworkNode?.configuration?.driverversion,
                ),
            ),
            createProperty(
              "cdx:hbom:operState",
              getStringValue(device.operstate),
            ),
            createProperty("cdx:hbom:mtu", getNumberValue(device.mtu)),
            createProperty(
              "cdx:hbom:speedMbps",
              getNumberValue(device.speedMbps) ??
                parseNetworkSpeedMbps(
                  getScalarStringValue(lshwNetworkNode?.configuration?.speed),
                  getNumberValue(lshwNetworkNode?.size) ??
                    getNumberValue(lshwNetworkNode?.capacity),
                ),
            ),
            createProperty(
              "cdx:hbom:duplex",
              getStringValue(device.duplex) ??
                getScalarStringValue(lshwNetworkNode?.configuration?.duplex),
            ),
            createProperty("cdx:hbom:ifindex", getNumberValue(device.ifindex)),
            createProperty(
              "cdx:hbom:linkType",
              getStringValue(device.linkType),
            ),
            createProperty(
              "cdx:hbom:deviceRevision",
              getStringValue(lshwNetworkNode?.version),
            ),
            createProperty(
              "cdx:hbom:port",
              getScalarStringValue(lshwNetworkNode?.configuration?.port),
            ),
            createProperty(
              "cdx:hbom:linkDetected",
              normalizeYesNo(lshwNetworkNode?.configuration?.link),
            ),
            createProperty(
              "cdx:hbom:autoNegotiation",
              normalizeYesNo(lshwNetworkNode?.configuration?.autonegotiation),
            ),
            createProperty(
              "cdx:hbom:capabilities",
              formatCapabilities(lshwNetworkNode?.capabilities),
            ),
          ]),
        });
      }),
    ...powerSupplies.flatMap((supply) => toPowerComponents(supply, options)),
    ...createHwmonComponents(hwmonDevices),
    ...createThermalZoneComponents(thermalZones),
    ...createTpmComponents(tpmDevices),
    ...createLinuxAudioComponents(audioCards, audioPcm),
    ...createNvmeControllerComponents(nvmeControllers, options, lshwNodes),
    ...mmcDevices.map((device) => createMmcComponent(device, options)),
    ...pciDevices.map((device) => createPciComponent(device, lshwNodes)),
    ...usbDevices.map((device) => createUsbComponent(device)),
    ...createVideoComponents(videoDevices),
    ...createDisplayComponents(drmDevices, options, lshwNodes),
    ...createLshwCommunicationComponents(lshwNodes),
  ]);

  return attachCollectorTrace(
    createHbomDocument({
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
        createProperty("cdx:hbom:targetPlatform", "linux"),
        createProperty("cdx:hbom:targetArchitecture", architecture),
        createProperty("cdx:hbom:identifierPolicy", identifierPolicy),
        createProperty("cdx:hbom:collectorProfile", `linux-${architecture}-v1`),
        createProperty("cdx:hbom:osName", osRelease.NAME),
        createProperty(
          "cdx:hbom:osVersion",
          osRelease.VERSION_ID ?? osRelease.VERSION,
        ),
        createProperty(
          "cdx:hbom:evidence:fileCount",
          options.observedFiles?.length ?? 0,
        ),
        ...(options.observedFiles ?? []).map((filePath) =>
          createProperty("cdx:hbom:evidence:file", filePath),
        ),
        createProperty(
          "cdx:hbom:evidence:commandCount",
          options.executedCommands?.length ?? 0,
        ),
        ...collectCommandProperties(options.executedCommands ?? []),
      ]),
    }),
    options.trace,
  );
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
    await attemptCollection(async () => {
      sources.lscpu = parseLscpuJson(
        await runCommand(getRequiredLinuxCommand("lscpu-json"), options),
      );
      executedCommands.push(
        toEvidenceCommand(getRequiredLinuxCommand("lscpu-json")),
      );
    }, allowPartial);
    await attemptCollection(async () => {
      sources.lsblk = parseLsblkJson(
        await runCommand(getRequiredLinuxCommand("lsblk-json"), options),
      );
      executedCommands.push(
        toEvidenceCommand(getRequiredLinuxCommand("lsblk-json")),
      );
    }, allowPartial);
    await attemptCollection(async () => {
      sources.ipLink = parseIpLinkJson(
        await runCommand(getRequiredLinuxCommand("ip-link-json"), options),
      );
      executedCommands.push(
        toEvidenceCommand(getRequiredLinuxCommand("ip-link-json")),
      );
    }, allowPartial);
    await attemptCollection(async () => {
      sources.lsmem = parseLsmemJson(
        await runCommand(getRequiredLinuxCommand("lsmem-json"), options),
      );
      executedCommands.push(
        toEvidenceCommand(getRequiredLinuxCommand("lsmem-json")),
      );
    }, allowPartial);
    await attemptCollection(async () => {
      sources.hostnamectl = parseHostnamectlJson(
        await runCommand(getRequiredLinuxCommand("hostnamectl-json"), options),
      );
      executedCommands.push(
        toEvidenceCommand(getRequiredLinuxCommand("hostnamectl-json")),
      );
    }, allowPartial);
    await attemptCollection(async () => {
      sources.lshw = parseLshwJson(
        await runCommand(getRequiredLinuxCommand("lshw-json"), options),
      );
      executedCommands.push(
        toEvidenceCommand(getRequiredLinuxCommand("lshw-json")),
      );
    }, allowPartial);
    await attemptCollection(async () => {
      sources.pciDevices = parseLspciVmmnn(
        await runCommand(getRequiredLinuxCommand("lspci-vmmnn"), options),
      );
      executedCommands.push(
        toEvidenceCommand(getRequiredLinuxCommand("lspci-vmmnn")),
      );
    }, allowPartial);
    await attemptCollection(async () => {
      sources.usbDevices = parseLsusbText(
        await runCommand(getRequiredLinuxCommand("lsusb"), options),
      );
      executedCommands.push(
        toEvidenceCommand(getRequiredLinuxCommand("lsusb")),
      );
    }, allowPartial);
    sources.ethtool = {};
    const interfaceNames = [
      ...new Set(
        [
          ...(sources.networkInterfaces ?? []).map((entry) =>
            getStringValue(entry.name),
          ),
          ...(sources.ipLink ?? []).map((entry) =>
            getStringValue(entry.ifname),
          ),
        ].filter(Boolean),
      ),
    ];
    for (const interfaceName of interfaceNames) {
      await attemptCollection(async () => {
        const spec = createEthtoolCommand(interfaceName);
        sources.ethtool[interfaceName] = parseEthtoolDriverInfo(
          await runCommand(spec, options),
        );
        executedCommands.push(toEvidenceCommand(spec));
      }, allowPartial);
    }
  }

  if (options.includePrivilegedEnrichment === true) {
    await attemptCollection(async () => {
      sources.dmidecode = parseDmidecodeText(
        await runCommand(
          getRequiredLinuxCommand("dmidecode-firmware-board"),
          options,
        ),
      );
      executedCommands.push(
        toEvidenceCommand(getRequiredLinuxCommand("dmidecode-firmware-board")),
      );
    }, allowPartial);
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
      readFirstExistingTextFile(
        ["/etc/os-release", "/usr/lib/os-release"],
        observedFiles,
      ) ?? "",
    ),
    cpuInfo: parseCpuInfo(
      readObservedTextFile("/proc/cpuinfo", observedFiles) ?? "",
    ),
    memInfo: parseMemInfo(
      readObservedTextFile("/proc/meminfo", observedFiles) ?? "",
    ),
    dmiInfo: readDmiInfo(observedFiles),
    deviceTree: readDeviceTreeInfo(observedFiles),
    networkInterfaces: readSysfsNetworkInterfaces(observedFiles),
    blockDevices: readSysfsBlockDevices(observedFiles),
    powerSupplies: readPowerSupplies(observedFiles),
    hwmonDevices: readHwmonDevices(observedFiles),
    thermalZones: readThermalZones(observedFiles),
    tpmDevices: readTpmDevices(observedFiles),
    nvmeControllers: readNvmeControllers(observedFiles),
    audioCards: readAudioCards(observedFiles),
    audioPcm: readAudioPcmDevices(observedFiles),
    videoDevices: readVideo4LinuxDevices(observedFiles),
    mmcDevices: readMmcDevices(observedFiles),
    pciSysfsDevices: readPciSysfsDevices(observedFiles),
    usbSysfsDevices: readUsbSysfsDevices(observedFiles),
    drmDevices: readDrmDevices(observedFiles),
  };
}

function readDmiInfo(observedFiles) {
  const basePath = ["/sys/devices/virtual/dmi/id", "/sys/class/dmi/id"].find(
    (candidate) => safeExistsSync(candidate),
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
  ].reduce(
    (result, field) => {
      const value = readObservedTextFile(join(basePath, field), observedFiles);
      if (value) {
        result[field] = value;
      }
      return result;
    },
    /** @type {Record<string, string>} */ ({}),
  );
}

function readDeviceTreeInfo(observedFiles) {
  const basePath = "/proc/device-tree";

  if (!safeExistsSync(basePath)) {
    return {};
  }

  return {
    model: readObservedBinaryTextFile(join(basePath, "model"), observedFiles),
    compatible: readObservedNullSeparatedStrings(
      join(basePath, "compatible"),
      observedFiles,
    ),
    serialNumber: readObservedBinaryTextFile(
      join(basePath, "serial-number"),
      observedFiles,
    ),
    linuxRevision: readObservedBinaryHexFile(
      join(basePath, "system", "linux,revision"),
      observedFiles,
    ),
    linuxSerial: readObservedBinaryHexFile(
      join(basePath, "system", "linux,serial"),
      observedFiles,
    ),
  };
}

function readAudioCards(observedFiles) {
  const cards = parseAsoundCards(
    readObservedTextFile("/proc/asound/cards", observedFiles) ?? "",
  );

  return cards.map((card) => {
    const basePath = join("/sys/class/sound", `card${card.number}`);
    const uevent = parseUeventText(
      readObservedTextFile(join(basePath, "uevent"), observedFiles) ?? "",
    );
    return {
      ...card,
      kernelId: readObservedTextFile(join(basePath, "id"), observedFiles),
      driver: normalizeEmptyString(uevent.driver),
    };
  });
}

function readAudioPcmDevices(observedFiles) {
  return parseAsoundPcm(
    readObservedTextFile("/proc/asound/pcm", observedFiles) ?? "",
  );
}

function readVideo4LinuxDevices(observedFiles) {
  return safeReaddirSync("/sys/class/video4linux").map((name) => {
    const basePath = join("/sys/class/video4linux", name);
    return {
      kernelName: name,
      name: readObservedTextFile(join(basePath, "name"), observedFiles),
      index: toNumber(
        readObservedTextFile(join(basePath, "index"), observedFiles),
      ),
      modalias: readObservedTextFile(
        join(basePath, "device", "modalias"),
        observedFiles,
      ),
      driver: readObservedLinkBaseName(join(basePath, "device", "driver")),
    };
  });
}

function readMmcDevices(observedFiles) {
  return safeReaddirSync("/sys/bus/mmc/devices").map((name) => {
    const basePath = join("/sys/bus/mmc/devices", name);
    return {
      name,
      type: readObservedTextFile(join(basePath, "type"), observedFiles),
      productName: readObservedTextFile(join(basePath, "name"), observedFiles),
      manufacturerId: readObservedTextFile(
        join(basePath, "manfid"),
        observedFiles,
      ),
      oemId: readObservedTextFile(join(basePath, "oemid"), observedFiles),
      serial: readObservedTextFile(join(basePath, "serial"), observedFiles),
      date: readObservedTextFile(join(basePath, "date"), observedFiles),
      firmwareRevision: readObservedTextFile(
        join(basePath, "fwrev"),
        observedFiles,
      ),
      hardwareRevision: readObservedTextFile(
        join(basePath, "hwrev"),
        observedFiles,
      ),
      uevent: parseUeventText(
        readObservedTextFile(join(basePath, "uevent"), observedFiles) ?? "",
      ),
    };
  });
}

function readPciSysfsDevices(observedFiles) {
  return safeReaddirSync("/sys/bus/pci/devices").map((name) => {
    const basePath = join("/sys/bus/pci/devices", name);
    return {
      slot: name,
      classCode: normalizeHexString(
        readObservedTextFile(join(basePath, "class"), observedFiles),
      ),
      vendorId: normalizeHexString(
        readObservedTextFile(join(basePath, "vendor"), observedFiles),
      ),
      productId: normalizeHexString(
        readObservedTextFile(join(basePath, "device"), observedFiles),
      ),
      subsystemVendorId: normalizeHexString(
        readObservedTextFile(join(basePath, "subsystem_vendor"), observedFiles),
      ),
      subsystemDeviceId: normalizeHexString(
        readObservedTextFile(join(basePath, "subsystem_device"), observedFiles),
      ),
      modalias: readObservedTextFile(join(basePath, "modalias"), observedFiles),
      driver: readObservedLinkBaseName(join(basePath, "driver")),
      label: readObservedTextFile(join(basePath, "label"), observedFiles),
    };
  });
}

function readUsbSysfsDevices(observedFiles) {
  return safeReaddirSync("/sys/bus/usb/devices")
    .filter((name) =>
      safeExistsSync(join("/sys/bus/usb/devices", name, "idVendor")),
    )
    .map((name) => {
      const basePath = join("/sys/bus/usb/devices", name);
      return {
        kernelName: name,
        bus: normalizeUsbNumber(
          readObservedTextFile(join(basePath, "busnum"), observedFiles),
        ),
        device: normalizeUsbNumber(
          readObservedTextFile(join(basePath, "devnum"), observedFiles),
        ),
        manufacturer: readObservedTextFile(
          join(basePath, "manufacturer"),
          observedFiles,
        ),
        description: readObservedTextFile(
          join(basePath, "product"),
          observedFiles,
        ),
        version: normalizeUsbVersion(
          readObservedTextFile(join(basePath, "version"), observedFiles),
        ),
        serial: readObservedTextFile(join(basePath, "serial"), observedFiles),
        vendorId: normalizeHexString(
          readObservedTextFile(join(basePath, "idVendor"), observedFiles),
        ),
        productId: normalizeHexString(
          readObservedTextFile(join(basePath, "idProduct"), observedFiles),
        ),
        deviceClass: normalizeHexString(
          readObservedTextFile(join(basePath, "bDeviceClass"), observedFiles),
        ),
        deviceSubclass: normalizeHexString(
          readObservedTextFile(
            join(basePath, "bDeviceSubClass"),
            observedFiles,
          ),
        ),
        deviceProtocol: normalizeHexString(
          readObservedTextFile(
            join(basePath, "bDeviceProtocol"),
            observedFiles,
          ),
        ),
        devpath: readObservedTextFile(join(basePath, "devpath"), observedFiles),
        speedMbps: normalizeUsbSpeed(
          readObservedTextFile(join(basePath, "speed"), observedFiles),
        ),
        removable: readObservedTextFile(
          join(basePath, "removable"),
          observedFiles,
        ),
      };
    });
}

function readDrmDevices(observedFiles) {
  return safeReaddirSync("/sys/class/drm").map((name) => {
    const basePath = join("/sys/class/drm", name);
    const uevent = parseUeventText(
      readObservedTextFile(join(basePath, "device", "uevent"), observedFiles) ??
        "",
    );
    const edidBuffer = readObservedBinaryBuffer(
      join(basePath, "edid"),
      observedFiles,
    );
    return {
      name,
      kind: /^card\d+$/u.test(name)
        ? "card"
        : name.includes("-")
          ? "connector"
          : "other",
      status: readObservedTextFile(join(basePath, "status"), observedFiles),
      enabled: readObservedTextFile(join(basePath, "enabled"), observedFiles),
      modes: readObservedTextFileList(join(basePath, "modes"), observedFiles),
      edid: parseEdidBuffer(edidBuffer),
      vendorId:
        normalizeHexString(
          readObservedTextFile(
            join(basePath, "device", "vendor"),
            observedFiles,
          ),
        ) ?? normalizeHexString(uevent.PCI_ID?.split(":")[0]),
      productId:
        normalizeHexString(
          readObservedTextFile(
            join(basePath, "device", "device"),
            observedFiles,
          ),
        ) ?? normalizeHexString(uevent.PCI_ID?.split(":")[1]),
      subsystemVendorId:
        normalizeHexString(
          readObservedTextFile(
            join(basePath, "device", "subsystem_vendor"),
            observedFiles,
          ),
        ) ?? normalizeHexString(uevent.PCI_SUBSYS_ID?.split(":")[0]),
      subsystemDeviceId:
        normalizeHexString(
          readObservedTextFile(
            join(basePath, "device", "subsystem_device"),
            observedFiles,
          ),
        ) ?? normalizeHexString(uevent.PCI_SUBSYS_ID?.split(":")[1]),
      pciSlot: uevent.PCI_SLOT_NAME,
      driver:
        readObservedLinkBaseName(join(basePath, "device", "driver")) ??
        normalizeEmptyString(uevent.DRIVER),
      ofName: normalizeEmptyString(uevent.OF_NAME),
      ofCompatible: collectOrderedUeventValues(uevent, "OF_COMPATIBLE_"),
    };
  });
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
        operstate: readObservedTextFile(
          join(basePath, "operstate"),
          observedFiles,
        ),
        mtu: toNumber(
          readObservedTextFile(join(basePath, "mtu"), observedFiles),
        ),
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
      const sectors = toNumber(
        readObservedTextFile(join(basePath, "size"), observedFiles),
      );
      const logicalBlockSize = toNumber(
        readObservedTextFile(
          join(basePath, "queue", "logical_block_size"),
          observedFiles,
        ),
      );
      return {
        name,
        model: readObservedTextFile(
          join(basePath, "device", "model"),
          observedFiles,
        ),
        vendor: readObservedTextFile(
          join(basePath, "device", "vendor"),
          observedFiles,
        ),
        serial: readObservedTextFile(
          join(basePath, "device", "serial"),
          observedFiles,
        ),
        removable:
          readObservedTextFile(join(basePath, "removable"), observedFiles) ===
          "1",
        rotational:
          readObservedTextFile(
            join(basePath, "queue", "rotational"),
            observedFiles,
          ) === "1",
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
      modelName: readObservedTextFile(
        join(basePath, "model_name"),
        observedFiles,
      ),
      serialNumber: readObservedTextFile(
        join(basePath, "serial_number"),
        observedFiles,
      ),
      technology: readObservedTextFile(
        join(basePath, "technology"),
        observedFiles,
      ),
      online: toNumber(
        readObservedTextFile(join(basePath, "online"), observedFiles),
      ),
    };
  });
}

function readHwmonDevices(observedFiles) {
  return safeReaddirSync("/sys/class/hwmon").map((name) => {
    const basePath = join("/sys/class/hwmon", name);
    return parseHwmonAttributes({
      name: readObservedTextFile(join(basePath, "name"), observedFiles),
      ...collectIndexedAttributeFiles(basePath, observedFiles, "temp", [
        "input",
        "label",
      ]),
      ...collectIndexedAttributeFiles(basePath, observedFiles, "fan", [
        "input",
        "label",
      ]),
      ...collectIndexedAttributeFiles(basePath, observedFiles, "pwm", [""]),
    });
  });
}

function readThermalZones(observedFiles) {
  return safeReaddirSync("/sys/class/thermal")
    .filter((name) => name.startsWith("thermal_zone"))
    .map((name) => {
      const basePath = join("/sys/class/thermal", name);
      return {
        name,
        type: readObservedTextFile(join(basePath, "type"), observedFiles),
        tempMilliC: toNumber(
          readObservedTextFile(join(basePath, "temp"), observedFiles),
        ),
        mode: readObservedTextFile(join(basePath, "mode"), observedFiles),
      };
    });
}

function readTpmDevices(observedFiles) {
  return safeReaddirSync("/sys/class/tpm").map((name) => {
    const basePath = join("/sys/class/tpm", name);
    return {
      name,
      versionMajor: toNumber(
        readObservedTextFile(
          join(basePath, "tpm_version_major"),
          observedFiles,
        ),
      ),
      versionMinor: toNumber(
        readObservedTextFile(
          join(basePath, "tpm_version_minor"),
          observedFiles,
        ),
      ),
      description: readObservedTextFile(
        join(basePath, "device", "description"),
        observedFiles,
      ),
      modalias: readObservedTextFile(
        join(basePath, "device", "modalias"),
        observedFiles,
      ),
      driver: readObservedLinkBaseName(join(basePath, "device", "driver")),
    };
  });
}

function readNvmeControllers(observedFiles) {
  return safeReaddirSync("/sys/class/nvme").map((name) => {
    const basePath = join("/sys/class/nvme", name);
    const namespaces = safeReaddirSync(basePath)
      .filter((entry) => safeExistsSync(join(basePath, entry)))
      .filter((entry) => new RegExp(`^${name}n\\d+$`, "u").test(entry));
    return {
      name,
      model: readObservedTextFile(join(basePath, "model"), observedFiles),
      serial: readObservedTextFile(join(basePath, "serial"), observedFiles),
      firmwareRevision: readObservedTextFile(
        join(basePath, "firmware_rev"),
        observedFiles,
      ),
      transport: readObservedTextFile(
        join(basePath, "transport"),
        observedFiles,
      ),
      state: readObservedTextFile(join(basePath, "state"), observedFiles),
      address: readObservedTextFile(join(basePath, "address"), observedFiles),
      vendorId: normalizeHexString(
        readObservedTextFile(join(basePath, "device", "vendor"), observedFiles),
      ),
      driver: readObservedLinkBaseName(join(basePath, "device", "driver")),
      namespaceCount: namespaces.length || undefined,
      namespaces,
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

function mergePciSources(commandDevices, sysfsDevices) {
  const sysfsIndex = new Map(
    sysfsDevices
      .map((device) => [getStringValue(device.slot), device])
      .filter(([slot]) => Boolean(slot)),
  );

  const merged = commandDevices.map((device) => {
    const sysfs = sysfsIndex.get(device.Slot);
    return {
      ...sysfs,
      ...device,
      Slot: device.Slot ?? getStringValue(sysfs?.slot),
      Driver: device.Driver ?? getStringValue(sysfs?.driver),
    };
  });
  const knownSlots = new Set(
    merged.map((device) => device.Slot).filter(Boolean),
  );
  const sysfsOnly = sysfsDevices
    .filter((device) => {
      const slot = getStringValue(device.slot);
      return Boolean(slot) && !knownSlots.has(slot);
    })
    .map((device) => ({
      Slot: getStringValue(device.slot),
      Driver: getStringValue(device.driver),
      label: getStringValue(device.label),
      classCode: getStringValue(device.classCode),
      vendorId: getStringValue(device.vendorId),
      productId: getStringValue(device.productId),
      subsystemVendorId: getStringValue(device.subsystemVendorId),
      subsystemDeviceId: getStringValue(device.subsystemDeviceId),
      modalias: getStringValue(device.modalias),
    }));

  return [...merged, ...sysfsOnly];
}

function mergeUsbSources(commandDevices, sysfsDevices) {
  const sysfsIndex = new Map(
    sysfsDevices
      .map((device) => [
        `${getStringValue(device.bus)}:${getStringValue(device.device)}`,
        device,
      ])
      .filter(([key]) => !key.includes("undefined")),
  );

  const merged = commandDevices.map((device) => {
    const sysfs = sysfsIndex.get(`${device.bus}:${device.device}`);
    return {
      ...sysfs,
      ...device,
      bus: device.bus ?? getStringValue(sysfs?.bus),
      device: device.device ?? getStringValue(sysfs?.device),
      description: device.description || getStringValue(sysfs?.description),
      manufacturer: getStringValue(sysfs?.manufacturer),
      version: getStringValue(sysfs?.version),
      serial: getStringValue(sysfs?.serial),
      kernelName: getStringValue(sysfs?.kernelName),
      devpath: getStringValue(sysfs?.devpath),
      speedMbps: getNumberValue(sysfs?.speedMbps),
      removable: getStringValue(sysfs?.removable),
      deviceClass: getStringValue(sysfs?.deviceClass),
      deviceSubclass: getStringValue(sysfs?.deviceSubclass),
      deviceProtocol: getStringValue(sysfs?.deviceProtocol),
    };
  });
  const knownKeys = new Set(
    merged
      .map((device) => `${device.bus}:${device.device}`)
      .filter((key) => !key.includes("undefined")),
  );
  const sysfsOnly = sysfsDevices
    .filter((device) => {
      const key = `${getStringValue(device.bus)}:${getStringValue(device.device)}`;
      return !key.includes("undefined") && !knownKeys.has(key);
    })
    .map((device) => ({
      bus: getStringValue(device.bus),
      device: getStringValue(device.device),
      vendorId: getStringValue(device.vendorId),
      productId: getStringValue(device.productId),
      description: getStringValue(device.description),
      manufacturer: getStringValue(device.manufacturer),
      version: getStringValue(device.version),
      serial: getStringValue(device.serial),
      kernelName: getStringValue(device.kernelName),
      devpath: getStringValue(device.devpath),
      speedMbps: getNumberValue(device.speedMbps),
      removable: getStringValue(device.removable),
      deviceClass: getStringValue(device.deviceClass),
      deviceSubclass: getStringValue(device.deviceSubclass),
      deviceProtocol: getStringValue(device.deviceProtocol),
    }));

  return [...merged, ...sysfsOnly];
}

function createLinuxAudioComponents(audioCards, audioPcm) {
  const pcmByCard = audioPcm.reduce((result, device) => {
    const cardNumber = getNumberValue(device.cardNumber);
    if (cardNumber === undefined) {
      return result;
    }
    const entries = result.get(cardNumber) ?? [];
    entries.push(device);
    result.set(cardNumber, entries);
    return result;
  }, new Map());

  return [
    ...audioCards.map((card) =>
      createHardwareComponent("audio-controller", {
        name:
          getStringValue(card.name) ??
          getStringValue(card.id) ??
          `Sound Card ${card.number}`,
        version: `card${card.number}`,
        description: getStringValue(card.interfaceType),
        properties: compact([
          createProperty("cdx:hbom:cardNumber", getNumberValue(card.number)),
          createProperty("cdx:hbom:cardId", getStringValue(card.id)),
          createProperty("cdx:hbom:kernelId", getStringValue(card.kernelId)),
          createProperty("cdx:hbom:driver", getStringValue(card.driver)),
          createProperty("cdx:hbom:longName", getStringValue(card.longName)),
          createProperty(
            "cdx:hbom:pcmDeviceCount",
            pcmByCard.get(getNumberValue(card.number))?.length,
          ),
        ]),
      }),
    ),
    ...audioPcm.map((device) =>
      createHardwareComponent("audio-device", {
        name:
          getStringValue(device.name) ??
          getStringValue(device.id) ??
          "PCM Device",
        version: `card${device.cardNumber}-device${device.deviceNumber}`,
        properties: compact([
          createProperty(
            "cdx:hbom:cardNumber",
            getNumberValue(device.cardNumber),
          ),
          createProperty(
            "cdx:hbom:deviceNumber",
            getNumberValue(device.deviceNumber),
          ),
          createProperty("cdx:hbom:pcmId", getStringValue(device.id)),
          createProperty(
            "cdx:hbom:playbackStreamCount",
            getNumberValue(device.playbackCount),
          ),
          createProperty(
            "cdx:hbom:captureStreamCount",
            getNumberValue(device.captureCount),
          ),
        ]),
      }),
    ),
  ];
}

function toPowerComponents(supply, options) {
  const type = getStringValue(supply.type)?.toLowerCase();

  if (type === "battery") {
    return [
      createHardwareComponent("power", {
        name:
          getStringValue(supply.modelName) ??
          getStringValue(supply.name) ??
          "Battery",
        manufacturer: getStringValue(supply.manufacturer)
          ? { name: getStringValue(supply.manufacturer) }
          : undefined,
        properties: compact([
          createProperty(
            "cdx:hbom:chargePercent",
            getNumberValue(supply.capacity),
          ),
          createProperty(
            "cdx:hbom:isCharging",
            getStringValue(supply.status) === "Charging",
          ),
          createProperty("cdx:hbom:status", getStringValue(supply.status)),
          createProperty(
            "cdx:hbom:cycleCount",
            getNumberValue(supply.cycleCount),
          ),
          createProperty(
            "cdx:hbom:technology",
            getStringValue(supply.technology),
          ),
          createProperty(
            "cdx:hbom:batterySerialNumber",
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
        createProperty("cdx:hbom:powerSupplyType", getStringValue(supply.type)),
        createProperty(
          "cdx:hbom:connected",
          getNumberValue(supply.online) === 1,
        ),
      ]),
    }),
  ];
}

function collectFirmwareAndBoardComponents(
  dmiInfo,
  deviceTree,
  dmidecode,
  hostnamectl,
  lshw,
  options,
) {
  return compact([
    hasBoardData(dmiInfo, deviceTree, dmidecode, lshw)
      ? createHardwareComponent("board", {
          name:
            normalizeIdentityString(dmiInfo.board_name) ??
            normalizeIdentityString(dmidecode.baseboard["Product Name"]) ??
            normalizeIdentityString(
              findLshwMotherboardField(lshw, "product"),
            ) ??
            normalizeIdentityString(deviceTree.model) ??
            normalizeIdentityString(
              findLshwMotherboardField(lshw, "description"),
            ) ??
            "System Board",
          version:
            normalizeIdentityString(dmiInfo.board_version) ??
            normalizeIdentityString(dmidecode.baseboard.Version) ??
            normalizeIdentityString(
              findLshwMotherboardField(lshw, "version"),
            ) ??
            deviceTree.linuxRevision,
          manufacturer:
            (normalizeIdentityString(dmiInfo.board_vendor) ??
            normalizeIdentityString(dmidecode.baseboard.Manufacturer) ??
            normalizeIdentityString(findLshwMotherboardField(lshw, "vendor")) ??
            normalizeIdentityString(dmiInfo.sys_vendor) ??
            inferVendorFromDeviceTree(deviceTree.compatible, deviceTree.model))
              ? {
                  name:
                    normalizeIdentityString(dmiInfo.board_vendor) ??
                    normalizeIdentityString(dmidecode.baseboard.Manufacturer) ??
                    normalizeIdentityString(
                      findLshwMotherboardField(lshw, "vendor"),
                    ) ??
                    normalizeIdentityString(dmiInfo.sys_vendor) ??
                    inferVendorFromDeviceTree(
                      deviceTree.compatible,
                      deviceTree.model,
                    ),
                }
              : undefined,
          properties: compact([
            createProperty(
              "cdx:hbom:serialNumber",
              redactIdentifier(
                normalizeIdentityString(dmiInfo.board_serial) ??
                  normalizeIdentityString(
                    dmidecode.baseboard["Serial Number"],
                  ) ??
                  normalizeIdentityString(
                    findLshwMotherboardField(lshw, "serial"),
                  ) ??
                  deviceTree.serialNumber,
                options,
              ),
            ),
            createProperty(
              "cdx:hbom:assetTag",
              redactIdentifier(
                normalizeIdentityString(dmidecode.baseboard["Asset Tag"]),
                options,
              ),
            ),
            createProperty(
              "cdx:hbom:deviceTreeCompatible",
              Array.isArray(deviceTree.compatible)
                ? deviceTree.compatible.join(", ")
                : undefined,
            ),
            createProperty(
              "cdx:hbom:deviceTreeRevision",
              deviceTree.linuxRevision,
            ),
          ]),
        })
      : undefined,
    hasFirmwareData(dmiInfo, dmidecode, hostnamectl)
      ? createComponent({
          type: "firmware",
          name:
            normalizeIdentityString(hostnamectl.FirmwareVersion) ??
            normalizeIdentityString(dmiInfo.bios_vendor) ??
            normalizeIdentityString(dmidecode.bios.Vendor) ??
            "Firmware",
          version:
            normalizeIdentityString(hostnamectl.FirmwareVersion) ??
            normalizeIdentityString(dmiInfo.bios_version) ??
            normalizeIdentityString(dmidecode.bios.Version),
          manufacturer: {
            name:
              normalizeIdentityString(dmiInfo.bios_vendor) ??
              normalizeIdentityString(dmidecode.bios.Vendor) ??
              manufacturerFromHost(hostnamectl, dmiInfo),
          },
          properties: compact([
            createProperty("cdx:hbom:hardwareClass", "firmware"),
            createProperty(
              "cdx:hbom:firmwareDate",
              normalizeHostnamectlFirmwareDate(hostnamectl.FirmwareDate) ??
                dmiInfo.bios_date ??
                dmidecode.bios["Release Date"],
            ),
            createProperty(
              "cdx:hbom:biosRevision",
              dmidecode.bios["BIOS Revision"],
            ),
          ]),
        })
      : undefined,
    (hostnamectl.Chassis ?? dmiInfo.chassis_type)
      ? createHardwareComponent("chassis", {
          name: normalizeChassisType(
            hostnamectl.Chassis ?? dmiInfo.chassis_type,
          ),
          manufacturer: manufacturerFromHost(hostnamectl, dmiInfo)
            ? { name: manufacturerFromHost(hostnamectl, dmiInfo) }
            : undefined,
        })
      : undefined,
  ]);
}

function createHwmonComponents(hwmonDevices) {
  return hwmonDevices.flatMap((device) =>
    compact([
      device.temperatureSensors?.length
        ? createHardwareComponent("sensor", {
            name: getStringValue(device.name) ?? "Hardware Monitor",
            properties: compact([
              createProperty(
                "cdx:hbom:temperatureSensorCount",
                device.temperatureSensors.length,
              ),
              createProperty(
                "cdx:hbom:temperatureReadings",
                device.temperatureSensors
                  .map((entry) =>
                    formatSensorReading(entry.label, entry.valueCelsius, "°C"),
                  )
                  .filter(Boolean)
                  .join(", "),
              ),
            ]),
          })
        : undefined,
      device.fanSensors?.length
        ? createHardwareComponent("fan", {
            name: `${getStringValue(device.name) ?? "Hardware Monitor"} Fan`,
            properties: compact([
              createProperty("cdx:hbom:fanCount", device.fanSensors.length),
              createProperty(
                "cdx:hbom:fanReadings",
                device.fanSensors
                  .map((entry) =>
                    formatSensorReading(entry.label, entry.valueRpm, "RPM"),
                  )
                  .filter(Boolean)
                  .join(", "),
              ),
              createProperty(
                "cdx:hbom:pwmValues",
                Array.isArray(device.pwmValues) && device.pwmValues.length
                  ? device.pwmValues.join(", ")
                  : undefined,
              ),
            ]),
          })
        : undefined,
    ]),
  );
}

function createThermalZoneComponents(thermalZones) {
  return thermalZones.map((zone) =>
    createHardwareComponent("thermal-zone", {
      name:
        getStringValue(zone.type) ??
        getStringValue(zone.name) ??
        "Thermal Zone",
      version: getStringValue(zone.name),
      properties: compact([
        createProperty(
          "cdx:hbom:temperatureCelsius",
          milliCelsiusToCelsius(zone.tempMilliC),
        ),
        createProperty("cdx:hbom:mode", getStringValue(zone.mode)),
      ]),
    }),
  );
}

function createTpmComponents(tpmDevices) {
  return tpmDevices.map((device) =>
    createHardwareComponent("tpm", {
      name:
        getStringValue(device.description) ??
        getStringValue(device.name) ??
        "TPM Device",
      version:
        device.versionMajor !== undefined && device.versionMinor !== undefined
          ? `${device.versionMajor}.${device.versionMinor}`
          : undefined,
      properties: compact([
        createProperty("cdx:hbom:driver", getStringValue(device.driver)),
        createProperty("cdx:hbom:modalias", getStringValue(device.modalias)),
      ]),
    }),
  );
}

function createNvmeControllerComponents(
  nvmeControllers,
  options = {},
  lshwNodes = [],
) {
  return nvmeControllers.map((controller) => {
    const lshwNode = findLshwNvmeControllerNode(lshwNodes, controller);
    const namespaceNode = findLshwNvmeNamespaceNode(lshwNode, controller);
    return createHardwareComponent("storage-controller", {
      name:
        pickHardwareName(
          getStringValue(controller.model),
          getStringValue(lshwNode?.product),
          getStringValue(controller.name),
        ) ?? "NVMe Controller",
      version:
        getStringValue(controller.firmwareRevision) ??
        getStringValue(lshwNode?.version),
      manufacturer: getStringValue(lshwNode?.vendor)
        ? { name: getStringValue(lshwNode?.vendor) }
        : undefined,
      description: getStringValue(lshwNode?.description),
      properties: compact([
        createProperty(
          "cdx:hbom:transport",
          getStringValue(controller.transport),
        ),
        createProperty(
          "cdx:hbom:state",
          getStringValue(controller.state) ??
            getScalarStringValue(lshwNode?.configuration?.state),
        ),
        createProperty(
          "cdx:hbom:pciAddress",
          getStringValue(controller.address),
        ),
        createProperty(
          "cdx:hbom:vendorId",
          getStringValue(controller.vendorId),
        ),
        createProperty(
          "cdx:hbom:driver",
          getStringValue(controller.driver) ??
            getScalarStringValue(lshwNode?.configuration?.driver),
        ),
        createProperty(
          "cdx:hbom:namespaceCount",
          getNumberValue(controller.namespaceCount),
        ),
        createProperty(
          "cdx:hbom:namespaces",
          Array.isArray(controller.namespaces) && controller.namespaces.length
            ? controller.namespaces.join(", ")
            : undefined,
        ),
        createProperty(
          "cdx:hbom:deviceSerial",
          redactIdentifier(
            getStringValue(controller.serial) ?? getStringValue(lshwNode?.serial),
            options,
          ),
        ),
        createProperty("cdx:hbom:busInfo", getStringValue(lshwNode?.businfo)),
        createProperty(
          "cdx:hbom:nqn",
          getScalarStringValue(lshwNode?.configuration?.nqn),
        ),
        createProperty(
          "cdx:hbom:wwid",
          getScalarStringValue(namespaceNode?.configuration?.wwid),
        ),
        createProperty(
          "cdx:hbom:capabilities",
          formatCapabilities(lshwNode?.capabilities),
        ),
      ]),
    });
  });
}

function createMmcComponent(device, options) {
  const type = getStringValue(device.type)?.toLowerCase();
  const uevent = device.uevent ?? {};
  const sdioId = normalizeHexString(
    getStringValue(uevent.SDIO_ID)?.replace(":", ""),
  );
  const sdioVendorId = normalizeHexString(
    getStringValue(uevent.SDIO_ID)?.split(":")[0],
  );
  const sdioProductId = normalizeHexString(
    getStringValue(uevent.SDIO_ID)?.split(":")[1],
  );
  const hardwareClass = type === "sdio" ? "sdio-device" : "storage";
  const name =
    getStringValue(device.productName) ??
    (type === "sdio"
      ? `SDIO ${getStringValue(uevent.SDIO_ID) ?? getStringValue(device.name) ?? "Device"}`
      : (getStringValue(device.name) ?? "MMC Device"));

  return createHardwareComponent(hardwareClass, {
    name,
    version:
      getStringValue(device.firmwareRevision) ??
      getStringValue(uevent.SDIO_REVISION) ??
      getStringValue(device.date),
    properties: compact([
      createProperty("cdx:hbom:mmcType", getStringValue(device.type)),
      createProperty("cdx:hbom:mmcName", getStringValue(device.name)),
      createProperty(
        "cdx:hbom:mmcManufacturerId",
        getStringValue(device.manufacturerId),
      ),
      createProperty("cdx:hbom:mmcOemId", getStringValue(device.oemId)),
      createProperty(
        "cdx:hbom:mmcSerialNumber",
        redactIdentifier(getStringValue(device.serial), options),
      ),
      createProperty("cdx:hbom:mmcDate", getStringValue(device.date)),
      createProperty(
        "cdx:hbom:firmwareVersion",
        getStringValue(device.firmwareRevision) ??
          getStringValue(uevent.SDIO_REVISION),
      ),
      createProperty(
        "cdx:hbom:hardwareRevision",
        getStringValue(device.hardwareRevision),
      ),
      createProperty("cdx:hbom:vendorId", sdioVendorId),
      createProperty("cdx:hbom:productId", sdioProductId),
      createProperty("cdx:hbom:deviceId", sdioId),
    ]),
  });
}

function createPciComponent(device, lshwNodes = []) {
  const vendorMatch = device.Vendor?.match(
    /^(.*?)(?:\s+\[([0-9a-f]{4})\])?$/iu,
  );
  const deviceMatch = device.Device?.match(
    /^(.*?)(?:\s+\[([0-9a-f]{4})\])?$/iu,
  );
  const classMatch = device.Class?.match(/^(.*?)(?:\s+\[([0-9a-f]{4})\])?$/iu);
  const lshwNode = findLshwPciNode(lshwNodes, device);
  const currentName = deviceMatch?.[1]?.trim() || device.Device;

  return createHardwareComponent("pci-device", {
    name:
      pickHardwareName(
        isGenericHardwareName(currentName) ? undefined : currentName,
        getStringValue(lshwNode?.product),
        getStringValue(lshwNode?.description),
        currentName,
        device.label,
        device.productId ? `PCI ${device.productId}` : "PCI Device",
      ) ?? "PCI Device",
    version: device.Slot,
    manufacturer: pickHardwareName(
      vendorMatch?.[1]?.trim(),
      getStringValue(lshwNode?.vendor),
      device.vendorId,
    )
      ? {
          name: pickHardwareName(
            vendorMatch?.[1]?.trim(),
            getStringValue(lshwNode?.vendor),
            device.vendorId,
          ),
        }
      : undefined,
    description:
      classMatch?.[1]?.trim() ||
      getStringValue(lshwNode?.description) ||
      device.Class ||
      device.classCode,
    properties: compact([
      createProperty("cdx:hbom:pciSlot", device.Slot),
      createProperty("cdx:hbom:pciClass", classMatch?.[1]?.trim()),
      createProperty(
        "cdx:hbom:pciClassCode",
        classMatch?.[2]?.toLowerCase() ??
          normalizePciClassCode(device.classCode),
      ),
      createProperty(
        "cdx:hbom:vendorId",
        vendorMatch?.[2]?.toLowerCase() ?? normalizeHexString(device.vendorId),
      ),
      createProperty(
        "cdx:hbom:productId",
        deviceMatch?.[2]?.toLowerCase() ?? normalizeHexString(device.productId),
      ),
      createProperty("cdx:hbom:subsystemVendor", device.SVendor),
      createProperty("cdx:hbom:subsystemDevice", device.SDevice),
      createProperty(
        "cdx:hbom:subsystemVendorId",
        normalizeHexString(device.subsystemVendorId),
      ),
      createProperty(
        "cdx:hbom:subsystemDeviceId",
        normalizeHexString(device.subsystemDeviceId),
      ),
      createProperty("cdx:hbom:revision", device.Rev),
      createProperty(
        "cdx:hbom:driver",
        device.Driver ?? getScalarStringValue(lshwNode?.configuration?.driver),
      ),
      createProperty("cdx:hbom:kernelModule", device.Module),
      createProperty("cdx:hbom:modalias", device.modalias),
      createProperty("cdx:hbom:busInfo", getStringValue(lshwNode?.businfo)),
      createProperty(
        "cdx:hbom:deviceRevision",
        getStringValue(lshwNode?.version),
      ),
      createProperty("cdx:hbom:clockHz", getNumberValue(lshwNode?.clock)),
      createProperty("cdx:hbom:width", getNumberValue(lshwNode?.width)),
      createProperty("cdx:hbom:isClaimed", getBooleanValue(lshwNode?.claimed)),
      createProperty(
        "cdx:hbom:capabilities",
        formatCapabilities(lshwNode?.capabilities),
      ),
    ]),
  });
}

function createUsbComponent(device) {
  return createHardwareComponent("usb-device", {
    name:
      device.description ||
      (device.vendorId && device.productId
        ? `USB ${device.vendorId}:${device.productId}`
        : device.kernelName || "USB Device"),
    version: `bus-${device.bus ?? "unknown"}-device-${device.device ?? "unknown"}`,
    manufacturer: device.manufacturer
      ? { name: device.manufacturer }
      : undefined,
    properties: compact([
      createProperty("cdx:hbom:usbBus", device.bus),
      createProperty("cdx:hbom:usbDevice", device.device),
      createProperty("cdx:hbom:vendorId", device.vendorId),
      createProperty("cdx:hbom:productId", device.productId),
      createProperty("cdx:hbom:usbVersion", device.version),
      createProperty("cdx:hbom:deviceSerial", device.serial),
      createProperty("cdx:hbom:usbKernelName", device.kernelName),
      createProperty("cdx:hbom:usbDevpath", device.devpath),
      createProperty("cdx:hbom:speedMbps", device.speedMbps),
      createProperty(
        "cdx:hbom:isRemovable",
        normalizeBooleanLike(device.removable),
      ),
      createProperty("cdx:hbom:usbClass", device.deviceClass),
      createProperty("cdx:hbom:usbSubclass", device.deviceSubclass),
      createProperty("cdx:hbom:usbProtocol", device.deviceProtocol),
    ]),
  });
}

function createVideoComponents(videoDevices) {
  const groupedDevices = videoDevices.reduce((result, device) => {
    const hardwareClass = classifyVideoHardwareClass(device);
    const key = [
      hardwareClass,
      getStringValue(device.name) ?? "",
      getStringValue(device.driver) ?? "",
      getStringValue(device.modalias) ?? "",
    ].join("|");
    const current = result.get(key) ?? {
      hardwareClass,
      name:
        getStringValue(device.name) ??
        getStringValue(device.kernelName) ??
        "Video Device",
      driver: getStringValue(device.driver),
      modalias: getStringValue(device.modalias),
      kernelNames: [],
      indices: [],
    };

    if (getStringValue(device.kernelName)) {
      current.kernelNames.push(getStringValue(device.kernelName));
    }
    if (getNumberValue(device.index) !== undefined) {
      current.indices.push(getNumberValue(device.index));
    }

    result.set(key, current);
    return result;
  }, new Map());

  return [...groupedDevices.values()].map((device) =>
    createHardwareComponent(device.hardwareClass, {
      name: device.name,
      version:
        device.kernelNames.length === 1
          ? device.kernelNames[0]
          : (device.kernelNames[0] ?? "video"),
      properties: compact([
        createProperty(
          "cdx:hbom:index",
          device.indices.length === 1 ? device.indices[0] : undefined,
        ),
        createProperty("cdx:hbom:driver", device.driver),
        createProperty("cdx:hbom:modalias", device.modalias),
        createProperty("cdx:hbom:instanceCount", device.kernelNames.length),
        createProperty(
          "cdx:hbom:kernelDevices",
          device.kernelNames.length > 1
            ? device.kernelNames.join(", ")
            : undefined,
        ),
      ]),
    }),
  );
}

function createDisplayComponents(drmDevices, options = {}, lshwNodes = []) {
  const cards = drmDevices.filter((device) => device.kind === "card");
  const connectors = drmDevices.filter((device) =>
    isPhysicalDisplayConnector(device),
  );
  const displays = connectors.filter((device) => device.edid);
  const connectorCountByCard = connectors.reduce((result, connector) => {
    const cardName = getDisplayCardName(connector.name);
    if (!cardName) {
      return result;
    }
    result.set(cardName, (result.get(cardName) ?? 0) + 1);
    return result;
  }, new Map());

  return [
    ...cards.map((device) => {
      const lshwNode = findLshwDisplayNode(lshwNodes, device);
      return createHardwareComponent("display-adapter", {
        name: deriveDisplayAdapterName(device, lshwNode),
        version: getStringValue(device.pciSlot) ?? getStringValue(device.name),
        manufacturer: pickHardwareName(
          getStringValue(lshwNode?.vendor),
          getStringValue(device.vendorId),
        )
          ? {
              name: pickHardwareName(
                getStringValue(lshwNode?.vendor),
                getStringValue(device.vendorId),
              ),
            }
          : undefined,
        description: getStringValue(lshwNode?.description),
        properties: compact([
          createProperty(
            "cdx:hbom:driver",
            getStringValue(device.driver) ??
              getScalarStringValue(lshwNode?.configuration?.driver),
          ),
          createProperty("cdx:hbom:pciSlot", getStringValue(device.pciSlot)),
          createProperty("cdx:hbom:vendorId", getStringValue(device.vendorId)),
          createProperty(
            "cdx:hbom:productId",
            getStringValue(device.productId),
          ),
          createProperty(
            "cdx:hbom:subsystemVendorId",
            getStringValue(device.subsystemVendorId),
          ),
          createProperty(
            "cdx:hbom:subsystemDeviceId",
            getStringValue(device.subsystemDeviceId),
          ),
          createProperty("cdx:hbom:ofName", getStringValue(device.ofName)),
          createProperty(
            "cdx:hbom:ofCompatible",
            Array.isArray(device.ofCompatible)
              ? device.ofCompatible.join(", ")
              : undefined,
          ),
          createProperty(
            "cdx:hbom:connectorCount",
            connectorCountByCard.get(device.name),
          ),
          createProperty("cdx:hbom:busInfo", getStringValue(lshwNode?.businfo)),
          createProperty(
            "cdx:hbom:deviceRevision",
            getStringValue(lshwNode?.version),
          ),
          createProperty("cdx:hbom:clockHz", getNumberValue(lshwNode?.clock)),
          createProperty("cdx:hbom:width", getNumberValue(lshwNode?.width)),
          createProperty("cdx:hbom:isClaimed", getBooleanValue(lshwNode?.claimed)),
          createProperty(
            "cdx:hbom:capabilities",
            formatCapabilities(lshwNode?.capabilities),
          ),
        ]),
      });
    }),
    ...connectors.map((device) =>
      createHardwareComponent("display-connector", {
        name: getStringValue(device.name) ?? "Display Connector",
        version: getDisplayCardName(device.name),
        properties: compact([
          createProperty("cdx:hbom:status", getStringValue(device.status)),
          createProperty("cdx:hbom:enabled", getStringValue(device.enabled)),
          createProperty(
            "cdx:hbom:modes",
            Array.isArray(device.modes) && device.modes.length
              ? device.modes.join(", ")
              : undefined,
          ),
          createProperty(
            "cdx:hbom:displayAdapter",
            getDisplayCardName(device.name),
          ),
        ]),
      }),
    ),
    ...displays.map((device) =>
      createHardwareComponent("display", {
        name:
          getStringValue(device.edid?.name) ??
          formatDisplayName(
            device.edid?.manufacturerId,
            getStringValue(device.name),
          ),
        version: getStringValue(device.edid?.productId),
        manufacturer: getStringValue(device.edid?.manufacturerId)
          ? { name: getStringValue(device.edid?.manufacturerId) }
          : undefined,
        properties: compact([
          createProperty(
            "cdx:hbom:displayConnector",
            getStringValue(device.name),
          ),
          createProperty(
            "cdx:hbom:displaySerialNumber",
            redactIdentifier(
              getStringValue(device.edid?.serialNumber),
              options,
            ),
          ),
          createProperty(
            "cdx:hbom:preferredResolution",
            getStringValue(device.edid?.preferredResolution),
          ),
          createProperty(
            "cdx:hbom:physicalSize",
            formatDisplayPhysicalSize(
              device.edid?.widthCm,
              device.edid?.heightCm,
            ),
          ),
          createProperty(
            "cdx:hbom:edidVersion",
            getStringValue(device.edid?.version),
          ),
          createProperty(
            "cdx:hbom:manufactureWeek",
            getNumberValue(device.edid?.weekOfManufacture),
          ),
          createProperty(
            "cdx:hbom:manufactureYear",
            getNumberValue(device.edid?.yearOfManufacture),
          ),
          createProperty("cdx:hbom:status", getStringValue(device.status)),
        ]),
      }),
    ),
  ];
}

function createEthtoolCommand(interfaceName) {
  return {
    ...getRequiredLinuxCommand("ethtool-driver-info"),
    id: `ethtool-driver-info:${interfaceName}`,
    args: ["-i", interfaceName],
  };
}

function createLshwCommunicationComponents(lshwNodes) {
  return lshwNodes
    .filter((node) => isBluetoothLshwNode(node))
    .map((node) =>
      createHardwareComponent("bluetooth-controller", {
        name:
          pickHardwareName(
            getStringValue(node.product),
            getStringValue(node.description),
            ...getLshwLogicalNames(node),
          ) ?? "Bluetooth Interface",
        manufacturer: getStringValue(node.vendor)
          ? { name: getStringValue(node.vendor) }
          : undefined,
        version: getStringValue(node.businfo),
        description: getStringValue(node.description),
        properties: compact([
          createProperty("cdx:hbom:busInfo", getStringValue(node.businfo)),
          createProperty(
            "cdx:hbom:logicalNames",
            formatList(getLshwLogicalNames(node)),
          ),
          createProperty(
            "cdx:hbom:wirelessType",
            getScalarStringValue(node.configuration?.wireless),
          ),
          createProperty(
            "cdx:hbom:capabilities",
            formatCapabilities(node.capabilities),
          ),
        ]),
      }),
    );
}

function collectCommandProperties(commands) {
  return commands.map((entry) =>
    createProperty(
      "cdx:hbom:evidence:command",
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

function readObservedBinaryTextFile(filePath, observedFiles) {
  const value = safeReadFileSync(filePath, { encoding: null });

  if (Buffer.isBuffer(value)) {
    observedFiles.push(filePath);
    return value.toString("utf8").replaceAll("\u0000", "").trim() || undefined;
  }

  return undefined;
}

function readObservedBinaryBuffer(filePath, observedFiles) {
  const value = safeReadFileSync(filePath, { encoding: null });

  if (Buffer.isBuffer(value)) {
    observedFiles.push(filePath);
    return value;
  }

  return undefined;
}

function readObservedBinaryHexFile(filePath, observedFiles) {
  const value = safeReadFileSync(filePath, { encoding: null });

  if (Buffer.isBuffer(value)) {
    observedFiles.push(filePath);
    const normalized = value.toString("hex").replace(/^0+/u, "");
    return normalized ? `0x${normalized}` : undefined;
  }

  return undefined;
}

function readObservedNullSeparatedStrings(filePath, observedFiles) {
  const value = safeReadFileSync(filePath, { encoding: null });

  if (!Buffer.isBuffer(value)) {
    return undefined;
  }

  observedFiles.push(filePath);
  const strings = value
    .toString("utf8")
    .split("\u0000")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return strings.length ? strings : undefined;
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

function readObservedTextFileList(filePath, observedFiles) {
  const value = readObservedTextFile(filePath, observedFiles);

  if (value === undefined) {
    return undefined;
  }

  const entries = value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries.length ? entries : undefined;
}

function readObservedLinkBaseName(linkPath) {
  try {
    const target = safeExistsSync(linkPath)
      ? safeReadlinkSync(linkPath)
      : undefined;
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

function isPhysicalDisplayConnector(device) {
  const name = getStringValue(device.name) ?? "";
  if (!name?.includes("-")) {
    return false;
  }
  if (/writeback/u.test(name)) {
    return false;
  }
  return /^card\d+-(?:HDMI|DP|DVI|eDP|LVDS|VGA|USB-C|DSI)/u.test(name);
}

function isPhysicalStorageDevice(device) {
  const name = getStringValue(device.name) ?? "";
  return !/^(dm-|loop|ram|zram|md)/u.test(name);
}

function isPhysicalNetworkInterface(device, ethtool) {
  const name =
    getStringValue(device.ifname) ?? getStringValue(device.name) ?? "";
  const driver = normalizeEmptyString(ethtool[name]?.driver);
  const busInfo = normalizeEmptyString(ethtool[name]?.["bus-info"]);

  if (!name || name === "lo") {
    return false;
  }
  if (/^(docker|veth|tailscale|virbr|br-|lo)/u.test(name)) {
    return false;
  }
  if (["bridge", "tun", "veth"].includes(driver ?? "")) {
    return false;
  }
  if (busInfo && !["N/A", "tun"].includes(busInfo)) {
    return true;
  }
  return getStringValue(device.linkType) !== "none";
}

function hasBoardData(dmiInfo, deviceTree, dmidecode, lshw) {
  return Boolean(
    normalizeIdentityString(dmiInfo.board_name) ||
      normalizeIdentityString(dmiInfo.board_vendor) ||
      normalizeIdentityString(dmiInfo.board_version) ||
      normalizeIdentityString(dmiInfo.board_serial) ||
      normalizeIdentityString(dmidecode.baseboard?.["Product Name"]) ||
      normalizeIdentityString(dmidecode.baseboard?.Manufacturer) ||
      normalizeIdentityString(findLshwMotherboardField(lshw, "product")) ||
      normalizeIdentityString(findLshwMotherboardField(lshw, "vendor")) ||
      normalizeIdentityString(findLshwMotherboardField(lshw, "description")) ||
      normalizeIdentityString(deviceTree.model),
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
  return (
    normalizeIdentityString(hostnamectl.HardwareVendor) ??
    normalizeIdentityString(dmiInfo.sys_vendor) ??
    normalizeIdentityString(dmiInfo.board_vendor)
  );
}

function inferVendorFromDeviceTree(compatible, model) {
  const firstCompatible = Array.isArray(compatible) ? compatible[0] : undefined;
  const vendorToken = firstCompatible?.split(",")[0]?.toLowerCase();
  if (vendorToken === "raspberrypi") {
    return "Raspberry Pi";
  }
  if (vendorToken) {
    return vendorToken.replace(/[-_]/gu, " ");
  }
  if (model?.toLowerCase().includes("raspberry pi")) {
    return "Raspberry Pi";
  }
  return undefined;
}

function findLshwSystemField(roots, field) {
  const system =
    roots.find((entry) => getStringValue(entry.class) === "system") ?? roots[0];
  const value = system?.[field];
  return typeof value === "string" ? value : undefined;
}

function findLshwMemorySize(roots) {
  const memoryNode = walkLshwNodes(roots).find(
    (entry) =>
      getStringValue(entry.class) === "memory" &&
      typeof entry.size === "number",
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

function findLshwCpuNode(nodes) {
  return nodes.find(
    (entry) =>
      getStringValue(entry.class) === "processor" &&
      getBooleanValue(entry.disabled) !== true &&
      Boolean(
        normalizeProcessorIdentity(getStringValue(entry.product)) ??
          normalizeProcessorIdentity(getStringValue(entry.description)),
      ),
  );
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

function findLshwNetworkNode(nodes, device, ethtoolInfo = undefined) {
  const interfaceNames = [getStringValue(device.ifname), getStringValue(device.name)]
    .filter(Boolean)
    .map((entry) => entry.toLowerCase());
  const busInfo = normalizePciAddress(ethtoolInfo?.["bus-info"]);

  return nodes.find((entry) => {
    if (getStringValue(entry.class) !== "network") {
      return false;
    }

    const logicalNames = getLshwLogicalNames(entry).map((name) => name.toLowerCase());
    if (logicalNames.some((name) => interfaceNames.includes(name))) {
      return true;
    }

    return busInfo !== undefined && normalizePciAddress(entry.businfo) === busInfo;
  });
}

function findLshwStorageContext(nodes, device) {
  const deviceName = getStringValue(device.name);
  const exactNode = deviceName
    ? nodes.find((entry) => getLshwLogicalNames(entry).includes(deviceName))
    : undefined;
  const controllerName = deriveStorageControllerName(deviceName);
  const controllerNode = controllerName
    ? nodes.find((entry) => getLshwLogicalNames(entry).includes(controllerName))
    : undefined;

  return {
    exactNode,
    controllerNode,
  };
}

function findLshwNvmeControllerNode(nodes, controller) {
  const controllerName = getStringValue(controller.name);
  const address = normalizePciAddress(controller.address);

  return nodes.find((entry) => {
    if (getStringValue(entry.class) !== "storage") {
      return false;
    }

    if (controllerName && getLshwLogicalNames(entry).includes(controllerName)) {
      return true;
    }

    return address !== undefined && normalizePciAddress(entry.businfo) === address;
  });
}

function findLshwNvmeNamespaceNode(lshwNode, controller) {
  const namespaces = Array.isArray(controller?.namespaces) ? controller.namespaces : [];
  const children = Array.isArray(lshwNode?.children) ? lshwNode.children : [];

  return children.find((entry) =>
    getLshwLogicalNames(entry).some((logicalName) => namespaces.includes(logicalName)),
  );
}

function findLshwPciNode(nodes, device) {
  const slot = normalizePciAddress(device.Slot);
  if (!slot) {
    return undefined;
  }

  return nodes.find((entry) => normalizePciAddress(entry.businfo) === slot);
}

function findLshwDisplayNode(nodes, device) {
  const pciSlot = normalizePciAddress(device.pciSlot);

  return nodes.find((entry) => {
    if (getStringValue(entry.class) !== "display") {
      return false;
    }

    if (pciSlot && normalizePciAddress(entry.businfo) === pciSlot) {
      return true;
    }

    return (
      getStringValue(entry.vendor) !== undefined &&
      normalizeHexString(entry.vendorId) === normalizeHexString(device.vendorId) &&
      normalizeHexString(entry.productId) === normalizeHexString(device.productId)
    );
  });
}

function parseUeventText(stdout) {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce(
      (result, line) => {
        const separatorIndex = line.indexOf("=");
        if (separatorIndex === -1) {
          return result;
        }
        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        if (key && value) {
          result[key] = value;
        }
        return result;
      },
      /** @type {Record<string, string>} */ ({}),
    );
}

function collectIndexedAttributeFiles(
  basePath,
  observedFiles,
  prefix,
  suffixes,
) {
  return safeReaddirSync(basePath)
    .filter((name) => new RegExp(`^${prefix}\\d+`, "u").test(name))
    .reduce(
      (result, name) => {
        const match = name.match(new RegExp(`^(${prefix}\\d+)(.*)$`, "u"));
        if (!match) {
          return result;
        }
        const sensorPrefix = match[1];
        suffixes.forEach((suffix) => {
          const fileName = suffix ? `${sensorPrefix}_${suffix}` : sensorPrefix;
          const value = readObservedTextFile(
            join(basePath, fileName),
            observedFiles,
          );
          if (value !== undefined) {
            result[fileName] = value;
          }
        });
        return result;
      },
      /** @type {Record<string, string>} */ ({}),
    );
}

function collectIndexedSensors(input, prefix, valueSuffix, divisor) {
  return Object.keys(input)
    .filter((key) =>
      new RegExp(`^${prefix}\\d+_${valueSuffix}$`, "u").test(key),
    )
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    )
    .map((key) => {
      const sensorPrefix = key.replace(new RegExp(`_${valueSuffix}$`, "u"), "");
      const rawValue = toNumber(input[key]);
      return {
        label: getStringValue(input[`${sensorPrefix}_label`]) ?? sensorPrefix,
        valueCelsius:
          prefix === "temp" && rawValue !== undefined
            ? rawValue / divisor
            : undefined,
        valueRpm: prefix === "fan" ? rawValue : undefined,
      };
    })
    .filter(
      (entry) =>
        entry.valueCelsius !== undefined || entry.valueRpm !== undefined,
    );
}

function collectIndexedScalarValues(input, prefix) {
  return Object.keys(input)
    .filter((key) => new RegExp(`^${prefix}\\d+$`, "u").test(key))
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    )
    .map((key) => toNumber(input[key]))
    .filter((value) => value !== undefined);
}

function milliCelsiusToCelsius(value) {
  const normalized = getNumberValue(value);
  return normalized !== undefined ? normalized / 1000 : undefined;
}

function formatSensorReading(label, value, unit) {
  return label && value !== undefined ? `${label}: ${value}${unit}` : undefined;
}

function decodeEdidManufacturerId(leftByte, rightByte) {
  const value = (leftByte << 8) | rightByte;
  const letters = [(value >> 10) & 0x1f, (value >> 5) & 0x1f, value & 0x1f]
    .map((entry) =>
      entry >= 1 && entry <= 26 ? String.fromCharCode(64 + entry) : "",
    )
    .join("");

  return letters || undefined;
}

function decodeEdidTextDescriptor(block, descriptorType) {
  if (
    block.length !== 18 ||
    block[0] !== 0x00 ||
    block[1] !== 0x00 ||
    block[2] !== 0x00 ||
    block[3] !== descriptorType
  ) {
    return undefined;
  }

  return (
    block
      .subarray(5, 18)
      .toString("ascii")
      .replaceAll("\u0000", "")
      .replace(/\n/gu, "")
      .trim() || undefined
  );
}

function decodeEdidPreferredTiming(block) {
  if (block.length !== 18 || block.readUInt16LE(0) === 0) {
    return undefined;
  }

  const horizontalActive = block[2] + ((block[4] & 0xf0) << 4);
  const verticalActive = block[5] + ((block[7] & 0xf0) << 4);

  return horizontalActive > 0 && verticalActive > 0
    ? `${horizontalActive}x${verticalActive}`
    : undefined;
}

function extractTrailingCount(value) {
  const match = value?.match(/(\d+)$/u);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function collectOrderedUeventValues(uevent, prefix) {
  const values = Object.keys(uevent)
    .filter((key) => key.startsWith(prefix) && key !== `${prefix}N`)
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    )
    .map((key) => uevent[key])
    .filter(Boolean);

  return values.length ? values : undefined;
}

function deriveDisplayAdapterName(device, lshwNode = undefined) {
  return (
    pickHardwareName(
      getStringValue(lshwNode?.product),
      getStringValue(lshwNode?.description),
    ) ??
    getStringValue(device.driver) ??
    getStringValue(device.ofName) ??
    (Array.isArray(device.ofCompatible)
      ? getStringValue(device.ofCompatible[0])
      : undefined) ??
    (device.vendorId && device.productId
      ? `Display Adapter ${device.vendorId}:${device.productId}`
      : undefined) ??
    getStringValue(device.name) ??
    "Display Adapter"
  );
}

function formatDisplayName(manufacturerId, connectorName) {
  return manufacturerId
    ? `${manufacturerId} Display`
    : connectorName
      ? `${connectorName} Display`
      : "Display";
}

function formatDisplayPhysicalSize(widthCm, heightCm) {
  const normalizedWidth = getNumberValue(widthCm);
  const normalizedHeight = getNumberValue(heightCm);

  return normalizedWidth !== undefined && normalizedHeight !== undefined
    ? `${normalizedWidth} x ${normalizedHeight} cm`
    : undefined;
}

function classifyVideoHardwareClass(device) {
  const text = [device.name, device.driver, device.modalias]
    .map((entry) => normalizeEmptyString(entry)?.toLowerCase())
    .filter(Boolean)
    .join(" ");

  if (/(camera|webcam|uvcvideo|facetime)/u.test(text)) {
    return "camera";
  }
  if (/(codec|decoder|encoder|rpivid|pispbe|isp|cec)/u.test(text)) {
    return "video-processor";
  }

  return "video-device";
}

function getDisplayCardName(name) {
  const match = getStringValue(name)?.match(/^(card\d+)/u);
  return match?.[1];
}

function walkLshwNodes(nodes) {
  return nodes.flatMap((node) => {
    const children = Array.isArray(node?.children) ? node.children : [];
    return [node, ...walkLshwNodes(children)];
  });
}

function getLshwLogicalNames(node) {
  const logicalName = node?.logicalname;

  return compact(
    (Array.isArray(logicalName) ? logicalName : [logicalName])
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.split("/").filter(Boolean).at(-1)?.trim()),
  );
}

function collectCpuFeatures(lscpu, cpuInfo, cpuNode) {
  const features = new Set();

  [lscpu.Flags, cpuInfo[0]?.flags, cpuInfo[0]?.Features, cpuInfo[0]?.isa]
    .filter(Boolean)
    .flatMap((value) => String(value).split(/\s+/u))
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value) => {
      features.add(value);
    });

  Object.entries(cpuNode?.capabilities ?? {})
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key.trim())
    .filter(Boolean)
    .forEach((key) => {
      features.add(key);
    });

  return [...features].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
}

function formatCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== "object") {
    return undefined;
  }

  const entries = Object.entries(capabilities)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) =>
      value === true ? key : `${key} (${getScalarStringValue(value) ?? "enabled"})`,
    )
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  return entries.length ? entries.join(", ") : undefined;
}

function formatList(values) {
  return Array.isArray(values) && values.length ? values.join(", ") : undefined;
}

function pickHardwareName(...values) {
  const normalized = values.map((value) => normalizeIdentityString(value)).filter(Boolean);
  return normalized.find((value) => !isGenericHardwareName(value)) ?? normalized[0];
}

function isGenericHardwareName(value) {
  const normalized = normalizeIdentityString(value)?.toLowerCase();
  return Boolean(
    normalized &&
      [
        "cpu",
        "processor",
        "network interface",
        "ethernet interface",
        "wireless interface",
        "block device",
        "pci device",
        "display adapter",
        "computer",
      ].includes(normalized),
  ) || /^device(?:\s+\[[0-9a-f]{4}\])?$/iu.test(normalized ?? "");
}

function normalizeProcessorIdentity(value) {
  const normalized = normalizeIdentityString(value);
  if (!normalized || /^(cpu|processor|l[123]-cache)$/iu.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function parseNetworkSpeedMbps(speedText, speedBitsPerSecond) {
  if (speedText) {
    const match = String(speedText).trim().match(/^(\d+(?:\.\d+)?)\s*([GMK]?)(?:bit|b)\/s$/iu);
    if (match) {
      const scalar = Number.parseFloat(match[1]);
      const multiplier = {
        "": 1,
        K: 0.001,
        M: 1,
        G: 1000,
      }[match[2].toUpperCase()];

      if (!Number.isNaN(scalar) && multiplier !== undefined) {
        return Math.round(scalar * multiplier);
      }
    }
  }

  const numericCapacity = getNumberValue(speedBitsPerSecond);
  return numericCapacity !== undefined ? Math.round(numericCapacity / 1000 / 1000) : undefined;
}

function normalizeYesNo(value) {
  const normalized = normalizeEmptyString(getScalarStringValue(value))?.toLowerCase();

  if (!normalized) {
    return undefined;
  }
  if (["yes", "on", "true", "up"].includes(normalized)) {
    return true;
  }
  if (["no", "off", "false", "down"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function normalizePciAddress(value) {
  const normalized = normalizeEmptyString(getScalarStringValue(value))?.toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized.startsWith("pci@")) {
    return normalized.slice(4);
  }

  return /^\w+@/u.test(normalized) ? normalized.split("@").at(-1) : normalized;
}

function deriveStorageControllerName(deviceName) {
  const normalized = getStringValue(deviceName);
  const nvmeMatch = normalized?.match(/^(nvme\d+)n\d+$/u);
  return nvmeMatch?.[1];
}

function isBluetoothLshwNode(node) {
  if (getStringValue(node?.class) !== "communication") {
    return false;
  }

  const text = [
    getStringValue(node.description),
    getStringValue(node.product),
    getScalarStringValue(node.configuration?.wireless),
    formatCapabilities(node.capabilities),
  ]
    .filter(Boolean)
    .join(" ");

  return /bluetooth/u.test(text) || getBooleanValue(node.capabilities?.bluetooth) === true;
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

function normalizeHexString(value) {
  const normalized = normalizeEmptyString(value)?.trim().toLowerCase();

  if (!normalized) {
    return undefined;
  }

  return normalized.replace(/^0x/u, "");
}

function normalizePciClassCode(value) {
  const normalized = normalizeHexString(value);

  if (!normalized) {
    return undefined;
  }

  return normalized.length > 2 ? normalized.slice(0, -2) : normalized;
}

function normalizeIdentityString(value) {
  const normalized = normalizeEmptyString(value)?.trim();

  if (!normalized) {
    return undefined;
  }
  if (
    [
      "default string",
      "to be filled by o.e.m.",
      "not specified",
      "unknown",
      "none",
    ].includes(normalized.toLowerCase())
  ) {
    return undefined;
  }

  return normalized;
}

function normalizeChassisType(value) {
  const normalized = normalizeIdentityString(value);

  if (!normalized) {
    return undefined;
  }
  const mapped = {
    3: "desktop",
    4: "low-profile-desktop",
    5: "pizza-box",
    6: "mini-tower",
    7: "tower",
    8: "portable",
    9: "laptop",
    10: "notebook",
    11: "hand-held",
    12: "docking-station",
    13: "all-in-one",
    14: "sub-notebook",
    15: "space-saving",
    16: "lunch-box",
    17: "main-server-chassis",
    23: "rack-mount",
    30: "tablet",
    31: "convertible",
    32: "detachable",
    33: "iot-gateway",
    34: "embedded-pc",
    35: "mini-pc",
    36: "stick-pc",
  }[normalized];

  return mapped ?? normalized;
}

function normalizeHostnamectlFirmwareDate(value) {
  if (!value) {
    return undefined;
  }

  if (/^\d+$/u.test(value)) {
    const asNumber = Number.parseInt(value, 10);
    const milliseconds =
      value.length >= 16 ? Math.floor(asNumber / 1000) : asNumber;
    if (!Number.isNaN(milliseconds)) {
      return new Date(milliseconds).toISOString().slice(0, 10);
    }
  }

  return value;
}

function normalizeUsbNumber(value) {
  const normalized = normalizeEmptyString(value);

  if (!normalized) {
    return undefined;
  }

  return normalized.padStart(3, "0");
}

function normalizeUsbVersion(value) {
  return normalizeEmptyString(value)?.trim();
}

function normalizeUsbSpeed(value) {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);

  return Number.isNaN(parsed) ? undefined : Math.round(parsed);
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
    const current = getStringValue(device?.type) === "disk" ? [device] : [];
    return [...current, ...flattenLsblkDevices(children)];
  });
}

function normalizeBooleanLike(value) {
  if (value === undefined) {
    return undefined;
  }
  return value === "1" || value.toLowerCase() === "true";
}

function getScalarStringValue(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
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
