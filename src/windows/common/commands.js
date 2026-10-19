import {
  buildCimScript,
  resolveWindowsPowerShellPath,
  WINDOWS_POWERSHELL_BASE_ARGS,
} from "./powershell.js";

/**
 * Manifest of `windows-cim-platform`, the tier-1 CIM batch.
 *
 * Property lists are the union this collector projects; the generated script
 * intersects them with the live class schema so builds that lack a property
 * degrade instead of failing the query. PII properties are never listed
 * (PLAN.md §4.7) and a test scans for them.
 *
 * @type {{
 *   commandId: string,
 *   entries: ReadonlyArray<Readonly<import("./powershell.js").CimManifestEntry>>
 * }}
 */
export const WINDOWS_PLATFORM_MANIFEST = Object.freeze({
  commandId: "windows-cim-platform",
  entries: Object.freeze([
    Object.freeze({
      key: "computerSystem",
      kind: "cim",
      namespace: "root/cimv2",
      className: "Win32_ComputerSystem",
      properties: Object.freeze([
        "Manufacturer",
        "Model",
        "SystemFamily",
        "SystemSKUNumber",
        "SystemType",
        "PCSystemType",
        "PCSystemTypeEx",
        "TotalPhysicalMemory",
        "NumberOfProcessors",
        "NumberOfLogicalProcessors",
        "HypervisorPresent",
      ]),
    }),
    Object.freeze({
      key: "computerSystemProduct",
      kind: "cim",
      namespace: "root/cimv2",
      className: "Win32_ComputerSystemProduct",
      properties: Object.freeze([
        "Name",
        "Vendor",
        "Version",
        "IdentifyingNumber",
        "UUID",
        "SKUNumber",
      ]),
    }),
    Object.freeze({
      key: "bios",
      kind: "cim",
      namespace: "root/cimv2",
      className: "Win32_BIOS",
      properties: Object.freeze([
        "Manufacturer",
        "SMBIOSBIOSVersion",
        "BIOSVersion",
        "Version",
        "ReleaseDate",
        "SerialNumber",
        "SMBIOSMajorVersion",
        "SMBIOSMinorVersion",
        "SystemBiosMajorVersion",
        "SystemBiosMinorVersion",
        "EmbeddedControllerMajorVersion",
        "EmbeddedControllerMinorVersion",
        "PrimaryBIOS",
      ]),
    }),
    Object.freeze({
      key: "baseBoard",
      kind: "cim",
      namespace: "root/cimv2",
      className: "Win32_BaseBoard",
      properties: Object.freeze([
        "Manufacturer",
        "Product",
        "Version",
        "SerialNumber",
        "HostingBoard",
      ]),
    }),
    Object.freeze({
      key: "systemEnclosure",
      kind: "cim",
      namespace: "root/cimv2",
      className: "Win32_SystemEnclosure",
      properties: Object.freeze([
        "Manufacturer",
        "ChassisTypes",
        "SerialNumber",
        "SMBIOSAssetTag",
      ]),
    }),
    Object.freeze({
      key: "processor",
      kind: "cim",
      namespace: "root/cimv2",
      className: "Win32_Processor",
      properties: Object.freeze([
        "DeviceID",
        "Name",
        "Manufacturer",
        "Architecture",
        "Family",
        "Stepping",
        "Revision",
        "NumberOfCores",
        "NumberOfEnabledCore",
        "NumberOfLogicalProcessors",
        "ThreadCount",
        "MaxClockSpeed",
        "CurrentClockSpeed",
        "L2CacheSize",
        "L3CacheSize",
        "SocketDesignation",
        "AddressWidth",
        "DataWidth",
        "VirtualizationFirmwareEnabled",
        "SecondLevelAddressTranslationExtensions",
        "VMMonitorModeExtensions",
      ]),
    }),
    Object.freeze({
      key: "physicalMemory",
      kind: "cim",
      namespace: "root/cimv2",
      className: "Win32_PhysicalMemory",
      properties: Object.freeze([
        "Tag",
        "Manufacturer",
        "PartNumber",
        "SerialNumber",
        "Capacity",
        "Speed",
        "ConfiguredClockSpeed",
        "ConfiguredVoltage",
        "SMBIOSMemoryType",
        "MemoryType",
        "FormFactor",
        "TypeDetail",
        "DataWidth",
        "TotalWidth",
        "DeviceLocator",
        "BankLabel",
      ]),
    }),
    Object.freeze({
      key: "physicalMemoryArray",
      kind: "cim",
      namespace: "root/cimv2",
      className: "Win32_PhysicalMemoryArray",
      properties: Object.freeze([
        "MaxCapacityEx",
        "MaxCapacity",
        "MemoryDevices",
        "MemoryErrorCorrection",
        "Use",
        "Location",
      ]),
    }),
    Object.freeze({
      key: "operatingSystem",
      kind: "cim",
      namespace: "root/cimv2",
      className: "Win32_OperatingSystem",
      properties: Object.freeze([
        "Caption",
        "Version",
        "BuildNumber",
        "ProductType",
      ]),
    }),
    Object.freeze({
      key: "msSystemInformation",
      kind: "cim",
      namespace: "root/wmi",
      className: "MS_SystemInformation",
      properties: Object.freeze([
        "BIOSReleaseDate",
        "BIOSVendor",
        "BIOSVersion",
        "SystemFamily",
        "SystemSKU",
      ]),
    }),
  ]),
});

