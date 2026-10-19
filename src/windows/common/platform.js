// Windows platform inventory: host metadata, processor, memory modules,
// board, firmware (BIOS) and chassis, built from the `windows-cim-platform`
// envelope plus the Node T0 baseline. All builders are pure.

import {
  SMBIOS_CHASSIS_TYPES,
  SMBIOS_MEMORY_TYPES,
  lookupSmbiosName,
} from "../../common/smbios.js";
import {
  compact,
  createComponent,
  createHardwareComponent,
  createProperty,
  formatBytes,
  isPlaceholderIdentity,
  normalizeIdentityString,
  redactIdentifier,
} from "../../common/shape.js";
import { cimArray, cimBool, cimDate, cimNumber, cimString } from "./cim.js";
import {
  WINDOWS_MEMORY_ERROR_CORRECTIONS,
  WINDOWS_MEMORY_FORM_FACTORS,
  WINDOWS_PC_SYSTEM_TYPES_EX,
  WINDOWS_PROCESSOR_ARCHITECTURES,
  windowsEnumName,
} from "./enums.js";

/**
 * @typedef {object} WindowsPlatformSources
 * @property {Record<string, unknown> | undefined} computerSystem First Win32_ComputerSystem item.
 * @property {Record<string, unknown> | undefined} product First Win32_ComputerSystemProduct item.
 * @property {Record<string, unknown> | undefined} bios First Win32_BIOS item.
 * @property {Record<string, unknown> | undefined} baseBoard First Win32_BaseBoard item.
 * @property {Record<string, unknown> | undefined} enclosure First Win32_SystemEnclosure item.
 * @property {Record<string, unknown>[]} processors Win32_Processor items.
 * @property {Record<string, unknown>[]} memoryModules Win32_PhysicalMemory items.
 * @property {Record<string, unknown>[]} memoryArrays Win32_PhysicalMemoryArray items.
 * @property {Record<string, unknown> | undefined} os First Win32_OperatingSystem item.
 * @property {Record<string, unknown> | undefined} msSystemInformation First root/wmi MS_SystemInformation item.
 */

const EMPTY_PLATFORM_SOURCES = Object.freeze({
  computerSystem: undefined,
  product: undefined,
  bios: undefined,
  baseBoard: undefined,
  enclosure: undefined,
  processors: [],
  memoryModules: [],
  memoryArrays: [],
  os: undefined,
  msSystemInformation: undefined,
});

/**
 * Project a parsed `windows-cim-platform` envelope into typed sources.
 *
 * Only successful results contribute data; failed results are turned into
 * diagnostics elsewhere, and an all-denied envelope therefore yields empty
 * sources (the collector builds from the T0 baseline instead).
 *
 * @param {{ results?: Record<string, { ok?: boolean, items?: object[] }> }} envelope Parsed envelope.
 * @returns {WindowsPlatformSources} Typed platform sources.
 */
export function parsePlatformEnvelope(envelope) {
  const results = envelope?.results ?? {};
  return {
    computerSystem: firstItem(results.computerSystem),
    product: firstItem(results.computerSystemProduct),
    bios: firstItem(results.bios),
    baseBoard: firstItem(results.baseBoard),
    enclosure: firstItem(results.systemEnclosure),
    processors: okItems(results.processor),
    memoryModules: okItems(results.physicalMemory),
    memoryArrays: okItems(results.physicalMemoryArray),
    os: firstItem(results.operatingSystem),
    msSystemInformation: firstItem(results.msSystemInformation),
  };
}

/**
 * Detect the host CPU architecture from Win32_Processor instances.
 *
 * Node's `process.arch` reports the emulated architecture when an x64 build
 * runs on ARM64 Windows (VM-FINDINGS §1), so the first processor's
 * `Architecture` code wins: 9 maps to amd64 and 12 to arm64. x86 (0) and any
 * other architecture this collector does not target throw the shared
 * unsupported-target error; without processor data the normalized fallback
 * from the routed/requested architecture is used.
 *
 * @param {Record<string, unknown>[]} processors Win32_Processor items.
 * @param {string | undefined} fallbackArch Normalized routing architecture.
 * @returns {{ architecture: string, source: "Win32_Processor" | "process" }} Detected architecture.
 * @throws {Error} When the observed architecture is not a supported target.
 */
