// Windows-specific CIM enum tables. Every table is sourced from Microsoft
// Learn; the live WMI schema can lag behind reality (the VM's live
// Win32_Processor.Architecture ValueMap lacks 12/ARM64 while instances
// report 12), so documentation is the source of truth and unknown codes are
// passed through raw rather than guessed.

/**
 * Win32_Processor.Architecture value map, from
 * https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-processor
 * (x86 (0), MIPS (1), Alpha (2), PowerPC (3), ARM (5), ia64 (6), x64 (9),
 * ARM64 (12)). Codes 9 and 12 use the collector architecture names amd64 and
 * arm64 so routing and emitted values agree.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_PROCESSOR_ARCHITECTURES = Object.freeze({
  0: "x86",
  1: "mips",
  2: "alpha",
  3: "powerpc",
  5: "arm",
  6: "ia64",
  9: "amd64",
  12: "arm64",
});

/**
 * Win32_ComputerSystem.PCSystemTypeEx value map, from
 * https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-computersystem
 * (Unspecified (0) ... Slate (8)). Value 9 (Maximum) is a range bound, not a
 * system type, and is omitted.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_PC_SYSTEM_TYPES_EX = Object.freeze({
  0: "unspecified",
  1: "desktop",
  2: "mobile",
  3: "workstation",
  4: "enterprise-server",
  5: "soho-server",
  6: "appliance-pc",
  7: "performance-server",
  8: "slate",
});

/**
 * Win32_PhysicalMemory.FormFactor value map (CIM chip form factors), from
 * https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-physicalmemory
 * (Unknown (0) ... LGA (23)). This is the CIM mapping, not the raw SMBIOS
 * §7.18.1 table, so DIMM is 8 here while SMBIOS reports 9.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_MEMORY_FORM_FACTORS = Object.freeze({
  0: "Unknown",
  1: "Other",
  2: "SIP",
  3: "DIP",
  4: "ZIP",
  5: "SOJ",
  6: "Proprietary",
  7: "SIMM",
  8: "DIMM",
  9: "TSOP",
  10: "PGA",
  11: "RIMM",
  12: "SODIMM",
  13: "SRIMM",
  14: "SMD",
  15: "SSMP",
  16: "QFP",
  17: "TQFP",
  18: "SOIC",
  19: "LCC",
  20: "PLCC",
  21: "BGA",
  22: "FPBGA",
  23: "LGA",
});

/**
 * Win32_PhysicalMemoryArray.MemoryErrorCorrection value map, from
 * https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-physicalmemoryarray
 * (Reserved (0), Other (1), Unknown (2), None (3), Parity (4),
 * Single-bit ECC (5), Multi-bit ECC (6), CRC (7)).
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_MEMORY_ERROR_CORRECTIONS = Object.freeze({
  0: "Reserved",
  1: "Other",
  2: "Unknown",
  3: "None",
  4: "Parity",
  5: "Single-bit ECC",
  6: "Multi-bit ECC",
  7: "CRC",
});

/**
 * Look up a Windows CIM enum code, passing unknown codes through raw.
 *
 * @param {Readonly<Record<number, string>>} table Enum code table.
 * @param {number | string | null | undefined} code Code observed on a host.
 * @returns {string | undefined} Mapped name, raw code, or undefined.
 */
export function windowsEnumName(table, code) {
  if (code === undefined || code === null) {
    return undefined;
  }
  const key = Number(code);
  if (!Number.isFinite(key)) {
    return undefined;
  }
  return table[key] ?? String(key);
}
