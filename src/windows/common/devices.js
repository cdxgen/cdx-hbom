// Windows PnP inventory: a device index built from Win32_PnPEntity, the
// DEVPKEY bulk properties and Win32_PnPSignedDriver of the
// `windows-pnp-devices` envelope, classified into usb-controller, usb-device,
// pci-device, bluetooth-controller and bluetooth-device components with a
// parent/child topology. Devices that other Windows builders already
// represent (NICs, disks, graphics, sound, monitors, endpoints, cameras) are
// enriched through `pnpEnrichmentProperties` and `pnpBomRef` instead of being
// emitted twice. All functions are pure.

import {
  compact,
  createHardwareComponent,
  createProperty,
  normalizeIdentityString,
  redactIdentifier,
} from "../../common/shape.js";
import {
  cimArray,
  cimBool,
  cimDate,
  cimNumber,
  cimResultItems,
  cimString,
} from "./cim.js";
import { windowsSetupClassName } from "./enums.js";
import {
  getInstanceSegment,
  parseDeviceInstanceId,
  parseHardwareIds,
  redactHardwareIds,
  redactInstanceId,
} from "./pnp.js";

// DEVPKEY_Device_Address is 0xFFFFFFFF when "the underlying bus driver did
// not supply a bus address for the device":
// https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/ne-wdm-device_registry_property
const ADDRESS_NOT_SUPPLIED = 0xffffffff;

// In-box class drivers report a parenthesised class placeholder instead of a
// vendor ("(Standard system devices)", "(Standard USB Host Controller)",
// "(Generic USB Hub)" on win11-vm). Like "(Standard disk drives)" on
// Win32_DiskDrive, these name the driver class, not a manufacturer.
const CLASS_PLACEHOLDER_MANUFACTURER = /^\(.+\)$/u;

// Enumerators that never yield a component here, with the reason recorded in
// the classification summary so nothing is dropped silently.
const UNCLASSIFIED_ENUMERATORS = Object.freeze({
  ACPI: "ACPI-described platform node (processors, bridges and firmware devices are covered by their own classes)",
  ACPI_HAL: "ACPI HAL root node",
  HTREE: "device tree root",
  ROOT: "root-enumerated software or legacy device",
  SWD: "software device without a physical bus",
  HID: "HID top-level collection; represented by its USB or VMBus device",
  DISPLAY: "monitor; represented by the display component when WmiMonitorID reports it",
  SCSI: "SCSI-enumerated disk or optical drive; disks are represented by storage components",
  STORAGE: "volume or volume snapshot; volumes are represented by storage-volume components",
  HDAUDIO: "HD Audio codec; represented by the audio-controller component",
  UEFI: "ESRT firmware resource; represented by the firmware-device component",
  VMBUS: "Hyper-V VMBus synthetic device; no documented vendor identifier format (NICs are represented through MSFT_NetAdapter)",
  UMB: "UMBus (umbus.sys) software bus child",
  MANA_BUS: "Azure MANA bus child; the adapter is represented through MSFT_NetAdapter when HardwareInterface is true",
  TS_USB_HUB_ENUMERATOR: "Remote Desktop USB redirection hub",
});

// Per-device instance segments also turn up inside other strings. On Hyper-V
// (windows-2025 and windows-11-arm GitHub runners), DEVPKEY_Device_LocationPaths
// embeds the VMBus instance GUID, and a hardware ID can repeat another
// device's instance GUID. Every emitted string that may carry them is therefore
// scrubbed of every instance segment the index knows, keyed by index.
const INSTANCE_SEGMENT_PATTERNS = new WeakMap();

const EMPTY_SOURCES = Object.freeze({
  entities: [],
  properties: [],
  signedDrivers: [],
  keyErrors: {},
  propertiesAvailable: false,
  propertyErrorCount: 0,
});

/**
 * @typedef {object} WindowsPnpSources
 * @property {Record<string, unknown>[]} entities Win32_PnPEntity items.
 * @property {Record<string, unknown>[]} properties `{InstanceId, KeyName, Type, Data}` rows.
 * @property {Record<string, unknown>[]} signedDrivers Win32_PnPSignedDriver items.
 * @property {Record<string, object>} keyErrors Per-DEVPKEY errors from the key probe.
 * @property {boolean} propertiesAvailable Whether the property result succeeded.
 * @property {number} propertyErrorCount Devices whose property call failed.
 */

