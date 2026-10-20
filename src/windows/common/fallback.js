import { resolveWindowsSystemPath } from "./powershell.js";

/**
 * T4 fallback sources for hosts where `powershell.exe` is missing, blocked
 * (AppLocker, WDAC) or forced into Constrained Language Mode (C10).
 *
 * Neither source needs PowerShell. Their text is translated into the same
 * envelope shape the CIM batches produce, so the existing builders emit the
 * components and nothing downstream knows which source was used.
 *
 * - `reg.exe query` on two keys under `HKLM\HARDWARE\DESCRIPTION\System`.
 *   Microsoft documents the volatile `HARDWARE\DESCRIPTION` hive as hardware
 *   data detected at boot, but not the value names of the `BIOS` subkey, so
 *   this is an undocumented source (PLAN.md §6); the value names are SMBIOS
 *   field names and have been stable since Windows 8.
 * - `pnputil /enum-devices /connected /relations /drivers` (documented on MS
 *   Learn, Windows 10 1903+ for `/relations` and 2004+ for `/drivers`). The
 *   text format is used: `/format` is documented only for `/enum-containers`.
 *   pnputil labels are localized, so a non-English host yields no records and
 *   a diagnostic instead of a misparse.
 */

const REG_BIOS_KEY = "HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS";
const REG_CPU_KEY = "HKLM\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0";

// Windows 10 builds that introduced the pnputil flags used here.
const PNPUTIL_RELATIONS_MIN_BUILD = 18362;
const PNPUTIL_DRIVERS_MIN_BUILD = 19041;

// Win32_Processor.Architecture codes (see enums.js).
const ARCHITECTURE_AMD64 = 9;
const ARCHITECTURE_ARM64 = 12;

function toFallbackCommandSpec(fields) {
  return Object.freeze({
    id: fields.id,
    category: fields.category,
    command: resolveWindowsSystemPath(fields.relativePath),
    args: Object.freeze([...fields.args]),
    parser: "text",
    purpose: fields.purpose,
    phase: "fallback",
    privilege: "none",
    sudoRetryOnPermissionDenied: false,
    timeoutMs: 30000,
    ...(fields.sensitiveFields
      ? { sensitiveFields: Object.freeze([...fields.sensitiveFields]) }
      : {}),
  });
}

/**
 * Fallback command specs. They are not part of the command plan: they run
 * only when the PowerShell batches cannot, and an allowlist that should
 * permit them must list `reg.exe` and `pnputil.exe` explicitly.
 *
 * @type {ReadonlyArray<Readonly<import("../../common/command.js").CommandSpec>>}
 */
export const WINDOWS_FALLBACK_COMMANDS = Object.freeze([
  toFallbackCommandSpec({
    id: "windows-reg-bios",
    category: "platform",
    relativePath: "System32\\reg.exe",
    args: ["query", REG_BIOS_KEY],
    purpose:
      "Read SMBIOS system, board and firmware strings from the boot-time hardware description when PowerShell is unavailable.",
  }),
  toFallbackCommandSpec({
    id: "windows-reg-cpu",
    category: "platform",
    relativePath: "System32\\reg.exe",
    args: ["query", REG_CPU_KEY],
    purpose:
      "Read the processor name, vendor and clock from the boot-time hardware description when PowerShell is unavailable.",
  }),
  toFallbackCommandSpec({
    id: "windows-pnputil-devices",
    category: "pnp-devices",
    relativePath: "System32\\pnputil.exe",
    args: ["/enum-devices", "/connected", "/relations", "/drivers"],
    purpose:
      "Enumerate connected PnP devices with parent links and installed drivers when PowerShell is unavailable.",
    sensitiveFields: ["Instance ID", "Parent", "Children"],
  }),
]);

/**
 * Look up a fallback command spec by id.
 *
 * @param {string} id Command id.
 * @returns {Readonly<import("../../common/command.js").CommandSpec>} Spec.
 * @throws {Error} When no fallback command carries the id.
 */
export function getWindowsFallbackCommand(id) {
  const spec = WINDOWS_FALLBACK_COMMANDS.find((candidate) => candidate.id === id);
  if (!spec) {
    throw new Error(`Unknown Windows fallback command: ${id}`);
  }
  return spec;
}

/**
 * Select the pnputil spec for an OS build, or undefined when the build
 * predates `/enum-devices /relations`. Builds before 2004 drop `/drivers`.
 *
 * @param {number | undefined} build Windows build number.
 * @returns {Readonly<import("../../common/command.js").CommandSpec> | undefined} Spec.
 */
export function selectPnputilCommand(build) {
  const spec = getWindowsFallbackCommand("windows-pnputil-devices");
  if (build === undefined || build >= PNPUTIL_DRIVERS_MIN_BUILD) {
    return spec;
  }
  if (build < PNPUTIL_RELATIONS_MIN_BUILD) {
    return undefined;
  }
  return Object.freeze({
    ...spec,
    args: Object.freeze(spec.args.filter((arg) => arg !== "/drivers")),
  });
}