export function detectWindowsArchitecture(processors, fallbackArch) {
  const code = cimNumber(processors?.[0]?.Architecture);
  if (code === undefined) {
    return { architecture: fallbackArch, source: "process" };
  }

  const name = WINDOWS_PROCESSOR_ARCHITECTURES[code] ?? String(code);
  if (name !== "amd64" && name !== "arm64") {
    throw new Error(`Unsupported HBOM target: win32/${name}`);
  }
  return { architecture: name, source: "Win32_Processor" };
}

/**
 * Build the `metadata.component` host device description.
 *
 * @param {{
 *   sources: WindowsPlatformSources,
 *   baseline: { cpuModel?: string, cpuCount?: number, totalMemoryBytes?: number },
 *   detected: { architecture: string, source: string },
 *   includeSensitiveIdentifiers?: boolean
 * }} context Build context.
 * @returns {object} Host component.
 */
export function buildWindowsHostComponent(context) {
  const { sources, baseline, detected } = context;
  const options = context;
  const computerSystem = sources.computerSystem ?? {};
  const product = sources.product ?? {};
  const bios = sources.bios ?? {};
  const baseBoard = sources.baseBoard ?? {};
  const enclosure = sources.enclosure ?? {};
  const processorName = windowsProcessorName(sources, baseline);
  const installedBytes = installedMemoryBytes(sources, baseline);
  const identifierPolicy = options.includeSensitiveIdentifiers
    ? "raw-identifiers-enabled"
    : "redacted-by-default";

  return createComponent({
    type: "device",
    name:
      normalizeIdentityString(computerSystem.Model) ??
      normalizeIdentityString(product.Name) ??
      "Windows Device",
    version:
      normalizeIdentityString(product.Version) ?? detected.architecture,
    manufacturer: {
      name:
        normalizeIdentityString(computerSystem.Manufacturer) ??
        normalizeIdentityString(product.Vendor) ??
        "Windows",
    },
    description: processorName,
    properties: compact([
      createProperty("cdx:hbom:platform", "windows"),
      createProperty("cdx:hbom:architecture", detected.architecture),
      createProperty("cdx:hbom:chip", processorName),
      createProperty("cdx:hbom:memory", formatBytes(installedBytes)),
      createProperty(
        "cdx:hbom:serialNumber",
        redactCimIdentifier(
          cimString(bios.SerialNumber) ?? cimString(product.IdentifyingNumber),
          options,
        ),
      ),
      createProperty(
        "cdx:hbom:platformUuid",
        redactCimIdentifier(cimString(product.UUID), options),
      ),
      createProperty(
        "cdx:hbom:modelNumber",
        normalizeIdentityString(computerSystem.SystemSKUNumber) ??
          normalizeIdentityString(product.SKUNumber),
      ),
      createProperty(
        "cdx:hbom:boardVendor",
        normalizeIdentityString(baseBoard.Manufacturer),
      ),
      createProperty(
        "cdx:hbom:boardName",
        normalizeIdentityString(baseBoard.Product),
      ),
      createProperty(
        "cdx:hbom:biosVendor",
        normalizeIdentityString(bios.Manufacturer),
      ),
      createProperty(
        "cdx:hbom:biosVersion",
        normalizeIdentityString(bios.SMBIOSBIOSVersion),
      ),
      createProperty("cdx:hbom:firmwareDate", windowsFirmwareDate(sources)),
      createProperty(
        "cdx:hbom:chassisType",
        windowsChassisTypeName(enclosure),
      ),
      createProperty(
        "cdx:hbom:systemFamily",
        normalizeIdentityString(computerSystem.SystemFamily),
      ),
      createProperty(
        "cdx:hbom:pcSystemType",
        windowsEnumName(
          WINDOWS_PC_SYSTEM_TYPES_EX,
          cimNumber(computerSystem.PCSystemTypeEx),
        ),
      ),
      createProperty(
        "cdx:hbom:hypervisorPresent",
        cimBool(computerSystem.HypervisorPresent),
      ),
      createProperty("cdx:hbom:smbiosVersion", smbiosVersion(bios)),
      createProperty("cdx:hbom:identifierPolicy", identifierPolicy),
    ]),
  });
}

