// SMBIOS reference tables shared by the Linux and Windows collectors.
// Source: DMTF System Management BIOS (SMBIOS) Reference Specification,
// DSP0134 3.10.0 (2026-07-30):
// https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_3.10.0.pdf

/**
 * System Enclosure or Chassis type codes (decimal) to collector names, from
 * SMBIOS §7.4.1 Table 17. Codes beyond the SMBIOS 2.x range the live WMI
 * schema still reports were added by later SMBIOS revisions (30/1Eh Tablet up
 * to 36/24h Stick PC). Unmapped codes are surfaced raw by the collectors.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const SMBIOS_CHASSIS_TYPES = Object.freeze({
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
});

/**
 * Memory Device — Type codes (decimal), SMBIOS §7.18.2 Table 77 (DSP0134
 * 3.10.0, up to 38/26h LPDDR6). `Win32_PhysicalMemory.SMBIOSMemoryType`
 * carries this raw SMBIOS value, unlike the CIM-mapped `MemoryType`.
 * 21h-23h (33-35) are Reserved.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const SMBIOS_MEMORY_TYPES = Object.freeze({
  1: "Other",
  2: "Unknown",
  3: "DRAM",
  4: "EDRAM",
  5: "VRAM",
  6: "SRAM",
  7: "RAM",
  8: "ROM",
  9: "FLASH",
  10: "EEPROM",
  11: "FEPROM",
  12: "EPROM",
  13: "CDRAM",
  14: "3DRAM",
  15: "SDRAM",
  16: "SGRAM",
  17: "RDRAM",
  18: "DDR",
  19: "DDR2",
  20: "DDR2 FB-DIMM",
  24: "DDR3",
  25: "FBD2",
  26: "DDR4",
  27: "LPDDR",
  28: "LPDDR2",
  29: "LPDDR3",
  30: "LPDDR4",
  31: "Logical non-volatile device",
  32: "HBM",
  33: "HBM2",
  34: "DDR5",
  35: "LPDDR5",
  36: "HBM3",
  37: "MRDIMM",
  38: "LPDDR6",
});

/**
 * Memory Device — Form Factor codes (decimal), SMBIOS §7.18.1 Table 76
 * (DSP0134 3.10.0, up to 19/13h CSODIMM). Note this SMBIOS table differs from
 * the CIM `Win32_PhysicalMemory.FormFactor` mapping; use
 * `WINDOWS_MEMORY_FORM_FACTORS` for that property.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const SMBIOS_MEMORY_FORM_FACTORS = Object.freeze({
  1: "Other",
  2: "Unknown",
  3: "SIMM",
  4: "SIP",
  5: "Chip",
  6: "DIP",
  7: "ZIP",
  8: "Proprietary Card",
  9: "DIMM",
  10: "TSOP",
  11: "Row of chips",
  12: "RIMM",
  13: "SODIMM",
  14: "SRIMM",
  15: "FB-DIMM",
  16: "Die",
  17: "CAMM",
  18: "CUDIMM",
  19: "CSODIMM",
});

/**
 * Look up an SMBIOS code, passing unknown codes through raw.
 *
 * Collectors never guess a name: a code that this cdx-hbom version does not
 * know is emitted as its decimal string so consumers can interpret it.
 *
 * @param {Readonly<Record<number, string>>} table SMBIOS code table.
 * @param {number | string | null | undefined} code Code observed on a host.
 * @returns {string | undefined} Mapped name, raw code, or undefined.
 */
export function lookupSmbiosName(table, code) {
  if (code === undefined || code === null) {
    return undefined;
  }
  const key = Number(code);
  if (!Number.isFinite(key)) {
    return undefined;
  }
  return table[key] ?? String(key);
}
