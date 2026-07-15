/**
 * USB-C (Type-C) port, cable, and partner modelling for Linux.
 *
 * The kernel exposes a rich view of each USB-C connector under
 * `/sys/class/typec`, including the negotiated port roles, the identity of any
 * attached cable, the identity of the peer on the far end (charger, dock,
 * display, or device), the power profiles a charger advertises, and the
 * alternate modes both ends support. Related surfaces add to the picture: the
 * charger's full power delivery advertisement under
 * `/sys/class/usb_power_delivery`, and a live charging readout on laptops under
 * `/sys/class/power_supply/ucsi-source-psy-*`.
 *
 * This module turns that raw view into CycloneDX hardware components: a
 * `usb-c-port` for each connector, a `cable` for each electronically marked
 * cable, and a `usb-c-partner` for each identified peer, wired into a
 * dependency graph that reads port to cable to partner and, when the kernel
 * links it, on to the enumerated USB device.
 *
 * The builder is a pure function of its input records so it can be exercised
 * with captured fixtures. The filesystem reader that produces those records is
 * also here but behind injected IO primitives, so it too can run against a
 * captured tree in tests.
 */

import { join } from "node:path";

import {
  cableTrustNotes,
  chargingDiagnostic,
  dataLinkDiagnostic,
} from "../../common/diagnostics.js";
import {
  compact,
  createHardwareComponent,
  createProperty,
} from "../../common/shape.js";
import {
  decodeActiveCableVdo2,
  decodeCableVdo,
  decodeIdHeaderVdo,
  toUint32,
} from "../../common/usbpd.js";
import { isHexFallback, lookupVendor } from "../../common/vendors.js";

// Standard IDs (SVIDs) for the alternate modes worth surfacing by name.
const ALT_MODE_SVIDS = {
  0xff01: "DisplayPort",
  0x8087: "Thunderbolt",
};

/**
 * @typedef {object} TypecAltModeRecord
 * @property {number} svid Standard or vendor ID.
 * @property {number} [mode] Mode index within the SVID.
 * @property {boolean} [active] Whether the mode is currently entered.
 */

/**
 * @typedef {object} TypecIdentityRecord
 * @property {string} [type] Kernel `type` attribute (passive/active for a
 *   cable, or a partner product type).
 * @property {string} [plugType] Physical plug type reported by the kernel.
 * @property {string} [idHeader] Raw ID Header VDO (hex string).
 * @property {string} [certStat] Raw Cert Stat VDO (hex string).
 * @property {string} [productTypeVdo1] Raw product type VDO 1 (hex string).
 * @property {string} [productTypeVdo2] Raw product type VDO 2 (hex string).
 * @property {TypecAltModeRecord[]} [altModes] Alternate modes advertised.
 */

/**
 * @typedef {TypecIdentityRecord & { present?: boolean }} TypecCableRecord
 */

/**
 * @typedef {TypecIdentityRecord & {
 *   present?: boolean,
 *   usbName?: string,
 *   pdName?: string
 * }} TypecPartnerRecord
 */

/**
 * @typedef {object} TypecSourceCapability
 * @property {string} [type] Supply type, such as `fixed_supply` or `pps`.
 * @property {number} [index] PDO index reported by the kernel.
 * @property {number} [voltageMillivolt] Voltage in millivolts (fixed supplies)
 *   or the low end of the range (programmable and variable supplies).
 * @property {number} [maxVoltageMillivolt] Maximum voltage in millivolts.
 * @property {number} [maxCurrentMilliamp] Maximum current in milliamps.
 */

/**
 * @typedef {object} TypecLiveSupply
 * @property {boolean} [online] Whether the supply reports itself online.
 * @property {number} [voltageMicrovolt] Present voltage in microvolts.
 * @property {number} [currentMicroamp] Present current in microamps.
 * @property {number} [currentMaxMicroamp] Maximum current in microamps.
 */

/**
 * @typedef {object} TypecPortRecord
 * @property {string} name Connector name, such as `port0`.
 * @property {number} [number] Numeric connector index.
 * @property {string} [powerRole] Raw `power_role` sysfs value.
 * @property {string} [dataRole] Raw `data_role` sysfs value.
 * @property {string} [portType] Raw `port_type` sysfs value.
 * @property {string} [pdRevision] USB Power Delivery revision.
 * @property {string} [typecRevision] USB Type-C revision.
 * @property {string} [orientation] Plug orientation.
 * @property {string} [powerOperationMode] Negotiated power operation mode.
 * @property {boolean} [connected] Whether something is attached.
 * @property {TypecCableRecord} [cable] Attached cable record.
 * @property {TypecPartnerRecord} [partner] Attached partner record.
 * @property {TypecSourceCapability[]} [sourceCapabilities] Advertised supplies.
 * @property {TypecLiveSupply} [liveSupply] Live charging readout.
 */