/**
 * @typedef {object} PnpDeviceRecord
 * @property {string} id Raw device instance ID.
 * @property {string} key Lower-cased instance ID (Windows mixes cases).
 * @property {string} ref Deterministic bom-ref.
 * @property {Record<string, unknown> | undefined} entity Win32_PnPEntity item.
 * @property {string | undefined} setupClass Documented setup-class name.
 * @property {string | undefined} parent Raw parent instance ID.
 * @property {string[]} locationPaths DEVPKEY_Device_LocationPaths.
 * @property {string | undefined} driverVersion DEVPKEY_Device_DriverVersion.
 * @property {string | undefined} driverProvider DEVPKEY_Device_DriverProvider.
 * @property {string | undefined} driverDate DEVPKEY_Device_DriverDate as `YYYY-MM-DD`.
 * @property {string | undefined} busReportedName DEVPKEY_Device_BusReportedDeviceDesc.
 * @property {number | undefined} busNumber DEVPKEY_Device_BusNumber.
 * @property {number | undefined} address DEVPKEY_Device_Address.
 * @property {Record<string, unknown> | undefined} signedDriver Win32_PnPSignedDriver row.
 * @property {ReturnType<typeof parseDeviceInstanceId>} parsed Parsed instance ID.
 * @property {Array<{ number: number | undefined, driver: string | undefined }>} interfaces USB interface functions folded into this device.
 */

/**
 * Project a parsed `windows-pnp-devices` envelope into typed sources.
 *
 * @param {{ results?: Record<string, { ok?: boolean, items?: object[], keyErrors?: Record<string, object> }> }} envelope Parsed envelope.
 * @returns {WindowsPnpSources} Typed sources.
 */
export function parsePnpDevicesEnvelope(envelope) {
  const results = envelope?.results ?? {};
  const properties = results.pnpProperties;
  return {
    entities: cimResultItems(results.pnpEntity),
    properties: cimResultItems(properties),
    signedDrivers: cimResultItems(results.signedDriver),
    keyErrors:
      properties?.ok && properties.keyErrors ? { ...properties.keyErrors } : {},
    propertiesAvailable: properties?.ok === true,
    propertyErrorCount: properties?.ok ? (cimNumber(properties.errorCount) ?? 0) : 0,
  };
}

/**
 * Build the device index: one record per instance ID merging the entity, its
 * DEVPKEY values and its signed-driver row, keyed case-insensitively.
 *
 * Every record gets a deterministic bom-ref
 * `windows-pnp:<enumerator>:<device-id>:<n>` where `n` is the 1-based ordinal
 * among identical enumerator/device-ID pairs in sorted raw-ID order, so the
 * per-machine instance segment never reaches the ref.
 *
 * @param {WindowsPnpSources | undefined} sources PnP sources.
 * @returns {Map<string, PnpDeviceRecord>} Index by lower-cased instance ID.
 */
export function buildPnpDeviceIndex(sources = EMPTY_SOURCES) {
  const index = new Map();
  const ensure = (id) => {
    const raw = cimString(id);
    if (raw === undefined) {
      return undefined;
    }
    const key = raw.toLowerCase();
    if (!index.has(key)) {
      index.set(key, {
        id: raw,
        key,
        ref: undefined,
        entity: undefined,
        setupClass: undefined,
        parent: undefined,
        locationPaths: [],
        driverVersion: undefined,
        driverProvider: undefined,
        driverDate: undefined,
        busReportedName: undefined,
        busNumber: undefined,
        address: undefined,
        signedDriver: undefined,
        parsed: parseDeviceInstanceId(raw),
        interfaces: [],
      });
    }
    return index.get(key);
  };

  for (const entity of sources.entities) {
    const record = ensure(entity.PNPDeviceID);
    if (record) {
      record.entity = entity;
      record.setupClass = windowsSetupClassName(cimString(entity.ClassGuid));
    }
  }
  for (const row of sources.properties) {
    const record = ensure(row.InstanceId);
    if (record) {
      applyDeviceProperty(record, row);
    }
  }
  for (const driver of sources.signedDrivers) {
    // Driver rows only annotate known devices: Win32_PnPSignedDriver also
    // lists non-PnP entries whose DeviceID is a plain name ("Microsoft Print
    // to PDF" on win11-vm), which must not become device records.
    const record = lookup(index, driver.DeviceID);
    if (record && record.signedDriver === undefined) {
      record.signedDriver = driver;
    }
  }

  assignBomRefs(index);
  INSTANCE_SEGMENT_PATTERNS.set(index, instanceSegmentPattern(index));
  return index;
}

