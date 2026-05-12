import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildLinuxHbom,
  parseCpuInfo,
  parseDmidecodeText,
  parseEthtoolDriverInfo,
  parseHostnamectlJson,
  parseIpLinkJson,
  parseLshwJson,
  parseLspciVmmnn,
  parseLsblkJson,
  parseLscpuJson,
  parseLsmemJson,
  parseLsusbText,
  parseMemInfo,
  parseOsRelease,
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
  const parsed = parseLsusbText(`Bus 003 Device 002: ID 046d:c52b Logitech, Inc. Unifying Receiver
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
    bom.metadata.component.properties.find((property) => property.name === "hbom:serialNumber")?.value,
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
  assert.ok(
    bom.components.some((component) => component.type === "firmware"),
  );
  assert.equal(
    bom.properties.find((property) => property.name === "hbom:targetPlatform")?.value,
    "linux",
  );
  assert.equal(
    bom.properties.find((property) => property.name === "hbom:evidence:fileCount")?.value,
    "2",
  );
  assert.equal(
    bom.components.find((component) => getPropertyValue(component, "hbom:hardwareClass") === "board")?.name,
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
    bom.components.find((component) => getPropertyValue(component, "hbom:hardwareClass") === "processor")?.version,
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
  const dmidecode = parseDmidecodeText(readFixture("linux/amd64/dmidecode.txt"));
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
  assert.equal(ethtool.wlp4s0["firmware-version"], "77.b405f9d4.0 cc-a0-77.ucode");
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
  const dmidecode = parseDmidecodeText(readFixture("linux/arm64/dmidecode.txt"));
  const ethtool = parseEthtoolFixture(readFixture("linux/arm64/ethtool.txt"));

  assert.equal(lscpu.Architecture, "aarch64");
  assert.equal(hostnamectl.HardwareModel, undefined);
  assert.equal(lspci[1].Device, "KingSpec NX series NVMe SSD (DRAM-less) [5216]");
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
      hostnamectl: parseHostnamectlJson(readFixture("linux/arm64/hostnamectl.json")),
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
    bom.components.find((component) => getPropertyValue(component, "hbom:hardwareClass") === "board")?.name,
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
    getPropertyValue(bom.metadata.component, "hbom:deviceTreeRevision"),
    "0xd04171",
  );
  assert.equal(
    bom.components.find((component) => getPropertyValue(component, "hbom:hardwareClass") === "board")?.version,
    "0xd04171",
  );
  assert.ok(hasHardwareClass(bom.components, "sdio-device"));
  assert.equal(
    bom.components.find((component) => getPropertyValue(component, "hbom:hardwareClass") === "sdio-device")?.name,
    "SDIO 02D0:4345",
  );
  assert.ok(hasHardwareClass(bom.components, "pci-device"));
  assert.equal(
    bom.components.find((component) => getPropertyValue(component, "hbom:hardwareClass") === "pci-device")?.version,
    "0000:01:00.0",
  );
  assert.ok(hasHardwareClass(bom.components, "usb-device"));
  assert.equal(
    bom.components.find((component) => getPropertyValue(component, "hbom:hardwareClass") === "usb-device")?.manufacturer?.name,
    "Linux 6.8.0-1053-raspi dwc2_hsotg",
  );
  assert.equal(getHardwareClassCount(bom.components, "display-adapter"), 2);
  assert.equal(getHardwareClassCount(bom.components, "display-connector"), 2);
  assert.equal(
    bom.components.find(
      (component) =>
        getPropertyValue(component, "hbom:hardwareClass") === "display-adapter" &&
        component.version === "card1",
    )?.properties.find((property) => property.name === "hbom:connectorCount")?.value,
    "2",
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
    bom.components.find((component) => getPropertyValue(component, "hbom:hardwareClass") === "display-adapter")?.name,
    "amdgpu",
  );
  assert.equal(
    bom.components.find((component) => getPropertyValue(component, "hbom:hardwareClass") === "display-connector")?.name,
    "card0-HDMI-A-1",
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
    bom.metadata.component.properties.find((property) => property.name === "hbom:chassisType")?.value,
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
  return readFileSync(new URL(`./fixtures/${relativePath}`, import.meta.url), "utf8");
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
    (component) => getPropertyValue(component, "hbom:hardwareClass") === hardwareClass,
  );
}

function getHardwareClassCount(components, hardwareClass) {
  return components.filter(
    (component) => getPropertyValue(component, "hbom:hardwareClass") === hardwareClass,
  ).length;
}

function getPropertyValue(component, name) {
  return component.properties.find((property) => property.name === name)?.value;
}
