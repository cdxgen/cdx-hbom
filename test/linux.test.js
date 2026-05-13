import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildLinuxHbom,
  parseAsoundCards,
  parseAsoundPcm,
  parseBoltctlText,
  parseCpuInfo,
  parseCpupowerFrequencyInfo,
  parseCpupowerIdleInfo,
  parseDmidecodeText,
  parseDrmInfoJson,
  parseEdidBuffer,
  parseEdidDecodeText,
  parseEthtoolDriverInfo,
  parseFwupdmgrDevicesJson,
  parseHostnamectlJson,
  parseHwmonAttributes,
  parseIpLinkJson,
  parseLsblkJson,
  parseLscpuJson,
  parseLshwJson,
  parseLsmemJson,
  parseLspciVmmnn,
  parseLsusbText,
  parseLsusbVerboseText,
  parseMemInfo,
  parseMmcliJson,
  parseMmcliListJson,
  parseOsRelease,
  parseUpowerDump,
} from "../src/linux/common/index.js";

test("parseOsRelease parses shell-style key/value pairs", () => {
  const parsed = parseOsRelease(`NAME="Ubuntu"
VERSION="24.04.2 LTS (Noble Numbat)"
ID=ubuntu
VERSION_ID="24.04"
PRETTY_NAME="Ubuntu 24.04.2 LTS"
`);

  assert.deepEqual(parsed, {
    NAME: "Ubuntu",
    VERSION: "24.04.2 LTS (Noble Numbat)",
    ID: "ubuntu",
    VERSION_ID: "24.04",
    PRETTY_NAME: "Ubuntu 24.04.2 LTS",
  });
});

test("parseCpuInfo parses Linux processor sections", () => {
  const parsed = parseCpuInfo(`processor	: 0
vendor_id	: GenuineIntel
cpu family	: 6
model		: 154
model name	: Intel(R) Core(TM) Ultra 7 165H
stepping	: 4
cpu cores	: 16
physical id	: 0

processor	: 1
vendor_id	: GenuineIntel
cpu family	: 6
model		: 154
model name	: Intel(R) Core(TM) Ultra 7 165H
stepping	: 4
cpu cores	: 16
physical id	: 0
`);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]["model name"], "Intel(R) Core(TM) Ultra 7 165H");
  assert.equal(parsed[0].vendor_id, "GenuineIntel");
});

test("parseMemInfo parses numeric memory values", () => {
  const parsed = parseMemInfo(`MemTotal:       64000000 kB
MemFree:         5120000 kB
`);

  assert.deepEqual(parsed, {
    MemTotal: { value: 64000000, unit: "kB" },
    MemFree: { value: 5120000, unit: "kB" },
  });
});

test("parseLscpuJson parses lscpu JSON rows into a simple map", () => {
  const parsed = parseLscpuJson(`{
  "lscpu": [
    { "field": "Architecture:", "data": "x86_64" },
    { "field": "CPU(s):", "data": "22" },
    { "field": "Socket(s):", "data": "1" },
    { "field": "Core(s) per socket:", "data": "16" },
    { "field": "Thread(s) per core:", "data": "2" },
    { "field": "Model name:", "data": "Intel(R) Core(TM) Ultra 7 165H" },
    { "field": "Vendor ID:", "data": "GenuineIntel" }
  ]
}`);

  assert.equal(parsed.Architecture, "x86_64");
  assert.equal(parsed["CPU(s)"], "22");
  assert.equal(parsed["Model name"], "Intel(R) Core(TM) Ultra 7 165H");
});

test("parseLsblkJson flattens disk devices from lsblk JSON", () => {
  const parsed = parseLsblkJson(`{
  "blockdevices": [
    {
      "name": "nvme0n1",
      "type": "disk",
      "model": "Samsung SSD",
      "vendor": "Samsung",
      "serial": "S123456",
      "tran": "nvme",
      "size": 1024209543168,
      "rm": false,
      "rota": false,
      "log_sec": 512,
      "children": [
        { "name": "nvme0n1p1", "type": "part", "size": 1073741824 }
      ]
    }
  ]
}`);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, "nvme0n1");
  assert.equal(parsed[0].serial, "S123456");
});

test("parseIpLinkJson parses ip link JSON arrays", () => {
  const parsed = parseIpLinkJson(`[
  {
    "ifindex": 2,
    "ifname": "eth0",
    "mtu": 1500,
    "operstate": "UP",
    "address": "52:54:00:12:34:56",
    "link_type": "ether"
  }
]`);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].ifname, "eth0");
  assert.equal(parsed[0].operstate, "UP");
});

test("parseHostnamectlJson preserves hostnamectl JSON keys", () => {
  const parsed = parseHostnamectlJson(`{
    "Chassis": "laptop",
    "HardwareVendor": "Dell Inc.",
    "HardwareModel": "XPS 16 9640",
    "FirmwareVersion": "1.10.2",
    "FirmwareDate": "2025-02-10"
  }`);

  assert.equal(parsed.Chassis, "laptop");
  assert.equal(parsed.HardwareVendor, "Dell Inc.");
  assert.equal(parsed.FirmwareVersion, "1.10.2");
});

test("parseLspciVmmnn parses vmmnn PCI records", () => {
  const parsed = parseLspciVmmnn(`Slot:\t0000:00:02.0
Class:\tVGA compatible controller [0300]
Vendor:\tIntel Corporation [8086]
Device:\tArc Graphics [7d55]
Rev:\t08

Slot:\t0000:00:14.0
Class:\tUSB controller [0c03]
Vendor:\tIntel Corporation [8086]
Device:\tUSB 3.2 Gen 2x1 xHCI Host Controller [7ec0]
Driver:\txhci_hcd
Module:\txhci_pci
`);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].Slot, "0000:00:02.0");
  assert.equal(parsed[0].Vendor, "Intel Corporation [8086]");
  assert.equal(parsed[1].Driver, "xhci_hcd");
});

test("parseLsusbText parses lsusb records", () => {
  const parsed =
    parseLsusbText(`Bus 003 Device 002: ID 046d:c52b Logitech, Inc. Unifying Receiver
Bus 001 Device 004: ID 05ac:8514 Apple, Inc. FaceTime HD Camera
`);

  assert.deepEqual(parsed, [
    {
      bus: "003",
      device: "002",
      vendorId: "046d",
      productId: "c52b",
      description: "Logitech, Inc. Unifying Receiver",
    },
    {
      bus: "001",
      device: "004",
      vendorId: "05ac",
      productId: "8514",
      description: "Apple, Inc. FaceTime HD Camera",
    },
  ]);
});

test("parseLsusbVerboseText extracts richer USB descriptor metadata", () => {
  const parsed =
    parseLsusbVerboseText(`Bus 001 Device 002: ID 8087:0029 Intel Corp. AX200 Bluetooth
Device Descriptor:
  bcdUSB               2.01
  bDeviceClass          224 Wireless
  bDeviceSubClass         1 Radio Frequency
  bDeviceProtocol         1 Bluetooth
  idVendor           0x8087 Intel Corp.
  idProduct          0x0029 AX200 Bluetooth
  iManufacturer           1 Intel Corp.
  iProduct                2 AX200 Bluetooth
  iSerial                 3 BT-123456
  bNumConfigurations      1
  Configuration Descriptor:
    bNumInterfaces          2
    bmAttributes         0xe0
      Self Powered
      Remote Wakeup
    MaxPower              100mA
    Interface Descriptor:
      bInterfaceClass       224 Wireless
    Interface Descriptor:
      bInterfaceClass       224 Wireless
`);

  assert.deepEqual(parsed, [
    {
      bus: "001",
      device: "002",
      vendorId: "8087",
      productId: "0029",
      description: "Intel Corp. AX200 Bluetooth",
      version: "2.01",
      deviceClassName: "Wireless",
      deviceSubclassName: "Radio Frequency",
      deviceProtocolName: "Bluetooth",
      manufacturer: "Intel Corp.",
      productName: "AX200 Bluetooth",
      serial: "BT-123456",
      configurationCount: 1,
      interfaceCount: 2,
      maxPowerMilliAmps: 100,
      selfPowered: true,
      remoteWakeup: true,
      interfaceClassNames: ["Wireless"],
    },
  ]);
});

test("parseCpupowerFrequencyInfo parses driver, governor, and boost metadata", () => {
  const parsed = parseCpupowerFrequencyInfo(`analyzing CPU 13:
  driver: amd-pstate-epp
  hardware limits: 400 MHz - 5.10 GHz
  available cpufreq governors: performance powersave
  current policy: frequency should be within 400 MHz and 5.10 GHz.
                  The governor "performance" may decide which speed to use
                  within this range.
  current CPU frequency: Unable to call hardware
  current CPU frequency: 4.09 GHz (asserted by call to kernel)
  boost state support:
    Supported: yes
    Active: yes
    AMD PSTATE Highest Performance: 196. Maximum Frequency: 5.10 GHz.
    AMD PSTATE Nominal Performance: 146. Nominal Frequency: 3.80 GHz.
    AMD PSTATE Lowest Non-linear Performance: 42. Lowest Non-linear Frequency: 1.09 GHz.
    AMD PSTATE Lowest Performance: 16. Lowest Frequency: 400 MHz.
`);

  assert.deepEqual(parsed, {
    driver: "amd-pstate-epp",
    hardwareMin: "400 MHz",
    hardwareMax: "5.10 GHz",
    availableGovernors: ["performance", "powersave"],
    policyMin: "400 MHz",
    policyMax: "5.10 GHz",
    governor: "performance",
    currentFrequencies: [
      "Unable to call hardware",
      "4.09 GHz (asserted by call to kernel)",
    ],
    boostSupported: true,
    boostActive: true,
    highestPerformance: 196,
    maximumFrequency: "5.10 GHz",
    nominalPerformance: 146,
    nominalFrequency: "3.80 GHz",
    lowestNonLinearPerformance: 42,
    lowestNonLinearFrequency: "1.09 GHz",
    lowestPerformance: 16,
    lowestFrequency: "400 MHz",
  });
});