/**
 * Build the processor component, grouping Win32_Processor instances by model.
 *
 * Windows reports one instance per core on some virtual platforms (four
 * single-core instances on the Parallels VM) and one instance per socket on
 * others (one 2-core instance on the Hyper-V runners), so instances sharing
 * a Name/Manufacturer pair collapse into one component.
 *
 * @param {{
 *   sources: WindowsPlatformSources,
 *   baseline: { cpuModel?: string, cpuCount?: number },
 *   detected: { architecture: string, source: string }
 * }} context Build context.
 * @returns {object | undefined} Processor component.
 */
export function buildWindowsProcessorComponent(context) {
  const { sources, baseline, detected } = context;
  if (sources.processors.length === 0) {
    const model = normalizeIdentityString(baseline.cpuModel);
    return createHardwareComponent("processor", {
      name: model ?? "Processor",
      version: detected.architecture,
      properties: compact([
        createProperty("cdx:hbom:architecture", detected.architecture),
        createProperty("cdx:hbom:logicalCpuCount", baseline.cpuCount),
      ]),
    });
  }

  const computerSystem = sources.computerSystem ?? {};
  const systemLogical = cimNumber(
    computerSystem.NumberOfLogicalProcessors,
  );
  return createHardwareComponent("processor", {
    name: cimString(sources.processors[0].Name) ?? "Processor",
    version: detected.architecture,
    manufacturer: cimString(sources.processors[0].Manufacturer)
      ? { name: cimString(sources.processors[0].Manufacturer) }
      : undefined,
    properties: compact([
      createProperty(
        "cdx:hbom:architecture",
        windowsEnumName(
          WINDOWS_PROCESSOR_ARCHITECTURES,
          cimNumber(sources.processors[0].Architecture),
        ),
      ),
      createProperty(
        "cdx:hbom:coreCount",
        sumCim(sources.processors, "NumberOfCores"),
      ),
      ...processorLogicalCount(sources.processors, systemLogical),
      createProperty("cdx:hbom:socketCount", sources.processors.length),
      createProperty(
        "cdx:hbom:vendorId",
        normalizeIdentityString(sources.processors[0].Manufacturer),
      ),
      createProperty(
        "cdx:hbom:cpuFamily",
        cimNumber(sources.processors[0].Family),
      ),
      createProperty(
        "cdx:hbom:stepping",
        cimString(sources.processors[0].Stepping),
      ),
      createProperty(
        "cdx:hbom:maxClockMHz",
        cimNumber(sources.processors[0].MaxClockSpeed),
      ),
      createProperty(
        "cdx:hbom:currentClockMHz",
        cimNumber(sources.processors[0].CurrentClockSpeed),
      ),
      createProperty(
        "cdx:hbom:l2CacheKiB",
        positiveCimNumber(sources.processors[0].L2CacheSize),
      ),
      createProperty(
        "cdx:hbom:l3CacheKiB",
        positiveCimNumber(sources.processors[0].L3CacheSize),
      ),
      createProperty(
        "cdx:hbom:virtualizationFirmwareEnabled",
        cimBool(sources.processors[0].VirtualizationFirmwareEnabled),
      ),
      createProperty(
        "cdx:hbom:slatSupported",
        cimBool(sources.processors[0].SecondLevelAddressTranslationExtensions),
      ),
      createProperty(
        "cdx:hbom:vmMonitorModeExtensions",
        cimBool(sources.processors[0].VMMonitorModeExtensions),
      ),
      createProperty(
        "cdx:hbom:socketDesignation",
        normalizeIdentityString(sources.processors[0].SocketDesignation),
      ),
    ]),
  });
}

/**
 * Build the system-memory component and one component per memory module.
 *
 * @param {{
 *   sources: WindowsPlatformSources,
 *   baseline: { totalMemoryBytes?: number },
 *   includeSensitiveIdentifiers?: boolean
 * }} context Build context.
 * @returns {object[]} Memory components.
 */
