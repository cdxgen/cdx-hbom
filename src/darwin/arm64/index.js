import process from "node:process";

import { runCommand } from "../../common/command.js";
import { parsePlistArray, parsePlistDict } from "../../common/plist.js";
import { createHbomDocument } from "../../common/schema.js";
import {
  compact,
  createComponent,
  createHardwareComponent,
  createProperty,
  redactIdentifier,
} from "../../common/shape.js";
import { readSystemProfiler } from "../common/system-profiler.js";
import {
  DARWIN_ARM64_COMMANDS,
  DARWIN_ARM64_SYSCTL_KEYS,
  DARWIN_ARM64_SYSTEM_PROFILER_TYPES,
} from "./commands.js";

/**
 * Return a copy of the Darwin/arm64 command plan.
 *
 * @returns {ReadonlyArray<object>} Command descriptors.
 */
export function getDarwinArm64CommandPlan() {
  return DARWIN_ARM64_COMMANDS.map((spec) => ({
    ...spec,
    args: [...spec.args],
    sensitiveFields: spec.sensitiveFields
      ? [...spec.sensitiveFields]
      : undefined,
  }));
}

/**
 * Parse ordered `sysctl -n` output into a key/value object.
 *
 * @param {string} stdout Command stdout.
 * @param {string[]} [keys=[...DARWIN_ARM64_SYSCTL_KEYS]] Key order.
 * @returns {Record<string, string>} Parsed values.
 */
export function parseSysctlValues(
  stdout,
  keys = [...DARWIN_ARM64_SYSCTL_KEYS],
) {
  const values = stdout
    .trim()
    .split(/\r?\n/u)
    .map((value) => value.trim());

  return keys.reduce(
    (result, key, index) => {
      result[key] = values[index] ?? "";
      return result;
    },
    /** @type {Record<string, string>} */ ({}),
  );
}

/**
 * Parse `networksetup -listallhardwareports` output into structured blocks.
 *
 * @param {string} stdout Command stdout.
 * @returns {Array<{ hardwarePort?: string, device?: string, ethernetAddress?: string }>} Parsed ports.
 */
export function parseNetworksetupPorts(stdout) {
  return stdout
    .trim()
    .split(/\n\s*\n/u)
    .map((block) => block.trim())
    .filter((block) => block.startsWith("Hardware Port:"))
    .map((block) => {
      const lines = block.split(/\r?\n/u);
      const entry =
        /** @type {{ hardwarePort?: string, device?: string, ethernetAddress?: string }} */ ({});

      lines.forEach((line) => {
        const trimmed = line.trim();

        if (trimmed.startsWith("Hardware Port:")) {
          entry.hardwarePort = trimmed.slice("Hardware Port:".length).trim();
        }
        if (trimmed.startsWith("Device:")) {
          entry.device = trimmed.slice("Device:".length).trim();
        }
        if (trimmed.startsWith("Ethernet Address:")) {
          entry.ethernetAddress = trimmed
            .slice("Ethernet Address:".length)
            .trim()
            .toLowerCase();
        }
      });

      return entry;
    });
}

/**
 * Parse `pmset -g batt` output.
 *
 * @param {string} stdout Command stdout.
 * @returns {{ powerSource?: string, batteryId?: string, chargePercent?: number, isAcAttached?: boolean, isCharging?: boolean } | null} Parsed battery state.
 */
export function parsePmsetBattery(stdout) {
  if (!stdout.trim()) {
    return null;
  }

  const lines = stdout.trim().split(/\r?\n/u);
  const powerSource = lines[0]?.match(/Now drawing from '([^']+)'/u)?.[1];
  const batteryLine = lines.find((line) => line.includes("InternalBattery"));

  if (!batteryLine) {
    return powerSource ? { powerSource } : null;
  }

  const chargePercent = Number.parseInt(
    batteryLine.match(/(\d+)%/u)?.[1] ?? "",
    10,
  );
  const batteryId = batteryLine.match(/\(id=(\d+)\)/u)?.[1];
  const isAcAttached = /AC attached/u.test(batteryLine);
  const isCharging =
    /charging/u.test(batteryLine) && !/not charging/u.test(batteryLine);

  return {
    powerSource,
    batteryId,
    chargePercent: Number.isNaN(chargePercent) ? undefined : chargePercent,
    isAcAttached,
    isCharging,
  };
}

/**
 * Parse `ifconfig <iface>` output.
 *
 * @param {string} stdout Command stdout.
 * @returns {{ flags?: string[], mtu?: number, macAddress?: string, ipv4Count: number, ipv6Count: number, media?: string, status?: string }} Parsed interface state.
 */
export function parseIfconfigText(stdout) {
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  const header = lines[0] ?? "";
  const flags = header.match(/<([^>]+)>/u)?.[1]?.split(",") ?? [];
  const mtu = Number.parseInt(header.match(/mtu\s+(\d+)/u)?.[1] ?? "", 10);
  const macAddress = lines
    .find((line) => line.trim().startsWith("ether "))
    ?.trim()
    .slice("ether ".length)
    .trim()
    .toLowerCase();
  const media = lines
    .find((line) => line.trim().startsWith("media:"))
    ?.trim()
    .slice("media:".length)
    .trim();
  const status = lines
    .find((line) => line.trim().startsWith("status:"))
    ?.trim()
    .slice("status:".length)
    .trim();

  return {
    flags,
    mtu: Number.isNaN(mtu) ? undefined : mtu,
    macAddress,
    ipv4Count: lines.filter((line) => line.trim().startsWith("inet ")).length,
    ipv6Count: lines.filter((line) => line.trim().startsWith("inet6 ")).length,
    media,
    status,
  };
}

/**
 * Normalize a `diskutil apfs list -plist` result into container and volume records.
 *
 * @param {Record<string, unknown> | undefined} plist Parsed APFS plist.
 * @returns {{ containers: Array<Record<string, unknown>>, volumes: Array<Record<string, unknown>> }} Normalized APFS topology.
 */
export function normalizeApfsTopology(plist) {
  const containers = Array.isArray(plist?.Containers) ? plist.Containers : [];

  return {
    containers,
    volumes: containers.flatMap((container) =>
      Array.isArray(container?.Volumes)
        ? container.Volumes.map((volume) => ({
            ...volume,
            ContainerReference: container.ContainerReference,
            APFSContainerUUID: container.APFSContainerUUID,
          }))
        : [],
    ),
  };
}

/**
 * Build an HBOM-like object from pre-collected Darwin arm64 command outputs.
 *
 * @param {{
 *   sources: {
 *     profiler?: Record<string, unknown>,
 *     sysctl?: Record<string, string>,
 *     networksetup?: Array<{ hardwarePort?: string, device?: string, ethernetAddress?: string }>,
 *     ifconfig?: Record<string, { flags?: string[], mtu?: number, macAddress?: string, ipv4Count: number, ipv6Count: number, media?: string, status?: string }>,
 *     pmsetBattery?: { powerSource?: string, batteryId?: string, chargePercent?: number, isAcAttached?: boolean, isCharging?: boolean } | null,
 *     diskutilPlists?: Record<string, unknown>[],
 *     ioregPlatform?: Record<string, unknown>[] | Record<string, unknown> | null,
 *     usb?: unknown[],
 *     airport?: unknown[],
 *     audio?: unknown[],
 *     camera?: unknown[],
 *     apfsTopology?: Record<string, unknown>
 *   },
 *   includeSensitiveIdentifiers?: boolean,
 *   collectedAt?: string,
 *   executedCommands?: Array<{ id: string, category: string, command: string, args: string[] }>
 * }} [options={}] Build inputs.
 * @returns {object} HBOM-like inventory object.
 */
