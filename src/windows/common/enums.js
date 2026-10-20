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

/**
 * D3DKMDT_VIDEO_OUTPUT_TECHNOLOGY, the connector type behind
 * WmiMonitorConnectionParams.VideoOutputTechnology, from
 * https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/d3dkmdt/ne-d3dkmdt-_d3dkmdt_video_output_technology
 * (UNINITIALIZED (-2), OTHER (-1), HD15 (0) ... INDIRECT_WIRED (16),
 * INTERNAL (0x80000000)). The live root/wmi schema has no ValueMap for this
 * property (VM-FINDINGS §5). Keys are the signed enum values; the uint32 forms
 * the WMI class reports are normalized by {@link windowsVideoOutputTechnologyName}.
 * The SVIDEO_4PIN/7PIN, RF, RCA_3COMPONENT and BNC constants alias 1 and 2
 * and therefore need no rows.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_VIDEO_OUTPUT_TECHNOLOGIES = Object.freeze({
  [-2]: "uninitialized",
  [-1]: "other",
  0: "hd15",
  1: "svideo",
  2: "composite-video",
  3: "component-video",
  4: "dvi",
  5: "hdmi",
  6: "lvds",
  8: "d-jpn",
  9: "sdi",
  10: "displayport",
  11: "displayport-embedded",
  12: "udi",
  13: "udi-embedded",
  14: "sdtv-dongle",
  15: "miracast",
  16: "indirect-wired",
  [-2147483648]: "internal",
});

/**
 * Name a VideoOutputTechnology code, accepting the signed enum value or the
 * uint32 form WMI serializes (4294967294 for -2, 4294967295 for -1,
 * 2147483648 for INTERNAL). Unknown codes are returned raw.
 *
 * @param {number | string | null | undefined} code Observed code.
 * @returns {string | undefined} Connector name, raw code, or undefined.
 */
export function windowsVideoOutputTechnologyName(code) {
  if (code === undefined || code === null) {
    return undefined;
  }
  let key = Number(code);
  if (!Number.isFinite(key)) {
    return undefined;
  }
  // uint32 → int32 reinterpretation for values with the top bit set.
  if (key >= 2 ** 31) {
    key -= 2 ** 32;
  }
  return WINDOWS_VIDEO_OUTPUT_TECHNOLOGIES[key] ?? String(Number(code));
}

