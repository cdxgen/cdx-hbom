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
    sensitiveFields: spec.sensitiveFields ? [...spec.sensitiveFields] : undefined,
  }));
}

/**
 * Parse ordered `sysctl -n` output into a key/value object.
 *
 * @param {string} stdout Command stdout.
 * @param {string[]} [keys=[...DARWIN_ARM64_SYSCTL_KEYS]] Key order.
 * @returns {Record<string, string>} Parsed values.
 */
export function parseSysctlValues(stdout, keys = [...DARWIN_ARM64_SYSCTL_KEYS]) {
  const values = stdout
    .trim()
    .split(/\r?\n/u)
    .map((value) => value.trim());

  return keys.reduce((result, key, index) => {
    result[key] = values[index] ?? "";
    return result;
  }, /** @type {Record<string, string>} */ ({}));
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
      const entry = /** @type {{ hardwarePort?: string, device?: string, ethernetAddress?: string }} */ ({});

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
  const isCharging = /charging/u.test(batteryLine) && !/not charging/u.test(batteryLine);

  return {
    powerSource,
    batteryId,
    chargePercent: Number.isNaN(chargePercent) ? undefined : chargePercent,
    isAcAttached,
    isCharging,
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
 *     pmsetBattery?: { powerSource?: string, batteryId?: string, chargePercent?: number, isAcAttached?: boolean, isCharging?: boolean } | null,
 *     diskutilPlists?: Record<string, unknown>[],
 *     ioregPlatform?: Record<string, unknown>[] | Record<string, unknown> | null
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
  const pmsetBattery = sources.pmsetBattery ?? null;
  const diskutilPlists = Array.isArray(sources.diskutilPlists)
    ? sources.diskutilPlists
    : [];
  const ioregPlatform = Array.isArray(sources.ioregPlatform)
    ? sources.ioregPlatform[0]
    : sources.ioregPlatform ?? undefined;
  const hardwareOverview = Array.isArray(profiler.SPHardwareDataType)
    ? profiler.SPHardwareDataType[0]
    : undefined;
  const displayEntries = Array.isArray(profiler.SPDisplaysDataType)
    ? profiler.SPDisplaysDataType
    : [];
  const storageGroups = Array.isArray(profiler.SPNVMeDataType)
    ? profiler.SPNVMeDataType
    : [];
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
  const modelName = getStringValue(hardwareOverview, "machine_name") ?? "Apple device";
  const modelIdentifier =
    getStringValue(hardwareOverview, "machine_model") ?? sysctl["hw.model"] ?? "unknown";
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
      createProperty("hbom:platform", "darwin"),
      createProperty("hbom:architecture", "arm64"),
      createProperty("hbom:chip", chipName),
      createProperty("hbom:memory", memoryValue),
      createProperty(
        "hbom:serialNumber",
        redactIdentifier(
          getStringValue(hardwareOverview, "serial_number") ??
            getStringValue(ioregPlatform, "IOPlatformSerialNumber"),
          options,
        ),
      ),
      createProperty(
        "hbom:platformUuid",
        redactIdentifier(
          getStringValue(hardwareOverview, "platform_UUID") ??
            getStringValue(ioregPlatform, "IOPlatformUUID"),
          options,
        ),
      ),
      createProperty(
        "hbom:modelNumber",
        getStringValue(hardwareOverview, "model_number"),
      ),
      createProperty(
        "hbom:registryEntryName",
        getStringValue(ioregPlatform, "IORegistryEntryName"),
      ),
      createProperty("hbom:identifierPolicy", identifierPolicy),
    ]),
  });
  const components = compact([
    createHardwareComponent("processor", {
      name: chipName,
      version: modelIdentifier,
      manufacturer: { name: "Apple" },
      properties: compact([
        createProperty("hbom:coreCount", sysctl["hw.ncpu"]),
        createProperty("hbom:logicalCpuCount", sysctl["hw.logicalcpu"]),
        createProperty("hbom:physicalCpuCount", sysctl["hw.physicalcpu"]),
      ]),
    }),
    memoryValue
      ? createHardwareComponent("memory", {
          name: "Unified Memory",
          manufacturer: { name: "Apple" },
          properties: compact([createProperty("hbom:size", memoryValue)]),
        })
      : undefined,
    ...collectStorageComponents(storageGroups, diskutilPlists, options),
    ...collectDisplayComponents(displayEntries, options),
    ...collectBluetoothComponents(bluetoothEntries, options),
    ...collectThunderboltComponents(thunderboltEntries, options),
    ...networkPorts.map((port) =>
      createHardwareComponent("network-interface", {
        name: port.hardwarePort ?? port.device ?? "Network Interface",
        version: port.device,
        properties: compact([
          createProperty(
            "hbom:macAddress",
            redactIdentifier(port.ethernetAddress, options),
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
      createProperty("hbom:targetPlatform", "darwin"),
      createProperty("hbom:targetArchitecture", "arm64"),
      createProperty("hbom:identifierPolicy", identifierPolicy),
      createProperty("hbom:collectorProfile", "darwin-arm64-v1"),
      createProperty(
        "hbom:evidence:commandCount",
        (options.executedCommands ??
          DARWIN_ARM64_COMMANDS.filter((spec) => spec.phase === "collector-v1")).length,
      ),
      ...collectCommandProperties(
        options.executedCommands ??
          DARWIN_ARM64_COMMANDS.filter((spec) => spec.phase === "collector-v1").map(
            (spec) => ({
              id: spec.id,
              category: spec.category,
              command: spec.command,
              args: [...spec.args],
            }),
          ),
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
   *   pmsetBattery?: { powerSource?: string, batteryId?: string, chargePercent?: number, isAcAttached?: boolean, isCharging?: boolean } | null,
   *   diskutilPlists?: Record<string, unknown>[],
   *   ioregPlatform?: Record<string, unknown>[] | null
   * }} */ ({});
  const executedCommands = [];

  await attemptCollection(
    async () => {
      sources.sysctl = parseSysctlValues(
        await runCommand(getRequiredCommand("sysctl-baseline"), options),
      );
      executedCommands.push(toEvidenceCommand(getRequiredCommand("sysctl-baseline")));
    },
    allowPartial,
  );

  await attemptCollection(
    async () => {
      sources.profiler = await readSystemProfiler(
        [...DARWIN_ARM64_SYSTEM_PROFILER_TYPES],
        options,
      );
      executedCommands.push(toEvidenceCommand(getRequiredCommand("system-profiler-json")));
    },
    allowPartial,
  );

  await attemptCollection(
    async () => {
      sources.networksetup = parseNetworksetupPorts(
        await runCommand(getRequiredCommand("network-hardware-ports"), options),
      );
      executedCommands.push(
        toEvidenceCommand(getRequiredCommand("network-hardware-ports")),
      );
    },
    allowPartial,
  );

  await attemptCollection(
    async () => {
      sources.pmsetBattery = parsePmsetBattery(
        await runCommand(getRequiredCommand("battery-status"), options),
      );
      executedCommands.push(toEvidenceCommand(getRequiredCommand("battery-status")));
    },
    allowPartial,
  );

  if (options.includePlistEnrichment === true) {
    const diskIdentifiers = findProfilerStorageIdentifiers(
      Array.isArray(sources.profiler?.SPNVMeDataType)
        ? sources.profiler.SPNVMeDataType
        : [],
    );

    for (const deviceIdentifier of diskIdentifiers) {
      await attemptCollection(
        async () => {
          const spec = createDiskutilCommand(deviceIdentifier);
          const plist = parsePlistDict(await runCommand(spec, options));
          if (!sources.diskutilPlists) {
            sources.diskutilPlists = [];
          }
          sources.diskutilPlists.push(plist);
          executedCommands.push(toEvidenceCommand(spec));
        },
        allowPartial,
      );
    }

    await attemptCollection(
      async () => {
        const spec = getRequiredCommand("platform-registry");
        sources.ioregPlatform = parsePlistArray(await runCommand(spec, options));
        executedCommands.push(toEvidenceCommand(spec));
      },
      allowPartial,
    );
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
            "hbom:resolution",
            getStringValue(display, "_spdisplays_resolution") ??
              getStringValue(display, "spdisplays_pixelresolution"),
          ),
          createProperty(
            "hbom:connectionType",
            getStringValue(display, "spdisplays_connection_type"),
          ),
          createProperty(
            "hbom:vendorId",
            getStringValue(display, "_spdisplays_display-vendor-id"),
          ),
          createProperty(
            "hbom:productId",
            getStringValue(display, "_spdisplays_display-product-id"),
          ),
          createProperty(
            "hbom:displaySerialNumber",
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
 * Collect storage components from `system_profiler` JSON and optional diskutil plists.
 *
 * @param {unknown[]} storageGroups Storage groups.
 * @param {Record<string, unknown>[]} diskutilPlists Optional diskutil plists.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Redaction options.
 * @returns {Array<object>} Storage components.
 */
function collectStorageComponents(storageGroups, diskutilPlists, options = {}) {
  const diskutilIndex = new Map(
    diskutilPlists.map((plist) => [getStringValue(plist, "DeviceIdentifier"), plist]),
  );
  const seenIdentifiers = new Set();
  const profilerComponents = storageGroups.flatMap((group) => {
    const items = Array.isArray(group?._items) ? group._items : [];

    return items.map((item) => {
      const deviceIdentifier = getStringValue(item, "bsd_name");
      const diskutil = deviceIdentifier ? diskutilIndex.get(deviceIdentifier) : undefined;
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
          createProperty("hbom:capacity", getStringValue(item, "size")),
          createProperty(
            "hbom:capacityBytes",
            getStringValue(item, "size_in_bytes") ?? getStringValue(diskutil, "Size"),
          ),
          createProperty("hbom:revision", getStringValue(item, "device_revision")),
          createProperty(
            "hbom:deviceSerial",
            redactIdentifier(getStringValue(item, "device_serial"), options),
          ),
          createProperty("hbom:busProtocol", getStringValue(diskutil, "BusProtocol")),
          createProperty("hbom:smartStatus", getStringValue(diskutil, "SMARTStatus")),
          createProperty("hbom:mediaType", getStringValue(diskutil, "MediaType")),
          createProperty("hbom:isInternal", getBooleanValue(diskutil, "Internal")),
          createProperty("hbom:isRemovable", getBooleanValue(diskutil, "Removable")),
          createProperty(
            "hbom:blockSize",
            getNumberValue(diskutil, "DeviceBlockSize"),
          ),
          createProperty(
            "hbom:deviceTreePath",
            getStringValue(diskutil, "DeviceTreePath"),
          ),
          createProperty(
            "hbom:wearPercentageUsed",
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
    .filter((plist) => !seenIdentifiers.has(getStringValue(plist, "DeviceIdentifier") ?? ""))
    .map((plist) =>
      createHardwareComponent("storage", {
        name: getStringValue(plist, "MediaName") ?? "Storage Device",
        version: getStringValue(plist, "DeviceIdentifier"),
        properties: compact([
          createProperty("hbom:capacityBytes", getNumberValue(plist, "Size")),
          createProperty("hbom:busProtocol", getStringValue(plist, "BusProtocol")),
          createProperty("hbom:smartStatus", getStringValue(plist, "SMARTStatus")),
          createProperty("hbom:mediaType", getStringValue(plist, "MediaType")),
          createProperty("hbom:isInternal", getBooleanValue(plist, "Internal")),
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
      Array.isArray(entry?.device_not_connected) ? entry.device_not_connected : [],
      "not-connected",
    );

    return compact([
      controller
        ? createHardwareComponent("bluetooth-controller", {
            name: "Bluetooth Controller",
            description: getStringValue(controller, "controller_chipset"),
            properties: compact([
              createProperty(
                "hbom:address",
                redactIdentifier(
                  getStringValue(controller, "controller_address")?.toLowerCase(),
                  options,
                ),
              ),
              createProperty(
                "hbom:chipset",
                getStringValue(controller, "controller_chipset"),
              ),
              createProperty(
                "hbom:firmwareVersion",
                getStringValue(controller, "controller_firmwareVersion"),
              ),
              createProperty(
                "hbom:productId",
                getStringValue(controller, "controller_productID"),
              ),
              createProperty(
                "hbom:vendorId",
                getStringValue(controller, "controller_vendorID"),
              ),
              createProperty(
                "hbom:transport",
                getStringValue(controller, "controller_transport"),
              ),
              createProperty(
                "hbom:state",
                getStringValue(controller, "controller_state"),
              ),
              createProperty(
                "hbom:supportedServices",
                getStringValue(controller, "controller_supportedServices"),
              ),
            ]),
          })
        : undefined,
      ...connectedDevices.map((device) => createBluetoothDeviceComponent(device, options)),
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
      .filter(([key, value]) => key.startsWith("receptacle_") && value && typeof value === "object")
      .map(([, value]) => /** @type {Record<string, unknown>} */ (value));

    return [
      createHardwareComponent("bus", {
        name: normalizeThunderboltName(getStringValue(entry, "_name")) ?? "Thunderbolt/USB4 Bus",
        description: "Thunderbolt/USB4 bus",
        manufacturer: {
          name: getStringValue(entry, "vendor_name_key") ?? "Apple",
        },
        properties: compact([
          createProperty("hbom:deviceName", getStringValue(entry, "device_name_key")),
          createProperty(
            "hbom:domainUuid",
            redactIdentifier(getStringValue(entry, "domain_uuid_key"), options),
          ),
          createProperty(
            "hbom:switchUid",
            redactIdentifier(getStringValue(entry, "switch_uid_key"), options),
          ),
          createProperty("hbom:routeString", getStringValue(entry, "route_string_key")),
          createProperty("hbom:receptacleCount", receptacleProperties.length),
          createProperty(
            "hbom:receptacleIds",
            receptacleProperties
              .map((receptacle) => getStringValue(receptacle, "receptacle_id_key"))
              .filter(Boolean)
              .join(", "),
          ),
          createProperty(
            "hbom:linkStatus",
            receptacleProperties
              .map((receptacle) => getStringValue(receptacle, "link_status_key"))
              .filter(Boolean)
              .join(", "),
          ),
          createProperty(
            "hbom:speed",
            receptacleProperties
              .map((receptacle) => getStringValue(receptacle, "current_speed_key"))
              .filter(Boolean)
              .join(", "),
          ),
          createProperty(
            "hbom:receptacleStatus",
            receptacleProperties
              .map((receptacle) => getStringValue(receptacle, "receptacle_status_key"))
              .filter(Boolean)
              .join(", "),
          ),
          createProperty(
            "hbom:microFirmwareVersion",
            receptacleProperties
              .map((receptacle) => getStringValue(receptacle, "micro_version_key"))
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
    (entry) => getStringValue(entry, "_name") === "sppower_ac_charger_information",
  );

  return compact([
    batteryInfo || pmsetBattery
      ? createHardwareComponent("power", {
          name: "Internal Battery",
          properties: compact([
            createProperty("hbom:powerSource", pmsetBattery?.powerSource),
            createProperty(
              "hbom:chargePercent",
              pmsetBattery?.chargePercent ??
                getNumberValue(chargeInfo, "sppower_battery_state_of_charge"),
            ),
            createProperty(
              "hbom:isAcAttached",
              pmsetBattery?.isAcAttached ??
                getBooleanFromStringValue(
                  chargerInfo,
                  "sppower_battery_charger_connected",
                ),
            ),
            createProperty(
              "hbom:isCharging",
              pmsetBattery?.isCharging ??
                getBooleanFromStringValue(chargeInfo, "sppower_battery_is_charging"),
            ),
            createProperty(
              "hbom:batteryId",
              redactIdentifier(pmsetBattery?.batteryId, options),
            ),
            createProperty(
              "hbom:cycleCount",
              getNumberValue(healthInfo, "sppower_battery_cycle_count"),
            ),
            createProperty(
              "hbom:health",
              getStringValue(healthInfo, "sppower_battery_health"),
            ),
            createProperty(
              "hbom:maximumCapacity",
              getStringValue(
                healthInfo,
                "sppower_battery_health_maximum_capacity",
              ),
            ),
            createProperty(
              "hbom:fullyCharged",
              getBooleanFromStringValue(chargeInfo, "sppower_battery_fully_charged"),
            ),
            createProperty(
              "hbom:atWarningLevel",
              getBooleanFromStringValue(chargeInfo, "sppower_battery_at_warn_level"),
            ),
            createProperty(
              "hbom:deviceName",
              getStringValue(modelInfo, "sppower_battery_device_name"),
            ),
            createProperty(
              "hbom:firmwareVersion",
              getStringValue(modelInfo, "sppower_battery_firmware_version"),
            ),
            createProperty(
              "hbom:hardwareRevision",
              getStringValue(modelInfo, "sppower_battery_hardware_revision"),
            ),
            createProperty(
              "hbom:cellRevision",
              getStringValue(modelInfo, "sppower_battery_cell_revision"),
            ),
            createProperty(
              "hbom:batterySerialNumber",
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
              "hbom:connected",
              getBooleanFromStringValue(
                chargerInfo,
                "sppower_battery_charger_connected",
              ),
            ),
            createProperty(
              "hbom:isCharging",
              getBooleanFromStringValue(chargerInfo, "sppower_battery_is_charging"),
            ),
            createProperty(
              "hbom:chargerId",
              getStringValue(chargerInfo, "sppower_ac_charger_ID"),
            ),
            createProperty(
              "hbom:family",
              getStringValue(chargerInfo, "sppower_ac_charger_family"),
            ),
            createProperty(
              "hbom:watts",
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
        "hbom:address",
        redactIdentifier(
          getStringValue(device.properties, "device_address")?.toLowerCase(),
          options,
        ),
      ),
      createProperty("hbom:connectionState", device.state),
      createProperty(
        "hbom:vendorId",
        getStringValue(device.properties, "device_vendorID"),
      ),
      createProperty(
        "hbom:productId",
        getStringValue(device.properties, "device_productID"),
      ),
      createProperty(
        "hbom:firmwareVersion",
        getStringValue(device.properties, "device_firmwareVersion"),
      ),
      createProperty(
        "hbom:minorType",
        getStringValue(device.properties, "device_minorType"),
      ),
      createProperty(
        "hbom:services",
        getStringValue(device.properties, "device_services"),
      ),
      createProperty("hbom:rssi", getStringValue(device.properties, "device_rssi")),
      createProperty(
        "hbom:serialNumber",
        redactIdentifier(
          getStringValue(device.properties, "device_serialNumber"),
          options,
        ),
      ),
      createProperty(
        "hbom:serialNumberLeft",
        redactIdentifier(
          getStringValue(device.properties, "device_serialNumberLeft"),
          options,
        ),
      ),
      createProperty(
        "hbom:serialNumberRight",
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
 * Return the BSD storage identifiers listed by `system_profiler`.
 *
 * @param {unknown[]} storageGroups Storage groups.
 * @returns {string[]} Device identifiers.
 */
function findProfilerStorageIdentifiers(storageGroups) {
  return [...new Set(storageGroups.flatMap((group) => {
    const items = Array.isArray(group?._items) ? group._items : [];
    return items
      .map((item) => getStringValue(item, "bsd_name"))
      .filter(Boolean);
  }))];
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
    name: "hbom:evidence:command",
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