export function buildDarwinArm64Hbom(options = {}) {
  const sources = options.sources ?? {};
  const profiler = sources.profiler ?? {};
  const sysctl = sources.sysctl ?? {};
  const networkPorts = sources.networksetup ?? [];
  const ifconfig = sources.ifconfig ?? {};
  const pmsetBattery = sources.pmsetBattery ?? null;
  const diskutilPlists = Array.isArray(sources.diskutilPlists)
    ? sources.diskutilPlists
    : [];
  const ioregPlatform = Array.isArray(sources.ioregPlatform)
    ? sources.ioregPlatform[0]
    : (sources.ioregPlatform ?? undefined);
  const hardwareOverview = Array.isArray(profiler.SPHardwareDataType)
    ? profiler.SPHardwareDataType[0]
    : undefined;
  const displayEntries = Array.isArray(profiler.SPDisplaysDataType)
    ? profiler.SPDisplaysDataType
    : [];
  const storageGroups = Array.isArray(profiler.SPNVMeDataType)
    ? profiler.SPNVMeDataType
    : [];
  const usbEntries = Array.isArray(sources.usb)
    ? sources.usb
    : Array.isArray(profiler.SPUSBDataType)
      ? profiler.SPUSBDataType
      : [];
  const airportEntries = Array.isArray(sources.airport)
    ? sources.airport
    : Array.isArray(profiler.SPAirPortDataType)
      ? profiler.SPAirPortDataType
      : [];
  const audioEntries = Array.isArray(sources.audio)
    ? sources.audio
    : Array.isArray(profiler.SPAudioDataType)
      ? profiler.SPAudioDataType
      : [];
  const cameraEntries = Array.isArray(sources.camera)
    ? sources.camera
    : Array.isArray(profiler.SPCameraDataType)
      ? profiler.SPCameraDataType
      : [];
  const apfsTopology = normalizeApfsTopology(sources.apfsTopology);
  const bluetoothEntries = Array.isArray(profiler.SPBluetoothDataType)
    ? profiler.SPBluetoothDataType
    : [];
  const thunderboltEntries = Array.isArray(profiler.SPThunderboltDataType)
    ? profiler.SPThunderboltDataType
    : [];
  const powerEntries = Array.isArray(profiler.SPPowerDataType)
    ? profiler.SPPowerDataType
    : [];
  const timestamp = options.collectedAt ?? new Date().toISOString();
  const modelName =
    getStringValue(hardwareOverview, "machine_name") ?? "Apple device";
  const modelIdentifier =
    getStringValue(hardwareOverview, "machine_model") ??
    sysctl["hw.model"] ??
    "unknown";
  const chipName =
    getStringValue(hardwareOverview, "chip_type") ??
    sysctl["machdep.cpu.brand_string"] ??
    "unknown processor";
  const memoryValue =
    getStringValue(hardwareOverview, "physical_memory") ??
    normalizeBytesToGiB(sysctl["hw.memsize"]);
  const identifierPolicy = options.includeSensitiveIdentifiers
    ? "raw-identifiers-enabled"
    : "redacted-by-default";
  const deviceComponent = createComponent({
    type: "device",
    name: modelName,
    version: modelIdentifier,
    manufacturer: {
      name:
        decodeBase64DataString(getStringValue(ioregPlatform, "manufacturer")) ??
        "Apple",
    },
    description: chipName,
    properties: compact([
      createProperty("cdx:hbom:platform", "darwin"),
      createProperty("cdx:hbom:architecture", "arm64"),
      createProperty("cdx:hbom:chip", chipName),
      createProperty("cdx:hbom:memory", memoryValue),
      createProperty(
        "cdx:hbom:serialNumber",
        redactIdentifier(
          getStringValue(hardwareOverview, "serial_number") ??
            getStringValue(ioregPlatform, "IOPlatformSerialNumber"),
          options,
        ),
      ),
      createProperty(
        "cdx:hbom:platformUuid",
        redactIdentifier(
          getStringValue(hardwareOverview, "platform_UUID") ??
            getStringValue(ioregPlatform, "IOPlatformUUID"),
          options,
        ),
      ),
      createProperty(
        "cdx:hbom:modelNumber",
        getStringValue(hardwareOverview, "model_number"),
      ),
      createProperty(
        "cdx:hbom:registryEntryName",
        getStringValue(ioregPlatform, "IORegistryEntryName"),
      ),
      createProperty("cdx:hbom:identifierPolicy", identifierPolicy),
    ]),
  });
  const components = compact([
    createHardwareComponent("processor", {
      name: chipName,
      version: modelIdentifier,
      manufacturer: { name: "Apple" },
      properties: compact([
        createProperty("cdx:hbom:coreCount", sysctl["hw.ncpu"]),
        createProperty("cdx:hbom:logicalCpuCount", sysctl["hw.logicalcpu"]),
        createProperty("cdx:hbom:physicalCpuCount", sysctl["hw.physicalcpu"]),
      ]),
    }),
    memoryValue
      ? createHardwareComponent("memory", {
          name: "Unified Memory",
          manufacturer: { name: "Apple" },
          properties: compact([createProperty("cdx:hbom:size", memoryValue)]),
        })
      : undefined,
    ...collectStorageComponents(storageGroups, diskutilPlists, options),
    ...collectDisplayComponents(displayEntries, options),
    ...collectUsbComponents(usbEntries, options),
    ...collectAirportComponents(airportEntries, options),
    ...collectAudioComponents(audioEntries),
    ...collectCameraComponents(cameraEntries, options),
    ...collectApfsComponents(apfsTopology, options),
    ...collectBluetoothComponents(bluetoothEntries, options),
    ...collectThunderboltComponents(thunderboltEntries, options),
    ...networkPorts.map((port) =>
      createHardwareComponent("network-interface", {
        name: port.hardwarePort ?? port.device ?? "Network Interface",
        version: port.device,
        properties: compact([
          createProperty(
            "cdx:hbom:macAddress",
            redactIdentifier(
              port.ethernetAddress ?? ifconfig[port.device]?.macAddress,
              options,
            ),
          ),
          createProperty("cdx:hbom:mtu", ifconfig[port.device]?.mtu),
          createProperty("cdx:hbom:media", ifconfig[port.device]?.media),
          createProperty("cdx:hbom:status", ifconfig[port.device]?.status),
          createProperty(
            "cdx:hbom:ipv4Count",
            ifconfig[port.device]?.ipv4Count,
          ),
          createProperty(
            "cdx:hbom:ipv6Count",
            ifconfig[port.device]?.ipv6Count,
          ),
          createProperty(
            "cdx:hbom:flags",
            Array.isArray(ifconfig[port.device]?.flags) &&
              ifconfig[port.device].flags.length
              ? ifconfig[port.device].flags.join(", ")
              : undefined,
          ),
        ]),
      }),
    ),
    ...collectBatteryComponents(powerEntries, pmsetBattery, options),
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
      createProperty("cdx:hbom:targetPlatform", "darwin"),
      createProperty("cdx:hbom:targetArchitecture", "arm64"),
      createProperty("cdx:hbom:identifierPolicy", identifierPolicy),
      createProperty("cdx:hbom:collectorProfile", "darwin-arm64-v1"),
      createProperty(
        "cdx:hbom:evidence:commandCount",
        (
          options.executedCommands ??
          DARWIN_ARM64_COMMANDS.filter((spec) => spec.phase === "collector-v1")
        ).length,
      ),
      ...collectCommandProperties(
        options.executedCommands ??
          DARWIN_ARM64_COMMANDS.filter(
            (spec) => spec.phase === "collector-v1",
          ).map((spec) => ({
            id: spec.id,
            category: spec.category,
            command: spec.command,
            args: [...spec.args],
          })),
      ),
    ]),
  });
}