test("parseCpupowerIdleInfo parses idle driver, governor, and states", () => {
  const parsed = parseCpupowerIdleInfo(`CPUidle driver: acpi_idle
CPUidle governor: menu

Number of idle states: 3
Available idle states: POLL C1 C2
POLL:
Flags/Description: CPUIDLE CORE POLL IDLE
Latency: 0
Usage: 10
Duration: 11
C1:
Flags/Description: ACPI FFH MWAIT 0x0
Latency: 1
Usage: 20
Duration: 22
C2:
Flags/Description: ACPI IOPORT 0x414
Latency: 18
Usage: 30
Duration: 33
`);

  assert.deepEqual(parsed, {
    driver: "acpi_idle",
    governor: "menu",
    idleStateCount: 3,
    availableIdleStates: ["POLL", "C1", "C2"],
    idleStates: [
      {
        name: "POLL",
        description: "CPUIDLE CORE POLL IDLE",
        latency: 0,
        usage: 10,
        duration: 11,
      },
      {
        name: "C1",
        description: "ACPI FFH MWAIT 0x0",
        latency: 1,
        usage: 20,
        duration: 22,
      },
      {
        name: "C2",
        description: "ACPI IOPORT 0x414",
        latency: 18,
        usage: 30,
        duration: 33,
      },
    ],
  });
});

test("parseDrmInfoJson normalizes DRM cards and connectors", () => {
  const parsed = parseDrmInfoJson(`{
    "/dev/dri/card1": {
      "driver": {
        "name": "vc4",
        "desc": "Broadcom VC4 graphics",
        "version": { "major": 0, "minor": 0, "patch": 0 },
        "kernel": {
          "release": "6.8.0-1053-raspi",
          "version": "#57-Ubuntu"
        },
        "client_caps": { "ATOMIC": true, "ASPECT_RATIO": true },
        "caps": { "DUMB_BUFFER": 1 }
      },
      "device": {
        "available_nodes": 1,
        "bus_type": 2,
        "device_data": { "compatible": ["brcm,bcm2712d0-vc6"] },
        "bus_data": { "fullname": "/axi/gpu" }
      },
      "fb_size": {
        "min_width": 0,
        "max_width": 8192,
        "min_height": 0,
        "max_height": 8192
      },
      "connectors": [
        {
          "id": 32,
          "type": 11,
          "status": 1,
          "phy_width": 600,
          "phy_height": 340,
          "subpixel": 1,
          "encoder_id": 31,
          "encoders": [31],
          "modes": [
            { "name": "3840x2160", "hdisplay": 3840, "vdisplay": 2160 }
          ],
          "properties": {
            "DPMS": {
              "value": 0,
              "spec": [{ "name": "On", "value": 0 }]
            },
            "link-status": {
              "value": 0,
              "spec": [{ "name": "Good", "value": 0 }]
            },
            "non-desktop": { "value": 0 },
            "max bpc": { "value": 12 },
            "Colorspace": {
              "value": 0,
              "spec": [{ "name": "Default", "value": 0 }]
            }
          }
        }
      ]
    }
  }`);

  assert.deepEqual(parsed.cards, [
    {
      name: "card1",
      kind: "card",
      drmNode: "/dev/dri/card1",
      driver: "vc4",
      driverDescription: "Broadcom VC4 graphics",
      driverVersion: "0.0.0",
      kernelRelease: "6.8.0-1053-raspi",
      kernelVersion: "#57-Ubuntu",
      clientCaps: { ATOMIC: true, ASPECT_RATIO: true },
      caps: { DUMB_BUFFER: 1 },
      availableNodes: 1,
      drmBusType: "platform",
      vendorId: undefined,
      productId: undefined,
      subsystemVendorId: undefined,
      subsystemDeviceId: undefined,
      pciSlot: undefined,
      ofCompatible: ["brcm,bcm2712d0-vc6"],
      ofFullname: "/axi/gpu",
      framebuffer: {
        min_width: 0,
        max_width: 8192,
        min_height: 0,
        max_height: 8192,
      },
    },
  ]);
  assert.deepEqual(parsed.connectors, [
    {
      cardName: "card1",
      kind: "connector",
      drmConnectorId: 32,
      connectorType: "HDMI-A",
      connectorTypeCode: 11,
      status: "connected",
      statusCode: 1,
      physicalWidthMm: 600,
      physicalHeightMm: 340,
      subpixel: 1,
      encoderId: 31,
      encoderIds: [31],
      modes: ["3840x2160"],
      dpms: "On",
      linkStatus: "Good",
      nonDesktop: 0,
      maxBpc: 12,
      colorspace: "Default",
      contentProtection: undefined,
      crtcId: undefined,
      variableRefreshEnabled: undefined,
      name: "card1-HDMI-A-1",
    },
  ]);
});

test("parseBoltctlText extracts Thunderbolt domain and device properties", () => {
  const parsed = parseBoltctlText(` ● domain0
   ├─ uuid:          11111111-2222-3333-4444-555555555555
   ├─ status:        online
   ├─ security:      user
   ├─ iommu:         yes
   ├─ rx speed:      40 Gb/s
   ├─ tx speed:      40 Gb/s

 ● CalDigit TS4
   ├─ vendor:        CalDigit
   ├─ uuid:          99999999-aaaa-bbbb-cccc-dddddddddddd
   ├─ type:          peripheral
   ├─ generation:    Thunderbolt 4
   ├─ status:        authorized
   │  authorized:    2026-05-13 12:00:00 UTC
`);

  assert.deepEqual(parsed, [
    {
      name: "domain0",
      uuid: "11111111-2222-3333-4444-555555555555",
      status: "online",
      security: "user",
      iommu: "yes",
      rxSpeed: "40 Gb/s",
      txSpeed: "40 Gb/s",
    },
    {
      name: "CalDigit TS4",
      vendor: "CalDigit",
      uuid: "99999999-aaaa-bbbb-cccc-dddddddddddd",
      type: "peripheral",
      generation: "Thunderbolt 4",
      status: "authorized",
      authorized: "2026-05-13 12:00:00 UTC",
    },
  ]);
});

test("parseMmcli JSON helpers normalize modem list and detail output", () => {
  const list = parseMmcliListJson(`{
    "modem-list": [
      { "modem-path": "/org/freedesktop/ModemManager1/Modem/0" }
    ]
  }`);
  const detail = parseMmcliJson(`{
    "modem": {
      "generic": {
        "manufacturer": "Quectel",
        "model": "RM500Q-GL",
        "revision": "RM500QGLABR11A06M4G",
        "plugin": "quectel",
        "drivers": ["qmi_wwan", "option"],
        "equipment-id": "359072060001234"
      },
      "status": {
        "state": "registered",
        "signal-quality": { "value": 72, "recent": true },
        "access-technologies": "lte, 5gnr"
      },
      "3gpp": {
        "operator-name": "ExampleTel",
        "imei": "359072060001234"
      },
      "own-numbers": ["+15551234567"],
      "sim-slots": ["/org/freedesktop/ModemManager1/SIM/0"]
    }
  }`);

  assert.deepEqual(list, [
    {
      modemPath: "/org/freedesktop/ModemManager1/Modem/0",
    },
  ]);
  assert.equal(detail.modem.generic.manufacturer, "Quectel");
  assert.equal(detail.modem.status.signalQuality.value, 72);
  assert.equal(detail.modem["3gpp"].operatorName, "ExampleTel");
});

test("parseUpowerDump extracts display device and daemon state", () => {
  const parsed =
    parseUpowerDump(`Device: /org/freedesktop/UPower/devices/DisplayDevice
  power supply:         yes
  updated:              Wed May 13 15:27:59 2026
  has history:          yes
  has statistics:       no
  battery
    present:             yes
    state:               discharging
    warning-level:       none
    percentage:          84%
    energy:              62.1 Wh
    energy-full:         74.0 Wh
    energy-full-design:  82.0 Wh
    energy-rate:         37.0 W
    voltage:             15.234 V
    vendor:              SMP
    model:               DELL M59JH45
    serial:              BATT-12345

Daemon:
  daemon-version:  1.90.3
  on-battery:      yes
  lid-is-present:  yes
`);

  assert.equal(parsed.displayDevice?.deviceType, "battery");
  assert.equal(parsed.displayDevice?.percentage, 84);
  assert.equal(parsed.displayDevice?.warningLevel, "none");
  assert.equal(parsed.daemon.onBattery, true);
  assert.equal(parsed.daemon.daemonVersion, "1.90.3");
});

