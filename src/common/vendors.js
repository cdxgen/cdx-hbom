/**
 * USB Implementers Forum vendor id lookup.
 *
 * A small bundled table covering vendors commonly seen in a typical hardware
 * tree, so decoded USB and USB-C vendor ids can render a readable name rather
 * than a bare hex number. The table is deliberately compact and dependency
 * free. Unknown ids fall back to a `0x....` hex string, and callers can use
 * {@link isHexFallback} to tell whether a result is a real name or the
 * fallback, so vendor labelling can be suppressed when nothing is known.
 */

// Canonical vendor names keyed by USB-IF vendor id. Keys are lower-case hex
// without a prefix so lookups are case insensitive after normalisation.
const VENDOR_NAMES = new Map([
  [0x05ac, "Apple"],
  [0x0b95, "ASIX Electronics"],
  [0x2109, "VIA Labs"],
  [0x0bda, "Realtek"],
  [0x8087, "Intel"],
  [0x8086, "Intel"],
  [0x04b4, "Cypress"],
  [0x1d6b, "Linux Foundation"],
  [0x1a40, "Terminus Technology"],
  [0x2188, "CalDigit"],
  [0x17ef, "Lenovo"],
  [0x04e8, "Samsung"],
  [0x0409, "NEC"],
  [0x0835, "Action Star Enterprise"],
  [0x291a, "Anker"],
  [0x1bcf, "Sunplus"],
  [0x2d01, "Google"],
  [0x18d1, "Google"],
  [0x046d, "Logitech"],
  [0x1532, "Razer"],
  [0x1b1c, "Corsair"],
  [0x258a, "Hailuck"],
  [0x0951, "Kingston"],
  [0x090c, "Silicon Motion"],
  [0x0781, "SanDisk"],
  [0x0930, "Toshiba"],
  [0x043e, "LG Electronics"],
  [0x413c, "Dell"],
  [0x03f0, "HP"],
  [0x0451, "Texas Instruments"],
  [0x0424, "Microchip"],
  [0x1a86, "QinHeng Electronics"],
  [0x0483, "STMicroelectronics"],
  [0x1050, "Yubico"],
  [0x32ac, "Framework"],
  [0x2b7e, "Belkin"],
  [0x2c7c, "Quectel"],
  [0x0e0f, "VMware"],
  [0x1d50, "OpenMoko"],
  [0x0403, "FTDI"],
  [0x0cf3, "Qualcomm Atheros"],
  [0x8564, "Transcend"],
  [0x152d, "JMicron"],
  [0x174c, "ASMedia"],
  [0x0402, "ALi"],
]);

/**
 * Format a vendor id as a canonical `0x....` hex string.
 *
 * @param {number} vendorId Vendor id.
 * @returns {string} Zero-padded lower-case hex string.
 */
export function formatVendorId(vendorId) {
  return `0x${(vendorId & 0xffff).toString(16).padStart(4, "0")}`;
}

/**
 * Look up a USB-IF vendor id.
 *
 * @param {number | undefined | null} vendorId Vendor id.
 * @returns {string | undefined} Canonical vendor name, a `0x....` hex fallback
 *   when the id is not in the bundled table, or undefined when no id is given.
 */
export function lookupVendor(vendorId) {
  if (vendorId === undefined || vendorId === null) {
    return undefined;
  }
  const normalized = vendorId & 0xffff;
  return VENDOR_NAMES.get(normalized) ?? formatVendorId(normalized);
}

/**
 * Report whether a {@link lookupVendor} result is the hex fallback rather than
 * a recognised vendor name.
 *
 * @param {string | undefined} name Result of {@link lookupVendor}.
 * @returns {boolean} True when the value is a `0x....` fallback.
 */
export function isHexFallback(name) {
  return typeof name === "string" && /^0x[0-9a-f]{4}$/u.test(name);
}