export function buildWindowsMemoryComponents(context) {
  const { sources, baseline } = context;
  const options = context;
  const array = sources.memoryArrays[0] ?? {};
  const sizeBytes =
    installedMemoryBytes(sources, baseline) ?? baseline.totalMemoryBytes;

  const systemMemory = createHardwareComponent("memory", {
    name: "System Memory",
    properties: compact([
      createProperty("cdx:hbom:size", formatBytes(sizeBytes)),
      createProperty("cdx:hbom:sizeBytes", sizeBytes),
      createProperty(
        "cdx:hbom:visibleMemoryBytes",
        cimNumber(sources.computerSystem?.TotalPhysicalMemory),
      ),
      createProperty(
        "cdx:hbom:memoryModuleCount",
        sources.memoryModules.length || undefined,
      ),
      createProperty(
        "cdx:hbom:maxCapacityBytes",
        maxCapacityBytes(array),
      ),
      createProperty(
        "cdx:hbom:memoryErrorCorrection",
        windowsEnumName(
          WINDOWS_MEMORY_ERROR_CORRECTIONS,
          cimNumber(array.MemoryErrorCorrection),
        ),
      ),
    ]),
  });

  return [
    ...(sizeBytes === undefined ? [] : [systemMemory]),
    ...sources.memoryModules.map((module) =>
      createHardwareComponent("memory-module", {
        name:
          normalizeIdentityString(module.DeviceLocator) ??
          cimString(module.Tag) ??
          "Memory Module",
        manufacturer: normalizeIdentityString(module.Manufacturer)
          ? { name: normalizeIdentityString(module.Manufacturer) }
          : undefined,
        version: normalizeIdentityString(module.PartNumber),
        properties: compact([
          createProperty("cdx:hbom:capacityBytes", cimNumber(module.Capacity)),
          createProperty(
            "cdx:hbom:capacity",
            formatBytes(cimNumber(module.Capacity)),
          ),
          createProperty(
            "cdx:hbom:memoryType",
            lookupSmbiosName(
              SMBIOS_MEMORY_TYPES,
              cimNumber(module.SMBIOSMemoryType),
            ),
          ),
          createProperty(
            "cdx:hbom:formFactor",
            windowsEnumName(
              WINDOWS_MEMORY_FORM_FACTORS,
              cimNumber(module.FormFactor),
            ),
          ),
          createProperty(
            "cdx:hbom:speedMTs",
            positiveCimNumber(module.Speed),
          ),
          createProperty(
            "cdx:hbom:configuredSpeedMTs",
            positiveCimNumber(module.ConfiguredClockSpeed),
          ),
          createProperty(
            "cdx:hbom:configuredVoltageMv",
            positiveCimNumber(module.ConfiguredVoltage),
          ),
          createProperty(
            "cdx:hbom:bankLabel",
            normalizeIdentityString(module.BankLabel),
          ),
          createProperty(
            "cdx:hbom:deviceLocator",
            normalizeIdentityString(module.DeviceLocator),
          ),
          createProperty(
            "cdx:hbom:serialNumber",
            redactCimIdentifier(cimString(module.SerialNumber), options),
          ),
        ]),
      }),
    ),
  ];
}

/**
 * Build the board, firmware and chassis components.
 *
 * Class names and property names mirror the Linux
 * `collectFirmwareAndBoardComponents` output so downstream consumers see one
 * vocabulary.
 *
 * @param {{
 *   sources: WindowsPlatformSources,
 *   includeSensitiveIdentifiers?: boolean
 * }} context Build context.
 * @returns {object[]} Board, firmware and chassis components.
 */