/**
 * @typedef {object} TypecReaderIo
 * @property {string} base Root of the Type-C class, usually `/sys/class/typec`.
 * @property {string} [powerSupplyBase] Root of the power supply class, usually
 *   `/sys/class/power_supply`, used for the UCSI live charging readout.
 * @property {(path: string) => boolean} exists Report whether a path exists.
 * @property {(path: string) => string[]} readDir List directory entries.
 * @property {(path: string) => string | undefined} readText Read a trimmed file.
 * @property {(value: string | undefined) => number | undefined} toNumber Parse a leading integer.
 * @property {(path: string) => string | undefined} [readLink] Read a symlink target.
 */

/**
 * Read USB-C connectors, cables, partners, and advertised charger supplies from
 * sysfs.
 *
 * The filesystem primitives are injected so the reader can run against the live
 * tree in production and against a captured tree in tests. Kernel attribute
 * names follow the USB Type-C connector class ABI.
 *
 * @param {TypecReaderIo} io Filesystem access primitives.
 * @returns {TypecPortRecord[]} Port records.
 */
export function readTypecPorts(io) {
  return io
    .readDir(io.base)
    .filter((name) => /^port\d+$/u.test(name))
    .map((name) => {
      const portPath = join(io.base, name);
      const cablePath = join(io.base, `${name}-cable`);
      const partnerPath = join(io.base, `${name}-partner`);
      const number = Number.parseInt(name.replace(/^port/u, ""), 10);

      return {
        name,
        number: Number.isNaN(number) ? undefined : number,
        powerRole: io.readText(join(portPath, "power_role")),
        dataRole: io.readText(join(portPath, "data_role")),
        portType: io.readText(join(portPath, "port_type")),
        pdRevision: io.readText(join(portPath, "usb_power_delivery_revision")),
        typecRevision: io.readText(join(portPath, "usb_typec_revision")),
        orientation: io.readText(join(portPath, "orientation")),
        powerOperationMode: io.readText(join(portPath, "power_operation_mode")),
        connected: io.exists(partnerPath) || io.exists(cablePath),
        cable: readTypecCable(name, cablePath, io),
        partner: readTypecPartner(name, partnerPath, io),
        sourceCapabilities: readTypecSourceCapabilities(partnerPath, io),
        liveSupply: readUcsiLiveSupply(name, portPath, number, io),
      };
    });
}

/**
 * Read an attached cable's identity from its sysfs directory.
 *
 * @param {string} portName Connector name, such as `port0`.
 * @param {string} cablePath Path to the `portN-cable` directory.
 * @param {TypecReaderIo} io Filesystem access primitives.
 * @returns {TypecCableRecord} Cable record.
 */
function readTypecCable(portName, cablePath, io) {
  if (!io.exists(cablePath)) {
    return { present: false };
  }

  const identityPath = join(cablePath, "identity");
  return {
    present: true,
    plugType: io.readText(join(cablePath, "plug_type")),
    type: io.readText(join(cablePath, "type")),
    idHeader: io.readText(join(identityPath, "id_header")),
    certStat: io.readText(join(identityPath, "cert_stat")),
    productTypeVdo1: io.readText(join(identityPath, "product_type_vdo1")),
    productTypeVdo2: io.readText(join(identityPath, "product_type_vdo2")),
    altModes: readAltModes(io.base, `${portName}-cable`, io),
  };
}

/**
 * Read the peer on the far end of the cable from its sysfs directory.
 *
 * Beyond the identity VDOs, the kernel links a partner to its enumerated USB
 * device (a bus-port child directory such as `2-2`) and to its power delivery
 * node (via the `usb_power_delivery` symlink resolving to `pdN`). Both linkages
 * let the partner be tied into the wider hardware topology.
 *
 * @param {string} portName Connector name, such as `port0`.
 * @param {string} partnerPath Path to the `portN-partner` directory.
 * @param {TypecReaderIo} io Filesystem access primitives.
 * @returns {TypecPartnerRecord} Partner record.
 */
function readTypecPartner(portName, partnerPath, io) {
  if (!io.exists(partnerPath)) {
    return { present: false };
  }

  const identityPath = join(partnerPath, "identity");
  return {
    present: true,
    type: io.readText(join(partnerPath, "type")),
    idHeader: io.readText(join(identityPath, "id_header")),
    certStat: io.readText(join(identityPath, "cert_stat")),
    productTypeVdo1: io.readText(join(identityPath, "product_type_vdo1")),
    usbName: findBusPortChild(partnerPath, io),
    pdName: readPdName(partnerPath, io),
    altModes: readAltModes(io.base, `${portName}-partner`, io),
  };
}