/**
 * Device setup classes keyed by lower-case ClassGuid (no braces), from
 * https://learn.microsoft.com/en-us/windows-hardware/drivers/install/system-defined-device-setup-classes-available-to-vendors
 * (vendor classes) and
 * https://learn.microsoft.com/en-us/windows-hardware/drivers/install/system-defined-device-setup-classes-reserved-for-system-use
 * (AudioEndpoint, Computer, PrintQueue, SoftwareDevice, USB, VolumeSnapshot).
 * The Firmware class comes from the UEFI firmware update platform INF sample at
 * https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/authoring-an-update-driver-package.
 * Values are the documented `Class` INF names, so classification never
 * depends on Win32_PnPEntity.PNPClass, which the MS Learn page says can be
 * missing.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const WINDOWS_DEVICE_SETUP_CLASSES = Object.freeze({
  "5989fce8-9cd0-467d-8a6a-5419e31529d4": "AudioProcessingObject",
  "c166523c-fe0c-4a94-a586-f1a80cfbbf3e": "AudioEndpoint",
  "72631e54-78a4-11d0-bcf7-00aa00b7b32a": "Battery",
  "53d29ef7-377c-4d14-864b-eb3a85769359": "Biometric",
  "e0cbf06c-cd8b-4647-bb8a-263b43f0f974": "Bluetooth",
  "ca3e7ab9-b4c3-4ae6-8251-579ef933890f": "Camera",
  "4d36e965-e325-11ce-bfc1-08002be10318": "CDROM",
  "4d36e966-e325-11ce-bfc1-08002be10318": "Computer",
  "4d36e967-e325-11ce-bfc1-08002be10318": "DiskDrive",
  "4d36e968-e325-11ce-bfc1-08002be10318": "Display",
  "48721b56-6795-11d2-b1a8-0080c72e74a2": "Dot4",
  "49ce6ac8-6f86-11d2-b1e5-0080c72e74a2": "Dot4Print",
  "e2f84ce7-8efa-411c-aa69-97454ca4cb57": "Extension",
  "4d36e969-e325-11ce-bfc1-08002be10318": "FDC",
  "f2e7dd72-6468-4e36-b6f1-6488f42c1b52": "Firmware",
  "4d36e980-e325-11ce-bfc1-08002be10318": "FloppyDisk",
  "4d36e96a-e325-11ce-bfc1-08002be10318": "HDC",
  "745a17a0-74d3-11d0-b6fe-00a0c90f57da": "HIDClass",
  "6bdd1fc1-810f-11d0-bec7-08002be2092f": "1394",
  "6bdd1fc6-810f-11d0-bec7-08002be2092f": "Image",
  "6bdd1fc5-810f-11d0-bec7-08002be2092f": "Infrared",
  "4d36e96b-e325-11ce-bfc1-08002be10318": "Keyboard",
  "ce5939ae-ebde-11d0-b181-0000f8753ec4": "MediumChanger",
  "4d36e970-e325-11ce-bfc1-08002be10318": "MTD",
  "4d36e96d-e325-11ce-bfc1-08002be10318": "Modem",
  "4d36e96e-e325-11ce-bfc1-08002be10318": "Monitor",
  "4d36e96f-e325-11ce-bfc1-08002be10318": "Mouse",
  "4d36e971-e325-11ce-bfc1-08002be10318": "Multifunction",
  "4d36e96c-e325-11ce-bfc1-08002be10318": "Media",
  "50906cb8-ba12-11d1-bf5d-0000f805f530": "MultiportSerial",
  "4d36e972-e325-11ce-bfc1-08002be10318": "Net",
  "4d36e973-e325-11ce-bfc1-08002be10318": "NetClient",
  "4d36e974-e325-11ce-bfc1-08002be10318": "NetService",
  "4d36e975-e325-11ce-bfc1-08002be10318": "NetTrans",
  "75416e63-5912-4dfa-ae8f-3efaccaffb14": "NvmeDisk",
  "4d36e977-e325-11ce-bfc1-08002be10318": "PCMCIA",
  "4d36e978-e325-11ce-bfc1-08002be10318": "Ports",
  "4d36e979-e325-11ce-bfc1-08002be10318": "Printer",
  "1ed2bbf9-11f0-4084-b21f-ad83a8e6dcdc": "PrintQueue",
  "4658ee7e-f050-11d1-b6bd-00c04fa372a7": "PNPPrinters",
  "50127dc3-0f36-415e-a6cc-4cb3be910b65": "Processor",
  "4d36e97b-e325-11ce-bfc1-08002be10318": "SCSIAdapter",
  "268c95a1-edfe-11d3-95c3-0010dc4050a5": "SecurityAccelerator",
  "d94ee5d8-d189-4994-83d2-f68d7d41b0e6": "SecurityDevices",
  "5175d334-c371-4806-b3ba-71fd53c9258d": "Sensor",
  "50dd5230-ba8a-11d1-bf5d-0000f805f530": "SmartCardReader",
  "5c4c3332-344d-483c-8739-259e934c9cc8": "SoftwareComponent",
  "62f9c741-b25a-46ce-b54c-9bccce08b6f2": "SoftwareDevice",
  "4d36e97d-e325-11ce-bfc1-08002be10318": "System",
  "6d807884-7d21-11cf-801c-08002be10318": "TapeDrive",
  "e6f1aa1c-7f3b-4473-b2e8-c97d8ac71d53": "UCM",
  "36fc9e60-c465-11cf-8056-444553540000": "USB",
  "88bae032-5a81-49f0-bc3d-a4ff138216d6": "USBDevice",
  "71a27cdd-812a-11d0-bec7-08002be2092f": "Volume",
  "533c5b84-ec70-11d2-9505-00c04f79deaf": "VolumeSnapshot",
  "25dbce51-6c8f-4a72-8a6d-b54c2b4fc835": "WCEUSBS",
  "eec5ad98-8080-425f-922a-dabf3de3f69a": "WPD",
});

/**
 * Resolve the documented setup-class name of a ClassGuid.
 *
 * @param {string | null | undefined} classGuid GUID with or without braces, any case.
 * @returns {string | undefined} Class name or undefined for unknown GUIDs.
 */