/**
 * Extract the build number from an `os.release()` string such as `10.0.26200`.
 *
 * @param {string | undefined} release OS release.
 * @returns {number | undefined} Build number.
 */
export function parseWindowsBuild(release) {
  const match = String(release ?? "").match(/^\d+\.\d+\.(\d+)/u);
  return match ? Number(match[1]) : undefined;
}

/**
 * Parse `reg.exe query` output.
 *
 * Value lines have the fixed form `    <Name>    <REG_TYPE>    <Value>`; names
 * may contain single spaces (`Component Information`). DWORD and QWORD values
 * print as `0x` hex and are returned as numbers; binary and resource values
 * are dropped.
 *
 * @param {string} text reg.exe stdout.
 * @returns {Record<string, Record<string, string | number>>} Values by key path.
 */
export function parseRegQuery(text) {
  const keys = {};
  let current;
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    if (/^HKEY_/u.test(line)) {
      current = {};
      keys[line.trim()] = current;
      continue;
    }
    const match = line.match(/^ {4}(\S(?:.*?\S)?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/u);
    if (!current || !match) {
      continue;
    }
    const [, name, type, raw = ""] = match;
    if (type === "REG_DWORD" || type === "REG_QWORD") {
      const value = Number.parseInt(raw.trim(), 16);
      if (Number.isFinite(value)) {
        current[name] = value;
      }
    } else if (type === "REG_SZ" || type === "REG_EXPAND_SZ") {
      const value = raw.trim();
      if (value) {
        current[name] = value;
      }
    }
  }
  return keys;
}

/**
 * Translate the two registry keys into a `windows-cim-platform`-shaped
 * envelope (CIM property names), so `parsePlatformEnvelope` reads it.
 *
 * @param {Record<string, string | number> | undefined} bios BIOS key values.
 * @param {Record<string, string | number> | undefined} cpu CentralProcessor\0 values.
 * @returns {{ meta: object, results: Record<string, { ok: boolean, items: object[] }>, warnings: string[] }} Envelope.
 */
export function toFallbackPlatformEnvelope(bios, cpu) {
  const results = {};
  const put = (key, item) => {
    const entries = Object.entries(item).filter(([, value]) => value !== undefined);
    if (entries.length > 0) {
      results[key] = { ok: true, items: [Object.fromEntries(entries)] };
    }
  };
  if (bios) {
    put("computerSystem", {
      Manufacturer: bios.SystemManufacturer,
      Model: bios.SystemProductName,
      SystemFamily: bios.SystemFamily,
      SystemSKUNumber: bios.SystemSKU,
    });
    put("computerSystemProduct", {
      Name: bios.SystemProductName,
      Vendor: bios.SystemManufacturer,
      Version: bios.SystemVersion,
    });
    put("bios", {
      Manufacturer: bios.BIOSVendor,
      SMBIOSBIOSVersion: bios.BIOSVersion,
      SystemBiosMajorVersion: bios.BiosMajorRelease,
      SystemBiosMinorVersion: bios.BiosMinorRelease,
      ReleaseDate: toIsoDate(bios.BIOSReleaseDate),
    });
    put("baseBoard", {
      Manufacturer: bios.BaseBoardManufacturer,
      Product: bios.BaseBoardProduct,
      Version: bios.BaseBoardVersion,
    });
    if (typeof bios.EnclosureType === "number") {
      put("systemEnclosure", { ChassisTypes: [bios.EnclosureType] });
    }
  }
  if (cpu) {
    put("processor", {
      Name: cpu.ProcessorNameString,
      Manufacturer: cpu.VendorIdentifier,
      MaxClockSpeed: cpu["~MHz"],
      Architecture: architectureFromIdentifier(cpu.Identifier),
    });
  }
  return {
    meta: { commandId: "windows-reg-platform" },
    results,
    warnings: [],
  };
}

/**
 * Parse `pnputil /enum-devices` text output.
 *
 * Each device starts with an `Instance ID:` line at column 0; continuation
 * lines of a multi-value field (Children) are indented past the label column,
 * and `Matching Drivers:` opens 4-space-indented driver blocks separated by a
 * whitespace-only line.
 *
 * @param {string} text pnputil stdout.
 * @returns {{ devices: PnputilDevice[], recognized: boolean }} Devices, and
 *   whether the English labels were found.
 */
export function parsePnputilDevices(text) {
  const devices = [];
  let device;
  let field;
  let driver;
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const top = line.match(/^([A-Z][A-Za-z ]*?):\s*(.*?)\s*$/u);
    if (top) {
      const [, label, value] = top;
      if (label === "Instance ID") {
        device = { instanceId: value, children: [], drivers: [] };
        devices.push(device);
      }
      if (!device) {
        continue;
      }
      field = label;
      driver = undefined;
      assignDeviceField(device, label, value);
      continue;
    }
    if (!device) {
      continue;
    }
    const nested = line.match(/^ {4}([A-Z][A-Za-z ]*?):\s*(.*?)\s*$/u);
    if (nested && field === "Matching Drivers") {
      const [, label, value] = nested;
      if (label === "Driver Name" || !driver) {
        driver = {};
        device.drivers.push(driver);
      }
      assignDriverField(driver, label, value);
      continue;
    }
    const continuation = line.match(/^\s{8,}(\S.*?)\s*$/u);
    if (continuation && field === "Children") {
      device.children.push(continuation[1]);
    }
  }
  return {
    devices: devices.filter((entry) => entry.instanceId),
    recognized: devices.length > 0,
  };
}

