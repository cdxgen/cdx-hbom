/**
 * Linux commands used for collector enrichment when available.
 *
 * The Linux collector primarily relies on `/proc` and `/sys` so it can work on
 * minimal hosts, but these commands provide structured enrichment when present.
 *
 * @type {ReadonlyArray<{
 *   id: string,
 *   category: string,
 *   command: string,
 *   args: string[],
 *   parser: string,
 *   purpose: string,
 *   phase: string,
 *   sensitiveFields?: string[],
 *   privilege?: "none" | "optional" | "required"
 * }>}
 */
export const LINUX_COMMON_COMMANDS = Object.freeze([
  Object.freeze({
    id: "lscpu-json",
    category: "cpu-memory",
    command: "lscpu",
    args: ["-J"],
    parser: "lscpu-json",
    purpose: "Collect structured CPU topology and architecture information.",
    phase: "collector-v1",
  }),
  Object.freeze({
    id: "lsblk-json",
    category: "storage",
    command: "lsblk",
    args: ["-J", "-b", "-O"],
    parser: "lsblk-json",
    purpose: "Collect structured block-device inventory and size metadata.",
    phase: "collector-v1",
    sensitiveFields: ["serial", "wwn"],
  }),
  Object.freeze({
    id: "ip-link-json",
    category: "network",
    command: "ip",
    args: ["-j", "link", "show"],
    parser: "ip-link-json",
    purpose: "Collect structured network interface details.",
    phase: "collector-v1",
    sensitiveFields: ["address", "permaddr"],
  }),
  Object.freeze({
    id: "lsmem-json",
    category: "cpu-memory",
    command: "lsmem",
    args: ["--json"],
    parser: "lsmem-json",
    purpose:
      "Collect structured Linux memory range information when available.",
    phase: "collector-v1",
  }),
  Object.freeze({
    id: "hostnamectl-json",
    category: "platform",
    command: "hostnamectl",
    args: ["--json=short", "status"],
    parser: "json",
    purpose:
      "Collect host chassis and firmware metadata on systemd systems when available.",
    phase: "collector-v1",
    sensitiveFields: ["HardwareSerial"],
  }),
  Object.freeze({
    id: "lspci-vmmnn",
    category: "bus",
    command: "lspci",
    args: ["-Dvmmnnk"],
    parser: "lspci-vmmnn",
    purpose:
      "Collect PCI bus, controller, and kernel driver inventory when lspci is available.",
    phase: "collector-v1",
  }),
  Object.freeze({
    id: "lsusb",
    category: "bus",
    command: "lsusb",
    args: [],
    parser: "lsusb-text",
    purpose: "Collect USB device inventory when lsusb is available.",
    phase: "collector-v1",
  }),
  Object.freeze({
    id: "lsusb-verbose",
    category: "bus",
    command: "lsusb",
    args: ["-v"],
    parser: "lsusb-verbose-text",
    purpose:
      "Collect richer USB descriptor metadata including class, power, and interface details when lsusb is available.",
    phase: "collector-v1",
    sensitiveFields: ["iSerial"],
  }),
  Object.freeze({
    id: "ethtool-driver-info",
    category: "network",
    command: "ethtool",
    args: ["-i", "<interface>"],
    parser: "ethtool-driver-info",
    purpose:
      "Collect per-interface network driver and firmware metadata when ethtool is available. The collector substitutes the interface name at runtime.",
    phase: "collector-v1",
  }),
  Object.freeze({
    id: "cpupower-frequency-info",
    category: "cpu-memory",
    command: "cpupower",
    args: ["frequency-info"],
    parser: "cpupower-frequency-info-text",
    purpose:
      "Collect CPU frequency driver, governor, and boost policy metadata when cpupower is available.",
    phase: "collector-v1",
  }),
  Object.freeze({
    id: "cpupower-idle-info",
    category: "cpu-memory",
    command: "cpupower",
    args: ["idle-info"],
    parser: "cpupower-idle-info-text",
    purpose:
      "Collect CPU idle driver, governor, and idle-state topology when cpupower is available.",
    phase: "collector-v1",
  }),
  Object.freeze({
    id: "drm-info-json",
    category: "graphics",
    command: "drm_info",
    args: ["-j"],
    parser: "drm-info-json",
    purpose:
      "Collect richer DRM/KMS graphics adapter and connector metadata when drm_info is available.",
    phase: "collector-v1",
    privilege: "optional",
  }),
  Object.freeze({
    id: "upower-dump",
    category: "power",
    command: "upower",
    args: ["--dump"],
    parser: "upower-dump-text",
    purpose:
      "Collect user-session power and battery state from UPower when available.",
    phase: "collector-v1",
    sensitiveFields: ["serial"],
  }),
  Object.freeze({
    id: "fwupdmgr-devices-json",
    category: "platform",
    command: "fwupdmgr",
    args: ["get-devices", "--json"],
    parser: "fwupdmgr-devices-json",
    purpose:
      "Collect firmware-update-capable device inventory from fwupd when available.",
    phase: "collector-v1",
    sensitiveFields: ["Serial", "InstanceIds"],
  }),
  Object.freeze({
    id: "boltctl-domains",
    category: "bus",
    command: "boltctl",
    args: ["domains", "--verbose"],
    parser: "boltctl-text",
    purpose:
      "Collect Thunderbolt/USB4 domain topology from boltctl when available.",
    phase: "collector-v1",
    sensitiveFields: ["uuid"],
  }),
  Object.freeze({
    id: "boltctl-list-all",
    category: "bus",
    command: "boltctl",
    args: ["list", "--all"],
    parser: "boltctl-text",
    purpose:
      "Collect Thunderbolt/USB4 device inventory from boltctl when available.",
    phase: "collector-v1",
    sensitiveFields: ["uuid"],
  }),
  Object.freeze({
    id: "mmcli-list-json",
    category: "network",
    command: "mmcli",
    args: ["-L", "-J"],
    parser: "mmcli-list-json",
    purpose: "Collect modem inventory from ModemManager when available.",
    phase: "collector-v1",
  }),
  Object.freeze({
    id: "mmcli-modem-json",
    category: "network",
    command: "mmcli",
    args: ["-m", "<modem-path>", "-J"],
    parser: "mmcli-json",
    purpose:
      "Collect per-modem detail from ModemManager when available. The collector substitutes the modem object path at runtime.",
    phase: "collector-v1",
    sensitiveFields: ["equipment-id", "imei", "own-numbers"],
  }),
  Object.freeze({
    id: "edid-decode",
    category: "graphics",
    command: "edid-decode",
    args: ["<edid-path>"],
    parser: "edid-decode-text",
    purpose:
      "Collect richer display capability metadata from decoded EDID text when edid-decode is available. The collector substitutes the per-connector EDID sysfs path at runtime.",
    phase: "collector-v1",
  }),
  Object.freeze({
    id: "dmidecode-firmware-board",
    category: "platform",
    command: "dmidecode",
    args: ["-t", "bios", "-t", "baseboard", "-t", "system"],
    parser: "dmidecode-text",
    purpose:
      "Privileged enrichment for SMBIOS firmware and board metadata when permissions permit.",
    phase: "planned-enrichment",
    sensitiveFields: ["Serial Number", "UUID"],
    privilege: "required",
  }),
  Object.freeze({
    id: "lshw-json",
    category: "platform",
    command: "lshw",
    args: ["-json"],
    parser: "json",
    purpose:
      "Planned enrichment for broader Linux hardware topology using lshw.",
    phase: "planned-enrichment",
    sensitiveFields: ["serial"],
  }),
]);