/**
 * Execute the Darwin arm64 collector.
 *
 * @param {{
 *   includeSensitiveIdentifiers?: boolean,
 *   includePlistEnrichment?: boolean,
 *   timeoutMs?: number,
 *   allowPartial?: boolean,
 *   allowedCommands?: string[]
 * }} [options={}] Collector options.
 * @returns {Promise<object>} HBOM-like inventory object.
 */
export async function collectDarwinArm64Hardware(options = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(
      `Darwin arm64 collector must run on darwin/arm64. Current host is ${process.platform}/${process.arch}.`,
    );
  }

  const allowPartial = options.allowPartial ?? true;
  const sources = /** @type {{
   *   profiler?: Record<string, unknown>,
   *   sysctl?: Record<string, string>,
   *   networksetup?: Array<{ hardwarePort?: string, device?: string, ethernetAddress?: string }>,
   *   ifconfig?: Record<string, { flags?: string[], mtu?: number, macAddress?: string, ipv4Count: number, ipv6Count: number, media?: string, status?: string }>,
   *   pmsetBattery?: { powerSource?: string, batteryId?: string, chargePercent?: number, isAcAttached?: boolean, isCharging?: boolean } | null,
   *   diskutilPlists?: Record<string, unknown>[],
   *   ioregPlatform?: Record<string, unknown>[] | null,
   *   apfsTopology?: Record<string, unknown>
   * }} */ ({});
  const executedCommands = [];

  await attemptCollection(async () => {
    sources.sysctl = parseSysctlValues(
      await runCommand(getRequiredCommand("sysctl-baseline"), options),
    );
    executedCommands.push(
      toEvidenceCommand(getRequiredCommand("sysctl-baseline")),
    );
  }, allowPartial);

  await attemptCollection(async () => {
    sources.profiler = await readSystemProfiler(
      [...DARWIN_ARM64_SYSTEM_PROFILER_TYPES],
      options,
    );
    executedCommands.push(
      toEvidenceCommand(getRequiredCommand("system-profiler-json")),
    );
  }, allowPartial);

  await attemptCollection(async () => {
    sources.networksetup = parseNetworksetupPorts(
      await runCommand(getRequiredCommand("network-hardware-ports"), options),
    );
    executedCommands.push(
      toEvidenceCommand(getRequiredCommand("network-hardware-ports")),
    );
  }, allowPartial);

  sources.ifconfig = {};
  const networkDevices = [
    ...new Set(
      (sources.networksetup ?? []).map((entry) => entry.device).filter(Boolean),
    ),
  ];
  for (const deviceName of networkDevices) {
    await attemptCollection(async () => {
      const spec = createIfconfigCommand(deviceName);
      sources.ifconfig[deviceName] = parseIfconfigText(
        await runCommand(spec, options),
      );
      executedCommands.push(toEvidenceCommand(spec));
    }, allowPartial);
  }

  await attemptCollection(async () => {
    sources.pmsetBattery = parsePmsetBattery(
      await runCommand(getRequiredCommand("battery-status"), options),
    );
    executedCommands.push(
      toEvidenceCommand(getRequiredCommand("battery-status")),
    );
  }, allowPartial);

  if (options.includePlistEnrichment === true) {
    const diskIdentifiers = findProfilerStorageIdentifiers(
      Array.isArray(sources.profiler?.SPNVMeDataType)
        ? sources.profiler.SPNVMeDataType
        : [],
    );

    for (const deviceIdentifier of diskIdentifiers) {
      await attemptCollection(async () => {
        const spec = createDiskutilCommand(deviceIdentifier);
        const plist = parsePlistDict(await runCommand(spec, options));
        if (!sources.diskutilPlists) {
          sources.diskutilPlists = [];
        }
        sources.diskutilPlists.push(plist);
        executedCommands.push(toEvidenceCommand(spec));
      }, allowPartial);
    }

    await attemptCollection(async () => {
      const spec = getRequiredCommand("platform-registry");
      sources.ioregPlatform = parsePlistArray(await runCommand(spec, options));
      executedCommands.push(toEvidenceCommand(spec));
    }, allowPartial);

    await attemptCollection(async () => {
      const spec = getRequiredCommand("apfs-topology");
      sources.apfsTopology = parsePlistDict(await runCommand(spec, options));
      executedCommands.push(toEvidenceCommand(spec));
    }, allowPartial);
  }

  return buildDarwinArm64Hbom({
    sources,
    includeSensitiveIdentifiers: options.includeSensitiveIdentifiers,
    executedCommands,
  });
}

/**
 * Collect display components from `system_profiler` JSON.
 *
 * @param {unknown[]} displayEntries Display groups.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Redaction options.
 * @returns {Array<object>} Display components.
 */
function collectDisplayComponents(displayEntries, options = {}) {
  return displayEntries.flatMap((entry) => {
    const groupName = getStringValue(entry, "_name");
    const displays = Array.isArray(entry?.spdisplays_ndrvs)
      ? entry.spdisplays_ndrvs
      : [];

    if (displays.length === 0 && groupName) {
      return [
        createHardwareComponent("display-controller", {
          name: groupName,
        }),
      ];
    }

    return displays.map((display) =>
      createHardwareComponent("display", {
        name: getStringValue(display, "_name") ?? groupName ?? "Display",
        description: getStringValue(display, "spdisplays_display_type"),
        properties: compact([
          createProperty(
            "cdx:hbom:resolution",
            getStringValue(display, "_spdisplays_resolution") ??
              getStringValue(display, "spdisplays_pixelresolution"),
          ),
          createProperty(
            "cdx:hbom:connectionType",
            getStringValue(display, "spdisplays_connection_type"),
          ),
          createProperty(
            "cdx:hbom:vendorId",
            getStringValue(display, "_spdisplays_display-vendor-id"),
          ),
          createProperty(
            "cdx:hbom:productId",
            getStringValue(display, "_spdisplays_display-product-id"),
          ),
          createProperty(
            "cdx:hbom:displaySerialNumber",
            redactIdentifier(
              getStringValue(display, "_spdisplays_display-serial-number"),
              options,
            ),
          ),
        ]),
      }),
    );
  });
}

/**
 * Collect USB controller and device components from `system_profiler` JSON.
 *
 * @param {unknown[]} usbEntries USB entries.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Redaction options.
 * @returns {Array<object>} USB components.
 */
function collectUsbComponents(usbEntries, options = {}) {
  return usbEntries.flatMap((entry) => {
    const controllerName = getStringValue(entry, "_name");
    const children = Array.isArray(entry?._items) ? entry._items : [];

    return compact([
      controllerName
        ? createHardwareComponent("usb-controller", {
            name: controllerName,
            properties: compact([
              createProperty(
                "cdx:hbom:locationId",
                getStringValue(entry, "location_id"),
              ),
              createProperty(
                "cdx:hbom:currentAvailable",
                getStringValue(entry, "current_available"),
              ),
            ]),
          })
        : undefined,
      ...collectUsbChildComponents(children, controllerName, options),
    ]);
  });
}