export function buildWindowsBoardFirmwareChassisComponents(context) {
  const { sources } = context;
  const options = context;
  const baseBoard = sources.baseBoard;
  const bios = sources.bios;
  const enclosure = sources.enclosure;
  const components = [];

  if (baseBoard) {
    components.push(
      createHardwareComponent("board", {
        name:
          normalizeIdentityString(baseBoard.Product) ??
          normalizeIdentityString(baseBoard.Manufacturer) ??
          "System Board",
        version: normalizeIdentityString(baseBoard.Version),
        manufacturer: normalizeIdentityString(baseBoard.Manufacturer)
          ? { name: normalizeIdentityString(baseBoard.Manufacturer) }
          : undefined,
        properties: compact([
          createProperty(
            "cdx:hbom:serialNumber",
            redactCimIdentifier(cimString(baseBoard.SerialNumber), options),
          ),
        ]),
      }),
    );
  }

  if (bios) {
    const biosVersion = normalizeIdentityString(bios.SMBIOSBIOSVersion);
    components.push(
      createComponent({
        type: "firmware",
        name: biosVersion ?? normalizeIdentityString(bios.Manufacturer) ?? "Firmware",
        version: biosVersion,
        manufacturer: normalizeIdentityString(bios.Manufacturer)
          ? { name: normalizeIdentityString(bios.Manufacturer) }
          : undefined,
        properties: compact([
          createProperty("cdx:hbom:hardwareClass", "firmware"),
          createProperty("cdx:hbom:firmwareVersion", biosVersion),
          createProperty("cdx:hbom:firmwareDate", windowsFirmwareDate(sources)),
          createProperty(
            "cdx:hbom:biosRevision",
            joinVersions(bios.SystemBiosMajorVersion, bios.SystemBiosMinorVersion),
          ),
          createProperty(
            "cdx:hbom:embeddedControllerVersion",
            embeddedControllerVersion(bios),
          ),
          createProperty("cdx:hbom:smbiosVersion", smbiosVersion(bios)),
        ]),
      }),
    );
  }

  const chassisName = enclosure ? windowsChassisTypeName(enclosure) : undefined;
  if (enclosure && chassisName) {
    components.push(
      createHardwareComponent("chassis", {
        name: chassisName,
        manufacturer: normalizeIdentityString(enclosure.Manufacturer)
          ? { name: normalizeIdentityString(enclosure.Manufacturer) }
          : undefined,
        properties: compact([
          createProperty(
            "cdx:hbom:serialNumber",
            redactCimIdentifier(cimString(enclosure.SerialNumber), options),
          ),
          createProperty(
            "cdx:hbom:assetTag",
            redactCimIdentifier(cimString(enclosure.SMBIOSAssetTag), options),
          ),
        ]),
      }),
    );
  }

  return components;
}

/**
 * Return the first item of a successful envelope result.
 *
 * @param {{ ok?: boolean, items?: object[] } | undefined} result Envelope result.
 * @returns {Record<string, unknown> | undefined} First item or undefined.
 */
function firstItem(result) {
  return result?.ok ? result.items?.[0] : undefined;
}

/**
 * Return the items of a successful envelope result.
 *
 * @param {{ ok?: boolean, items?: object[] } | undefined} result Envelope result.
 * @returns {Record<string, unknown>[]} Items, empty when the result failed.
 */
function okItems(result) {
  return result?.ok ? [...(result.items ?? [])] : [];
}

/**
 * Resolve the processor marketing name for host descriptions.
 *
 * @param {WindowsPlatformSources} sources Platform sources.
 * @param {{ cpuModel?: string }} baseline T0 baseline.
 * @returns {string | undefined} Processor name.
 */
function windowsProcessorName(sources, baseline) {
  return (
    cimString(sources.processors[0]?.Name) ??
    normalizeIdentityString(baseline.cpuModel) ??
    undefined
  );
}

/**
 * Resolve installed memory bytes from modules, CIM total or T0 baseline.
 *
 * @param {WindowsPlatformSources} sources Platform sources.
 * @param {{ totalMemoryBytes?: number }} baseline T0 baseline.
 * @returns {number | undefined} Installed bytes.
 */
function installedMemoryBytes(sources, baseline) {
  const moduleBytes = sources.memoryModules
    .map((module) => cimNumber(module.Capacity))
    .filter((value) => value !== undefined);
  if (moduleBytes.length > 0) {
    return moduleBytes.reduce((total, value) => total + value, 0);
  }
  return (
    cimNumber(sources.computerSystem?.TotalPhysicalMemory) ??
    baseline.totalMemoryBytes
  );
}

/**
 * Resolve the firmware release date from Win32_BIOS or MS_SystemInformation.
 *
 * @param {WindowsPlatformSources} sources Platform sources.
 * @returns {string | undefined} ISO calendar date.
 */
function windowsFirmwareDate(sources) {
  return (
    cimDate(cimString(sources.bios?.ReleaseDate)) ??
    cimDate(cimString(sources.msSystemInformation?.BIOSReleaseDate))
  );
}

/**
 * Resolve the chassis type name, omitting Other (1) and Unknown (2).
 *
 * @param {Record<string, unknown> | undefined} enclosure Enclosure item.
 * @returns {string | undefined} Chassis type name.
 */
function windowsChassisTypeName(enclosure) {
  const code = cimNumber(cimArray(enclosure?.ChassisTypes)[0]);
  if (code === undefined || code === 1 || code === 2) {
    return undefined;
  }
  return lookupSmbiosName(SMBIOS_CHASSIS_TYPES, code);
}