export function windowsSetupClassName(classGuid) {
  const key = normalizeGuid(classGuid);
  return key === undefined ? undefined : WINDOWS_DEVICE_SETUP_CLASSES[key];
}

/**
 * Normalize a GUID to lower-case without braces.
 *
 * @param {string | null | undefined} value Candidate GUID.
 * @returns {string | undefined} Normalized GUID or undefined.
 */
export function normalizeGuid(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim().replace(/^\{/u, "").replace(/\}$/u, "").toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(text)
    ? text
    : undefined;
}

/**
 * Win32_DeviceGuard.VirtualizationBasedSecurityStatus, from
 * https://learn.microsoft.com/en-us/windows/security/hardware-security/enable-virtualization-based-protection-of-code-integrity
 * (0 VBS isn't enabled, 1 enabled but not running, 2 enabled and running);
 * the live root/Microsoft/Windows/DeviceGuard ValueMap agrees.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_VBS_STATUSES = Object.freeze({
  0: "off",
  1: "enabled",
  2: "running",
});

/**
 * Win32_DeviceGuard.SecurityServicesConfigured / SecurityServicesRunning, from
 * the same page (0 none, 1 Credential Guard, 2 memory integrity (HVCI),
 * 3 System Guard Secure Launch, 4 SMM Firmware Measurement, 5 Kernel-mode
 * Hardware-enforced Stack Protection, 6 the same in audit mode,
 * 7 Hypervisor-Enforced Paging Translation). Both properties are arrays.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_SECURITY_SERVICES = Object.freeze({
  0: "none",
  1: "credential-guard",
  2: "memory-integrity",
  3: "system-guard-secure-launch",
  4: "smm-firmware-measurement",
  5: "kernel-mode-hardware-enforced-stack-protection",
  6: "kernel-mode-hardware-enforced-stack-protection-audit",
  7: "hypervisor-enforced-paging-translation",
});

/**
 * Win32_DeviceGuard.CodeIntegrityPolicyEnforcementStatus and
 * UsermodeCodeIntegrityPolicyEnforcementStatus, from the same page
 * (0 Off, 1 Audit, 2 Enforced).
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_CODE_INTEGRITY_ENFORCEMENT = Object.freeze({
  0: "off",
  1: "audit",
  2: "enforced",
});

/**
 * Win32_DeviceGuard.AvailableSecurityProperties / RequiredSecurityProperties,
 * from the same page (0 none, 1 hypervisor support, 2 Secure Boot, 3 DMA
 * protection, 4 Secure Memory Overwrite, 5 NX protections, 6 SMM mitigations,
 * 7 MBEC/GMET, 8 APIC virtualization). Both properties are arrays.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_SECURITY_PROPERTIES = Object.freeze({
  0: "none",
  1: "hypervisor-support",
  2: "secure-boot",
  3: "dma-protection",
  4: "secure-memory-overwrite",
  5: "nx-protections",
  6: "smm-mitigations",
  7: "mbec-gmet",
  8: "apic-virtualization",
});

/**
 * Win32_Battery.BatteryStatus value map, from
 * https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-battery
 * (Other (1) "The battery is discharging", Unknown (2) "The system has access
 * to AC so no battery is being discharged. However, the battery is not
 * necessarily charging", Fully Charged (3), Low (4), Critical (5),
 * Charging (6), Charging and High (7), Charging and Low (8), Charging and
 * Critical (9), Undefined (10), Partially Charged (11)).
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_BATTERY_STATUSES = Object.freeze({
  1: "Discharging",
  2: "On AC",
  3: "Fully Charged",
  4: "Low",
  5: "Critical",
  6: "Charging",
  7: "Charging and High",
  8: "Charging and Low",
  9: "Charging and Critical",
  10: "Undefined",
  11: "Partially Charged",
});

/**
 * Win32_Battery.Chemistry value map, from the same page (Other (1),
 * Unknown (2), Lead Acid (3), Nickel Cadmium (4), Nickel Metal Hydride (5),
 * Lithium-ion (6), Zinc air (7), Lithium Polymer (8)).
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_BATTERY_CHEMISTRIES = Object.freeze({
  1: "Other",
  2: "Unknown",
  3: "Lead Acid",
  4: "Nickel Cadmium",
  5: "Nickel Metal Hydride",
  6: "Lithium-ion",
  7: "Zinc air",
  8: "Lithium Polymer",
});

/**
 * Win32_EncryptableVolume.ProtectionStatus, from
 * https://learn.microsoft.com/en-us/windows/win32/secprov/win32-encryptablevolume
 * (0 PROTECTION OFF, 1 PROTECTION ON, 2 PROTECTION UNKNOWN).
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_BITLOCKER_PROTECTION_STATUSES = Object.freeze({
  0: "off",
  1: "on",
  2: "unknown",
});

/**
 * Win32_EncryptableVolume.ConversionStatus, from the same page
 * (0 FULLY DECRYPTED ... 5 DECRYPTION PAUSED).
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_BITLOCKER_CONVERSION_STATUSES = Object.freeze({
  0: "fully-decrypted",
  1: "fully-encrypted",
  2: "encryption-in-progress",
  3: "decryption-in-progress",
  4: "encryption-paused",
  5: "decryption-paused",
});

/**
 * Win32_EncryptableVolume.EncryptionMethod, using the constant names of the
 * GetEncryptionMethod method documentation,
 * https://learn.microsoft.com/en-us/windows/win32/secprov/getencryptionmethod-win32-encryptablevolume
 * (None (0), AES_128_WITH_DIFFUSER (1), AES_256_WITH_DIFFUSER (2), AES_128 (3),
 * AES_256 (4), HARDWARE_ENCRYPTION (5), XTS_AES_128 (6), XTS_AES_256 (7),
 * (uint32)-1 UNKNOWN).
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_BITLOCKER_ENCRYPTION_METHODS = Object.freeze({
  0: "None",
  1: "AES_128_WITH_DIFFUSER",
  2: "AES_256_WITH_DIFFUSER",
  3: "AES_128",
  4: "AES_256",
  5: "HARDWARE_ENCRYPTION",
  6: "XTS_AES_128",
  7: "XTS_AES_256",
  4294967295: "UNKNOWN",
});

/**
 * Win32_EncryptableVolume.VolumeType, from the class page (0 SYSTEM, the
 * volume with the operating system; 1 FIXED DISK; 2 REMOVABLE).
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_BITLOCKER_VOLUME_TYPES = Object.freeze({
  0: "system",
  1: "fixed-disk",
  2: "removable",
});

/**
 * ESRT LastAttemptStatus as Windows stores it under
 * `Control\FirmwareResources\{GUID}`: the OS loader maps the UEFI status to
 * an NTSTATUS, per the table at
 * https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/authoring-an-update-driver-package
 * (Success 0 -> STATUS_SUCCESS 0x00000000, Unsuccessful 1 -> 0xC0000001,
 * Insufficient Resources 2 -> 0xC000009A, Incorrect Version 3 ->
 * STATUS_REVISION_MISMATCH 0xC0000059, Invalid Image Format 4 -> 0xC000007B,
 * Authentication Error 5 -> STATUS_ACCESS_DENIED 0xC0000022, Power Event, AC
 * Not Connected 6 -> 0xC00002D3, Power Event, Insufficient Battery 7 ->
 * 0xC00002DE). Keys are the NTSTATUS values as unsigned 32-bit numbers.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINDOWS_ESRT_LAST_ATTEMPT_STATUSES = Object.freeze({
  0x00000000: "success",
  0xc0000001: "unsuccessful",
  0xc000009a: "insufficient-resources",
  0xc0000059: "incorrect-version",
  0xc000007b: "invalid-image-format",
  0xc0000022: "authentication-error",
  0xc00002d3: "power-event-ac-not-connected",
  0xc00002de: "power-event-insufficient-battery",
});