/**
 * Collect Wi-Fi adapter components from `SPAirPortDataType`.
 *
 * @param {unknown[]} airportEntries Wi-Fi entries.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Redaction options.
 * @returns {Array<object>} Wi-Fi components.
 */
function collectAirportComponents(airportEntries, options = {}) {
  const interfaces = airportEntries.flatMap((entry) =>
    Array.isArray(entry?.spairport_airport_interfaces)
      ? entry.spairport_airport_interfaces
      : [],
  );

  return interfaces
    .filter((entry) => {
      const name = getStringValue(entry, "_name") ?? "";
      if (/^(awdl|llw|p2p)/u.test(name)) {
        return false;
      }

      return Boolean(
        getStringValue(entry, "spairport_wireless_card_type") ||
          getStringValue(entry, "spairport_wireless_firmware_version"),
      );
    })
    .map((entry) => {
      const currentNetwork = getObjectValue(
        entry,
        "spairport_current_network_information",
      );
      const ids = parseAirportCardIds(
        getStringValue(entry, "spairport_wireless_card_type"),
      );
      const supportedChannels = Array.isArray(
        entry?.spairport_supported_channels,
      )
        ? entry.spairport_supported_channels
        : [];

      return createHardwareComponent("wireless-adapter", {
        name: getStringValue(entry, "_name") ?? "Wi-Fi Interface",
        description: getStringValue(entry, "spairport_supported_phymodes"),
        properties: compact([
          createProperty(
            "cdx:hbom:macAddress",
            redactIdentifier(
              getStringValue(
                entry,
                "spairport_wireless_mac_address",
              )?.toLowerCase(),
              options,
            ),
          ),
          createProperty("cdx:hbom:vendorId", ids.vendorId),
          createProperty("cdx:hbom:productId", ids.productId),
          createProperty(
            "cdx:hbom:firmwareVersion",
            getStringValue(entry, "spairport_wireless_firmware_version"),
          ),
          createProperty(
            "cdx:hbom:status",
            getStringValue(entry, "spairport_status_information"),
          ),
          createProperty(
            "cdx:hbom:connected",
            getStringValue(entry, "spairport_status_information") ===
              "spairport_status_connected",
          ),
          createProperty(
            "cdx:hbom:supportedPhyModes",
            getStringValue(entry, "spairport_supported_phymodes"),
          ),
          createProperty(
            "cdx:hbom:supportedChannelCount",
            supportedChannels.length || undefined,
          ),
          createProperty(
            "cdx:hbom:countryCode",
            getStringValue(currentNetwork, "spairport_network_country_code") ??
              getStringValue(entry, "spairport_wireless_country_code"),
          ),
          createProperty(
            "cdx:hbom:channel",
            getStringValue(currentNetwork, "spairport_network_channel"),
          ),
          createProperty(
            "cdx:hbom:phyMode",
            getStringValue(currentNetwork, "spairport_network_phymode"),
          ),
          createProperty(
            "cdx:hbom:linkRateMbps",
            getNumberValue(currentNetwork, "spairport_network_rate"),
          ),
          createProperty(
            "cdx:hbom:securityMode",
            getStringValue(currentNetwork, "spairport_security_mode"),
          ),
        ]),
      });
    });
}

/**
 * Collect CoreAudio devices from `SPAudioDataType`.
 *
 * @param {unknown[]} audioEntries Audio entries.
 * @returns {Array<object>} Audio components.
 */
function collectAudioComponents(audioEntries) {
  const mergedDevices = new Map();

  audioEntries.forEach((entry) => {
    const items = Array.isArray(entry?._items) ? entry._items : [];
    items.forEach((device) => {
      const name = getStringValue(device, "_name") ?? "Audio Device";
      const manufacturer =
        getStringValue(device, "coreaudio_device_manufacturer") ?? "";
      const transport =
        getStringValue(device, "coreaudio_device_transport") ?? "";
      const key = [name, manufacturer, transport].join("|");
      const current = mergedDevices.get(key) ?? {
        name,
        manufacturer,
        transport,
        inputChannels: undefined,
        outputChannels: undefined,
        sampleRates: new Set(),
        defaultInput: false,
        defaultOutput: false,
        defaultSystemOutput: false,
        inputSources: new Set(),
        outputSources: new Set(),
      };

      const inputChannels = getNumberValue(device, "coreaudio_device_input");
      const outputChannels = getNumberValue(device, "coreaudio_device_output");
      const sampleRate = getNumberValue(device, "coreaudio_device_srate");
      if (inputChannels !== undefined) {
        current.inputChannels = Math.max(
          current.inputChannels ?? 0,
          inputChannels,
        );
      }
      if (outputChannels !== undefined) {
        current.outputChannels = Math.max(
          current.outputChannels ?? 0,
          outputChannels,
        );
      }
      if (sampleRate !== undefined) {
        current.sampleRates.add(String(sampleRate));
      }
      current.defaultInput =
        current.defaultInput ||
        getStringValue(device, "coreaudio_default_audio_input_device") ===
          "spaudio_yes";
      current.defaultOutput =
        current.defaultOutput ||
        getStringValue(device, "coreaudio_default_audio_output_device") ===
          "spaudio_yes";
      current.defaultSystemOutput =
        current.defaultSystemOutput ||
        getStringValue(device, "coreaudio_default_audio_system_device") ===
          "spaudio_yes";

      const inputSource = getStringValue(device, "coreaudio_input_source");
      const outputSource = getStringValue(device, "coreaudio_output_source");
      if (inputSource) {
        current.inputSources.add(inputSource);
      }
      if (outputSource) {
        current.outputSources.add(outputSource);
      }

      mergedDevices.set(key, current);
    });
  });

  return [...mergedDevices.values()].map((device) =>
    createHardwareComponent("audio-device", {
      name: device.name,
      manufacturer: device.manufacturer
        ? { name: device.manufacturer }
        : undefined,
      description: normalizeCoreAudioTransport(device.transport),
      properties: compact([
        createProperty("cdx:hbom:transport", device.transport),
        createProperty("cdx:hbom:inputChannels", device.inputChannels),
        createProperty("cdx:hbom:outputChannels", device.outputChannels),
        createProperty(
          "cdx:hbom:sampleRate",
          device.sampleRates.size === 1
            ? [...device.sampleRates][0]
            : undefined,
        ),
        createProperty(
          "cdx:hbom:sampleRates",
          device.sampleRates.size > 1
            ? [...device.sampleRates].sort().join(", ")
            : undefined,
        ),
        createProperty("cdx:hbom:defaultInput", device.defaultInput),
        createProperty("cdx:hbom:defaultOutput", device.defaultOutput),
        createProperty(
          "cdx:hbom:defaultSystemOutput",
          device.defaultSystemOutput,
        ),
        createProperty(
          "cdx:hbom:inputSources",
          device.inputSources.size
            ? [...device.inputSources].sort().join(", ")
            : undefined,
        ),
        createProperty(
          "cdx:hbom:outputSources",
          device.outputSources.size
            ? [...device.outputSources].sort().join(", ")
            : undefined,
        ),
      ]),
    }),
  );
}

/**
 * Collect camera components from `SPCameraDataType`.
 *
 * @param {unknown[]} cameraEntries Camera entries.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Redaction options.
 * @returns {Array<object>} Camera components.
 */
