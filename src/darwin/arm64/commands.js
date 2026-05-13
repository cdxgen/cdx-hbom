/**
 * Data types requested from `system_profiler` for the initial Darwin arm64 collector.
 *
 * @type {readonly string[]}
 */
export const DARWIN_ARM64_SYSTEM_PROFILER_TYPES = Object.freeze([
  "SPHardwareDataType",
  "SPMemoryDataType",
  "SPNVMeDataType",
  "SPDisplaysDataType",
  "SPNetworkDataType",
  "SPUSBDataType",
  "SPAirPortDataType",
  "SPAudioDataType",
  "SPCameraDataType",
  "SPBluetoothDataType",
  "SPThunderboltDataType",
  "SPPowerDataType",
]);

/**
 * Ordered `sysctl` keys used by the initial collector.
 *
 * @type {readonly string[]}
 */
export const DARWIN_ARM64_SYSCTL_KEYS = Object.freeze([
  "machdep.cpu.brand_string",
  "hw.memsize",
  "hw.model",
  "hw.ncpu",
  "hw.logicalcpu",
  "hw.physicalcpu",
]);

/**
 * Darwin arm64 command registry.
 *
 * Commands marked `collector-v1` are executed by the initial collector.
 * Commands marked `planned-enrichment` are documented for later use.
 *
 * @type {ReadonlyArray<{
 *   id: string,
 *   category: string,
 *   command: string,
 *   args: string[],
 *   parser: string,
 *   purpose: string,
 *   phase: string,
 *   sensitiveFields?: string[]
 * }>}
 */
export const DARWIN_ARM64_COMMANDS = Object.freeze([
  Object.freeze({
    id: "system-profiler-json",
    category: "platform",
    command: "/usr/sbin/system_profiler",
    args: [...DARWIN_ARM64_SYSTEM_PROFILER_TYPES, "-json"],
    parser: "json",
    purpose:
      "Collect structured Apple Silicon hardware, memory, storage, display, networking, Bluetooth, Thunderbolt, and power inventory.",
    phase: "collector-v1",
    sensitiveFields: [
      "serial_number",
      "platform_UUID",
      "provisioning_UDID",
      "device_serial",
      "serial_num",
      "_spdisplays_display-serial-number",
      "spcamera_unique-id",
      "spairport_wireless_mac_address",
      "controller_address",
      "device_address",
      "device_serialNumber",
      "device_serialNumberLeft",
      "device_serialNumberRight",
      "domain_uuid_key",
      "switch_uid_key",
      "sppower_battery_serial_number",
    ],
  }),
  Object.freeze({
    id: "sysctl-baseline",
    category: "cpu-memory",
    command: "/usr/sbin/sysctl",
    args: ["-n", ...DARWIN_ARM64_SYSCTL_KEYS],
    parser: "ordered-lines",
    purpose:
      "Collect low-latency CPU brand, memory bytes, model identifier, and core counts to cross-check system_profiler data.",
    phase: "collector-v1",
  }),
  Object.freeze({
    id: "network-hardware-ports",
    category: "network",
    command: "/usr/sbin/networksetup",
    args: ["-listallhardwareports"],
    parser: "hardware-port-blocks",
    purpose:
      "Map friendly hardware port names to BSD device names and MAC addresses.",
    phase: "collector-v1",
    sensitiveFields: ["Ethernet Address"],
  }),
  Object.freeze({
    id: "battery-status",
    category: "power",
    command: "/usr/bin/pmset",
    args: ["-g", "batt"],
    parser: "pmset-battery",
    purpose:
      "Capture current battery percentage, charging state, and external power attachment.",
    phase: "collector-v1",
  }),
  Object.freeze({
    id: "platform-registry",
    category: "platform",
    command: "/usr/sbin/ioreg",
    args: ["-a", "-rd1", "-c", "IOPlatformExpertDevice"],
    parser: "plist",
    purpose:
      "Planned enrichment for low-level Apple platform model and registry-backed identifiers via plist output.",
    phase: "planned-enrichment",
    sensitiveFields: [
      "IOPlatformSerialNumber",
      "IOPlatformUUID",
      "serial-number",
    ],
  }),
  Object.freeze({
    id: "storage-plist",
    category: "storage",
    command: "/usr/sbin/diskutil",
    args: ["info", "-plist", "disk0"],
    parser: "plist",
    purpose:
      "Planned enrichment for richer storage media and controller information.",
    phase: "planned-enrichment",
  }),
  Object.freeze({
    id: "apfs-topology",
    category: "storage",
    command: "/usr/sbin/diskutil",
    args: ["apfs", "list", "-plist"],
    parser: "plist",
    purpose:
      "Planned enrichment for APFS container and volume topology when plist enrichment is enabled.",
    phase: "planned-enrichment",
    sensitiveFields: ["APFSContainerUUID", "APFSVolumeUUID"],
  }),
  Object.freeze({
    id: "interface-details",
    category: "network",
    command: "/sbin/ifconfig",
    args: ["en0"],
    parser: "ifconfig-text",
    purpose:
      "Planned enrichment for live interface media, MTU, and operational status.",
    phase: "planned-enrichment",
    sensitiveFields: ["ether"],
  }),
  Object.freeze({
    id: "os-version",
    category: "metadata",
    command: "/usr/bin/sw_vers",
    args: [],
    parser: "sw-vers-text",
    purpose:
      "Planned metadata enrichment for Darwin version and build context.",
    phase: "planned-enrichment",
  }),
]);