test("parseFwupdmgrDevicesJson normalizes fwupd device arrays", () => {
  const parsed = parseFwupdmgrDevicesJson(`{
    "Devices": [
      {
        "Name": "Acer SSD FA100 256GB",
        "Plugin": "nvme",
        "Version": "1.4.6.57",
        "Vendor": "Biwin Storage Technology Co., Ltd.",
        "VendorId": "NVME:0x1DEE",
        "Guid": ["9e02e500-1f91-54f6-a50a-10ad5ab020d5"],
        "InstanceIds": ["NVME\\\\VEN_1DEE&DEV_5216"],
        "Flags": ["updatable", "registered"],
        "Created": 1778220995
      }
    ]
  }`);

  assert.deepEqual(parsed, [
    {
      name: "Acer SSD FA100 256GB",
      plugin: "nvme",
      version: "1.4.6.57",
      vendor: "Biwin Storage Technology Co., Ltd.",
      vendorId: "NVME:0x1DEE",
      guid: ["9e02e500-1f91-54f6-a50a-10ad5ab020d5"],
      instanceIds: ["NVME\\VEN_1DEE&DEV_5216"],
      flags: ["updatable", "registered"],
      created: 1778220995,
    },
  ]);
});

test("parseEdidDecodeText extracts richer display capability metadata", () => {
  const parsed = parseEdidDecodeText(`EDID version: 1.4
Display Product Name: DELL U2720Q
Display Product Serial Number: SN123456
Native detailed mode: 3840x2160p60 533.250 MHz
Image size: 60 cm x 34 cm
Bits per primary color channel: 10
Supported color formats: RGB 4:4:4, YCbCr 4:4:4, YCbCr 4:2:2
Supported EOTF: Traditional SDR, SMPTE ST2084
`);

  assert.deepEqual(parsed, {
    version: "1.4",
    name: "DELL U2720Q",
    serialNumber: "SN123456",
    preferredResolution: "3840x2160p60",
    widthCm: 60,
    heightCm: 34,
    bitsPerColorChannel: 10,
    colorFormats: ["RGB 4:4:4", "YCbCr 4:4:4", "YCbCr 4:2:2"],
    hdrEotf: ["Traditional SDR", "SMPTE ST2084"],
  });
});

test("parseDmidecodeText parses BIOS, system, and baseboard sections", () => {
  const parsed = parseDmidecodeText(`Handle 0x0001, DMI type 1, 27 bytes
System Information
	Manufacturer: Dell Inc.
	Product Name: XPS 16 9640
	Version: 1.0
	Serial Number: ABC123XYZ

Handle 0x0002, DMI type 2, 15 bytes
Base Board Information
	Manufacturer: Dell Inc.
	Product Name: 0T14K5
	Version: A00
	Serial Number: /ABC1234/CN1296375C1234/

Handle 0x0003, DMI type 0, 26 bytes
BIOS Information
	Vendor: Dell Inc.
	Version: 1.10.2
	Release Date: 02/10/2025
	BIOS Revision: 1.10
`);

  assert.equal(parsed.system.Manufacturer, "Dell Inc.");
  assert.equal(parsed.baseboard["Product Name"], "0T14K5");
  assert.equal(parsed.bios.Version, "1.10.2");
});

test("parseAsoundCards parses ALSA card inventory", () => {
  const parsed =
    parseAsoundCards(` 0 [Generic        ]: HDA-Intel - HD-Audio Generic
                      HD-Audio Generic at 0xdc5c8000 irq 115
 2 [acp63          ]: acp63 - acp63
                      AZW-SER8-Defaultstring
`);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].number, 0);
  assert.equal(parsed[0].id, "Generic");
  assert.equal(parsed[0].interfaceType, "HDA-Intel");
  assert.equal(parsed[1].longName, "AZW-SER8-Defaultstring");
});

test("parseAsoundPcm parses ALSA PCM devices", () => {
  const parsed = parseAsoundPcm(`00-03: HDMI 0 : HDMI 0 : playback 1
01-00: ALC897 Analog : ALC897 Analog : playback 1 : capture 1
`);

  assert.deepEqual(parsed, [
    {
      cardNumber: 0,
      deviceNumber: 3,
      id: "HDMI 0",
      name: "HDMI 0",
      playbackCount: 1,
      captureCount: undefined,
    },
    {
      cardNumber: 1,
      deviceNumber: 0,
      id: "ALC897 Analog",
      name: "ALC897 Analog",
      playbackCount: 1,
      captureCount: 1,
    },
  ]);
});

test("parseEdidBuffer extracts basic monitor identity and preferred timing", () => {
  const edid = createSampleEdidBuffer();
  const parsed = parseEdidBuffer(edid);

  assert.deepEqual(parsed, {
    manufacturerId: "DEL",
    productId: "a06b",
    serialNumber: "SN123456",
    name: "DELL U2720Q",
    weekOfManufacture: 12,
    yearOfManufacture: 2024,
    version: "1.4",
    widthCm: 60,
    heightCm: 34,
    preferredResolution: "3840x2160",
  });
});

test("parseHwmonAttributes normalizes hwmon temperature and fan sensors", () => {
  const parsed = parseHwmonAttributes({
    name: "nvme",
    temp1_input: "38850",
    temp1_label: "Composite",
    temp2_input: "45850",
    temp2_label: "Sensor 1",
    fan1_input: "1200",
    fan1_label: "cpu fan",
    pwm1: "90",
  });

  assert.deepEqual(parsed, {
    name: "nvme",
    temperatureSensors: [
      { label: "Composite", valueCelsius: 38.85, valueRpm: undefined },
      { label: "Sensor 1", valueCelsius: 45.85, valueRpm: undefined },
    ],
    fanSensors: [{ label: "cpu fan", valueCelsius: undefined, valueRpm: 1200 }],
    pwmValues: [90],
  });
});

test("buildLinuxHbom creates a CycloneDX 1.7 BOM for linux amd64 fixtures", () => {
  const bom = buildLinuxHbom({
    architecture: "amd64",
    collectedAt: "2026-05-12T00:00:00.000Z",
    observedFiles: ["/etc/os-release", "/proc/cpuinfo"],
    executedCommands: [
      {
        id: "lscpu-json",
        category: "cpu-memory",
        command: "lscpu",
        args: ["-J"],
      },
    ],
    sources: {
      osRelease: {
        NAME: "Ubuntu",
        VERSION_ID: "24.04",
      },
      cpuInfo: [
        {
          processor: "0",
          vendor_id: "GenuineIntel",
          "cpu family": "6",
          model: "154",
          stepping: "4",
          "model name": "Intel(R) Core(TM) Ultra 7 165H",
          "cpu cores": "16",
          "physical id": "0",
        },
        {
          processor: "1",
          vendor_id: "GenuineIntel",
          "model name": "Intel(R) Core(TM) Ultra 7 165H",
          "cpu cores": "16",
          "physical id": "0",
        },
      ],
      memInfo: {
        MemTotal: { value: 64000000, unit: "kB" },
      },
      dmiInfo: {
        sys_vendor: "Dell Inc.",
        product_name: "XPS 16 9640",
        product_version: "1.0",
        product_serial: "ABC123XYZ",
        product_uuid: "2f0fd4b6-9380-4f9d-a6fd-000000000001",
        board_vendor: "Dell Inc.",
        board_name: "0T14K5",
        board_version: "A00",
        board_serial: "/ABC1234/CN1296375C1234/",
        bios_vendor: "Dell Inc.",
        bios_version: "1.10.2",
        bios_date: "2025-02-10",
        chassis_type: "laptop",
      },
      networkInterfaces: [
        {
          name: "eth0",
          ifname: "eth0",
          address: "52:54:00:12:34:56",
          operstate: "up",
          mtu: 1500,
          speedMbps: 2500,
          duplex: "full",
          ifindex: 2,
          linkType: "1",
        },
      ],
      blockDevices: [
        {
          name: "nvme0n1",
          model: "Samsung SSD 990 PRO",
          vendor: "Samsung",
          serial: "S123456789",
          size: 1024209543168,
          removable: false,
          rotational: false,
          subsystem: "block",
          transport: "nvme",
          logicalBlockSize: 512,
        },
      ],
      powerSupplies: [
        {
          name: "BAT0",
          type: "Battery",
          status: "Charging",
          capacity: 84,
          cycleCount: 42,
          manufacturer: "SMP",
          modelName: "DELL M59JH45",
          serialNumber: "BATT-12345",
          technology: "Li-ion",
        },
        {
          name: "AC",
          type: "Mains",
          online: 1,
        },
      ],
      lscpu: {
        Architecture: "x86_64",
        "CPU(s)": "22",
        "Socket(s)": "1",
        "Core(s) per socket": "16",
        "Thread(s) per core": "2",
        "Model name": "Intel(R) Core(TM) Ultra 7 165H",
        "Vendor ID": "GenuineIntel",
      },
      hostnamectl: {
        Chassis: "laptop",
        HardwareVendor: "Dell Inc.",
        HardwareModel: "XPS 16 9640",
        FirmwareVersion: "1.10.2",
        FirmwareDate: "2025-02-10",
      },
      pciDevices: [
        {
          Slot: "0000:00:02.0",
          Class: "VGA compatible controller [0300]",
          Vendor: "Intel Corporation [8086]",
          Device: "Arc Graphics [7d55]",
          Rev: "08",
        },
      ],
      usbDevices: [
        {
          bus: "003",
          device: "002",
          vendorId: "046d",
          productId: "c52b",
          description: "Logitech, Inc. Unifying Receiver",
        },
      ],
      dmidecode: {
        system: {
          Manufacturer: "Dell Inc.",
          "Product Name": "XPS 16 9640",
        },
        baseboard: {
          Manufacturer: "Dell Inc.",
          "Product Name": "0T14K5",
          Version: "A00",
          "Serial Number": "/ABC1234/CN1296375C1234/",
        },
        bios: {
          Vendor: "Dell Inc.",
          Version: "1.10.2",
          "Release Date": "02/10/2025",
          "BIOS Revision": "1.10",
        },
      },
    },
  });

  assert.equal(bom.$schema, "http://cyclonedx.org/schema/bom-1.7.schema.json");
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.7");
  assert.equal(bom.metadata.component.name, "XPS 16 9640");
  assert.equal(bom.metadata.component.manufacturer.name, "Dell Inc.");
  assert.equal(
    bom.metadata.component.properties.find(
      (property) => property.name === "cdx:hbom:serialNumber",
    )?.value,
    "redacted:3XYZ",
  );
  assert.ok(hasHardwareClass(bom.components, "processor"));
  assert.ok(hasHardwareClass(bom.components, "memory"));
  assert.ok(hasHardwareClass(bom.components, "storage"));
  assert.ok(hasHardwareClass(bom.components, "network-interface"));
  assert.ok(hasHardwareClass(bom.components, "board"));
  assert.ok(hasHardwareClass(bom.components, "chassis"));
  assert.ok(hasHardwareClass(bom.components, "pci-device"));
  assert.ok(hasHardwareClass(bom.components, "usb-device"));
  assert.ok(hasHardwareClass(bom.components, "power"));
  assert.ok(hasHardwareClass(bom.components, "power-adapter"));
  assert.ok(bom.components.some((component) => component.type === "firmware"));
  assert.equal(
    bom.properties.find(
      (property) => property.name === "cdx:hbom:targetPlatform",
    )?.value,
    "linux",
  );
  assert.equal(
    bom.properties.find(
      (property) => property.name === "cdx:hbom:evidence:fileCount",
    )?.value,
    "2",
  );
  assert.equal(
    bom.components.find(
      (component) =>
        getPropertyValue(component, "cdx:hbom:hardwareClass") === "board",
    )?.name,
    "0T14K5",
  );
  assert.equal(
    bom.components.find((component) => component.type === "firmware")?.version,
    "1.10.2",
  );
});