function collectCameraComponents(cameraEntries, options = {}) {
  return cameraEntries.map((entry) => {
    const name = getStringValue(entry, "_name") ?? "Camera";
    const modelId = getStringValue(entry, "spcamera_model-id");
    const uniqueId = getStringValue(entry, "spcamera_unique-id");
    const isVirtual = /(virtual|extension|obs|insta360)/iu.test(
      `${name} ${modelId ?? ""}`,
    );

    return createHardwareComponent("camera", {
      name,
      description: modelId,
      properties: compact([
        createProperty("cdx:hbom:cameraModelId", modelId),
        createProperty("cdx:hbom:isVirtual", isVirtual),
        createProperty(
          "cdx:hbom:cameraUniqueId",
          redactIdentifier(uniqueId, options),
        ),
      ]),
    });
  });
}

/**
 * Collect APFS container and volume components from `diskutil apfs list -plist` output.
 *
 * @param {{ containers: Array<Record<string, unknown>>, volumes: Array<Record<string, unknown>> }} topology Normalized APFS topology.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Redaction options.
 * @returns {Array<object>} APFS components.
 */
function collectApfsComponents(topology, options = {}) {
  return [
    ...topology.containers.map((container) =>
      createHardwareComponent("storage-container", {
        name: `APFS Container ${getStringValue(container, "ContainerReference") ?? "container"}`,
        version: getStringValue(container, "ContainerReference"),
        properties: compact([
          createProperty(
            "cdx:hbom:containerUuid",
            redactIdentifier(
              getStringValue(container, "APFSContainerUUID"),
              options,
            ),
          ),
          createProperty(
            "cdx:hbom:physicalStores",
            Array.isArray(container.PhysicalStores)
              ? container.PhysicalStores.map((store) =>
                  getStringValue(store, "DeviceIdentifier"),
                )
                  .filter(Boolean)
                  .join(", ")
              : undefined,
          ),
          createProperty(
            "cdx:hbom:capacityBytes",
            getNumberValue(container, "CapacityCeiling"),
          ),
          createProperty(
            "cdx:hbom:freeBytes",
            getNumberValue(container, "CapacityFree"),
          ),
        ]),
      }),
    ),
    ...topology.volumes.map((volume) =>
      createHardwareComponent("storage-volume", {
        name: getStringValue(volume, "Name") ?? "APFS Volume",
        version: getStringValue(volume, "DeviceIdentifier"),
        properties: compact([
          createProperty(
            "cdx:hbom:volumeUuid",
            redactIdentifier(getStringValue(volume, "APFSVolumeUUID"), options),
          ),
          createProperty(
            "cdx:hbom:container",
            getStringValue(volume, "ContainerReference"),
          ),
          createProperty(
            "cdx:hbom:roles",
            Array.isArray(volume.Roles) ? volume.Roles.join(", ") : undefined,
          ),
          createProperty(
            "cdx:hbom:isEncrypted",
            getBooleanValue(volume, "Encryption"),
          ),
          createProperty(
            "cdx:hbom:fileVault",
            getBooleanValue(volume, "FileVault"),
          ),
          createProperty(
            "cdx:hbom:isLocked",
            getBooleanValue(volume, "Locked"),
          ),
          createProperty(
            "cdx:hbom:capacityInUse",
            getNumberValue(volume, "CapacityInUse"),
          ),
          createProperty(
            "cdx:hbom:capacityQuota",
            getNumberValue(volume, "CapacityQuota"),
          ),
          createProperty(
            "cdx:hbom:capacityReserve",
            getNumberValue(volume, "CapacityReserve"),
          ),
        ]),
      }),
    ),
  ];
}

/**
 * Collect storage components from `system_profiler` JSON and optional diskutil plists.
 *
 * @param {unknown[]} storageGroups Storage groups.
 * @param {Record<string, unknown>[]} diskutilPlists Optional diskutil plists.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Redaction options.
 * @returns {Array<object>} Storage components.
 */
function collectStorageComponents(storageGroups, diskutilPlists, options = {}) {
  const diskutilIndex = new Map(
    diskutilPlists.map((plist) => [
      getStringValue(plist, "DeviceIdentifier"),
      plist,
    ]),
  );
  const seenIdentifiers = new Set();
  const profilerComponents = storageGroups.flatMap((group) => {
    const items = Array.isArray(group?._items) ? group._items : [];

    return items.map((item) => {
      const deviceIdentifier = getStringValue(item, "bsd_name");
      const diskutil = deviceIdentifier
        ? diskutilIndex.get(deviceIdentifier)
        : undefined;
      if (deviceIdentifier) {
        seenIdentifiers.add(deviceIdentifier);
      }
      return createHardwareComponent("storage", {
        name:
          getStringValue(item, "device_model") ??
          getStringValue(item, "_name") ??
          getStringValue(diskutil, "MediaName") ??
          "Storage Device",
        version: deviceIdentifier,
        properties: compact([
          createProperty("cdx:hbom:capacity", getStringValue(item, "size")),
          createProperty(
            "cdx:hbom:capacityBytes",
            getStringValue(item, "size_in_bytes") ??
              getStringValue(diskutil, "Size"),
          ),
          createProperty(
            "cdx:hbom:revision",
            getStringValue(item, "device_revision"),
          ),
          createProperty(
            "cdx:hbom:deviceSerial",
            redactIdentifier(getStringValue(item, "device_serial"), options),
          ),
          createProperty(
            "cdx:hbom:busProtocol",
            getStringValue(diskutil, "BusProtocol"),
          ),
          createProperty(
            "cdx:hbom:smartStatus",
            getStringValue(diskutil, "SMARTStatus"),
          ),
          createProperty(
            "cdx:hbom:mediaType",
            getStringValue(diskutil, "MediaType"),
          ),
          createProperty(
            "cdx:hbom:isInternal",
            getBooleanValue(diskutil, "Internal"),
          ),
          createProperty(
            "cdx:hbom:isRemovable",
            getBooleanValue(diskutil, "Removable"),
          ),
          createProperty(
            "cdx:hbom:blockSize",
            getNumberValue(diskutil, "DeviceBlockSize"),
          ),
          createProperty(
            "cdx:hbom:deviceTreePath",
            getStringValue(diskutil, "DeviceTreePath"),
          ),
          createProperty(
            "cdx:hbom:wearPercentageUsed",
            getNestedNumberValue(
              diskutil,
              "SMARTDeviceSpecificKeysMayVaryNotGuaranteed",
              "PERCENTAGE_USED",
            ),
          ),
        ]),
      });
    });
  });
  const diskutilOnlyComponents = diskutilPlists
    .filter(
      (plist) =>
        !seenIdentifiers.has(getStringValue(plist, "DeviceIdentifier") ?? ""),
    )
    .map((plist) =>
      createHardwareComponent("storage", {
        name: getStringValue(plist, "MediaName") ?? "Storage Device",
        version: getStringValue(plist, "DeviceIdentifier"),
        properties: compact([
          createProperty(
            "cdx:hbom:capacityBytes",
            getNumberValue(plist, "Size"),
          ),
          createProperty(
            "cdx:hbom:busProtocol",
            getStringValue(plist, "BusProtocol"),
          ),
          createProperty(
            "cdx:hbom:smartStatus",
            getStringValue(plist, "SMARTStatus"),
          ),
          createProperty(
            "cdx:hbom:mediaType",
            getStringValue(plist, "MediaType"),
          ),
          createProperty(
            "cdx:hbom:isInternal",
            getBooleanValue(plist, "Internal"),
          ),
        ]),
      }),
    );

  return [...profilerComponents, ...diskutilOnlyComponents];
}

