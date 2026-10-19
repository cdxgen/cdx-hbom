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

/**
 * MSFT_PhysicalDisk.BusType value map, from
 * https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-physicaldisk
 * (Unknown (0) ... NVMe (17)). The live root/Microsoft/Windows/Storage schema
 * (VM-FINDINGS §5) extends the stale doc page with 14 Virtual, 18 SCM and
 * 19 UFS, which the doc lists as reserved.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_STORAGE_BUS_TYPES = Object.freeze({
  0: "Unknown",
  1: "SCSI",
  2: "ATAPI",
  3: "ATA",
  4: "1394",
  5: "SSA",
  6: "Fibre Channel",
  7: "USB",
  8: "RAID",
  9: "iSCSI",
  10: "SAS",
  11: "SATA",
  12: "SD",
  13: "MMC",
  14: "Virtual",
  15: "File Backed Virtual",
  16: "Storage Spaces",
  17: "NVMe",
  18: "SCM",
  19: "UFS",
});

/**
 * MSFT_PhysicalDisk.MediaType value map, from
 * https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-physicaldisk
 * (0 Unspecified, 3 HDD, 4 SSD, 5 SCM). 0 is omitted by callers.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_STORAGE_MEDIA_TYPES = Object.freeze({
  0: "Unspecified",
  3: "HDD",
  4: "SSD",
  5: "SCM",
});

/**
 * MSFT_PhysicalDisk.HealthStatus value map, from
 * https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-physicaldisk
 * (0 Healthy, 1 Warning, 2 Unhealthy, 5 Unknown).
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_STORAGE_HEALTH_STATUSES = Object.freeze({
  0: "Healthy",
  1: "Warning",
  2: "Unhealthy",
  5: "Unknown",
});

/**
 * MSFT_NetAdapter.NdisPhysicalMedium value map, from
 * https://learn.microsoft.com/en-us/previous-versions/windows/desktop/legacy/hh968170(v=vs.85)
 * (Unspecified (0) ... Other (19)).
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_NDIS_PHYSICAL_MEDIA = Object.freeze({
  0: "Unspecified",
  1: "Wireless LAN",
  2: "Cable Modem",
  3: "Phone Line",
  4: "Power Line",
  5: "DSL",
  6: "FC",
  7: "1394",
  8: "Wireless WAN",
  9: "Native 802.11",
  10: "BlueTooth",
  11: "Infiniband",
  12: "WiMAX",
  13: "UWB",
  14: "802.3",
  15: "802.5",
  16: "IRDA",
  17: "Wired WAN",
  18: "Wired Connection Oriented WAN",
  19: "Other",
});

/**
 * Win32_Volume.DriveType value map, from
 * https://learn.microsoft.com/en-us/previous-versions/windows/desktop/legacy/aa394515(v=vs.85)
 * (0 Unknown ... 6 RAM Disk). Volumes are collected when they carry a drive
 * letter or report a removable (2) or local (3) disk type.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_VOLUME_DRIVE_TYPES = Object.freeze({
  0: "Unknown",
  1: "No Root Directory",
  2: "Removable Disk",
  3: "Local Disk",
  4: "Network Drive",
  5: "Compact Disk",
  6: "RAM Disk",
});

/**
 * Win32_NetworkAdapter.NetConnectionStatus value map, from
 * https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-networkadapter
 * (Disconnected (0) ... Credentials Required (12)); 13+ is Other. Only the
 * values that map to an operState survive into the BOM.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_NET_CONNECTION_STATUSES = Object.freeze({
  0: "Disconnected",
  1: "Connecting",
  2: "Connected",
  3: "Disconnecting",
  4: "Hardware Not Present",
  5: "Hardware Disabled",
  6: "Hardware Malfunction",
  7: "Media Disconnected",
  8: "Authenticating",
  9: "Authentication Succeeded",
  10: "Authentication Failed",
  11: "Invalid Address",
  12: "Credentials Required",
});

/**
 * CIM_ManagedSystemElement.OperationalStatus value map (inherited by the
 * Storage CIM classes), from the DMTF Values qualifier as documented at
 * https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/cim-managedsystemelement
 * (0 Unknown ... 19 Relocating).
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_OPERATIONAL_STATUSES = Object.freeze({
  0: "Unknown",
  1: "Other",
  2: "OK",
  3: "Degraded",
  4: "Stressed",
  5: "Predictive Failure",
  6: "Error",
  7: "Non-Recoverable Error",
  8: "Starting",
  9: "Stopping",
  10: "Stopped",
  11: "In Service",
  12: "No Contact",
  13: "Lost Communication",
  14: "Aborted",
  15: "Dormant",
  16: "Supporting Entity in Error",
  17: "Completed",
  18: "Power Mode",
  19: "Relocating",
});