test("buildLinuxHbom creates a CycloneDX 1.7 BOM for linux arm64 fixtures", () => {
  const bom = buildLinuxHbom({
    architecture: "arm64",
    sources: {
      osRelease: {
        NAME: "Ubuntu",
      },
      cpuInfo: [
        {
          processor: "0",
          Processor: "ARMv8 Processor rev 1 (v8l)",
        },
      ],
      memInfo: {
        MemTotal: { value: 8192000, unit: "kB" },
      },
      dmiInfo: {
        product_name: "Ampere Dev Platform",
        sys_vendor: "Ampere",
      },
    },
  });

  assert.equal(bom.metadata.component.name, "Ampere Dev Platform");
  assert.ok(hasHardwareClass(bom.components, "processor"));
  assert.equal(
    bom.components.find(
      (component) =>
        getPropertyValue(component, "cdx:hbom:hardwareClass") === "processor",
    )?.version,
    "arm64",
  );
});

test("real amd64 fixtures from mini-dev-2 parse successfully", () => {
  const lscpu = parseLscpuJson(readFixture("linux/amd64/lscpu.json"));
  const hostnamectl = parseHostnamectlJson(
    readFixture("linux/amd64/hostnamectl.json"),
  );
  const lspci = parseLspciVmmnn(readFixture("linux/amd64/lspci.vmmnn"));
  const lsusb = parseLsusbText(readFixture("linux/amd64/lsusb.txt"));
  const ipLink = parseIpLinkJson(readFixture("linux/amd64/ip-link.json"));
  const lsmem = parseLsmemJson(readFixture("linux/amd64/lsmem.json"));
  const lshw = parseLshwJson(readFixture("linux/amd64/lshw.json"));
  const dmidecode = parseDmidecodeText(
    readFixture("linux/amd64/dmidecode.txt"),
  );
  const ethtool = parseEthtoolFixture(readFixture("linux/amd64/ethtool.txt"));

  assert.equal(lscpu.Architecture, "x86_64");
  assert.equal(hostnamectl.HardwareModel, "NucBox K8 Plus");
  assert.ok(lspci.length > 10);
  assert.ok(lsusb.length >= 2);
  assert.ok(ipLink.some((entry) => entry.ifname === "enp3s0"));
  assert.equal(lsmem.length, 1);
  assert.equal(lshw[0].product, undefined);
  assert.equal(dmidecode.system["Product Name"], "NucBox K8 Plus");
  assert.equal(ethtool.eno1.driver, "igc");
  assert.equal(
    ethtool.wlp4s0["firmware-version"],
    "77.b405f9d4.0 cc-a0-77.ucode",
  );
});

test("real arm64 fixtures from pi5 parse successfully", () => {
  const lscpu = parseLscpuJson(readFixture("linux/arm64/lscpu.json"));
  const hostnamectl = parseHostnamectlJson(
    readFixture("linux/arm64/hostnamectl.json"),
  );
  const lspci = parseLspciVmmnn(readFixture("linux/arm64/lspci.vmmnn"));
  const lsusb = parseLsusbText(readFixture("linux/arm64/lsusb.txt"));
  const ipLink = parseIpLinkJson(readFixture("linux/arm64/ip-link.json"));
  const lshw = parseLshwJson(readFixture("linux/arm64/lshw.json"));
  const dmidecode = parseDmidecodeText(
    readFixture("linux/arm64/dmidecode.txt"),
  );
  const ethtool = parseEthtoolFixture(readFixture("linux/arm64/ethtool.txt"));

  assert.equal(lscpu.Architecture, "aarch64");
  assert.equal(hostnamectl.HardwareModel, undefined);
  assert.equal(
    lspci[1].Device,
    "KingSpec NX series NVMe SSD (DRAM-less) [5216]",
  );
  assert.ok(lsusb.length >= 3);
  assert.ok(ipLink.some((entry) => entry.ifname === "wlan0"));
  assert.equal(lshw[0].product, "Raspberry Pi 5 Model B Rev 1.1");
  assert.deepEqual(dmidecode, { system: {}, baseboard: {}, bios: {} });
  assert.equal(ethtool.wlan0.driver, "brcmfmac");
});

test("real captured arm64 fixtures can build a Linux BOM with board and PCI data", () => {
  const bom = buildLinuxHbom({
    architecture: "arm64",
    sources: {
      osRelease: parseOsRelease(`NAME="Ubuntu"\nVERSION_ID="24.04"\n`),
      cpuInfo: [
        {
          processor: "0",
          Processor: "ARMv8 Processor rev 1 (v8l)",
        },
      ],
      memInfo: {
        MemTotal: { value: 8189064, unit: "kB" },
      },
      deviceTree: {
        model: "Raspberry Pi 5 Model B Rev 1.1",
        compatible: ["raspberrypi,5-model-b", "brcm,bcm2712"],
        serialNumber: "redacted-device-tree-serial",
      },
      hostnamectl: parseHostnamectlJson(
        readFixture("linux/arm64/hostnamectl.json"),
      ),
      lscpu: parseLscpuJson(readFixture("linux/arm64/lscpu.json")),
      pciDevices: parseLspciVmmnn(readFixture("linux/arm64/lspci.vmmnn")),
      usbDevices: parseLsusbText(readFixture("linux/arm64/lsusb.txt")),
      ipLink: parseIpLinkJson(readFixture("linux/arm64/ip-link.json")),
      lshw: parseLshwJson(readFixture("linux/arm64/lshw.json")),
      dmidecode: parseDmidecodeText(readFixture("linux/arm64/dmidecode.txt")),
      ethtool: parseEthtoolFixture(readFixture("linux/arm64/ethtool.txt")),
    },
  });

  assert.equal(bom.metadata.component.name, "Raspberry Pi 5 Model B Rev 1.1");
  assert.ok(hasHardwareClass(bom.components, "board"));
  assert.ok(hasHardwareClass(bom.components, "pci-device"));
  assert.ok(hasHardwareClass(bom.components, "usb-device"));
  assert.equal(
    bom.components.find(
      (component) =>
        getPropertyValue(component, "cdx:hbom:hardwareClass") === "board",
    )?.name,
    "Raspberry Pi 5 Model B Rev 1.1",
  );
});