/**
 * Collect Bluetooth controller and device components from `system_profiler` JSON.
 *
 * @param {unknown[]} bluetoothEntries Bluetooth entries.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Redaction options.
 * @returns {Array<object>} Bluetooth components.
 */
function collectBluetoothComponents(bluetoothEntries, options = {}) {
  return bluetoothEntries.flatMap((entry) => {
    const controller = getObjectValue(entry, "controller_properties");
    const connectedDevices = parseNamedDeviceList(
      Array.isArray(entry?.device_connected) ? entry.device_connected : [],
      "connected",
    );
    const disconnectedDevices = parseNamedDeviceList(
      Array.isArray(entry?.device_not_connected)
        ? entry.device_not_connected
        : [],
      "not-connected",
    );

    return compact([
      controller
        ? createHardwareComponent("bluetooth-controller", {
            name: "Bluetooth Controller",
            description: getStringValue(controller, "controller_chipset"),
            properties: compact([
              createProperty(
                "cdx:hbom:address",
                redactIdentifier(
                  getStringValue(
                    controller,
                    "controller_address",
                  )?.toLowerCase(),
                  options,
                ),
              ),
              createProperty(
                "cdx:hbom:chipset",
                getStringValue(controller, "controller_chipset"),
              ),
              createProperty(
                "cdx:hbom:firmwareVersion",
                getStringValue(controller, "controller_firmwareVersion"),
              ),
              createProperty(
                "cdx:hbom:productId",
                getStringValue(controller, "controller_productID"),
              ),
              createProperty(
                "cdx:hbom:vendorId",
                getStringValue(controller, "controller_vendorID"),
              ),
              createProperty(
                "cdx:hbom:transport",
                getStringValue(controller, "controller_transport"),
              ),
              createProperty(
                "cdx:hbom:state",
                getStringValue(controller, "controller_state"),
              ),
              createProperty(
                "cdx:hbom:supportedServices",
                getStringValue(controller, "controller_supportedServices"),
              ),
            ]),
          })
        : undefined,
      ...connectedDevices.map((device) =>
        createBluetoothDeviceComponent(device, options),
      ),
      ...disconnectedDevices.map((device) =>
        createBluetoothDeviceComponent(device, options),
      ),
    ]);
  });
}

/**
 * Collect Thunderbolt/USB4 bus components from `system_profiler` JSON.
 *
 * @param {unknown[]} thunderboltEntries Thunderbolt entries.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Redaction options.
 * @returns {Array<object>} Thunderbolt components.
 */
function collectThunderboltComponents(thunderboltEntries, options = {}) {
  return thunderboltEntries.flatMap((entry) => {
    const receptacleProperties = Object.entries(entry ?? {})
      .filter(
        ([key, value]) =>
          key.startsWith("receptacle_") && value && typeof value === "object",
      )
      .map(([, value]) => /** @type {Record<string, unknown>} */ (value));

    return [
      createHardwareComponent("bus", {
        name:
          normalizeThunderboltName(getStringValue(entry, "_name")) ??
          "Thunderbolt/USB4 Bus",
        description: "Thunderbolt/USB4 bus",
        manufacturer: {
          name: getStringValue(entry, "vendor_name_key") ?? "Apple",
        },
        properties: compact([
          createProperty(
            "cdx:hbom:deviceName",
            getStringValue(entry, "device_name_key"),
          ),
          createProperty(
            "cdx:hbom:domainUuid",
            redactIdentifier(getStringValue(entry, "domain_uuid_key"), options),
          ),
          createProperty(
            "cdx:hbom:switchUid",
            redactIdentifier(getStringValue(entry, "switch_uid_key"), options),
          ),
          createProperty(
            "cdx:hbom:routeString",
            getStringValue(entry, "route_string_key"),
          ),
          createProperty(
            "cdx:hbom:receptacleCount",
            receptacleProperties.length,
          ),
          createProperty(
            "cdx:hbom:receptacleIds",
            receptacleProperties
              .map((receptacle) =>
                getStringValue(receptacle, "receptacle_id_key"),
              )
              .filter(Boolean)
              .join(", "),
          ),
          createProperty(
            "cdx:hbom:linkStatus",
            receptacleProperties
              .map((receptacle) =>
                getStringValue(receptacle, "link_status_key"),
              )
              .filter(Boolean)
              .join(", "),
          ),
          createProperty(
            "cdx:hbom:speed",
            receptacleProperties
              .map((receptacle) =>
                getStringValue(receptacle, "current_speed_key"),
              )
              .filter(Boolean)
              .join(", "),
          ),
          createProperty(
            "cdx:hbom:receptacleStatus",
            receptacleProperties
              .map((receptacle) =>
                getStringValue(receptacle, "receptacle_status_key"),
              )
              .filter(Boolean)
              .join(", "),
          ),
          createProperty(
            "cdx:hbom:microFirmwareVersion",
            receptacleProperties
              .map((receptacle) =>
                getStringValue(receptacle, "micro_version_key"),
              )
              .filter(Boolean)
              .join(", "),
          ),
        ]),
      }),
    ];
  });
}

/**
 * Collect battery and charger components from `SPPowerDataType` and `pmset` output.
 *
 * @param {unknown[]} powerEntries Power entries.
 * @param {{ powerSource?: string, batteryId?: string, chargePercent?: number, isAcAttached?: boolean, isCharging?: boolean } | null} pmsetBattery pmset battery data.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Redaction options.
 * @returns {Array<object>} Power components.
 */