/**
 * Format the SMBIOS version as `major.minor`.
 *
 * @param {Record<string, unknown> | undefined} bios BIOS item.
 * @returns {string | undefined} SMBIOS version.
 */
function smbiosVersion(bios) {
  const major = cimNumber(bios?.SMBIOSMajorVersion);
  const minor = cimNumber(bios?.SMBIOSMinorVersion);
  return major === undefined || minor === undefined
    ? undefined
    : `${major}.${minor}`;
}

/**
 * Format the BIOS revision as `major.minor`.
 *
 * @param {unknown} major SystemBiosMajorVersion.
 * @param {unknown} minor SystemBiosMinorVersion.
 * @returns {string | undefined} BIOS revision.
 */
function joinVersions(major, minor) {
  const majorNumber = cimNumber(major);
  const minorNumber = cimNumber(minor);
  return majorNumber === undefined || minorNumber === undefined
    ? undefined
    : `${majorNumber}.${minorNumber}`;
}

/**
 * Format the embedded controller version, omitted at 255.255.
 *
 * SMBIOS fills 255/255 when the platform has no separate embedded
 * controller, which is the common case on VMs.
 *
 * @param {Record<string, unknown> | undefined} bios BIOS item.
 * @returns {string | undefined} Embedded controller version.
 */
function embeddedControllerVersion(bios) {
  const major = cimNumber(bios?.EmbeddedControllerMajorVersion);
  const minor = cimNumber(bios?.EmbeddedControllerMinorVersion);
  if (major === undefined || minor === undefined) {
    return undefined;
  }
  if (major === 255 && minor === 255) {
    return undefined;
  }
  return `${major}.${minor}`;
}

/**
 * Compute the memory array maximum capacity in bytes.
 *
 * `MaxCapacityEx` is documented in kilobytes (Win32_PhysicalMemoryArray).
 *
 * @param {Record<string, unknown>} array Memory array item.
 * @returns {number | undefined} Maximum capacity bytes.
 */
function maxCapacityBytes(array) {
  const kilobytes = positiveCimNumber(array.MaxCapacityEx);
  return kilobytes === undefined ? undefined : kilobytes * 1024;
}

/**
 * Build logical CPU count properties, reconciling instance sums with
 * Win32_ComputerSystem.
 *
 * When the computer-system count disagrees with the instance sum (some
 * virtual platforms report one instance per core), the computer-system value
 * wins and the instance count is recorded separately.
 *
 * @param {Record<string, unknown>[]} processors Processor items.
 * @param {number | undefined} systemLogical Win32_ComputerSystem.NumberOfLogicalProcessors.
 * @returns {object[]} One or two properties.
 */
function processorLogicalCount(processors, systemLogical) {
  const instanceSum = sumCim(processors, "NumberOfLogicalProcessors");
  if (
    systemLogical !== undefined &&
    instanceSum !== undefined &&
    systemLogical !== instanceSum
  ) {
    return [
      createProperty("cdx:hbom:logicalCpuCount", systemLogical),
      createProperty("cdx:hbom:processorInstanceCount", processors.length),
    ];
  }
  return [createProperty("cdx:hbom:logicalCpuCount", instanceSum)];
}

/**
 * Sum a CIM numeric property across items.
 *
 * @param {Record<string, unknown>[]} items CIM items.
 * @param {string} property Property name.
 * @returns {number | undefined} Sum or undefined.
 */
function sumCim(items, property) {
  const values = items
    .map((item) => cimNumber(item[property]))
    .filter((value) => value !== undefined);
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Normalize a CIM number, dropping zero sentinels.
 *
 * CIM classes use 0 for "unknown" on fields such as cache sizes, clock
 * speeds and voltages, so a zero carries no information.
 *
 * @param {unknown} value Candidate value.
 * @returns {number | undefined} Positive number or undefined.
 */
function positiveCimNumber(value) {
  const number = cimNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

/**
 * Redact a sensitive identifier unless raw identifiers were requested.
 *
 * Vendor placeholders (for example a literal `None` serial on Hyper-V)
 * identify nothing and are dropped instead of redacted.
 *
 * @param {string | undefined} value Trimmed identifier.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Redaction options.
 * @returns {string | undefined} Redacted identifier.
 */
function redactCimIdentifier(value, options) {
  if (value === undefined || isPlaceholderIdentity(value)) {
    return undefined;
  }
  return redactIdentifier(value, options);
}