/**
 * Find the enumerated USB device linked to a partner.
 *
 * The kernel places the partner's USB device as a child directory named like a
 * bus-port (`<bus>-<port>` with optional `.<n>` hub-chain groups). The first
 * match in sorted order is returned.
 *
 * @param {string} partnerPath Path to the `portN-partner` directory.
 * @param {TypecReaderIo} io Filesystem access primitives.
 * @returns {string | undefined} Bus-port name, or undefined when none is linked.
 */
function findBusPortChild(partnerPath, io) {
  return io
    .readDir(partnerPath)
    .filter((name) => isBusPortName(name))
    .sort()[0];
}

/**
 * Report whether a name matches the kernel bus-port pattern such as `2-2` or
 * `2-2.1.4`.
 *
 * @param {string} name Directory name.
 * @returns {boolean} True when the name is a bus-port.
 */
export function isBusPortName(name) {
  return /^\d+-\d+(\.\d+)*$/u.test(name);
}

/**
 * Resolve the power delivery node name linked to a partner.
 *
 * Real kernels link the partner to its `pdN` node with a `usb_power_delivery`
 * symlink. When the symlink is unavailable, the `pdN` directory is a child of
 * the partner, so the first `pd<digits>` child is used as a fallback.
 *
 * @param {string} partnerPath Path to the `portN-partner` directory.
 * @param {TypecReaderIo} io Filesystem access primitives.
 * @returns {string | undefined} Power delivery node name, or undefined.
 */
function readPdName(partnerPath, io) {
  const linkTarget = io.readLink?.(join(partnerPath, "usb_power_delivery"));
  if (linkTarget) {
    return basename(linkTarget);
  }
  return io
    .readDir(partnerPath)
    .filter((name) => /^pd\d+$/u.test(name))
    .sort()[0];
}

/**
 * Read alternate mode siblings for a partner or cable.
 *
 * The kernel exposes alternate modes as siblings named `<prefix>.<index>`
 * (for example `port0-partner.0`), each carrying an `svid`, a `mode` index,
 * and an `active` flag.
 *
 * @param {string} base Root of the Type-C class.
 * @param {string} prefix Owner directory name, such as `port0-partner`.
 * @param {TypecReaderIo} io Filesystem access primitives.
 * @returns {TypecAltModeRecord[]} Alternate mode records.
 */