test("linux build uses native arm64 device-tree, MMC/SDIO, PCI/USB sysfs, and DRM display sources", () => {
  const bom = buildLinuxHbom({
    architecture: "arm64",
    sources: {
      osRelease: {
        NAME: "Ubuntu",
      },
      cpuInfo: [
        {
          processor: "0",
          Processor: "ARMv8 Processor rev 1 (v8l)",
        },
      ],
      memInfo: {
        MemTotal: { value: 8189064, unit: "kB" },
      },
      deviceTree: {
        model: "Raspberry Pi 5 Model B Rev 1.1",
        compatible: ["raspberrypi,5-model-b", "brcm,bcm2712"],
        serialNumber: "151b7a6417d67893",
        linuxRevision: "0xd04171",
        linuxSerial: "0x151b7a6417d67893",
      },
      mmcDevices: [
        {
          name: "mmc1:0001",
          type: "SDIO",
          uevent: {
            MMC_TYPE: "SDIO",
            SDIO_ID: "02D0:4345",
            SDIO_REVISION: "0.0",
          },
        },
      ],
      pciSysfsDevices: [
        {
          slot: "0000:01:00.0",
          classCode: "0108",
          vendorId: "1dee",
          productId: "5216",
          subsystemVendorId: "1dee",
          subsystemDeviceId: "5216",
          driver: "nvme",
          modalias: "pci:v00001DEEd00005216sv00001DEEsd00005216bc01sc08i02",
        },
      ],
      usbSysfsDevices: [
        {
          kernelName: "usb5",
          bus: "005",
          device: "001",
          manufacturer: "Linux 6.8.0-1053-raspi dwc2_hsotg",
          description: "DWC OTG Controller",
          version: "2.00",
          serial: "1000480000.usb",
          vendorId: "1d6b",
          productId: "0002",
          deviceClass: "09",
          deviceSubclass: "00",
          deviceProtocol: "01",
          devpath: "0",
          speedMbps: 480,
          removable: "unknown",
        },
      ],
      drmDevices: [
        {
          name: "card0",
          kind: "card",
          driver: "v3d",
          ofName: "v3d",
          ofCompatible: ["brcm,2712-v3d"],
        },
        {
          name: "card1",
          kind: "card",
          driver: "vc4-drm",
          ofName: "gpu",
          ofCompatible: ["brcm,bcm2712d0-vc6"],
        },
        {
          name: "card1-HDMI-A-1",
          kind: "connector",
          status: "disconnected",
          enabled: "disabled",
          modes: [],
        },
        {
          name: "card1-HDMI-A-2",
          kind: "connector",
          status: "disconnected",
          enabled: "disabled",
          modes: [],
        },
        {
          name: "card1-Writeback-1",
          kind: "connector",
          status: "unknown",
          enabled: "disabled",
          modes: [],
        },
      ],
    },
  });

  assert.equal(
    getPropertyValue(bom.metadata.component, "cdx:hbom:deviceTreeRevision"),
    "0xd04171",
  );
  assert.equal(
    bom.components.find(
      (component) =>
        getPropertyValue(component, "cdx:hbom:hardwareClass") === "board",
    )?.version,
    "0xd04171",
  );
  assert.ok(hasHardwareClass(bom.components, "sdio-device"));
  assert.equal(
    bom.components.find(
      (component) =>
        getPropertyValue(component, "cdx:hbom:hardwareClass") === "sdio-device",
    )?.name,
    "SDIO 02D0:4345",
  );
  assert.ok(hasHardwareClass(bom.components, "pci-device"));
  assert.equal(
    bom.components.find(
      (component) =>
        getPropertyValue(component, "cdx:hbom:hardwareClass") === "pci-device",
    )?.version,
    "0000:01:00.0",
  );
  assert.ok(hasHardwareClass(bom.components, "usb-device"));
  assert.equal(
    bom.components.find(
      (component) =>
        getPropertyValue(component, "cdx:hbom:hardwareClass") === "usb-device",
    )?.manufacturer?.name,
    "Linux 6.8.0-1053-raspi dwc2_hsotg",
  );
  assert.equal(getHardwareClassCount(bom.components, "display-adapter"), 2);
  assert.equal(getHardwareClassCount(bom.components, "display-connector"), 2);
  assert.equal(
    bom.components
      .find(
        (component) =>
          getPropertyValue(component, "cdx:hbom:hardwareClass") ===
            "display-adapter" && component.version === "card1",
      )
      ?.properties.find(
        (property) => property.name === "cdx:hbom:connectorCount",
      )?.value,
    "2",
  );
});

test("linux build emits native audio, video, and EDID-backed display components", () => {
  const bom = buildLinuxHbom({
    architecture: "amd64",
    sources: {
      osRelease: {
        NAME: "Ubuntu",
      },
      cpuInfo: [
        {
          processor: "0",
          vendor_id: "AuthenticAMD",
          "model name": "AMD Ryzen 7 8845HS w/ Radeon 780M Graphics",
        },
      ],
      memInfo: {
        MemTotal: { value: 32768000, unit: "kB" },
      },
      dmiInfo: {
        sys_vendor: "AZW",
        product_name: "SER8",
      },
      audioCards: [
        {
          number: 0,
          id: "Generic",
          kernelId: "Generic",
          interfaceType: "HDA-Intel",
          name: "HD-Audio Generic",
          longName: "HD-Audio Generic at 0xdc5c8000 irq 115",
          driver: "snd_hda_intel",
        },
      ],
      audioPcm: [
        {
          cardNumber: 0,
          deviceNumber: 3,
          id: "HDMI 0",
          name: "HDMI 0",
          playbackCount: 1,
        },
        {
          cardNumber: 0,
          deviceNumber: 0,
          id: "ALC897 Analog",
          name: "ALC897 Analog",
          playbackCount: 1,
          captureCount: 1,
        },
      ],
      videoDevices: [
        {
          kernelName: "video0",
          name: "Integrated Camera",
          index: 0,
          driver: "uvcvideo",
          modalias: "usb:v1BCFp2C99d0100dcEFdsc02dp01ic0Eisc01ip00in00",
        },
        {
          kernelName: "video19",
          name: "rpivid",
          index: 0,
          driver: "rpivid",
          modalias: "of:NcodecT(null)Craspberrypi,rpivid-vid-decoder",
        },
      ],
      drmDevices: [
        {
          name: "card0",
          kind: "card",
          driver: "amdgpu",
          pciSlot: "0000:65:00.0",
          vendorId: "1002",
          productId: "1900",
        },
        {
          name: "card0-HDMI-A-1",
          kind: "connector",
          status: "connected",
          enabled: "enabled",
          modes: ["3840x2160"],
          edid: parseEdidBuffer(createSampleEdidBuffer()),
        },
      ],
    },
  });

  assert.ok(hasHardwareClass(bom.components, "audio-controller"));
  assert.equal(getHardwareClassCount(bom.components, "audio-device"), 2);
  assert.ok(hasHardwareClass(bom.components, "camera"));
  assert.ok(hasHardwareClass(bom.components, "video-processor"));
  assert.ok(hasHardwareClass(bom.components, "display"));
  assert.equal(
    bom.components.find(
      (component) =>
        getPropertyValue(component, "cdx:hbom:hardwareClass") === "display",
    )?.name,
    "DELL U2720Q",
  );
  assert.equal(
    bom.components
      .find(
        (component) =>
          getPropertyValue(component, "cdx:hbom:hardwareClass") ===
          "audio-controller",
      )
      ?.properties.find((property) => property.name === "cdx:hbom:driver")
      ?.value,
    "snd_hda_intel",
  );
});

test("linux build merges drm_info enrichment into display components with graceful fallback", () => {
  const bom = buildLinuxHbom({
    architecture: "arm64",
    sources: {
      osRelease: { NAME: "Ubuntu" },
      cpuInfo: [{ processor: "0", Processor: "ARMv8 Processor rev 1 (v8l)" }],
      memInfo: { MemTotal: { value: 8192000, unit: "kB" } },
      dmiInfo: {
        sys_vendor: "Raspberry Pi Ltd",
        product_name: "Raspberry Pi 5",
      },
      drmDevices: [
        {
          name: "card1",
          kind: "card",
          driver: "vc4-drm",
          ofName: "gpu",
          ofCompatible: ["brcm,bcm2712d0-vc6"],
        },
        {
          name: "card1-HDMI-A-1",
          kind: "connector",
          status: "connected",
          enabled: "enabled",
          modes: ["3840x2160"],
          edid: parseEdidBuffer(createSampleEdidBuffer()),
        },
      ],
      drmInfo: {
        cards: [
          {
            name: "card1",
            kind: "card",
            drmNode: "/dev/dri/card1",
            driver: "vc4",
            driverDescription: "Broadcom VC4 graphics",
            driverVersion: "0.0.0",
            kernelRelease: "6.8.0-1053-raspi",
            drmBusType: "platform",
            availableNodes: 1,
            framebuffer: {
              min_width: 0,
              max_width: 8192,
              min_height: 0,
              max_height: 8192,
            },
            clientCaps: { ATOMIC: true },
            caps: { DUMB_BUFFER: 1 },
            ofCompatible: ["brcm,bcm2712d0-vc6"],
          },
        ],
        connectors: [
          {
            cardName: "card1",
            kind: "connector",
            drmConnectorId: 32,
            connectorType: "HDMI-A",
            status: "connected",
            dpms: "On",
            linkStatus: "Good",
            nonDesktop: 0,
            maxBpc: 12,
            colorspace: "Default",
          },
        ],
      },
    },
  });

  const adapter = bom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") ===
      "display-adapter",
  );
  const connector = bom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") ===
      "display-connector",
  );

  assert.equal(getPropertyValue(adapter, "cdx:hbom:drmNode"), "/dev/dri/card1");
  assert.equal(
    getPropertyValue(adapter, "cdx:hbom:driverDescription"),
    "Broadcom VC4 graphics",
  );
  assert.equal(
    getPropertyValue(adapter, "cdx:hbom:kernelRelease"),
    "6.8.0-1053-raspi",
  );
  assert.equal(
    getPropertyValue(adapter, "cdx:hbom:clientCapabilities"),
    "ATOMIC",
  );
  assert.equal(
    getPropertyValue(connector, "cdx:hbom:displayConnectorType"),
    "HDMI-A",
  );
  assert.equal(getPropertyValue(connector, "cdx:hbom:drmConnectorId"), "32");
  assert.equal(getPropertyValue(connector, "cdx:hbom:dpms"), "On");
  assert.equal(getPropertyValue(connector, "cdx:hbom:linkStatus"), "Good");
  assert.equal(getPropertyValue(connector, "cdx:hbom:maxBitsPerChannel"), "12");
});