/**
 * Manifest of `windows-cim-storage-network`, the tier-2 storage and network
 * enrichment batch (PLAN.md §4.2). Storage components are built from
 * Win32_DiskDrive and enriched from MSFT_PhysicalDisk, which returns zero
 * instances (no error) for a standard user (PERMISSIONS-MATRIX.md). PII and
 * per-machine identifiers (InterfaceGuid, MSFT DeviceID, NetLuid,
 * NetworkAddresses, the user-chosen volume Label and the path-valued volume
 * Name, LocationInformationString) are never selected.
 *
 * @type {{
 *   commandId: string,
 *   entries: ReadonlyArray<Readonly<import("./powershell.js").CimManifestEntry>>
 * }}
 */
export const WINDOWS_STORAGE_NETWORK_MANIFEST = Object.freeze({
  commandId: "windows-cim-storage-network",
  entries: Object.freeze([
    Object.freeze({
      key: "physicalDisk",
      kind: "cim",
      namespace: "root/Microsoft/Windows/Storage",
      className: "MSFT_PhysicalDisk",
      properties: Object.freeze([
        "DeviceId",
        "FriendlyName",
        "Model",
        "Manufacturer",
        "SerialNumber",
        "FirmwareVersion",
        "Size",
        "BusType",
        "MediaType",
        "SpindleSpeed",
        "HealthStatus",
        "OperationalStatus",
        "LogicalSectorSize",
        "PhysicalSectorSize",
      ]),
    }),
    Object.freeze({
      key: "diskDrive",
      kind: "cim",
      namespace: "root/cimv2",
      className: "Win32_DiskDrive",
      properties: Object.freeze([
        "Index",
        "Model",
        "Manufacturer",
        "InterfaceType",
        "PNPDeviceID",
        "SerialNumber",
        "Size",
        "FirmwareRevision",
        "BytesPerSector",
        "Partitions",
        "Capabilities",
        "Status",
      ]),
    }),
    Object.freeze({
      key: "volume",
      kind: "cim",
      namespace: "root/cimv2",
      className: "Win32_Volume",
      properties: Object.freeze([
        "DeviceID",
        "DriveLetter",
        "DriveType",
        "FileSystem",
        "Capacity",
        "FreeSpace",
        "BootVolume",
        "SystemVolume",
        "SerialNumber",
      ]),
    }),
    Object.freeze({
      key: "netAdapter",
      kind: "cim",
      namespace: "root/StandardCimv2",
      className: "MSFT_NetAdapter",
      properties: Object.freeze([
        "Name",
        "InterfaceDescription",
        "DriverDescription",
        "DriverVersionString",
        "DriverProvider",
        "DriverDate",
        "DriverName",
        "PermanentAddress",
        "MtuSize",
        "ReceiveLinkSpeed",
        "TransmitLinkSpeed",
        "FullDuplex",
        "MediaConnectState",
        "InterfaceOperationalStatus",
        "InterfaceIndex",
        "NdisPhysicalMedium",
        "HardwareInterface",
        "Virtual",
        "ConnectorPresent",
        "EndPointInterface",
        "PnPDeviceID",
        "ComponentID",
      ]),
    }),
    Object.freeze({
      key: "netAdapterHardware",
      kind: "cim",
      namespace: "root/StandardCimv2",
      className: "MSFT_NetAdapterHardwareInfoSettingData",
      properties: Object.freeze([
        "Name",
        "InterfaceDescription",
        "SegmentNumber",
        "BusNumber",
        "DeviceNumber",
        "FunctionNumber",
        "PciExpressCurrentLinkSpeedEncoded",
        "PciExpressCurrentLinkWidth",
        "PciExpressMaxLinkSpeedEncoded",
        "PciExpressMaxLinkWidth",
      ]),
    }),
    Object.freeze({
      key: "networkAdapterLegacy",
      kind: "cim",
      namespace: "root/cimv2",
      className: "Win32_NetworkAdapter",
      properties: Object.freeze([
        "Name",
        "Manufacturer",
        "ProductName",
        "PNPDeviceID",
        "MACAddress",
        "Speed",
        "PhysicalAdapter",
        "NetConnectionStatus",
        "ServiceName",
        "AdapterType",
        "InterfaceIndex",
      ]),
    }),
  ]),
});

