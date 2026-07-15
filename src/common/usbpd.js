/**
 * USB Power Delivery (PD) and USB-C cable decoding helpers.
 *
 * These functions turn the raw 32-bit Vendor Defined Objects (VDOs) and Power
 * Data Objects (PDOs) exchanged during USB-C negotiation into structured,
 * human-readable capability records. They are intentionally free of any
 * operating-system or filesystem dependency so the same logic can run against
 * data collected on Linux (`/sys/class/typec`), on macOS (IORegistry), or
 * against captured fixtures in the test suite.
 *
 * Bit layouts follow the USB Power Delivery specification (Revision 3.2). Every
 * field is annotated with its bit range so the encoding can be checked against
 * the specification without a decoder ring.
 */

/**
 * @typedef {object} DecodeWarning
 * @property {string} field Field that produced the warning.
 * @property {string} message Human-readable explanation.
 */

/**
 * Extract an unsigned bit field from a 32-bit value.
 *
 * @param {number} value Source 32-bit value.
 * @param {number} start Least-significant bit of the field (inclusive).
 * @param {number} end Most-significant bit of the field (inclusive).
 * @returns {number} Field value.
 */
export function bits(value, start, end) {
  const width = end - start + 1;
  const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
  return ((value >>> start) & mask) >>> 0;
}

/**
 * Coerce a hex string or number into an unsigned 32-bit integer.
 *
 * Accepts values such as `0x1abc`, `"1abc"`, or a plain number. Returns
 * `undefined` when the value cannot be parsed, so callers can skip fields that
 * were not reported rather than emitting misleading zeroes.
 *
 * @param {string | number | undefined | null} value Raw value.
 * @returns {number | undefined} Unsigned 32-bit integer or undefined.
 */
export function toUint32(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value >>> 0 : undefined;
  }

  const text = String(value).trim().toLowerCase();
  const normalized = text.startsWith("0x") ? text.slice(2) : text;
  if (!/^[0-9a-f]+$/u.test(normalized)) {
    return undefined;
  }

  return Number.parseInt(normalized, 16) >>> 0;
}

// USB-C product types advertised in the ID Header VDO (UFP field, bits 27-29).
const UFP_PRODUCT_TYPES = {
  0: undefined,
  1: "pdusb-hub",
  2: "pdusb-peripheral",
  3: "psd",
  5: "alternate-mode-adapter",
  6: "vpd",
};

// Cable-related product types advertised in either the UFP or DFP field.
const CABLE_PRODUCT_TYPES = {
  3: "passive-cable",
  4: "active-cable",
  6: "vpd",
};

/**
 * Decode the ID Header VDO returned by a Discover Identity request.
 *
 * The USB-C specification carries the cable/product type in the UFP field, but
 * some non-compliant cables report it in the DFP field instead. Both are
 * inspected so genuine cables are not missed.
 *
 * @param {number} value 32-bit ID Header VDO.
 * @returns {{
 *   vendorId: number,
 *   ufpProductType: string | undefined,
 *   dfpProductType: string | undefined,
 *   usbCapableAsHost: boolean,
 *   usbCapableAsDevice: boolean,
 *   modalOperationSupported: boolean,
 *   isCable: boolean
 * }} Decoded header.
 */
export function decodeIdHeaderVdo(value) {
  const vendorId = bits(value, 0, 15);
  const ufpRaw = bits(value, 27, 29);
  const dfpRaw = bits(value, 23, 25);

  const ufpProductType = UFP_PRODUCT_TYPES[ufpRaw];
  const ufpCableType = CABLE_PRODUCT_TYPES[ufpRaw];
  const dfpCableType = CABLE_PRODUCT_TYPES[dfpRaw];

  return {
    vendorId,
    ufpProductType: ufpCableType ?? ufpProductType,
    dfpProductType: CABLE_PRODUCT_TYPES[dfpRaw],
    usbCapableAsHost: bits(value, 31, 31) === 1,
    usbCapableAsDevice: bits(value, 30, 30) === 1,
    modalOperationSupported: bits(value, 26, 26) === 1,
    isCable: Boolean(ufpCableType ?? dfpCableType),
  };
}

// Cable maximum speed encoded in the Cable VDO (bits 0-2).
const CABLE_SPEED_GBPS = {
  0: 0.48,
  1: 5,
  2: 10,
  3: 40,
};

// Cable maximum current encoded in the Cable VDO (bits 5-6).
const CABLE_CURRENT_AMPS = {
  1: 3,
  2: 5,
};

// Cable maximum VBUS voltage encoded in the Cable VDO (bits 9-10).
const CABLE_VBUS_VOLTS = {
  0: 20,
  1: 30,
  2: 40,
  3: 50,
};

// The highest voltage USB Power Delivery actually delivers, in volts. The
// 50V field in the Cable VDO is an insulation rating rather than a delivery
// voltage, so watt calculations clamp to this value.
const MAX_DELIVERY_VOLTS = 48;

// The ceiling defined by USB Power Delivery, in watts (48V at 5A).
export const MAX_PD_WATTS = 240;

/**
 * Decode a passive or active Cable VDO.
 *
 * @param {number} value 32-bit Cable VDO.
 * @param {{ isActive?: boolean }} [options={}] Decode options.
 * @returns {{
 *   maxDataRateGbps: number | undefined,
 *   maxCurrentAmps: number | undefined,
 *   maxVbusVoltage: number | undefined,
 *   maxPowerWatts: number | undefined,
 *   cableType: string,
 *   eprCapable: boolean,
 *   vdoVersion: number,
 *   cableLengthMeters: number | undefined,
 *   warnings: DecodeWarning[]
 * }} Decoded cable capabilities.
 */