test("linux build emits Thunderbolt, modem, fwupd, UPower, EDID decode, and command diagnostic enrichment", () => {
  const bom = buildLinuxHbom({
    architecture: "amd64",
    sources: {
      osRelease: { NAME: "Ubuntu" },
      cpuInfo: [
        {
          processor: "0",
          vendor_id: "AuthenticAMD",
          "model name": "AMD Ryzen 7 8845HS",
        },
      ],
      memInfo: { MemTotal: { value: 32768000, unit: "kB" } },
      dmiInfo: { sys_vendor: "AZW", product_name: "SER8" },
      upower:
        parseUpowerDump(`Device: /org/freedesktop/UPower/devices/DisplayDevice
  power supply:         yes
  battery
    state:               discharging
    warning-level:       low
    percentage:          84%
    energy:              62.1 Wh
    energy-full:         74.0 Wh
    energy-full-design:  82.0 Wh
    energy-rate:         37.0 W
    voltage:             15.234 V
    vendor:              SMP
    model:               DELL M59JH45
    serial:              BATT-12345

Daemon:
  on-battery:      yes
  daemon-version:  1.90.3
`),
      boltctlDomains: parseBoltctlText(` ● domain0
   ├─ uuid:          11111111-2222-3333-4444-555555555555
   ├─ status:        online
   ├─ security:      user
   ├─ iommu:         yes
   ├─ rx speed:      40 Gb/s
   ├─ tx speed:      40 Gb/s
`),
      boltctlDevices: parseBoltctlText(` ● CalDigit TS4
   ├─ vendor:        CalDigit
   ├─ uuid:          99999999-aaaa-bbbb-cccc-dddddddddddd
   ├─ type:          peripheral
   ├─ generation:    Thunderbolt 4
   ├─ status:        authorized
`),
      modems: [
        {
          modemPath: "/org/freedesktop/ModemManager1/Modem/0",
          modem: {
            generic: {
              manufacturer: "Quectel",
              model: "RM500Q-GL",
              revision: "RM500QGLABR11A06M4G",
              plugin: "quectel",
              drivers: ["qmi_wwan", "option"],
              equipmentId: "359072060001234",
            },
            status: {
              state: "registered",
              signalQuality: { value: 72 },
              accessTechnologies: "lte, 5gnr",
            },
            "3gpp": {
              operatorName: "ExampleTel",
              imei: "359072060001234",
            },
            ownNumbers: ["+15551234567"],
            simSlots: ["/org/freedesktop/ModemManager1/SIM/0"],
          },
        },
      ],
      fwupdDevices: parseFwupdmgrDevicesJson(`{
        "Devices": [
          {
            "Name": "Acer SSD FA100 256GB",
            "Plugin": "nvme",
            "Version": "1.4.6.57",
            "Vendor": "Biwin Storage Technology Co., Ltd.",
            "VendorId": "NVME:0x1DEE",
            "Guid": ["9e02e500-1f91-54f6-a50a-10ad5ab020d5"],
            "Flags": ["updatable", "registered"]
          }
        ]
      }`),
      drmDevices: [
        {
          name: "card0",
          kind: "card",
          driver: "amdgpu",
          pciSlot: "0000:c6:00.0",
          vendorId: "1002",
          productId: "1900",
        },
        {
          name: "card0-HDMI-A-1",
          kind: "connector",
          status: "connected",
          enabled: "enabled",
          modes: ["3840x2160"],
          edid: parseEdidBuffer(createSampleEdidBuffer()),
        },
      ],
      edidDecoded: [
        {
          name: "card0-HDMI-A-1",
          bitsPerColorChannel: 10,
          colorFormats: ["RGB 4:4:4", "YCbCr 4:4:4"],
          hdrEotf: ["Traditional SDR", "SMPTE ST2084"],
        },
      ],
    },
    commandDiagnostics: [
      {
        id: "edid-decode:card0-HDMI-A-1",
        issue: "missing-command",
        command: "edid-decode",
        installHint: "install edid-decode",
      },
    ],
  });

  const thunderboltDevice = bom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") ===
      "thunderbolt-device",
  );
  const modem = bom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") === "modem",
  );
  const firmwareDevice = bom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") ===
      "firmware-device",
  );
  const displayConnector = bom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") ===
      "display-connector",
  );
  const battery = bom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") === "power",
  );

  assert.equal(
    getPropertyValue(bom.metadata.component, "cdx:hbom:powerSource"),
    "Battery",
  );
  assert.equal(
    getPropertyValue(bom.metadata.component, "cdx:hbom:isAcAttached"),
    "false",
  );
  assert.equal(getPropertyValue(battery, "cdx:hbom:warningLevel"), "low");
  assert.equal(thunderboltDevice?.name, "CalDigit TS4");
  assert.equal(
    getPropertyValue(thunderboltDevice, "cdx:hbom:deviceUuid"),
    "redacted:dddd",
  );
  assert.equal(modem?.name, "RM500Q-GL");
  assert.equal(getPropertyValue(modem, "cdx:hbom:plugin"), "quectel");
  assert.equal(getPropertyValue(modem, "cdx:hbom:imei"), "redacted:1234");
  assert.equal(firmwareDevice?.name, "Acer SSD FA100 256GB");
  assert.equal(getPropertyValue(firmwareDevice, "cdx:hbom:plugin"), "nvme");
  assert.equal(
    getPropertyValue(displayConnector, "cdx:hbom:bitsPerColorChannel"),
    "10",
  );
  assert.match(
    getPropertyValue(displayConnector, "cdx:hbom:hdrEotf"),
    /SMPTE ST2084/u,
  );
  assert.equal(
    bom.properties.find(
      (property) =>
        property.name === "cdx:hbom:evidence:commandDiagnosticCount",
    )?.value,
    "1",
  );
  assert.match(
    bom.properties.find(
      (property) => property.name === "cdx:hbom:evidence:commandDiagnostic",
    )?.value,
    /missing-command/u,
  );
});

test("linux build emits hwmon, thermal, TPM, and NVMe controller components", () => {
  const bom = buildLinuxHbom({
    architecture: "amd64",
    sources: {
      osRelease: { NAME: "Ubuntu" },
      cpuInfo: [
        {
          processor: "0",
          vendor_id: "AuthenticAMD",
          "model name": "AMD Ryzen 7 8845HS",
        },
      ],
      memInfo: { MemTotal: { value: 32768000, unit: "kB" } },
      dmiInfo: { sys_vendor: "AZW", product_name: "SER8" },
      hwmonDevices: [
        parseHwmonAttributes({
          name: "nvme",
          temp1_input: "38850",
          temp1_label: "Composite",
          temp2_input: "45850",
          temp2_label: "Sensor 1",
        }),
        parseHwmonAttributes({
          name: "pwmfan",
          fan1_input: "1400",
          fan1_label: "cpu fan",
          pwm1: "120",
        }),
      ],
      thermalZones: [
        {
          name: "thermal_zone0",
          type: "cpu-thermal",
          tempMilliC: 48500,
          mode: "enabled",
        },
      ],
      tpmDevices: [
        {
          name: "tpm0",
          versionMajor: 2,
          versionMinor: 0,
          description: "TPM 2.0 Device",
          driver: "tpm_crb",
          modalias: "acpi:MSFT0101:",
        },
      ],
      nvmeControllers: [
        {
          name: "nvme0",
          model: "CT1000P3PSSD8",
          serial: "24404B653734",
          firmwareRevision: "P9CR413",
          transport: "pcie",
          state: "live",
          address: "0000:04:00.0",
          vendorId: "1344",
          driver: "nvme",
          namespaceCount: 1,
          namespaces: ["nvme0n1"],
        },
      ],
    },
  });

  assert.ok(hasHardwareClass(bom.components, "sensor"));
  assert.ok(hasHardwareClass(bom.components, "fan"));
  assert.ok(hasHardwareClass(bom.components, "thermal-zone"));
  assert.ok(hasHardwareClass(bom.components, "tpm"));
  assert.ok(hasHardwareClass(bom.components, "storage-controller"));
  assert.equal(
    bom.components.find(
      (component) =>
        getPropertyValue(component, "cdx:hbom:hardwareClass") === "tpm",
    )?.version,
    "2.0",
  );
  assert.equal(
    bom.components
      .find(
        (component) =>
          getPropertyValue(component, "cdx:hbom:hardwareClass") ===
          "storage-controller",
      )
      ?.properties.find(
        (property) => property.name === "cdx:hbom:namespaceCount",
      )?.value,
    "1",
  );
});