function readAltModes(base, prefix, io) {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\.\\d+$`, "u");
  return io
    .readDir(base)
    .filter((name) => pattern.test(name))
    .map((name) => {
      const modePath = join(base, name);
      const svid = toUint32(io.readText(join(modePath, "svid")));
      const active = io.readText(join(modePath, "active"));
      return {
        svid,
        mode: io.toNumber(io.readText(join(modePath, "mode"))),
        active: active === "yes" || active === "1",
      };
    })
    .filter((altMode) => altMode.svid !== undefined);
}

/**
 * Read the advertised source power supplies of a connected charger.
 *
 * The kernel exposes each supply as a numbered directory such as
 * `1:fixed_supply` or `5:programmable_supply`. Fixed supplies carry a single
 * `voltage`; programmable and variable supplies expose a `minimum_voltage` and
 * `maximum_voltage` range instead. The supply type is taken from the directory
 * name, which is the only place real kernels record it. The
 * `source-capabilities` directory has used both a hyphen and an underscore
 * across kernel versions, so both spellings are accepted.
 *
 * @param {string} partnerPath Path to the `portN-partner` directory.
 * @param {TypecReaderIo} io Filesystem access primitives.
 * @returns {TypecSourceCapability[]} Advertised supplies.
 */
function readTypecSourceCapabilities(partnerPath, io) {
  const pdPath = join(partnerPath, "usb_power_delivery");
  const capabilitiesPath = [
    join(pdPath, "source-capabilities"),
    join(pdPath, "source_capabilities"),
  ].find((candidate) => io.exists(candidate));
  if (!capabilitiesPath) {
    return [];
  }

  return io
    .readDir(capabilitiesPath)
    // Keep only PDO entries, which are named `<index>:<type>`. The kernel also
    // places a runtime power-management `power` directory here that must not
    // become a junk supply.
    .filter((name) => /^\d+:/u.test(name))
    .sort()
    .map((name) => {
      const supplyPath = join(capabilitiesPath, name);
      const [indexPart, typePart = ""] = name.split(":");
      return {
        type: typePart || undefined,
        index: io.toNumber(indexPart),
        voltageMillivolt:
          io.toNumber(io.readText(join(supplyPath, "voltage"))) ??
          io.toNumber(io.readText(join(supplyPath, "minimum_voltage"))),
        maxVoltageMillivolt: io.toNumber(
          io.readText(join(supplyPath, "maximum_voltage")),
        ),
        maxCurrentMilliamp: io.toNumber(
          io.readText(join(supplyPath, "maximum_current")),
        ),
      };
    });
}

/**
 * Read the live charging readout for a port from its UCSI power supply.
 *
 * On laptops the kernel publishes an `ucsi-source-psy-<controller><n>` power
 * supply whose present voltage and current describe the operating point of the
 * active power contract. The controller id is taken from the port's resolved
 * device path. This is a requested operating point, never a measured flow.
 *
 * @param {string} portName Connector name, such as `port0`.
 * @param {string} portPath Path to the connector directory.
 * @param {number} portNumber Numeric connector index.
 * @param {TypecReaderIo} io Filesystem access primitives.
 * @returns {TypecLiveSupply | undefined} Live readout, or undefined when none.
 */
function readUcsiLiveSupply(portName, portPath, portNumber, io) {
  if (!io.powerSupplyBase || Number.isNaN(portNumber)) {
    return undefined;
  }

  const linkTarget = io.readLink?.(portPath) ?? portPath;
  const controller = ucsiController(linkTarget);
  if (!controller) {
    return undefined;
  }

  // UCSI numbers its source supplies from one, so port0 maps to supply one.
  const supplyName = `ucsi-source-psy-${controller}${portNumber + 1}`;
  const supplyPath = join(io.powerSupplyBase, supplyName);
  if (!io.exists(supplyPath)) {
    return undefined;
  }

  return {
    online: io.toNumber(io.readText(join(supplyPath, "online"))) === 1,
    voltageMicrovolt: io.toNumber(io.readText(join(supplyPath, "voltage_now"))),
    currentMicroamp: io.toNumber(io.readText(join(supplyPath, "current_now"))),
    currentMaxMicroamp: io.toNumber(
      io.readText(join(supplyPath, "current_max")),
    ),
  };
}

/**
 * Extract a UCSI controller id such as `USBC000:00` from a device path.
 *
 * @param {string} path Device path, typically a resolved symlink target.
 * @returns {string | undefined} Controller id, or undefined when absent.
 */
export function ucsiController(path) {
  return /USBC[0-9a-fA-F]+:[0-9a-fA-F]+/u.exec(path ?? "")?.[0];
}

/**
 * Parse a sysfs role field of the form `"[sink] source"`.
 *
 * The kernel wraps the currently selected role in square brackets and lists the
 * remaining supported roles alongside it. A plain value without brackets is
 * reported as both the current and only supported role.
 *
 * @param {string | undefined} value Raw role field.
 * @returns {{ current: string | undefined, supported: string[] }} Parsed roles.
 */
export function parseTypecRole(value) {
  if (!value) {
    return { current: undefined, supported: [] };
  }

  const supported = [];
  let current;
  for (const token of value.trim().split(/\s+/u)) {
    const bracketed = /^\[(.+)\]$/u.exec(token);
    if (bracketed) {
      current = bracketed[1];
      supported.push(bracketed[1]);
    } else if (token) {
      supported.push(token);
    }
  }

  // A field with a single unbracketed value reports a fixed role.
  if (current === undefined && supported.length === 1) {
    [current] = supported;
  }

  return { current, supported };
}

/**
 * Classify a port as a source, sink, or dual-role connector.
 *
 * @param {string[]} supportedRoles Supported power roles.
 * @returns {string | undefined} Connector role.
 */
function classifyPortRole(supportedRoles) {
  const hasSource = supportedRoles.includes("source");
  const hasSink = supportedRoles.includes("sink");
  if (hasSource && hasSink) {
    return "dual";
  }
  if (hasSource) {
    return "source";
  }
  if (hasSink) {
    return "sink";
  }
  return undefined;
}

/**
 * Summarise the alternate modes advertised by an end of the link.
 *
 * @param {TypecAltModeRecord[]} [altModes] Alternate mode records.
 * @returns {{
 *   names: string[],
 *   hasThunderbolt: boolean,
 *   hasDisplayPort: boolean
 * }} Alternate mode summary.
 */
function summarizeAltModes(altModes) {
  const names = [];
  let hasThunderbolt = false;
  let hasDisplayPort = false;
  for (const altMode of altModes ?? []) {
    const name = ALT_MODE_SVIDS[altMode.svid];
    if (name === "Thunderbolt") {
      hasThunderbolt = true;
    }
    if (name === "DisplayPort") {
      hasDisplayPort = true;
    }
    names.push(name ?? `SVID 0x${altMode.svid.toString(16).padStart(4, "0")}`);
  }
  return { names, hasThunderbolt, hasDisplayPort };
}

/**
 * Decode a cable record into its capabilities.
 *
 * @param {TypecCableRecord} cable Cable record.
 * @returns {object} Decoded cable capabilities.
 */
function decodeCable(cable) {
  const idHeader = toUint32(cable.idHeader);
  const cableVdo = toUint32(cable.productTypeVdo1);
  const header = idHeader !== undefined ? decodeIdHeaderVdo(idHeader) : undefined;

  // The kernel reports the cable type directly; fall back to the identity VDO
  // when that attribute is absent.
  const isActive =
    cable.type === "active" ||
    header?.ufpProductType === "active-cable" ||
    header?.dfpProductType === "active-cable";

  const decoded =
    cableVdo !== undefined ? decodeCableVdo(cableVdo, { isActive }) : undefined;

  let active;
  if (isActive) {
    const vdo2 = toUint32(cable.productTypeVdo2);
    if (vdo2 !== undefined) {
      active = decodeActiveCableVdo2(vdo2);
    }
  }

  const altModes = summarizeAltModes(cable.altModes);

  return {
    emarked: idHeader !== undefined || cableVdo !== undefined,
    vendorId: header?.vendorId,
    cableType: cable.type ?? decoded?.cableType,
    maxDataRateGbps: decoded?.maxDataRateGbps,
    maxCurrentAmps: decoded?.maxCurrentAmps,
    maxPowerWatts: decoded?.maxPowerWatts,
    maxVbusVoltage: decoded?.maxVbusVoltage,
    eprCapable: decoded?.eprCapable,
    cableLengthMeters: decoded?.cableLengthMeters,
    medium: active?.medium,
    activeElement: active?.activeElement,
    usb4Support: active?.usb4Support,
    altModes,
    warnings: (decoded?.warnings ?? []).map((warning) => warning.message),
  };
}

/**
 * Summarise a set of advertised source capabilities.
 *
 * @param {TypecSourceCapability[]} capabilities Advertised supplies.
 * @returns {{
 *   chargerWatts: number | undefined,
 *   profiles: Array<{
 *     type: string | undefined,
 *     voltageMillivolt: number | undefined,
 *     maxVoltageMillivolt: number | undefined,
 *     maxCurrentMilliamp: number | undefined,
 *     watts: number | undefined
 *   }>
 * }} Summary with the peak fixed-supply wattage and a per-profile breakdown.
 */
export function summarizeSourceCapabilities(capabilities) {
  let chargerWatts;
  const profiles = (capabilities ?? []).map((capability) => {
    const watts = pdoWatts(capability);
    if (
      watts !== undefined &&
      isFixedSupply(capability.type) &&
      (chargerWatts === undefined || watts > chargerWatts)
    ) {
      chargerWatts = watts;
    }
    return {
      type: capability.type,
      voltageMillivolt: capability.voltageMillivolt,
      maxVoltageMillivolt: capability.maxVoltageMillivolt,
      maxCurrentMilliamp: capability.maxCurrentMilliamp,
      watts,
    };
  });
  return {
    chargerWatts: chargerWatts === undefined ? undefined : round1(chargerWatts),
    profiles,
  };
}

/**
 * Select the active source PDO by matching a live voltage readout.
 *
 * The kernel does not flag which PDO is in force, so the fixed supply whose
 * voltage is closest to the present voltage is treated as the active contract.
 *
 * @param {TypecSourceCapability[]} capabilities Advertised supplies.
 * @param {number | undefined} voltageMicrovolt Present voltage in microvolts.
 * @returns {TypecSourceCapability | undefined} Active supply, or undefined.
 */
export function selectActivePdo(capabilities, voltageMicrovolt) {
  if (voltageMicrovolt === undefined) {
    return undefined;
  }
  const targetMillivolt = voltageMicrovolt / 1000;
  let best;
  let bestDelta = Infinity;
  for (const capability of capabilities ?? []) {
    if (!isFixedSupply(capability.type) || capability.voltageMillivolt === undefined) {
      continue;
    }
    const delta = Math.abs(capability.voltageMillivolt - targetMillivolt);
    if (delta < bestDelta) {
      best = capability;
      bestDelta = delta;
    }
  }
  // Only accept a match within one volt, so a stray reading does not pin an
  // unrelated profile.
  return bestDelta <= 1000 ? best : undefined;
}

/**
 * Compute the wattage of a source capability.
 *
 * @param {TypecSourceCapability} capability Advertised supply.
 * @returns {number | undefined} Wattage, or undefined when it cannot be derived.
 */
function pdoWatts(capability) {
  const voltage = capability.maxVoltageMillivolt ?? capability.voltageMillivolt;
  if (voltage === undefined || capability.maxCurrentMilliamp === undefined) {
    return undefined;
  }
  return (voltage / 1000) * (capability.maxCurrentMilliamp / 1000);
}

/**
 * Report whether a supply type is a fixed supply.
 *
 * @param {string | undefined} type Supply type.
 * @returns {boolean} True for a fixed supply.
 */
function isFixedSupply(type) {
  return type === "fixed_supply" || type === "fixed";
}

/**
 * Describe a partner's product type in plain language.
 *
 * @param {object | undefined} header Decoded ID header.
 * @param {TypecPartnerRecord} partner Partner record.
 * @returns {{ label: string, hardwareClass: string }} Description.
 */
function describePartner(header, partner) {
  const productType = header?.ufpProductType ?? partner.type;
  switch (productType) {
    case "pdusb-hub":
      return { label: "USB-C hub", hardwareClass: "usb-c-hub" };
    case "pdusb-peripheral":
      return { label: "USB-C peripheral", hardwareClass: "usb-c-peripheral" };
    case "psd":
      return { label: "USB-C charger", hardwareClass: "usb-c-charger" };
    case "alternate-mode-adapter":
      return { label: "USB-C adapter", hardwareClass: "usb-c-adapter" };
    default:
      return { label: "USB-C partner", hardwareClass: "usb-c-partner" };
  }
}

/**
 * Build USB-C port, cable, and partner components with a topology graph.
 *
 * @param {TypecPortRecord[]} ports Port records.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Options.
 * @returns {{
 *   components: object[],
 *   dependencies: Array<{ ref: string, dependsOn: string[] }>
 * }} Components and dependency edges.
 */
export function createTypecComponents(ports, options = {}) {
  const components = [];
  const dependencies = [];

  for (const port of ports ?? []) {
    if (!port?.name) {
      continue;
    }

    const portRef = `typec-port-${port.name}`;
    const powerRole = parseTypecRole(port.powerRole);
    const dataRole = parseTypecRole(port.dataRole);
    const connected = port.connected ?? Boolean(port.cable?.present);

    const { chargerWatts, profiles } = summarizeSourceCapabilities(
      port.sourceCapabilities ?? [],
    );

    const cableInfo = port.cable?.present ? decodeCable(port.cable) : undefined;

    const activePdo = selectActivePdo(
      port.sourceCapabilities ?? [],
      port.liveSupply?.voltageMicrovolt,
    );
    const requested = computeRequestedPower(port.liveSupply);

    const charging = chargingDiagnostic({
      chargerMaxWatts: chargerWatts,
      cableMaxWatts: cableInfo?.maxPowerWatts,
      activeWatts:
        activePdo !== undefined ? round1(pdoWatts(activePdo) ?? 0) : undefined,
      activeCurrentMilliamp: activePdo?.maxCurrentMilliamp,
      requestedWatts: requested?.watts,
      requestedMilliamp: requested?.milliamp,
      cableCurrentRatingVisible: cableInfo?.maxCurrentAmps !== undefined,
      connectionActive: connected,
    });

    const showCharging = connected || chargerWatts !== undefined;
    const portProperties = compact([
      createProperty("cdx:hbom:portRole", classifyPortRole(powerRole.supported)),
      createProperty("cdx:hbom:powerRole", powerRole.current),
      createProperty("cdx:hbom:dataRole", dataRole.current),
      createProperty("cdx:hbom:portType", port.portType),
      createProperty("cdx:hbom:pdRevision", port.pdRevision),
      createProperty("cdx:hbom:typecRevision", port.typecRevision),
      createProperty("cdx:hbom:plugOrientation", port.orientation),
      createProperty("cdx:hbom:powerOperationMode", port.powerOperationMode),
      createProperty("cdx:hbom:connected", connected),
      createProperty("cdx:hbom:chargerMaxWatts", chargerWatts),
      createProperty("cdx:hbom:powerProfileCount", profiles.length || undefined),
      createProperty("cdx:hbom:powerProfiles", formatProfiles(profiles)),
      createProperty(
        "cdx:hbom:negotiatedWatts",
        requested?.watts !== undefined ? round1(requested.watts) : undefined,
      ),
      createProperty(
        "cdx:hbom:chargingBottleneck",
        showCharging ? charging.bottleneck : undefined,
      ),
      createProperty(
        "cdx:hbom:chargingVerdict",
        showCharging ? charging.verdict : undefined,
      ),
      charging.isWarning
        ? createProperty("cdx:hbom:chargingWarning", true)
        : undefined,
    ]);

    components.push(
      createHardwareComponent("usb-c-port", {
        "bom-ref": portRef,
        name: `USB-C Port ${port.name.replace(/^port/u, "")}`.trim(),
        description: "USB-C connector",
        properties: portProperties,
      }),
    );

    let cableRef;
    if (cableInfo) {
      cableRef = `typec-cable-${port.name}`;
      components.push(
        buildCableComponent(cableRef, port, cableInfo, options),
      );
      dependencies.push({ ref: portRef, dependsOn: [cableRef] });
    }

    const partnerRef = buildPartner(components, port, options);
    if (partnerRef) {
      // Chain the partner behind the cable when a cable is present, otherwise
      // hang it directly off the port.
      dependencies.push({
        ref: cableRef ?? portRef,
        dependsOn: [partnerRef],
      });
      const usbRef = usbDeviceRef(port.partner?.usbName);
      if (usbRef) {
        dependencies.push({ ref: partnerRef, dependsOn: [usbRef] });
      }
    }
  }

  return { components, dependencies };
}

/**
 * Build the cable component for a port.
 *
 * @param {string} cableRef Cable bom-ref.
 * @param {TypecPortRecord} port Port record.
 * @param {object} cableInfo Decoded cable capabilities.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Options.
 * @returns {object} Cable component.
 */
function buildCableComponent(cableRef, port, cableInfo, options) {
  // A Type-C cable presents through a Type-C plug, so the class is refined by
  // the alternate modes the cable actually advertises rather than guessed from
  // the plug type. Thunderbolt takes precedence over DisplayPort.
  let cableClass = "usb-c";
  if (cableInfo.altModes.hasThunderbolt) {
    cableClass = "thunderbolt";
  } else if (cableInfo.altModes.hasDisplayPort) {
    cableClass = "usb-c-displayport";
  }

  const dataLink = dataLinkDiagnostic({ cableGbps: cableInfo.maxDataRateGbps });

  const trustNotes = cableTrustNotes({
    vendorId: cableInfo.vendorId,
    eprCapable: cableInfo.eprCapable,
    maxVbusVoltage: cableInfo.maxVbusVoltage,
    decodeWarnings: cableInfo.warnings,
  });

  const vendorName = lookupVendor(cableInfo.vendorId);

  const cableProperties = compact([
    createProperty("cdx:hbom:cableClass", cableClass),
    createProperty("cdx:hbom:emarked", cableInfo.emarked),
    createProperty("cdx:hbom:cableType", cableInfo.cableType),
    createProperty("cdx:hbom:plugType", port.cable?.plugType),
    createProperty("cdx:hbom:maxDataRateGbps", cableInfo.maxDataRateGbps),
    createProperty("cdx:hbom:maxCurrentAmps", cableInfo.maxCurrentAmps),
    createProperty("cdx:hbom:maxPowerWatts", cableInfo.maxPowerWatts),
    createProperty("cdx:hbom:maxVbusVoltage", cableInfo.maxVbusVoltage),
    createProperty("cdx:hbom:eprCapable", cableInfo.eprCapable),
    createProperty("cdx:hbom:cableLengthMeters", cableInfo.cableLengthMeters),
    createProperty("cdx:hbom:cableMedium", cableInfo.medium),
    createProperty("cdx:hbom:activeElement", cableInfo.activeElement),
    createProperty("cdx:hbom:usb4Support", cableInfo.usb4Support),
    cableInfo.altModes.names.length
      ? createProperty(
          "cdx:hbom:alternateModes",
          cableInfo.altModes.names.join(", "),
        )
      : undefined,
    vendorName && !isHexFallback(vendorName)
      ? createProperty("cdx:hbom:vendorName", vendorName)
      : undefined,
    createProperty(
      "cdx:hbom:dataRateVerdict",
      cableInfo.maxDataRateGbps !== undefined ? dataLink.verdict : undefined,
    ),
    options.includeSensitiveIdentifiers && cableInfo.vendorId !== undefined
      ? createProperty(
          "cdx:hbom:vendorId",
          `0x${cableInfo.vendorId.toString(16).padStart(4, "0")}`,
        )
      : undefined,
    trustNotes.length
      ? createProperty("cdx:hbom:trustNotes", trustNotes.join("; "))
      : undefined,
  ]);

  const cableName =
    cableInfo.maxDataRateGbps !== undefined
      ? `USB-C cable (${cableInfo.maxDataRateGbps} Gbps)`
      : "USB-C cable";

  return createHardwareComponent("cable", {
    "bom-ref": cableRef,
    name: cableName,
    description: "Electronically marked USB-C cable",
    properties: cableProperties,
  });
}

/**
 * Build the partner component for a port and append it to the component list.
 *
 * @param {object[]} components Component list to append to.
 * @param {TypecPortRecord} port Port record.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Options.
 * @returns {string | undefined} Partner bom-ref, or undefined when no partner.
 */
function buildPartner(components, port, options) {
  const partner = port.partner;
  if (!partner?.present) {
    return undefined;
  }

  const idHeader = toUint32(partner.idHeader);
  const header = idHeader !== undefined ? decodeIdHeaderVdo(idHeader) : undefined;
  const usbName = partner.usbName;

  // Skip a partner that carries neither identity nor any linkage worth
  // recording, so an empty node does not clutter the graph.
  if (!header && !usbName && !partner.pdName && !(partner.altModes?.length)) {
    return undefined;
  }

  const { label, hardwareClass } = describePartner(header, partner);
  const altModes = summarizeAltModes(partner.altModes);
  const vendorName = lookupVendor(header?.vendorId);
  const partnerRef = `typec-partner-${port.name}`;

  const properties = compact([
    createProperty("cdx:hbom:partnerType", header?.ufpProductType ?? partner.type),
    createProperty(
      "cdx:hbom:usbCapableAsHost",
      header ? header.usbCapableAsHost : undefined,
    ),
    createProperty(
      "cdx:hbom:usbCapableAsDevice",
      header ? header.usbCapableAsDevice : undefined,
    ),
    createProperty("cdx:hbom:linkedUsbDevice", usbName),
    createProperty("cdx:hbom:powerDeliveryNode", partner.pdName),
    altModes.names.length
      ? createProperty("cdx:hbom:alternateModes", altModes.names.join(", "))
      : undefined,
    altModes.hasThunderbolt
      ? createProperty("cdx:hbom:thunderboltCapable", true)
      : undefined,
    altModes.hasDisplayPort
      ? createProperty("cdx:hbom:displayPortCapable", true)
      : undefined,
    vendorName && !isHexFallback(vendorName)
      ? createProperty("cdx:hbom:vendorName", vendorName)
      : undefined,
    options.includeSensitiveIdentifiers && header?.vendorId !== undefined
      ? createProperty(
          "cdx:hbom:vendorId",
          `0x${header.vendorId.toString(16).padStart(4, "0")}`,
        )
      : undefined,
  ]);

  components.push(
    createHardwareComponent(hardwareClass, {
      "bom-ref": partnerRef,
      name: label,
      description: "Peer connected to a USB-C port",
      properties,
    }),
  );

  return partnerRef;
}

/**
 * Derive the enumerated USB device bom-ref for a bus-port name.
 *
 * Mirrors the reference the USB collector assigns so a partner can link to it.
 *
 * @param {string | undefined} usbName Bus-port name, such as `2-2`.
 * @returns {string | undefined} USB device bom-ref, or undefined.
 */
function usbDeviceRef(usbName) {
  return usbName ? `usb-device-${usbName}` : undefined;
}

/**
 * Compute the requested operating power from a live UCSI readout.
 *
 * @param {TypecLiveSupply | undefined} liveSupply Live readout.
 * @returns {{ watts: number, milliamp: number } | undefined} Requested power.
 */
function computeRequestedPower(liveSupply) {
  if (
    !liveSupply ||
    liveSupply.voltageMicrovolt === undefined ||
    liveSupply.currentMicroamp === undefined
  ) {
    return undefined;
  }
  const volts = liveSupply.voltageMicrovolt / 1_000_000;
  const amps = liveSupply.currentMicroamp / 1_000_000;
  return { watts: volts * amps, milliamp: liveSupply.currentMicroamp / 1000 };
}

/**
 * Render the advertised power profiles as a compact string.
 *
 * @param {Array<object>} profiles Profile breakdown.
 * @returns {string | undefined} Rendered profiles.
 */
function formatProfiles(profiles) {
  const parts = profiles
    .filter((profile) => profile.watts !== undefined)
    .map((profile) => {
      const volts = (profile.maxVoltageMillivolt ?? profile.voltageMillivolt) / 1000;
      const amps = (profile.maxCurrentMilliamp ?? 0) / 1000;
      return `${round1(volts)}V/${round1(amps)}A`;
    });
  return parts.length ? parts.join(", ") : undefined;
}

/**
 * Round to one decimal place.
 *
 * @param {number} value Value.
 * @returns {number} Rounded value.
 */
function round1(value) {
  return Number(value.toFixed(1));
}

/**
 * Return the last path segment of a string.
 *
 * @param {string} value Path-like string.
 * @returns {string} Final segment.
 */
function basename(value) {
  const parts = value.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

/**
 * Escape a string for use inside a regular expression.
 *
 * @param {string} value Literal string.
 * @returns {string} Escaped string.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