/**
 * Classify one device record.
 *
 * Rules, in order: a device another builder already represents is enriched
 * there; USB interface functions (`&MI_xx`) fold into their composite parent;
 * Bluetooth radios on USB or PCI are controllers; USB-enumerated devices
 * (root hubs included, as on Linux) are usb-device; PCI functions are
 * usb-controller when their setup class is USB and pci-device otherwise;
 * BTHENUM/BTHLE children are bluetooth-device. Everything else is left
 * unclassified with a reason.
 *
 * @param {PnpDeviceRecord} record Device record.
 * @param {Map<string, PnpDeviceRecord>} index Device index.
 * @param {Set<string>} represented Lower-cased IDs already represented elsewhere.
 * @returns {{ hardwareClass?: string, foldInto?: string, represented?: boolean, reason?: string }} Decision.
 */
export function classifyPnpDevice(record, index, represented = new Set()) {
  if (represented.has(record.key)) {
    return { represented: true };
  }
  const enumerator = String(record.parsed.enumerator ?? "").toUpperCase();
  const setupClass = record.setupClass;

  if (enumerator === "USB" && record.parsed.ids.interfaceNumber !== undefined) {
    const parentKey = cimString(record.parent)?.toLowerCase();
    if (parentKey !== undefined && index.has(parentKey)) {
      return { foldInto: parentKey };
    }
    return { hardwareClass: "usb-device" };
  }
  if (setupClass === "Bluetooth" && (enumerator === "USB" || enumerator === "PCI")) {
    return { hardwareClass: "bluetooth-controller" };
  }
  if (enumerator === "USB") {
    return { hardwareClass: "usb-device" };
  }
  if (enumerator === "PCI") {
    return { hardwareClass: setupClass === "USB" ? "usb-controller" : "pci-device" };
  }
  if (enumerator === "BTHENUM" || enumerator === "BTHLE") {
    return { hardwareClass: "bluetooth-device" };
  }
  return {
    reason:
      UNCLASSIFIED_ENUMERATORS[enumerator] ??
      `unrecognized enumerator ${enumerator || "(none)"}`,
  };
}

/**
 * Build the PnP-derived components and the classification summary.
 *
 * @param {Map<string, PnpDeviceRecord>} index Device index.
 * @param {{ includeSensitiveIdentifiers?: boolean, represented?: Set<string> }} [options={}] Build options.
 * @returns {{
 *   components: object[],
 *   summary: {
 *     counts: Record<string, number>,
 *     folded: number,
 *     represented: number,
 *     notPresent: number,
 *     unclassified: Array<{ id: string, enumerator: string | undefined, setupClass: string | undefined, reason: string }>
 *   }
 * }} Components and summary.
 */