test("linux build can emit native sysfs PCI, USB, and DRM components without command enrichment", () => {
  const bom = buildLinuxHbom({
    architecture: "amd64",
    sources: {
      osRelease: {
        NAME: "Ubuntu",
      },
      cpuInfo: [
        {
          processor: "0",
          vendor_id: "AuthenticAMD",
          "model name": "AMD Ryzen 7 8845HS w/ Radeon 780M Graphics",
        },
      ],
      memInfo: {
        MemTotal: { value: 32768000, unit: "kB" },
      },
      dmiInfo: {
        sys_vendor: "AZW",
        product_name: "SER8",
      },
      pciSysfsDevices: [
        {
          slot: "0000:65:00.0",
          classCode: "0300",
          vendorId: "1002",
          productId: "1900",
          subsystemVendorId: "1f66",
          subsystemDeviceId: "0031",
          driver: "amdgpu",
          modalias: "pci:v00001002d00001900sv00001F66sd00000031bc03sc00i00",
        },
      ],
      usbSysfsDevices: [
        {
          kernelName: "1-5",
          bus: "001",
          device: "005",
          vendorId: "8087",
          productId: "0029",
          deviceClass: "e0",
          deviceSubclass: "01",
          deviceProtocol: "01",
          version: "2.01",
          speedMbps: 12,
          removable: "fixed",
        },
      ],
      drmDevices: [
        {
          name: "card0",
          kind: "card",
          driver: "amdgpu",
          pciSlot: "0000:65:00.0",
          vendorId: "1002",
          productId: "1900",
          subsystemVendorId: "1f66",
          subsystemDeviceId: "0031",
        },
        {
          name: "card0-HDMI-A-1",
          kind: "connector",
          status: "disconnected",
          enabled: "disabled",
          modes: [],
        },
        {
          name: "card0-Writeback-1",
          kind: "connector",
          status: "unknown",
          enabled: "disabled",
          modes: [],
        },
      ],
    },
  });

  assert.equal(getHardwareClassCount(bom.components, "pci-device"), 1);
  assert.equal(getHardwareClassCount(bom.components, "usb-device"), 1);
  assert.equal(getHardwareClassCount(bom.components, "display-adapter"), 1);
  assert.equal(getHardwareClassCount(bom.components, "display-connector"), 1);
  assert.equal(
    bom.components.find(
      (component) =>
        getPropertyValue(component, "cdx:hbom:hardwareClass") ===
        "display-adapter",
    )?.name,
    "amdgpu",
  );
  assert.equal(
    bom.components.find(
      (component) =>
        getPropertyValue(component, "cdx:hbom:hardwareClass") ===
        "display-connector",
    )?.name,
    "card0-HDMI-A-1",
  );
});

test("linux build enriches CPU, network, and storage components from lshw", () => {
  const bom = buildLinuxHbom({
    architecture: "amd64",
    sources: {
      osRelease: { NAME: "Ubuntu" },
      cpuInfo: [
        {
          processor: "0",
          vendor_id: "AuthenticAMD",
          "model name": "AMD Ryzen 7 8845HS w/ Radeon 780M Graphics",
          flags: "sse sse2 avx avx2 svm aes",
        },
      ],
      memInfo: { MemTotal: { value: 32768000, unit: "kB" } },
      dmiInfo: { sys_vendor: "GMKtec", product_name: "NucBox K8 Plus" },
      lscpu: {
        Architecture: "x86_64",
        "CPU(s)": "16",
        "Model name": "AMD Ryzen 7 8845HS w/ Radeon 780M Graphics",
        Flags: "sse sse2 avx avx2 svm aes",
      },
      networkInterfaces: [
        {
          name: "wlp4s0",
          ifname: "wlp4s0",
          address: "52:54:00:12:34:56",
          linkType: "1",
        },
      ],
      ethtool: {
        wlp4s0: {
          driver: "iwlwifi",
          version: "6.8.0-111-generic",
          "firmware-version": "77.b405f9d4.0 cc-a0-77.ucode",
          "bus-info": "0000:04:00.0",
        },
      },
      blockDevices: [
        {
          name: "nvme0n1",
          transport: "nvme",
          removable: false,
          rotational: false,
          size: 2048,
        },
      ],
      nvmeControllers: [
        {
          name: "nvme0",
          address: "0000:05:00.0",
          namespaces: ["nvme0n1"],
        },
      ],
      lshw: [
        {
          id: "system",
          class: "system",
          children: [
            {
              id: "cpu",
              class: "processor",
              product: "AMD Ryzen 7 8845HS w/ Radeon 780M Graphics",
              vendor: "Advanced Micro Devices [AMD]",
              size: 4000000000,
              capacity: 5100000000,
              configuration: { microcode: "175133190" },
              capabilities: { avx2: true, svm: true, aes: true },
            },
            {
              id: "wifi",
              class: "network",
              description: "Wireless interface",
              product: "Wi-Fi 6 AX200",
              vendor: "Intel Corporation",
              businfo: "pci@0000:04:00.0",
              logicalname: ["wlp4s0"],
              version: "1a",
              configuration: {
                driver: "iwlwifi",
                driverversion: "6.8.0-111-generic",
                firmware: "77.b405f9d4.0 cc-a0-77.ucode",
                link: "yes",
                wireless: "IEEE 802.11",
              },
              capabilities: {
                ethernet: true,
                physical: "Physical interface",
                wireless: "Wireless-LAN",
              },
            },
            {
              id: "nvme",
              class: "storage",
              description: "NVMe device",
              product: "CT2000P310SSD8",
              vendor: "Micron/Crucial Technology",
              businfo: "pci@0000:05:00.0",
              logicalname: "/dev/nvme0",
              version: "V8CR000",
              serial: "25044DB332FB",
              configuration: {
                driver: "nvme",
                state: "live",
                nqn: "nqn.2016-08.com.micron:nvme:nvm-subsystem-sn-25044DB332FB",
              },
              capabilities: { nvme: true, nvm_express: true },
              children: [
                {
                  id: "namespace:1",
                  class: "disk",
                  logicalname: "/dev/nvme0n1",
                  configuration: {
                    wwid: "eui.000000000000000100a075254db332fb",
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  });

  const processor = bom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") === "processor",
  );
  const wireless = bom.components.find(
    (component) => component.version === "wlp4s0",
  );
  const storage = bom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") === "storage",
  );
  const storageController = bom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") ===
      "storage-controller",
  );

  assert.match(
    getPropertyValue(processor, "cdx:hbom:cpuFeatures"),
    /\bavx2\b/u,
  );
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:microcodeVersion"),
    "175133190",
  );
  assert.equal(wireless?.name, "Wi-Fi 6 AX200");
  assert.equal(wireless?.manufacturer?.name, "Intel Corporation");
  assert.equal(getPropertyValue(wireless, "cdx:hbom:linkDetected"), "true");
  assert.equal(storage?.name, "CT2000P310SSD8");
  assert.equal(storage?.manufacturer?.name, "Micron/Crucial Technology");
  assert.equal(
    getPropertyValue(storage, "cdx:hbom:firmwareVersion"),
    "V8CR000",
  );
  assert.equal(
    getPropertyValue(storage, "cdx:hbom:wwid"),
    "eui.000000000000000100a075254db332fb",
  );
  assert.equal(
    storageController?.manufacturer?.name,
    "Micron/Crucial Technology",
  );
  assert.equal(
    getPropertyValue(storageController, "cdx:hbom:nqn"),
    "nqn.2016-08.com.micron:nvme:nvm-subsystem-sn-25044DB332FB",
  );
});

test("linux build emits richer USB, cpupower, and battery properties", () => {
  const bom = buildLinuxHbom({
    architecture: "amd64",
    sources: {
      osRelease: { NAME: "Ubuntu" },
      cpuInfo: [
        {
          processor: "0",
          vendor_id: "AuthenticAMD",
          "model name": "AMD Ryzen 7 8845HS w/ Radeon 780M Graphics",
        },
      ],
      memInfo: { MemTotal: { value: 32768000, unit: "kB" } },
      dmiInfo: { sys_vendor: "GMKtec", product_name: "NucBox K8 Plus" },
      lscpu: {
        Architecture: "x86_64",
        "CPU(s)": "16",
        "Socket(s)": "1",
        "Thread(s) per core": "2",
        "Core(s) per socket": "8",
        "CPU min MHz": "400.0000",
        "CPU max MHz": "5100.0000",
        "On-line CPU(s) list": "0-15",
      },
      cpupowerFrequency: {
        driver: "amd-pstate-epp",
        availableGovernors: ["performance", "powersave"],
        governor: "performance",
        hardwareMin: "400 MHz",
        hardwareMax: "5.10 GHz",
        boostSupported: true,
        boostActive: true,
        currentFrequencies: ["4.09 GHz (asserted by call to kernel)"],
      },
      cpupowerIdle: {
        driver: "acpi_idle",
        governor: "menu",
        idleStateCount: 4,
        availableIdleStates: ["POLL", "C1", "C2", "C3"],
        idleStates: [
          { name: "POLL", latency: 0, usage: 10 },
          { name: "C1", latency: 1, usage: 20 },
        ],
      },
      usbDevices: [
        {
          bus: "001",
          device: "002",
          vendorId: "8087",
          productId: "0029",
          description: "Intel Corp. AX200 Bluetooth",
        },
      ],
      usbVerboseDevices: [
        {
          bus: "001",
          device: "002",
          vendorId: "8087",
          productId: "0029",
          productName: "AX200 Bluetooth",
          manufacturer: "Intel Corp.",
          serial: "BT-123456",
          version: "2.01",
          deviceClassName: "Wireless",
          deviceSubclassName: "Radio Frequency",
          deviceProtocolName: "Bluetooth",
          interfaceClassNames: ["Wireless"],
          configurationCount: 1,
          interfaceCount: 2,
          maxPowerMilliAmps: 100,
          selfPowered: true,
          remoteWakeup: true,
        },
      ],
      powerSupplies: [
        {
          name: "BAT0",
          type: "Battery",
          status: "Discharging",
          capacity: 84,
          cycleCount: 42,
          manufacturer: "SMP",
          modelName: "DELL M59JH45",
          serialNumber: "BATT-12345",
          technology: "Li-ion",
          scope: "System",
          voltageNow: 15234000,
          voltageMinDesign: 15000000,
          currentNow: 2450000,
          powerNow: 37000000,
          energyNow: 62100000,
          energyFull: 74000000,
          energyFullDesign: 82000000,
        },
      ],
    },
  });

  const processor = bom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") === "processor",
  );
  const usbDevice = bom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") === "usb-device",
  );
  const battery = bom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") === "power",
  );

  assert.equal(
    getPropertyValue(processor, "cdx:hbom:frequencyDriver"),
    "amd-pstate-epp",
  );
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:availableGovernors"),
    "performance, powersave",
  );
  assert.equal(getPropertyValue(processor, "cdx:hbom:idleDriver"), "acpi_idle");
  assert.match(
    getPropertyValue(processor, "cdx:hbom:idleStateSummary"),
    /POLL/u,
  );
  assert.equal(usbDevice?.name, "AX200 Bluetooth");
  assert.equal(usbDevice?.manufacturer?.name, "Intel Corp.");
  assert.equal(
    getPropertyValue(usbDevice, "cdx:hbom:usbClassName"),
    "Wireless",
  );
  assert.equal(
    getPropertyValue(usbDevice, "cdx:hbom:maxPowerMilliAmps"),
    "100",
  );
  assert.equal(
    getPropertyValue(usbDevice, "cdx:hbom:deviceSerial"),
    "redacted:3456",
  );
  assert.equal(getPropertyValue(battery, "cdx:hbom:scope"), "System");
  assert.equal(
    getPropertyValue(battery, "cdx:hbom:designCapacityPercent"),
    "90",
  );
  assert.equal(getPropertyValue(battery, "cdx:hbom:powerNow"), "37000000");
});