/**
 * @typedef {object} PnputilDevice
 * @property {string} instanceId Raw instance ID.
 * @property {string} [description] Device description.
 * @property {string} [className] Setup class name.
 * @property {string} [classGuid] Setup class GUID.
 * @property {string} [manufacturer] Manufacturer name.
 * @property {string} [status] Status (Started, Disabled, Problem, ...).
 * @property {number} [problemCode] Device Manager problem code.
 * @property {string} [driverName] Installed INF name.
 * @property {string} [parent] Parent instance ID.
 * @property {string[]} children Child instance IDs.
 * @property {Array<{ driverName?: string, providerName?: string, driverDate?: string, driverVersion?: string, signerName?: string, status?: string }>} drivers Matching drivers.
 */

function assignDeviceField(device, label, value) {
  if (!value) {
    return;
  }
  switch (label) {
    case "Device Description":
      device.description = value;
      break;
    case "Class Name":
      device.className = value;
      break;
    case "Class GUID":
      device.classGuid = value;
      break;
    case "Manufacturer Name":
      device.manufacturer = value;
      break;
    case "Status":
      device.status = value;
      break;
    case "Problem Code": {
      const code = Number.parseInt(value, 10);
      if (Number.isFinite(code)) {
        device.problemCode = code;
      }
      break;
    }
    case "Driver Name":
      device.driverName = value;
      break;
    case "Parent":
      device.parent = value;
      break;
    case "Children":
      device.children.push(value);
      break;
    default:
      break;
  }
}

function assignDriverField(driver, label, value) {
  switch (label) {
    case "Driver Name":
      driver.driverName = value;
      break;
    case "Provider Name":
      driver.providerName = value;
      break;
    case "Driver Version": {
      // `MM/DD/YYYY <version>`; the date is the INF DriverVer date.
      const match = value.match(/^(\d{2}\/\d{2}\/\d{4})\s+(\S+)$/u);
      if (match) {
        driver.driverDate = toIsoDate(match[1]);
        driver.driverVersion = match[2];
      } else if (value) {
        driver.driverVersion = value;
      }
      break;
    }
    case "Signer Name":
      driver.signerName = value;
      break;
    case "Driver Status":
      driver.status = value;
      break;
    default:
      break;
  }
}

/**
 * Translate pnputil devices into a `windows-pnp-devices`-shaped envelope:
 * entities, `DEVPKEY_Device_Parent` rows and the installed driver as a
 * signed-driver row.
 *
 * @param {PnputilDevice[]} devices Parsed devices.
 * @returns {{ meta: object, results: Record<string, object>, warnings: string[] }} Envelope.
 */
export function toFallbackPnpEnvelope(devices) {
  const entities = [];
  const properties = [];
  const signedDrivers = [];
  for (const device of devices) {
    entities.push(
      compactObject({
        PNPDeviceID: device.instanceId,
        Name: device.description,
        ClassGuid: device.classGuid,
        Manufacturer: device.manufacturer,
        Present: true,
        ConfigManagerErrorCode: device.problemCode ?? 0,
      }),
    );
    if (device.parent) {
      properties.push({
        InstanceId: device.instanceId,
        KeyName: "DEVPKEY_Device_Parent",
        Type: "String",
        Data: device.parent,
      });
    }
    const installed =
      device.drivers.find((entry) => /\binstalled\b/iu.test(entry.status ?? "")) ??
      device.drivers.find((entry) => entry.driverName === device.driverName);
    if (installed) {
      signedDrivers.push(
        compactObject({
          DeviceID: device.instanceId,
          DriverVersion: installed.driverVersion,
          DriverProviderName: installed.providerName,
          DriverDate: installed.driverDate,
          Signer: installed.signerName,
          InfName: installed.driverName,
        }),
      );
    }
  }
  return {
    meta: { commandId: "windows-pnputil-devices" },
    results: {
      pnpEntity: { ok: true, items: entities },
      pnpProperties: { ok: true, items: properties, errorCount: 0 },
      signedDriver: { ok: true, items: signedDrivers },
    },
    warnings: [],
  };
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function toIsoDate(value) {
  const match = String(value ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/u);
  return match ? `${match[3]}-${match[1]}-${match[2]}` : undefined;
}

function architectureFromIdentifier(identifier) {
  const text = String(identifier ?? "");
  if (/^(?:ARMv8|ARM64)\b/iu.test(text)) {
    return ARCHITECTURE_ARM64;
  }
  if (/^(?:Intel64|AMD64|EM64T)\b/iu.test(text)) {
    return ARCHITECTURE_AMD64;
  }
  return undefined;
}