export function buildPnpComponents(index, options = {}) {
  const represented = options.represented ?? new Set();
  const records = [...index.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  const summary = {
    counts: {},
    folded: 0,
    represented: 0,
    notPresent: 0,
    unclassified: [],
  };
  for (const record of records) {
    record.interfaces = [];
  }

  const emit = [];
  for (const record of records) {
    if (cimBool(record.entity?.Present) === false) {
      summary.notPresent += 1;
      continue;
    }
    const decision = classifyPnpDevice(record, index, represented);
    if (decision.represented) {
      summary.represented += 1;
      continue;
    }
    if (decision.foldInto !== undefined) {
      index.get(decision.foldInto).interfaces.push({
        number: parseInterfaceNumber(record.parsed.ids.interfaceNumber),
        driver: cimString(record.entity?.Service),
      });
      summary.folded += 1;
      continue;
    }
    if (decision.hardwareClass === undefined) {
      summary.unclassified.push({
        id: redactInstanceId(record.id, options),
        enumerator: record.parsed.enumerator,
        setupClass: record.setupClass,
        reason: decision.reason,
      });
      continue;
    }
    emit.push([record, decision.hardwareClass]);
  }

  const components = emit.map(([record, hardwareClass]) => {
    summary.counts[hardwareClass] = (summary.counts[hardwareClass] ?? 0) + 1;
    return buildPnpComponent(record, hardwareClass, index, options);
  });
  return { components, summary };
}

/**
 * Build parent-depends-on-child edges for every emitted component.
 *
 * Edges follow `DEVPKEY_Device_Parent` and use the same direction as the
 * Linux `buildUsbTopologyEdges` (parent depends on child, matching physical
 * containment). Ancestors that have no component (ACPI, ROOT, HTREE, folded
 * interfaces) are skipped transitively, so a USB device under a root hub
 * under an xHCI controller links to the nearest emitted ancestor.
 *
 * @param {Map<string, PnpDeviceRecord>} index Device index.
 * @param {Iterable<string>} knownRefs bom-refs of emitted components.
 * @returns {Array<{ ref: string, dependsOn: string[] }>} Edges.
 */
export function buildPnpTopologyEdges(index, knownRefs) {
  const known = new Set(knownRefs);
  const edges = [];
  for (const record of index.values()) {
    if (!known.has(record.ref)) {
      continue;
    }
    const visited = new Set([record.key]);
    let parentKey = cimString(record.parent)?.toLowerCase();
    while (parentKey !== undefined && !visited.has(parentKey)) {
      visited.add(parentKey);
      const parent = index.get(parentKey);
      if (!parent) {
        break;
      }
      if (known.has(parent.ref)) {
        edges.push({ ref: parent.ref, dependsOn: [record.ref] });
        break;
      }
      parentKey = cimString(parent.parent)?.toLowerCase();
    }
  }
  return edges;
}

/**
 * Return the bom-ref of a device another builder represents.
 *
 * @param {Map<string, PnpDeviceRecord> | undefined} index Device index.
 * @param {string | undefined} instanceId Raw device instance ID.
 * @returns {string | undefined} bom-ref, or undefined without PnP data.
 */
export function pnpBomRef(index, instanceId) {
  return lookup(index, instanceId)?.ref;
}

/**
 * PnP-derived properties for a component another builder represents.
 *
 * Returns driver identity and signing, the problem code, the bus-reported
 * name, the location path and the redacted instance ID, skipping any name the
 * component already carries from its primary CIM class.
 *
 * @param {Map<string, PnpDeviceRecord> | undefined} index Device index.
 * @param {string | undefined} instanceId Raw device instance ID.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Build options.
 * @param {Array<{ name: string }>} [existing=[]] Properties already built.
 * @returns {object[]} Extra properties.
 */
export function pnpEnrichmentProperties(index, instanceId, options = {}, existing = []) {
  const record = lookup(index, instanceId);
  if (!record) {
    return [];
  }
  const taken = new Set(existing.filter(Boolean).map((property) => property.name));
  return commonPnpProperties(record, index, options).filter(
    (property) => !taken.has(property.name),
  );
}

/**
 * Component fields for a device another builder represents: its PnP bom-ref
 * and its properties followed by the PnP-derived ones it does not already
 * carry. Without PnP data the properties pass through unchanged.
 *
 * @param {Map<string, PnpDeviceRecord> | undefined} index Device index.
 * @param {string | undefined} instanceId Raw device instance ID.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Build options.
 * @param {object[]} properties Properties the builder already made.
 * @returns {{ "bom-ref"?: string, properties: object[] }} Fields to spread into the component.
 */
export function withPnpIdentity(index, instanceId, options, properties) {
  const ref = pnpBomRef(index, instanceId);
  return {
    ...(ref ? { "bom-ref": ref } : {}),
    properties: [
      ...properties,
      ...pnpEnrichmentProperties(index, instanceId, options, properties),
    ],
  };
}

/**
 * Diagnostics for the PnP batch: one `partial-support` entry per DEVPKEY the
 * first device rejected (the key is then skipped for every device) and one
 * when individual devices failed their property call, because in both cases
 * properties are missing without the batch having failed.
 *
 * @param {WindowsPnpSources} sources PnP sources.
 * @returns {object[]} Diagnostics.
 */
export function pnpDevicesDiagnostics(sources) {
  const diagnostics = Object.entries(sources.keyErrors ?? {}).map(([key, error]) => ({
    id: `windows-pnp-devices:pnpProperties:${key}`,
    issue: "partial-support",
    code: cimString(error?.nativeErrorCode),
    message: `Get-PnpDeviceProperty rejected ${key}; the key was skipped for every device`,
  }));
  if ((sources.propertyErrorCount ?? 0) > 0) {
    diagnostics.push({
      id: "windows-pnp-devices:pnpProperties",
      issue: "partial-support",
      message: `Get-PnpDeviceProperty failed for ${sources.propertyErrorCount} device(s); their driver and topology properties are missing`,
    });
  }
  return diagnostics;
}

/**
 * Build one PnP-derived component.
 *
 * @param {PnpDeviceRecord} record Device record.
 * @param {string} hardwareClass Hardware class.
 * @param {Map<string, PnpDeviceRecord>} index Device index.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Build options.
 * @returns {object} Component.
 */
function buildPnpComponent(record, hardwareClass, index, options) {
  const entity = record.entity ?? {};
  // Hardware IDs lead (most specific first, so REV_ is kept); the instance ID
  // is the fallback for entities without a hardware ID list.
  const ids = parseHardwareIds([...allHardwareIds(record, options), record.id]);
  const manufacturer = pnpManufacturer(entity.Manufacturer);
  const isPci = String(record.parsed.enumerator ?? "").toUpperCase() === "PCI";
  const isUsb = hardwareClass === "usb-device";
  const isBluetooth = hardwareClass.startsWith("bluetooth-");
  const interfaces = [...record.interfaces].sort(
    (a, b) => (a.number ?? 0) - (b.number ?? 0),
  );

  return createHardwareComponent(hardwareClass, {
    "bom-ref": record.ref,
    name: cimString(entity.Name) ?? record.busReportedName ?? defaultName(hardwareClass),
    manufacturer: manufacturer ? { name: manufacturer } : undefined,
    description: record.setupClass,
    properties: compact([
      createProperty("cdx:hbom:vendorId", ids.vendorId),
      createProperty("cdx:hbom:productId", ids.productId),
      createProperty("cdx:hbom:revision", ids.revision),
      ...(isBluetooth
        ? [
            // BTHENUM/BTHLE device IDs embed the remote radio's address;
            // it is a MAC and is redacted like every other MAC.
            createProperty(
              "cdx:hbom:address",
              redactBluetoothAddress(record.parsed.ids.deviceAddress, options),
            ),
          ]
        : []),
      ...(isPci
        ? [
            createProperty("cdx:hbom:subsystemVendorId", ids.subsystemVendorId),
            createProperty("cdx:hbom:subsystemDeviceId", ids.subsystemId),
            createProperty("cdx:hbom:pciClassCode", ids.pciClassCode),
          ]
        : []),
      ...(isUsb
        ? [
            createProperty("cdx:hbom:usbClass", ids.usbClass),
            createProperty("cdx:hbom:usbSubclass", ids.usbSubclass),
            createProperty("cdx:hbom:usbProtocol", ids.usbProtocol),
            createProperty(
              "cdx:hbom:usbInterfaceCount",
              interfaces.length > 0 ? interfaces.length : undefined,
            ),
            createProperty(
              "cdx:hbom:usbInterfaceDrivers",
              formatInterfaceDrivers(interfaces),
            ),
          ]
        : []),
      ...commonPnpProperties(record, index, options),
    ]),
  });
}

/**
 * Properties every PnP-backed component shares.
 *
 * @param {PnpDeviceRecord} record Device record.
 * @param {Map<string, PnpDeviceRecord> | undefined} index Device index.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Build options.
 * @returns {object[]} Properties (undefined entries removed).
 */
function commonPnpProperties(record, index, options) {
  const entity = record.entity ?? {};
  const signed = record.signedDriver ?? {};
  const name = cimString(entity.Name);
  const problemCode = cimNumber(entity.ConfigManagerErrorCode);
  const scrub = (value) => redactEmbeddedSegments(value, index, options);
  const hardwareIds = redactHardwareIds(cimArray(entity.HardwareID), record.id, options).map(scrub);
  const compatibleIds = redactHardwareIds(cimArray(entity.CompatibleID), record.id, options).map(scrub);
  return compact([
    createProperty("cdx:hbom:driver", cimString(entity.Service)),
    createProperty(
      "cdx:hbom:driverVersion",
      record.driverVersion ?? cimString(signed.DriverVersion),
    ),
    createProperty(
      "cdx:hbom:driverProvider",
      record.driverProvider ?? cimString(signed.DriverProviderName),
    ),
    createProperty(
      "cdx:hbom:driverDate",
      record.driverDate ?? cimDate(cimString(signed.DriverDate)),
    ),
    createProperty("cdx:hbom:driverSigned", cimBool(signed.IsSigned)),
    createProperty("cdx:hbom:driverSigner", cimString(signed.Signer)),
    createProperty("cdx:hbom:infName", cimString(signed.InfName)),
    // ConfigManagerErrorCode 0 is "This device is working properly"; the
    // non-zero codes are the Device Manager error codes listed at
    // https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-pnpentity
    createProperty(
      "cdx:hbom:problemCode",
      problemCode !== undefined && problemCode !== 0 ? problemCode : undefined,
    ),
    createProperty(
      "cdx:hbom:busReportedName",
      record.busReportedName !== undefined && record.busReportedName !== name
        ? record.busReportedName
        : undefined,
    ),
    createProperty("cdx:hbom:locationPath", scrub(record.locationPaths[0])),
    createProperty("cdx:hbom:present", cimBool(entity.Present)),
    createProperty(
      "cdx:hbom:hardwareIds",
      hardwareIds.length > 0 ? hardwareIds.join(", ") : undefined,
    ),
    createProperty(
      "cdx:hbom:compatibleIds",
      compatibleIds.length > 0 ? compatibleIds.join(", ") : undefined,
    ),
    createProperty("cdx:hbom:pnpInstanceId", redactInstanceId(record.id, options)),
  ]);
}

/**
 * Build one case-insensitive pattern matching every raw instance segment in
 * the index that `redactIdentifier` would not reduce to a bare `redacted`.
 * Longer segments come first so a segment never matches part of a longer one.
 *
 * @param {Map<string, PnpDeviceRecord>} index Device index.
 * @returns {RegExp | undefined} Pattern, or undefined when there is nothing to scrub.
 */
function instanceSegmentPattern(index) {
  const segments = new Set();
  for (const record of index.values()) {
    const segment = getInstanceSegment(record.id);
    if (segment && segment.length > 4 && !/^redacted(?::|$)/u.test(segment)) {
      segments.add(segment.toLowerCase());
    }
  }
  if (segments.size === 0) {
    return undefined;
  }
  const alternatives = [...segments]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return new RegExp(alternatives.join("|"), "giu");
}

/**
 * Replace every known instance segment inside a string with its redacted form.
 *
 * @param {string | undefined} text Candidate string.
 * @param {Map<string, PnpDeviceRecord> | undefined} index Device index.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Redaction options.
 * @returns {string | undefined} Scrubbed string.
 */
function redactEmbeddedSegments(text, index, options) {
  const pattern = index ? INSTANCE_SEGMENT_PATTERNS.get(index) : undefined;
  if (text === undefined || pattern === undefined || options.includeSensitiveIdentifiers === true) {
    return text;
  }
  return text.replace(pattern, (segment) => redactIdentifier(segment, options));
}

/**
 * Merge one `{InstanceId, KeyName, Data}` row into a record.
 *
 * @param {PnpDeviceRecord} record Device record.
 * @param {Record<string, unknown>} row Property row.
 * @returns {void} Nothing.
 */
function applyDeviceProperty(record, row) {
  const data = row.Data;
  if (data === null || data === undefined) {
    return;
  }
  switch (cimString(row.KeyName)) {
    case "DEVPKEY_Device_Parent":
      record.parent = cimString(data);
      break;
    case "DEVPKEY_Device_LocationPaths":
      record.locationPaths = cimArray(data).map((value) => cimString(value)).filter(Boolean);
      break;
    case "DEVPKEY_Device_DriverVersion":
      record.driverVersion = cimString(data);
      break;
    case "DEVPKEY_Device_DriverProvider":
      record.driverProvider = cimString(data);
      break;
    case "DEVPKEY_Device_DriverDate":
      record.driverDate = cimDate(cimString(data));
      break;
    case "DEVPKEY_Device_BusReportedDeviceDesc":
      record.busReportedName = cimString(data);
      break;
    case "DEVPKEY_Device_BusNumber":
      record.busNumber = cimNumber(data);
      break;
    case "DEVPKEY_Device_Address": {
      const address = cimNumber(data);
      record.address = address === ADDRESS_NOT_SUPPLIED ? undefined : address;
      break;
    }
    default:
      break;
  }
}

/**
 * Assign deterministic bom-refs to every record in the index.
 *
 * @param {Map<string, PnpDeviceRecord>} index Device index.
 * @returns {void} Nothing.
 */
function assignBomRefs(index) {
  const groups = new Map();
  for (const record of index.values()) {
    // The ref is built from the redacted form so a Bluetooth device-ID
    // segment (`BTHLE\DEV_<address>`) never carries the address into it;
    // for every other enumerator the device-ID segment is unchanged.
    const safe = parseDeviceInstanceId(redactInstanceId(record.id));
    const enumerator = String(safe.enumerator ?? "").toLowerCase();
    const deviceId = String(safe.deviceId ?? "").toLowerCase();
    const groupKey = `${enumerator}:${deviceId}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey).push(record);
  }
  for (const [groupKey, records] of groups) {
    records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    records.forEach((record, position) => {
      record.ref = `windows-pnp:${groupKey}:${position + 1}`;
    });
  }
}

/**
 * Collect a record's hardware and compatible IDs, redacted.
 *
 * @param {PnpDeviceRecord} record Device record.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Build options.
 * @returns {string[]} IDs.
 */
function allHardwareIds(record, options) {
  const entity = record.entity ?? {};
  return redactHardwareIds(
    [...cimArray(entity.HardwareID), ...cimArray(entity.CompatibleID)],
    record.id,
    options,
  );
}

/**
 * Format a 12-hex-digit Bluetooth address as lower-case colon MAC (the Linux
 * and Darwin form) and redact it.
 *
 * @param {string | undefined} token Address token from the device ID.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Redaction options.
 * @returns {string | undefined} Redacted address.
 */
function redactBluetoothAddress(token, options) {
  if (token === undefined || !/^[0-9a-f]{12}$/iu.test(token)) {
    return undefined;
  }
  return redactIdentifier(
    token.toLowerCase().replace(/(..)(?=.)/gu, "$1:"),
    options,
  );
}

/**
 * Normalize a PnP manufacturer, dropping in-box class placeholders.
 *
 * @param {unknown} value Raw manufacturer.
 * @returns {string | undefined} Manufacturer name.
 */
function pnpManufacturer(value) {
  const text = normalizeIdentityString(cimString(value));
  if (text === undefined || CLASS_PLACEHOLDER_MANUFACTURER.test(text)) {
    return undefined;
  }
  return text;
}

/**
 * Parse a `MI_xx` interface number (hex) to its decimal value.
 *
 * @param {string | undefined} token Two-digit hex token.
 * @returns {number | undefined} Interface number.
 */
function parseInterfaceNumber(token) {
  if (token === undefined) {
    return undefined;
  }
  const value = Number.parseInt(token, 16);
  return Number.isNaN(value) ? undefined : value;
}

/**
 * Format folded interface drivers the way Linux does (`0:HidUsb, 1:HidUsb`).
 *
 * @param {Array<{ number: number | undefined, driver: string | undefined }>} interfaces Interfaces.
 * @returns {string | undefined} Summary.
 */
function formatInterfaceDrivers(interfaces) {
  const parts = interfaces
    .filter((entry) => entry.driver !== undefined)
    .map((entry) => `${entry.number ?? "?"}:${entry.driver}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * Default component name per hardware class.
 *
 * @param {string} hardwareClass Hardware class.
 * @returns {string} Name.
 */
function defaultName(hardwareClass) {
  return {
    "usb-controller": "USB Controller",
    "usb-device": "USB Device",
    "pci-device": "PCI Device",
    "bluetooth-controller": "Bluetooth Controller",
    "bluetooth-device": "Bluetooth Device",
  }[hardwareClass] ?? "Device";
}

/**
 * Look up a record by raw instance ID.
 *
 * @param {Map<string, PnpDeviceRecord> | undefined} index Device index.
 * @param {string | undefined} instanceId Raw instance ID.
 * @returns {PnpDeviceRecord | undefined} Record.
 */
function lookup(index, instanceId) {
  const key = cimString(instanceId)?.toLowerCase();
  return index && key !== undefined ? index.get(key) : undefined;
}