/**
 * Manifest of the Windows CIM selftest command.
 *
 * `WINDOWS_SELFTEST_COMMAND` is deliberately excluded from
 * {@link WINDOWS_COMMANDS} and from the command plan: it exists to capture,
 * on a real host, one envelope of every error shape the parser must classify
 * (`InvalidClass`, `NotSupported`, `InvalidNamespace`, `AccessDenied` with a
 * short-circuited repeat, a missing registry key) plus real PnP identifier
 * strings for the parser tests.
 *
 * @type {{
 *   commandId: string,
 *   entries: ReadonlyArray<Readonly<import("./powershell.js").CimManifestEntry | Readonly<import("./powershell.js").RegistryManifestEntry>>
 * }}
 */
export const WINDOWS_SELFTEST_MANIFEST = Object.freeze({
  commandId: "windows-cim-selftest",
  entries: Object.freeze([
    Object.freeze({
      key: "bios",
      kind: "cim",
      namespace: "root/cimv2",
      className: "Win32_BIOS",
      properties: Object.freeze(["Manufacturer"]),
    }),
    Object.freeze({
      key: "missingClass",
      kind: "cim",
      namespace: "root/wmi",
      className: "BatteryStaticData",
      properties: Object.freeze(["InstanceName"]),
    }),
    Object.freeze({
      key: "notSupported",
      kind: "cim",
      namespace: "root/wmi",
      className: "MSAcpi_ThermalZoneTemperature",
      properties: Object.freeze(["InstanceName"]),
    }),
    Object.freeze({
      key: "missingNamespace",
      kind: "cim",
      namespace: "root/cdxhbomnotthere",
      className: "Foo",
      properties: Object.freeze(["Bar"]),
    }),
    Object.freeze({
      key: "tpm",
      kind: "cim",
      namespace: "root/cimv2/Security/MicrosoftTpm",
      className: "Win32_Tpm",
      properties: Object.freeze(["SpecVersion"]),
    }),
    Object.freeze({
      key: "biosAgain",
      kind: "cim",
      namespace: "root/cimv2",
      className: "Win32_BIOS",
      properties: Object.freeze(["SMBIOSBIOSVersion"]),
    }),
    Object.freeze({
      key: "missingRegistry",
      kind: "registry",
      path: "HKLM:\\SOFTWARE\\cdx-hbom-selftest-absent",
      names: Object.freeze(["X"]),
    }),
    Object.freeze({
      key: "pnpIds",
      kind: "cim",
      namespace: "root/cimv2",
      className: "Win32_PnPEntity",
      properties: Object.freeze([
        "PNPDeviceID",
        "HardwareID",
        "CompatibleID",
        "ClassGuid",
      ]),
    }),
  ]),
});