function collectBatteryComponents(powerEntries, pmsetBattery, options = {}) {
  const batteryInfo = powerEntries.find(
    (entry) => getStringValue(entry, "_name") === "spbattery_information",
  );
  const chargeInfo = getObjectValue(batteryInfo, "sppower_battery_charge_info");
  const healthInfo = getObjectValue(batteryInfo, "sppower_battery_health_info");
  const modelInfo = getObjectValue(batteryInfo, "sppower_battery_model_info");
  const chargerInfo = powerEntries.find(
    (entry) =>
      getStringValue(entry, "_name") === "sppower_ac_charger_information",
  );

  return compact([
    batteryInfo || pmsetBattery
      ? createHardwareComponent("power", {
          name: "Internal Battery",
          properties: compact([
            createProperty("cdx:hbom:powerSource", pmsetBattery?.powerSource),
            createProperty(
              "cdx:hbom:chargePercent",
              pmsetBattery?.chargePercent ??
                getNumberValue(chargeInfo, "sppower_battery_state_of_charge"),
            ),
            createProperty(
              "cdx:hbom:isAcAttached",
              pmsetBattery?.isAcAttached ??
                getBooleanFromStringValue(
                  chargerInfo,
                  "sppower_battery_charger_connected",
                ),
            ),
            createProperty(
              "cdx:hbom:isCharging",
              pmsetBattery?.isCharging ??
                getBooleanFromStringValue(
                  chargeInfo,
                  "sppower_battery_is_charging",
                ),
            ),
            createProperty(
              "cdx:hbom:batteryId",
              redactIdentifier(pmsetBattery?.batteryId, options),
            ),
            createProperty(
              "cdx:hbom:cycleCount",
              getNumberValue(healthInfo, "sppower_battery_cycle_count"),
            ),
            createProperty(
              "cdx:hbom:health",
              getStringValue(healthInfo, "sppower_battery_health"),
            ),
            createProperty(
              "cdx:hbom:maximumCapacity",
              getStringValue(
                healthInfo,
                "sppower_battery_health_maximum_capacity",
              ),
            ),
            createProperty(
              "cdx:hbom:fullyCharged",
              getBooleanFromStringValue(
                chargeInfo,
                "sppower_battery_fully_charged",
              ),
            ),
            createProperty(
              "cdx:hbom:atWarningLevel",
              getBooleanFromStringValue(
                chargeInfo,
                "sppower_battery_at_warn_level",
              ),
            ),
            createProperty(
              "cdx:hbom:deviceName",
              getStringValue(modelInfo, "sppower_battery_device_name"),
            ),
            createProperty(
              "cdx:hbom:firmwareVersion",
              getStringValue(modelInfo, "sppower_battery_firmware_version"),
            ),
            createProperty(
              "cdx:hbom:hardwareRevision",
              getStringValue(modelInfo, "sppower_battery_hardware_revision"),
            ),
            createProperty(
              "cdx:hbom:cellRevision",
              getStringValue(modelInfo, "sppower_battery_cell_revision"),
            ),
            createProperty(
              "cdx:hbom:batterySerialNumber",
              redactIdentifier(
                getStringValue(modelInfo, "sppower_battery_serial_number"),
                options,
              ),
            ),
          ]),
        })
      : undefined,
    chargerInfo
      ? createHardwareComponent("power-adapter", {
          name: "AC Charger",
          properties: compact([
            createProperty(
              "cdx:hbom:connected",
              getBooleanFromStringValue(
                chargerInfo,
                "sppower_battery_charger_connected",
              ),
            ),
            createProperty(
              "cdx:hbom:isCharging",
              getBooleanFromStringValue(
                chargerInfo,
                "sppower_battery_is_charging",
              ),
            ),
            createProperty(
              "cdx:hbom:chargerId",
              getStringValue(chargerInfo, "sppower_ac_charger_ID"),
            ),
            createProperty(
              "cdx:hbom:family",
              getStringValue(chargerInfo, "sppower_ac_charger_family"),
            ),
            createProperty(
              "cdx:hbom:watts",
              getStringValue(chargerInfo, "sppower_ac_charger_watts"),
            ),
          ]),
        })
      : undefined,
  ]);
}

/**
 * Create a Bluetooth device component from a named device entry.
 *
 * @param {{ name: string, state: string, properties: Record<string, unknown> }} device Bluetooth device entry.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Redaction options.
 * @returns {object} Bluetooth device component.
 */
function createBluetoothDeviceComponent(device, options = {}) {
  return createHardwareComponent("bluetooth-device", {
    name: device.name,
    description: device.state,
    properties: compact([
      createProperty(
        "cdx:hbom:address",
        redactIdentifier(
          getStringValue(device.properties, "device_address")?.toLowerCase(),
          options,
        ),
      ),
      createProperty("cdx:hbom:connectionState", device.state),
      createProperty(
        "cdx:hbom:vendorId",
        getStringValue(device.properties, "device_vendorID"),
      ),
      createProperty(
        "cdx:hbom:productId",
        getStringValue(device.properties, "device_productID"),
      ),
      createProperty(
        "cdx:hbom:firmwareVersion",
        getStringValue(device.properties, "device_firmwareVersion"),
      ),
      createProperty(
        "cdx:hbom:minorType",
        getStringValue(device.properties, "device_minorType"),
      ),
      createProperty(
        "cdx:hbom:services",
        getStringValue(device.properties, "device_services"),
      ),
      createProperty(
        "cdx:hbom:rssi",
        getStringValue(device.properties, "device_rssi"),
      ),
      createProperty(
        "cdx:hbom:serialNumber",
        redactIdentifier(
          getStringValue(device.properties, "device_serialNumber"),
          options,
        ),
      ),
      createProperty(
        "cdx:hbom:serialNumberLeft",
        redactIdentifier(
          getStringValue(device.properties, "device_serialNumberLeft"),
          options,
        ),
      ),
      createProperty(
        "cdx:hbom:serialNumberRight",
        redactIdentifier(
          getStringValue(device.properties, "device_serialNumberRight"),
          options,
        ),
      ),
    ]),
  });
}

/**
 * Parse system_profiler named-device arrays like Bluetooth connected devices.
 *
 * @param {unknown[]} list Raw list.
 * @param {string} state Connection state.
 * @returns {Array<{ name: string, state: string, properties: Record<string, unknown> }>} Parsed devices.
 */
function parseNamedDeviceList(list, state) {
  return list.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    return Object.entries(entry).map(([name, properties]) => ({
      name,
      state,
      properties:
        properties && typeof properties === "object"
          ? /** @type {Record<string, unknown>} */ (properties)
          : {},
    }));
  });
}

/**
 * Recursively collect USB child components from `SPUSBDataType`.
 *
 * @param {unknown[]} items Nested USB items.
 * @param {string | undefined} controllerName Parent controller name.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Redaction options.
 * @returns {Array<object>} USB device components.
 */
function collectUsbChildComponents(items, controllerName, options = {}) {
  return items.flatMap((item) => {
    const children = Array.isArray(item?._items) ? item._items : [];
    const name = getStringValue(item, "_name");
    const component = shouldCreateDarwinUsbDevice(item)
      ? createHardwareComponent("usb-device", {
          name: name ?? "USB Device",
          manufacturer: getStringValue(item, "manufacturer")
            ? { name: getStringValue(item, "manufacturer") }
            : undefined,
          version: getStringValue(item, "version"),
          properties: compact([
            createProperty("cdx:hbom:usbController", controllerName),
            createProperty(
              "cdx:hbom:vendorId",
              getStringValue(item, "vendor_id"),
            ),
            createProperty(
              "cdx:hbom:productId",
              getStringValue(item, "product_id"),
            ),
            createProperty(
              "cdx:hbom:locationId",
              getStringValue(item, "location_id"),
            ),
            createProperty("cdx:hbom:speed", getStringValue(item, "speed")),
            createProperty(
              "cdx:hbom:bsdName",
              getStringValue(item, "bsd_name"),
            ),
            createProperty(
              "cdx:hbom:deviceSerial",
              redactIdentifier(getStringValue(item, "serial_num"), options),
            ),
            createProperty(
              "cdx:hbom:currentAvailable",
              getStringValue(item, "current_available"),
            ),
            createProperty(
              "cdx:hbom:currentRequired",
              getStringValue(item, "current_required"),
            ),
            createProperty(
              "cdx:hbom:extraOperatingCurrentUsed",
              getStringValue(item, "extra_operating_current_used"),
            ),
          ]),
        })
      : undefined;

    return compact([
      component,
      ...collectUsbChildComponents(children, controllerName, options),
    ]);
  });
}

/**
 * Determine whether a profiler USB item looks like a real device.
 *
 * @param {unknown} item USB candidate item.
 * @returns {boolean} True when the item has meaningful USB identity fields.
 */
function shouldCreateDarwinUsbDevice(item) {
  return Boolean(
    getStringValue(item, "_name") &&
      (getStringValue(item, "vendor_id") ||
        getStringValue(item, "product_id") ||
        getStringValue(item, "serial_num") ||
        getStringValue(item, "location_id") ||
        getStringValue(item, "manufacturer") ||
        getStringValue(item, "bsd_name")),
  );
}