export function decodeCableVdo(value, options = {}) {
  const warnings = [];

  const speedRaw = bits(value, 0, 2);
  const maxDataRateGbps = CABLE_SPEED_GBPS[speedRaw];
  if (maxDataRateGbps === undefined) {
    warnings.push({
      field: "speed",
      message: `Reserved cable speed encoding ${speedRaw}`,
    });
  }

  const currentRaw = bits(value, 5, 6);
  const maxCurrentAmps = CABLE_CURRENT_AMPS[currentRaw];
  if (maxCurrentAmps === undefined) {
    warnings.push({
      field: "current",
      message: `Reserved cable current encoding ${currentRaw}`,
    });
  }

  const vbusRaw = bits(value, 9, 10);
  const maxVbusVoltage = CABLE_VBUS_VOLTS[vbusRaw];

  let maxPowerWatts;
  if (maxCurrentAmps !== undefined && maxVbusVoltage !== undefined) {
    const deliveryVolts = Math.min(maxVbusVoltage, MAX_DELIVERY_VOLTS);
    maxPowerWatts = Math.min(deliveryVolts * maxCurrentAmps, MAX_PD_WATTS);
  }

  // Cable plug latency (bits 13-16) maps to roughly 10 nanoseconds per metre.
  const latencyRaw = bits(value, 13, 16);
  const cableLengthMeters =
    latencyRaw > 0 ? Number((latencyRaw * 0.1).toFixed(1)) : undefined;

  return {
    maxDataRateGbps,
    maxCurrentAmps,
    maxVbusVoltage,
    maxPowerWatts,
    cableType: options.isActive ? "active" : "passive",
    eprCapable: bits(value, 7, 7) === 1,
    vdoVersion: bits(value, 21, 23),
    cableLengthMeters,
    warnings,
  };
}

/**
 * Decode the second Active Cable VDO, which describes the physical medium and
 * supported protocols of an active cable.
 *
 * The USB4, USB 3.2, and USB 2.0 support flags are stored inverted in the
 * specification (a cleared bit means the protocol is supported), and are
 * un-inverted here so callers see plain booleans.
 *
 * @param {number} value 32-bit Active Cable VDO2.
 * @returns {{
 *   medium: string,
 *   activeElement: string,
 *   usb4Support: boolean,
 *   usb32Support: boolean,
 *   usb2Support: boolean,
 *   maxOperatingTempCelsius: number | undefined
 * }} Decoded active cable details.
 */
export function decodeActiveCableVdo2(value) {
  const optical = bits(value, 21, 21) === 1;
  const retimer = bits(value, 24, 24) === 1;

  const maxTempRaw = bits(value, 24, 31);

  return {
    medium: optical ? "optical" : "copper",
    activeElement: retimer ? "retimer" : "redriver",
    usb4Support: bits(value, 8, 8) === 0,
    usb32Support: bits(value, 4, 4) === 0,
    usb2Support: bits(value, 5, 5) === 0,
    maxOperatingTempCelsius: maxTempRaw > 0 ? maxTempRaw : undefined,
  };
}

// Power Data Object supply types (bits 30-31).
const PDO_SUPPLY_TYPES = {
  0: "fixed",
  1: "battery",
  2: "variable",
  3: "augmented",
};

/**
 * Decode a Source Power Data Object advertised by a charger.
 *
 * Only fixed supplies are decoded to concrete voltage and current values.
 * Battery, variable, and augmented (programmable) supplies are reported with
 * their supply type so callers can present them without misinterpreting the
 * bit layout.
 *
 * @param {number} value 32-bit Source PDO.
 * @returns {{
 *   supplyType: string,
 *   voltage: number | undefined,
 *   maxCurrent: number | undefined,
 *   maxPowerWatts: number | undefined
 * }} Decoded PDO.
 */
export function decodeSourcePdo(value) {
  const supplyType = PDO_SUPPLY_TYPES[bits(value, 30, 31)];

  if (supplyType !== "fixed") {
    return {
      supplyType,
      voltage: undefined,
      maxCurrent: undefined,
      maxPowerWatts: undefined,
    };
  }

  // Fixed supply: voltage in 50mV units (bits 10-19), current in 10mA units
  // (bits 0-9).
  const voltage = bits(value, 10, 19) * 0.05;
  const maxCurrent = bits(value, 0, 9) * 0.01;

  return {
    supplyType,
    voltage: Number(voltage.toFixed(2)),
    maxCurrent: Number(maxCurrent.toFixed(2)),
    maxPowerWatts: Number((voltage * maxCurrent).toFixed(1)),
  };
}

/**
 * Determine the highest fixed-supply wattage a set of Source PDOs can deliver.
 *
 * @param {number[]} pdos List of raw 32-bit Source PDOs.
 * @returns {number | undefined} Maximum wattage, or undefined when unknown.
 */
export function maxSourceWatts(pdos) {
  let max;
  for (const raw of pdos) {
    const decoded = decodeSourcePdo(raw);
    if (
      decoded.maxPowerWatts !== undefined &&
      (max === undefined || decoded.maxPowerWatts > max)
    ) {
      max = decoded.maxPowerWatts;
    }
  }
  return max;
}