/**
 * Windows PowerShell command registry.
 *
 * Every Windows spec runs without elevation (`privilege: "none"`, no sudo
 * retry): Windows 11 ships its own `sudo.exe`, which cdx-hbom must never
 * invoke. Privileged CIM sources are gated by collector options in later
 * chunks, never by retrying elevated.
 *
 * @type {ReadonlyArray<Readonly<import("../../common/command.js").CommandSpec>>}
 */
export const WINDOWS_COMMANDS = Object.freeze([
  toWindowsCommandSpec(WINDOWS_PLATFORM_MANIFEST, {
    category: "platform",
    purpose:
      "Collect SMBIOS-backed system, firmware, board, enclosure, processor and memory inventory via CIM.",
    sensitiveFields: [
      "computerSystemProduct.IdentifyingNumber",
      "computerSystemProduct.UUID",
      "bios.SerialNumber",
      "baseBoard.SerialNumber",
      "systemEnclosure.SerialNumber",
      "systemEnclosure.SMBIOSAssetTag",
      "physicalMemory.SerialNumber",
    ],
  }),
  toWindowsCommandSpec(WINDOWS_STORAGE_NETWORK_MANIFEST, {
    category: "storage-network",
    purpose:
      "Collect disk, volume and network-adapter inventory via CIM, enriching Win32_DiskDrive from the Storage and NetAdapter CIM classes.",
    sensitiveFields: [
      "physicalDisk.SerialNumber",
      "diskDrive.SerialNumber",
      "diskDrive.PNPDeviceID",
      "volume.DeviceID",
      "volume.SerialNumber",
      "netAdapter.PermanentAddress",
      "netAdapter.PnPDeviceID",
      "networkAdapterLegacy.MACAddress",
      "networkAdapterLegacy.PNPDeviceID",
    ],
  }),
]);

/**
 * Test-only Windows command that exercises every envelope error path on a
 * real host. Not part of {@link WINDOWS_COMMANDS} or the command plan.
 *
 * @type {Readonly<import("../../common/command.js").CommandSpec>}
 */
export const WINDOWS_SELFTEST_COMMAND = toWindowsCommandSpec(
  WINDOWS_SELFTEST_MANIFEST,
  {
    category: "selftest",
    purpose:
      "Capture one envelope of every Windows CIM error shape plus real PnP identifier strings.",
    sensitiveFields: [
      "pnpIds.PNPDeviceID",
      "pnpIds.HardwareID",
      "pnpIds.CompatibleID",
    ],
  },
);

/**
 * Look up a Windows command spec by id.
 *
 * @param {string} id Command id such as `windows-cim-platform`.
 * @returns {import("../../common/command.js").CommandSpec} Command spec.
 * @throws {Error} When no Windows command carries the id.
 */
export function getRequiredWindowsCommand(id) {
  const spec = WINDOWS_COMMANDS.find((candidate) => candidate.id === id);
  if (!spec) {
    throw new Error(`Unknown Windows command: ${id}`);
  }
  return spec;
}

/**
 * Build a frozen command spec from a manifest.
 *
 * The script is generated and validated at module load so an unsafe or
 * oversized manifest fails on import, not on a collector run.
 *
 * @param {import("./powershell.js").CimManifest} manifest CIM manifest.
 * @param {{ category: string, purpose: string, sensitiveFields?: string[] }} fields Spec fields.
 * @returns {Readonly<import("../../common/command.js").CommandSpec>} Frozen spec.
 */
function toWindowsCommandSpec(manifest, fields) {
  // buildCimScript asserts the script invariants before returning.
  const script = buildCimScript(manifest);

  return Object.freeze({
    id: manifest.commandId,
    category: fields.category,
    command: resolveWindowsPowerShellPath(),
    args: Object.freeze([...WINDOWS_POWERSHELL_BASE_ARGS, script]),
    parser: "windows-envelope",
    purpose: fields.purpose,
    phase: "collector-v1",
    privilege: "none",
    sudoRetryOnPermissionDenied: false,
    timeoutMs: 60000,
    ...(fields.sensitiveFields
      ? { sensitiveFields: Object.freeze([...fields.sensitiveFields]) }
      : {}),
  });
}