/**
 * Extract vendor and product identifiers from the AirPort card-type string.
 *
 * @param {string | undefined} value Raw card type string.
 * @returns {{ vendorId?: string, productId?: string }} Parsed ids.
 */
function parseAirportCardIds(value) {
  const match = value?.match(/\((0x[0-9a-f]+),\s*(0x[0-9a-f]+)\)/iu);

  return {
    vendorId: match?.[1]?.toLowerCase(),
    productId: match?.[2]?.toLowerCase(),
  };
}

/**
 * Normalize CoreAudio transport values into friendlier labels.
 *
 * @param {string | undefined} value Raw CoreAudio transport value.
 * @returns {string | undefined} Friendly transport label.
 */
function normalizeCoreAudioTransport(value) {
  return value?.replace(/^coreaudio_device_type_/u, "")?.replaceAll("_", " ");
}

/**
 * Return the BSD storage identifiers listed by `system_profiler`.
 *
 * @param {unknown[]} storageGroups Storage groups.
 * @returns {string[]} Device identifiers.
 */
function findProfilerStorageIdentifiers(storageGroups) {
  return [
    ...new Set(
      storageGroups.flatMap((group) => {
        const items = Array.isArray(group?._items) ? group._items : [];
        return items
          .map((item) => getStringValue(item, "bsd_name"))
          .filter(Boolean);
      }),
    ),
  ];
}

/**
 * Create a dynamic diskutil command for a specific BSD device.
 *
 * @param {string} deviceIdentifier BSD device identifier.
 * @returns {object} Command descriptor.
 */
function createDiskutilCommand(deviceIdentifier) {
  return {
    ...getRequiredCommand("storage-plist"),
    args: ["info", "-plist", deviceIdentifier],
  };
}

/**
 * Create a dynamic ifconfig command for a specific BSD interface.
 *
 * @param {string} deviceName BSD interface name.
 * @returns {object} Command descriptor.
 */
function createIfconfigCommand(deviceName) {
  return {
    ...getRequiredCommand("interface-details"),
    id: `interface-details:${deviceName}`,
    args: [deviceName],
  };
}

/**
 * Safely attempt an async collection step.
 *
 * @param {() => Promise<void>} action Collection action.
 * @param {boolean} allowPartial Whether partial collection is allowed.
 * @returns {Promise<void>} Completion promise.
 */
async function attemptCollection(action, allowPartial) {
  try {
    await action();
  } catch (error) {
    if (!allowPartial) {
      throw error;
    }
  }
}

/**
 * Convert a command spec into an evidence command entry.
 *
 * @param {{ id: string, category: string, command: string, args: string[] }} spec Command spec.
 * @returns {{ id: string, category: string, command: string, args: string[] }} Evidence command.
 */
function toEvidenceCommand(spec) {
  return {
    id: spec.id,
    category: spec.category,
    command: spec.command,
    args: [...spec.args],
  };
}

/**
 * Safely read a string property from an unknown object.
 *
 * @param {unknown} input Source object.
 * @param {string} key Property name.
 * @returns {string | undefined} String value.
 */
function getStringValue(input, key) {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Safely read an object property from an unknown object.
 *
 * @param {unknown} input Source object.
 * @param {string} key Property name.
 * @returns {Record<string, unknown> | undefined} Object value.
 */
function getObjectValue(input, key) {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const value = input[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined;
}

/**
 * Safely read a number property from an unknown object.
 *
 * @param {unknown} input Source object.
 * @param {string} key Property name.
 * @returns {number | undefined} Numeric value.
 */
function getNumberValue(input, key) {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Safely read a nested numeric property from an unknown object.
 *
 * @param {unknown} input Source object.
 * @param {string} parentKey Parent property key.
 * @param {string} childKey Child property key.
 * @returns {number | undefined} Numeric value.
 */
function getNestedNumberValue(input, parentKey, childKey) {
  const parent = getObjectValue(input, parentKey);
  return getNumberValue(parent, childKey);
}

/**
 * Read a boolean property or return undefined.
 *
 * @param {unknown} input Source object.
 * @param {string} key Property name.
 * @returns {boolean | undefined} Boolean value.
 */
function getBooleanValue(input, key) {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Parse TRUE/FALSE string values used by `system_profiler` JSON.
 *
 * @param {unknown} input Source object.
 * @param {string} key Property name.
 * @returns {boolean | undefined} Boolean value.
 */
function getBooleanFromStringValue(input, key) {
  const value = getStringValue(input, key)?.toUpperCase();

  if (value === "TRUE") {
    return true;
  }
  if (value === "FALSE") {
    return false;
  }

  return undefined;
}

/**
 * Normalize byte strings to a human-readable GiB string.
 *
 * @param {string | undefined} bytes Raw byte count.
 * @returns {string | undefined} Human-readable memory size.
 */
function normalizeBytesToGiB(bytes) {
  if (!bytes) {
    return undefined;
  }

  const value = Number.parseInt(bytes, 10);

  if (Number.isNaN(value)) {
    return undefined;
  }

  const gib = value / 1024 / 1024 / 1024;
  return `${Math.round(gib)} GB`;
}

/**
 * Normalize Thunderbolt entry names into friendlier labels.
 *
 * @param {string | undefined} value Raw profiler name.
 * @returns {string | undefined} Normalized label.
 */
function normalizeThunderboltName(value) {
  if (!value) {
    return undefined;
  }

  return value
    .replace("thunderboltusb4_bus_", "Thunderbolt/USB4 Bus ")
    .replaceAll("_", " ");
}

/**
 * Parse embedded strings that may include NUL padding.
 *
 * @param {string | undefined} value Candidate string.
 * @returns {string | undefined} Cleaned string.
 */
function parseEmbeddedString(value) {
  if (!value) {
    return undefined;
  }

  return value.replace(/\u0000+$/u, "").trim() || undefined;
}

/**
 * Convert executed commands into custom CycloneDX properties.
 *
 * @param {Array<{ id: string, category: string, command: string, args: string[] }>} commands Executed commands.
 * @returns {Array<{ name: string, value: string }>} Command properties.
 */
function collectCommandProperties(commands) {
  return commands.map((entry) => ({
    name: "cdx:hbom:evidence:command",
    value: `${entry.id}|${entry.category}|${entry.command}${entry.args.length ? ` ${entry.args.join(" ")}` : ""}`,
  }));
}

/**
 * Decode base64 plist `<data>` payloads that actually contain UTF-8 strings.
 *
 * @param {string | undefined} value Base64 candidate.
 * @returns {string | undefined} Decoded string when the payload looks textual.
 */
function decodeBase64DataString(value) {
  if (!value || !/^[A-Za-z0-9+/=\s]+$/u.test(value)) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(value.replace(/\s+/gu, ""), "base64").toString(
      "utf8",
    );
    return parseEmbeddedString(decoded);
  } catch {
    return undefined;
  }
}

/**
 * Return a command descriptor by id.
 *
 * @param {string} id Command id.
 * @returns {{ id: string, category: string, command: string, args: string[], parser: string, purpose: string, phase: string, sensitiveFields?: string[] }} Command descriptor.
 */
function getRequiredCommand(id) {
  const spec = DARWIN_ARM64_COMMANDS.find((candidate) => candidate.id === id);

  if (!spec) {
    throw new Error(`Unknown Darwin arm64 command: ${id}`);
  }

  return spec;
}