test("linux build enriches PCI, display, and Bluetooth components from lshw", () => {
  const bom = buildLinuxHbom({
    architecture: "arm64",
    sources: {
      osRelease: { NAME: "Ubuntu" },
      cpuInfo: [{ processor: "0", Processor: "ARMv8 Processor rev 1 (v8l)" }],
      memInfo: { MemTotal: { value: 8192000, unit: "kB" } },
      dmiInfo: {
        sys_vendor: "Raspberry Pi Ltd",
        product_name: "Raspberry Pi 5",
      },
      pciDevices: [
        {
          Slot: "0000:00:01.0",
          Class: "Host bridge [0600]",
          Vendor: "Advanced Micro Devices, Inc. [AMD] [1022]",
          Device: "Device [14ea]",
        },
      ],
      drmDevices: [
        {
          name: "card0",
          kind: "card",
          driver: "amdgpu",
          pciSlot: "0000:c6:00.0",
          vendorId: "1002",
          productId: "1900",
        },
      ],
      lshw: [
        {
          id: "system",
          class: "system",
          children: [
            {
              id: "bridge0",
              class: "bridge",
              description: "Host bridge",
              product: "AMD Root Complex",
              vendor: "Advanced Micro Devices, Inc. [AMD]",
              businfo: "pci@0000:00:01.0",
              version: "00",
              capabilities: { bus_master: "bus mastering" },
            },
            {
              id: "display0",
              class: "display",
              description: "VGA compatible controller",
              product: "Phoenix3",
              vendor: "Advanced Micro Devices, Inc. [AMD/ATI]",
              businfo: "pci@0000:c6:00.0",
              version: "c5",
              configuration: { driver: "amdgpu" },
              capabilities: {
                vga_controller: true,
                bus_master: "bus mastering",
              },
            },
            {
              id: "bt0",
              class: "communication",
              description: "BlueTooth interface",
              product: "4345",
              vendor: "Broadcom",
              businfo: "mmc@1:0001:3",
              logicalname: "mmc1:0001:3",
              configuration: { wireless: "BlueTooth" },
              capabilities: { wireless: true, bluetooth: true },
            },
          ],
        },
      ],
    },
  });

  const pciDevice = bom.components.find(
    (component) => component.version === "0000:00:01.0",
  );
  const displayAdapter = bom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") ===
      "display-adapter",
  );
  const bluetooth = bom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") ===
      "bluetooth-controller",
  );

  assert.equal(pciDevice?.name, "AMD Root Complex");
  assert.equal(
    getPropertyValue(pciDevice, "cdx:hbom:busInfo"),
    "pci@0000:00:01.0",
  );
  assert.equal(displayAdapter?.name, "Phoenix3");
  assert.equal(
    displayAdapter?.manufacturer?.name,
    "Advanced Micro Devices, Inc. [AMD/ATI]",
  );
  assert.match(
    getPropertyValue(displayAdapter, "cdx:hbom:capabilities"),
    /vga_controller/u,
  );
  assert.equal(bluetooth?.name, "4345");
  assert.equal(bluetooth?.manufacturer?.name, "Broadcom");
  assert.equal(
    getPropertyValue(bluetooth, "cdx:hbom:wirelessType"),
    "BlueTooth",
  );
});

test("linux build normalizes DMI placeholders, chassis codes, and filters virtual devices", () => {
  const bom = buildLinuxHbom({
    architecture: "amd64",
    sources: {
      osRelease: {
        NAME: "Ubuntu",
      },
      cpuInfo: [
        {
          processor: "0",
          vendor_id: "AuthenticAMD",
          "model name": "AMD Ryzen 7 8845HS w/ Radeon 780M Graphics",
          "cpu cores": "8",
          "physical id": "0",
        },
      ],
      memInfo: {
        MemTotal: { value: 32768000, unit: "kB" },
      },
      dmiInfo: {
        sys_vendor: "AZW",
        product_name: "SER8",
        product_version: "Default string",
        board_vendor: "AZW",
        board_name: "SER8",
        chassis_type: "35",
        bios_vendor: "American Megatrends International, LLC.",
        bios_version: "HPT.TEST",
      },
      blockDevices: [
        {
          name: "dm-0",
          model: "dm-0",
          size: 1234,
        },
        {
          name: "nvme0n1",
          model: "CT1000P3PSSD8",
          size: 1000,
          transport: "nvme",
          removable: false,
          rotational: false,
        },
      ],
      networkInterfaces: [
        {
          name: "docker0",
          ifname: "docker0",
          address: "redacted:mac",
          linkType: "ether",
        },
        {
          name: "enp1s0",
          ifname: "enp1s0",
          address: "redacted:mac",
          linkType: "ether",
        },
      ],
      ethtool: {
        docker0: {
          driver: "bridge",
          "bus-info": "N/A",
        },
        enp1s0: {
          driver: "r8169",
          "bus-info": "0000:01:00.0",
          "firmware-version": "rtl8125b-2_0.0.2 07/13/20",
        },
      },
    },
  });

  assert.equal(bom.metadata.component.version, "amd64");
  assert.equal(
    bom.metadata.component.properties.find(
      (property) => property.name === "cdx:hbom:chassisType",
    )?.value,
    "mini-pc",
  );
  assert.equal(hasHardwareClass(bom.components, "storage"), true);
  assert.equal(
    bom.components.some((component) => component.name === "dm-0"),
    false,
  );
  assert.equal(
    bom.components.some((component) => component.version === "docker0"),
    false,
  );
  assert.equal(
    bom.components.some((component) => component.version === "enp1s0"),
    true,
  );
});

function readFixture(relativePath) {
  return readFileSync(
    new URL(`./fixtures/${relativePath}`, import.meta.url),
    "utf8",
  );
}

function parseEthtoolFixture(stdout) {
  return stdout
    .split(/^###\s+/mu)
    .map((block) => block.trim())
    .filter(Boolean)
    .reduce((result, block) => {
      const [header, ...body] = block.split(/\r?\n/u);
      result[header.trim()] = parseEthtoolDriverInfo(body.join("\n"));
      return result;
    }, {});
}

function hasHardwareClass(components, hardwareClass) {
  return components.some(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") === hardwareClass,
  );
}

function getHardwareClassCount(components, hardwareClass) {
  return components.filter(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") === hardwareClass,
  ).length;
}

function createSampleEdidBuffer() {
  const edid = Buffer.alloc(128);

  Buffer.from("00ffffffffffff00", "hex").copy(edid, 0);
  edid[8] = 0x10;
  edid[9] = 0xac;
  edid.writeUInt16LE(0xa06b, 10);
  edid.writeUInt32LE(12345678, 12);
  edid[16] = 12;
  edid[17] = 34;
  edid[18] = 1;
  edid[19] = 4;
  edid[21] = 60;
  edid[22] = 34;
  edid.writeUInt16LE(0x1d1a, 54);
  edid[56] = 0x00;
  edid[58] = 0xf0;
  edid[59] = 0x70;
  edid[61] = 0x80;

  writeEdidTextDescriptor(edid, 72, 0xfc, "DELL U2720Q");
  writeEdidTextDescriptor(edid, 90, 0xff, "SN123456");

  return edid;
}

function writeEdidTextDescriptor(edid, offset, descriptorType, value) {
  edid[offset + 3] = descriptorType;
  Buffer.from(`${value}\n`, "ascii").copy(edid, offset + 5);
}

function getPropertyValue(component, name) {
  return component.properties.find((property) => property.name === name)?.value;
}
