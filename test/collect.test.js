import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildDarwinArm64Hbom,
  normalizeApfsTopology,
  parseIfconfigText,
  parseNetworksetupPorts,
  parsePmsetBattery,
  parseSysctlValues,
} from "../src/darwin/arm64/index.js";

function readFixture(relativePath) {
  return readFileSync(
    new URL(`./fixtures/${relativePath}`, import.meta.url),
    "utf8",
  );
}

test("parseSysctlValues maps name: value lines to keys", () => {
  const parsed = parseSysctlValues(
    [
      "machdep.cpu.brand_string: Apple M4 Pro",
      "hw.memsize: 51539607552",
      "hw.model: Mac16,7",
      "hw.ncpu: 14",
      "hw.logicalcpu: 14",
      "hw.physicalcpu: 14",
    ].join("\n"),
  );

  assert.deepEqual(parsed, {
    "machdep.cpu.brand_string": "Apple M4 Pro",
    "hw.memsize": "51539607552",
    "hw.model": "Mac16,7",
    "hw.ncpu": "14",
    "hw.logicalcpu": "14",
    "hw.physicalcpu": "14",
  });
});

test("parseSysctlValues keeps later values when a key is missing", () => {
  // `sysctl -i` skips a key the host does not answer for. The printed names
  // decide the mapping, so the values after the gap land on their own keys.
  const parsed = parseSysctlValues(
    [
      "hw.cachelinesize: 128",
      "hw.l1dcachesize: 65536",
      "hw.targettype: J616s",
    ].join("\n"),
  );

  assert.deepEqual(parsed, {
    "hw.cachelinesize": "128",
    "hw.l1dcachesize": "65536",
    "hw.targettype": "J616s",
  });
});

test("parseSysctlValues ignores lines without a name: value prefix", () => {
  const parsed = parseSysctlValues(
    ["hw.cachelinesize: 128", "", "some stray output"].join("\n"),
  );

  assert.deepEqual(parsed, { "hw.cachelinesize": "128" });
});

test("parseNetworksetupPorts extracts hardware ports", () => {
  const parsed = parseNetworksetupPorts(`Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 84:2f:57:91:e6:ce

Hardware Port: Thunderbolt Bridge
Device: bridge0
Ethernet Address: 36:67:a6:34:36:40
`);

  assert.deepEqual(parsed, [
    {
      hardwarePort: "Wi-Fi",
      device: "en0",
      ethernetAddress: "84:2f:57:91:e6:ce",
    },
    {
      hardwarePort: "Thunderbolt Bridge",
      device: "bridge0",
      ethernetAddress: "36:67:a6:34:36:40",
    },
  ]);
});

test("parsePmsetBattery extracts battery state", () => {
  const parsed = parsePmsetBattery(
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=23265379)       80%; AC attached; not charging present: true",
  );

  assert.deepEqual(parsed, {
    powerSource: "AC Power",
    batteryId: "23265379",
    chargePercent: 80,
    isAcAttached: true,
    isCharging: false,
  });
});

test("parseIfconfigText extracts live interface state without leaking raw IPs", () => {
  const parsed =
    parseIfconfigText(`en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
        options=6460<TSO4,TSO6,CHANNEL_IO,PARTIAL_CSUM,ZEROINVERT_CSUM>
        ether e2:45:88:f2:af:d4
        inet6 fe80::4cf:4cd8:1d32:1915%en0 prefixlen 64 secured scopeid 0x12
        inet 192.168.0.39 netmask 0xffffff00 broadcast 192.168.0.255
        media: autoselect
        status: active
`);

  assert.deepEqual(parsed, {
    flags: ["UP", "BROADCAST", "SMART", "RUNNING", "SIMPLEX", "MULTICAST"],
    mtu: 1500,
    macAddress: "e2:45:88:f2:af:d4",
    ipv4Count: 1,
    ipv6Count: 1,
    media: "autoselect",
    status: "active",
  });
});

test("normalizeApfsTopology flattens APFS containers and volumes", () => {
  const topology = normalizeApfsTopology({
    Containers: [
      {
        APFSContainerUUID: "CONTAINER-UUID-1",
        ContainerReference: "disk3",
        CapacityCeiling: 1000,
        CapacityFree: 100,
        PhysicalStores: [{ DeviceIdentifier: "disk0s2" }],
        Volumes: [
          {
            APFSVolumeUUID: "VOLUME-UUID-1",
            DeviceIdentifier: "disk3s1",
            Name: "Macintosh HD",
            Roles: ["System"],
          },
        ],
      },
    ],
  });

  assert.equal(topology.containers.length, 1);
  assert.equal(topology.volumes.length, 1);
  assert.equal(topology.volumes[0].ContainerReference, "disk3");
  assert.equal(topology.volumes[0].APFSContainerUUID, "CONTAINER-UUID-1");
});

test("buildDarwinArm64Hbom returns a redacted, CycloneDX-like shape by default", () => {
  const hbom = buildDarwinArm64Hbom({
    collectedAt: "2026-05-12T00:00:00.000Z",
    sources: {
      profiler: {
        SPHardwareDataType: [
          {
            machine_name: "MacBook Pro",
            machine_model: "Mac16,7",
            model_number: "Z1FQ000B5B/A",
            chip_type: "Apple M4 Pro",
            physical_memory: "48 GB",
            serial_number: "KX2L66YHJR",
            platform_UUID: "8A770B45-5F72-5242-B992-E8BC22A1BE01",
          },
        ],
        SPDisplaysDataType: [
          {
            _name: "Apple M4 Pro",
            spdisplays_ndrvs: [
              {
                _name: "Color LCD",
                _spdisplays_resolution: "2056 x 1329 @ 120.00Hz",
                spdisplays_connection_type: "Internal",
                "_spdisplays_display-vendor-id": "610",
                "_spdisplays_display-product-id": "a05f",
                "_spdisplays_display-serial-number": "fd626d62",
              },
            ],
          },
        ],
        SPNVMeDataType: [
          {
            _items: [
              {
                _name: "APPLE SSD AP1024Z",
                device_model: "APPLE SSD AP1024Z",
                bsd_name: "disk0",
                size: "1 TB",
                size_in_bytes: "1000555581440",
                device_revision: "2973.100",
                device_serial: "0ba0286441d10620",
              },
            ],
          },
        ],
        SPBluetoothDataType: [
          {
            controller_properties: {
              controller_address: "84:2F:57:84:5B:45",
              controller_chipset: "BCM_4388C2",
              controller_firmwareVersion: "23.5.224.1467",
              controller_productID: "0x4A3D",
              controller_state: "attrib_on",
              controller_supportedServices:
                "0x392039 < HFP AVRCP A2DP HID Braille LEA AACP GATT SerialPort >",
              controller_transport: "PCIe",
              controller_vendorID: "0x004C (Apple)",
            },
            device_connected: [
              {
                "MX KEYS S MAC": {
                  device_address: "D4:52:63:27:92:76",
                  device_minorType: "Keyboard",
                  device_productID: "0xB37C",
                  device_vendorID: "0x046D",
                },
              },
            ],
          },
        ],
        SPThunderboltDataType: [
          {
            _name: "thunderboltusb4_bus_0",
            device_name_key: "MacBook Pro",
            domain_uuid_key: "075CF3B0-FEF3-4A82-9F3D-E0261A7AF419",
            route_string_key: "0",
            switch_uid_key: "0x05ACC10CD9CD0D90",
            vendor_name_key: "Apple Inc.",
            receptacle_1_tag: {
              current_speed_key: "Up to 120 Gb/s",
              link_status_key: "0x100",
              micro_version_key: "0.0.0",
              receptacle_id_key: "1",
              receptacle_status_key: "receptacle_no_devices_connected",
            },
          },
        ],
        SPPowerDataType: [
          {
            _name: "spbattery_information",
            sppower_battery_charge_info: {
              sppower_battery_at_warn_level: "FALSE",
              sppower_battery_fully_charged: "FALSE",
              sppower_battery_is_charging: "FALSE",
              sppower_battery_state_of_charge: 80,
            },
            sppower_battery_health_info: {
              sppower_battery_cycle_count: 120,
              sppower_battery_health: "Good",
              sppower_battery_health_maximum_capacity: "91%",
            },
            sppower_battery_model_info: {
              sppower_battery_device_name: "bq40z651",
              sppower_battery_firmware_version: "0b00",
              sppower_battery_hardware_revision: "0100",
              sppower_battery_cell_revision: "171d",
              sppower_battery_serial_number: "F8YHD7000PG0000FWQ",
            },
          },
          {
            _name: "sppower_ac_charger_information",
            sppower_ac_charger_ID: "0x0000",
            sppower_ac_charger_family: "0xe000400a",
            sppower_ac_charger_watts: "100",
            sppower_battery_charger_connected: "TRUE",
            sppower_battery_is_charging: "FALSE",
          },
        ],
      },
      sysctl: {
        "machdep.cpu.brand_string": "Apple M4 Pro",
        "hw.memsize": "51539607552",
        "hw.model": "Mac16,7",
        "hw.ncpu": "14",
        "hw.logicalcpu": "14",
        "hw.physicalcpu": "14",
      },
      networksetup: [
        {
          hardwarePort: "Wi-Fi",
          device: "en0",
          ethernetAddress: "84:2f:57:91:e6:ce",
        },
      ],
      pmsetBattery: {
        powerSource: "AC Power",
        batteryId: "23265379",
        chargePercent: 80,
        isAcAttached: true,
        isCharging: false,
      },
      diskutilPlists: [
        {
          DeviceIdentifier: "disk0",
          DeviceBlockSize: 4096,
          DeviceTreePath:
            "IODeviceTree:/arm-io@10F00000/ans@9600000/iop-ans-nub/AppleANS3CGv2Controller",
          BusProtocol: "Apple Fabric",
          Internal: true,
          MediaName: "APPLE SSD AP1024Z",
          MediaType: "Generic",
          Removable: false,
          SMARTStatus: "Verified",
          SMARTDeviceSpecificKeysMayVaryNotGuaranteed: {
            PERCENTAGE_USED: 2,
          },
          Size: 1000555581440,
        },
      ],
      ioregPlatform: [
        {
          IOPlatformSerialNumber: "KX2L66YHJR",
          IOPlatformUUID: "8A770B45-5F72-5242-B992-E8BC22A1BE01",
          IORegistryEntryName: "J616sAP",
        },
      ],
    },
  });

  assert.equal(hbom.bomFormat, "CycloneDX");
  assert.equal(hbom.specVersion, "1.7");
  assert.match(hbom.serialNumber, /^urn:uuid:/u);
  assert.equal("evidence" in hbom, false);
  assert.equal(hbom.metadata.timestamp, "2026-05-12T00:00:00.000Z");
  assert.equal(hbom.metadata.component.name, "MacBook Pro");
  assert.equal(hbom.metadata.component.version, "Mac16,7");
  assert.equal(
    hbom.metadata.component.properties.find(
      (property) => property.name === "cdx:hbom:serialNumber",
    )?.value,
    "redacted:YHJR",
  );
  assert.equal(
    hbom.metadata.component.properties.find(
      (property) => property.name === "cdx:hbom:registryEntryName",
    )?.value,
    "J616sAP",
  );
  assert.ok(hbom.components.every((component) => component.type === "device"));
  assert.ok(hasHardwareClass(hbom.components, "processor"));
  assert.ok(hasHardwareClass(hbom.components, "storage"));
  assert.ok(hasHardwareClass(hbom.components, "display"));
  assert.ok(hasHardwareClass(hbom.components, "bluetooth-controller"));
  assert.ok(hasHardwareClass(hbom.components, "bluetooth-device"));
  assert.ok(hasHardwareClass(hbom.components, "bus"));
  assert.ok(hasHardwareClass(hbom.components, "power"));
  assert.ok(hasHardwareClass(hbom.components, "power-adapter"));
  assert.ok(
    hbom.components.some(
      (component) =>
        getPropertyValue(component, "cdx:hbom:hardwareClass") ===
          "network-interface" &&
        getPropertyValue(component, "cdx:hbom:macAddress")?.startsWith(
          "redacted:",
        ),
    ),
  );
  assert.equal(
    hbom.components
      .find(
        (component) =>
          getPropertyValue(component, "cdx:hbom:hardwareClass") === "power",
      )
      ?.properties.find((property) => property.name === "cdx:hbom:cycleCount")
      ?.value,
    "120",
  );
  assert.equal(
    hbom.components
      .find(
        (component) =>
          getPropertyValue(component, "cdx:hbom:hardwareClass") ===
          "power-adapter",
      )
      ?.properties.find((property) => property.name === "cdx:hbom:watts")
      ?.value,
    "100",
  );
  assert.equal(
    hbom.components
      .find(
        (component) =>
          getPropertyValue(component, "cdx:hbom:hardwareClass") === "storage",
      )
      ?.properties.find((property) => property.name === "cdx:hbom:smartStatus")
      ?.value,
    "Verified",
  );
  assert.equal(
    hbom.properties.find(
      (property) => property.name === "cdx:hbom:targetPlatform",
    )?.value,
    "darwin",
  );
  assert.ok(
    hbom.properties.some(
      (property) => property.name === "cdx:hbom:evidence:command",
    ),
  );
});

test("buildDarwinArm64Hbom records Apple Silicon CPU topology from sysctl", () => {
  // Recorded from an M4 Pro MacBook Pro (J616s) with the `sysctl -i` form
  // the collector runs. The host has no hw.l3cachesize key and
  // hw.optional.arm.FEAT_MTE prints 0, so the BOM omits l3CacheBytes and
  // leaves FEAT_MTE out of armFeatures.
  const hbom = buildDarwinArm64Hbom({
    collectedAt: "2026-05-12T00:00:00.000Z",
    sources: {
      sysctl: parseSysctlValues(
        readFixture("darwin/arm64/sysctl-baseline.txt"),
      ),
    },
  });
  const processor = getProcessorComponent(hbom);

  assert.equal(getPropertyValue(processor, "cdx:hbom:coreCount"), "14");
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:performanceLevelCount"),
    "2",
  );
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:performanceCoreCount"),
    "10",
  );
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:efficiencyCoreCount"),
    "4",
  );
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:performanceL2CacheBytes"),
    "16777216",
  );
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:efficiencyL2CacheBytes"),
    "4194304",
  );
  assert.equal(getPropertyValue(processor, "cdx:hbom:cacheLineBytes"), "128");
  assert.equal(getPropertyValue(processor, "cdx:hbom:l1iCacheBytes"), "131072");
  assert.equal(getPropertyValue(processor, "cdx:hbom:l1dCacheBytes"), "65536");
  assert.equal(getPropertyValue(processor, "cdx:hbom:l2CacheBytes"), "4194304");
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:l3CacheBytes"),
    undefined,
  );
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:armFeatures"),
    "FEAT_AES, FEAT_BF16, FEAT_BTI, FEAT_I8MM, FEAT_PAuth, FEAT_PMULL, FEAT_SHA256, FEAT_SHA3, FEAT_SHA512, FEAT_SME, FEAT_SME2",
  );
  assert.equal(getPropertyValue(processor, "cdx:hbom:targetType"), "J616s");
  // The chip target type describes the processor, not the host device.
  assert.equal(
    hbom.metadata.component.properties.find(
      (property) => property.name === "cdx:hbom:targetType",
    ),
    undefined,
  );
});

test("buildDarwinArm64Hbom omits properties for keys the host lacks", () => {
  // A single performance level and an L3 cache that does answer: the
  // efficiency properties and the level 1 scans are absent, the L3 size is
  // recorded.
  const hbom = buildDarwinArm64Hbom({
    sources: {
      sysctl: {
        "hw.nperflevels": "1",
        "hw.perflevel0.name": "Performance",
        "hw.perflevel0.physicalcpu": "8",
        "hw.cachelinesize": "64",
        "hw.l3cachesize": "33554432",
      },
    },
  });
  const processor = getProcessorComponent(hbom);

  assert.equal(
    getPropertyValue(processor, "cdx:hbom:performanceLevelCount"),
    "1",
  );
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:performanceCoreCount"),
    "8",
  );
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:efficiencyCoreCount"),
    undefined,
  );
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:performanceL2CacheBytes"),
    undefined,
  );
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:efficiencyL2CacheBytes"),
    undefined,
  );
  assert.equal(getPropertyValue(processor, "cdx:hbom:l3CacheBytes"), "33554432");
});

test("buildDarwinArm64Hbom keys performance levels on their name", () => {
  // Level 0 is named neither Performance nor Efficiency, so its cores are
  // not mislabelled; the Efficiency level is still recognized. A feature
  // key that prints 0 yields no armFeatures value.
  const hbom = buildDarwinArm64Hbom({
    sources: {
      sysctl: {
        "hw.nperflevels": "2",
        "hw.perflevel0.name": "Cluster0",
        "hw.perflevel0.physicalcpu": "8",
        "hw.perflevel0.l2cachesize": "8388608",
        "hw.perflevel1.name": "Efficiency",
        "hw.perflevel1.physicalcpu": "4",
        "hw.perflevel1.l2cachesize": "2097152",
        "hw.optional.arm.FEAT_MTE": "0",
      },
    },
  });
  const processor = getProcessorComponent(hbom);

  assert.equal(
    getPropertyValue(processor, "cdx:hbom:performanceCoreCount"),
    undefined,
  );
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:performanceL2CacheBytes"),
    undefined,
  );
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:efficiencyCoreCount"),
    "4",
  );
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:efficiencyL2CacheBytes"),
    "2097152",
  );
  assert.equal(
    getPropertyValue(processor, "cdx:hbom:armFeatures"),
    undefined,
  );
});

test("buildDarwinArm64Hbom can preserve identifiers when explicitly requested", () => {
  const hbom = buildDarwinArm64Hbom({
    includeSensitiveIdentifiers: true,
    sources: {
      profiler: {
        SPHardwareDataType: [
          {
            machine_name: "MacBook Pro",
            machine_model: "Mac16,7",
            chip_type: "Apple M4 Pro",
            serial_number: "KX2L66YHJR",
          },
        ],
      },
      sysctl: {
        "machdep.cpu.brand_string": "Apple M4 Pro",
      },
    },
  });

  assert.equal(
    hbom.metadata.component.properties.find(
      (property) => property.name === "cdx:hbom:serialNumber",
    )?.value,
    "KX2L66YHJR",
  );
});

test("buildDarwinArm64Hbom emits native USB, Wi-Fi, and audio components", () => {
  const hbom = buildDarwinArm64Hbom({
    sources: {
      profiler: {
        SPHardwareDataType: [
          {
            machine_name: "MacBook Pro",
            machine_model: "Mac16,7",
            chip_type: "Apple M4 Pro",
          },
        ],
        SPUSBDataType: [
          {
            _name: "USB 3.1 Bus",
            current_available: "900",
            _items: [
              {
                _name: "ROG DELTA S",
                manufacturer: "Asus",
                vendor_id: "0x0b05",
                product_id: "0x1958",
                location_id: "0x01100000 / 1",
                serial_num: "ABCDEF123456",
                speed: "Up to 480 Mb/s",
                version: "1.00",
              },
            ],
          },
        ],
        SPAirPortDataType: [
          {
            spairport_airport_interfaces: [
              {
                _name: "en0",
                spairport_status_information: "spairport_status_connected",
                spairport_supported_phymodes: "802.11 a/b/g/n/ac/ax",
                spairport_supported_channels: [
                  "1 (2GHz)",
                  "36 (5GHz)",
                  "149 (5GHz)",
                ],
                spairport_wireless_card_type:
                  "spairport_wireless_card_type_wifi (0x14E4, 0x4388)",
                spairport_wireless_country_code: "GB",
                spairport_wireless_firmware_version: "wl0: version 23.50.20",
                spairport_wireless_mac_address: "e2:45:88:f2:af:d4",
                spairport_current_network_information: {
                  spairport_network_channel: "36 (5GHz, 80MHz)",
                  spairport_network_country_code: "GB",
                  spairport_network_phymode: "802.11ac",
                  spairport_network_rate: 866,
                  spairport_security_mode:
                    "spairport_security_mode_wpa2_personal",
                },
              },
              {
                _name: "awdl0",
                spairport_supported_channels: ["6 (2GHz)"],
              },
            ],
          },
        ],
        SPAudioDataType: [
          {
            _name: "coreaudio_device",
            _items: [
              {
                _name: "ROG DELTA S",
                coreaudio_default_audio_output_device: "spaudio_yes",
                coreaudio_default_audio_system_device: "spaudio_yes",
                coreaudio_device_manufacturer: "Asus",
                coreaudio_device_output: 2,
                coreaudio_device_srate: 48000,
                coreaudio_device_transport: "coreaudio_device_type_usb",
                coreaudio_output_source: "spaudio_default",
              },
              {
                _name: "ROG DELTA S",
                coreaudio_device_input: 2,
                coreaudio_device_manufacturer: "Asus",
                coreaudio_device_srate: 48000,
                coreaudio_device_transport: "coreaudio_device_type_usb",
                coreaudio_input_source: "spaudio_default",
              },
              {
                _name: "MacBook Pro Speakers",
                coreaudio_device_manufacturer: "Apple Inc.",
                coreaudio_device_output: 2,
                coreaudio_device_srate: 96000,
                coreaudio_device_transport: "coreaudio_device_type_builtin",
                coreaudio_output_source: "MacBook Pro Speakers",
              },
            ],
          },
        ],
      },
      sysctl: {
        "machdep.cpu.brand_string": "Apple M4 Pro",
        "hw.model": "Mac16,7",
      },
    },
  });

  assert.ok(hasHardwareClass(hbom.components, "usb-controller"));
  assert.ok(hasHardwareClass(hbom.components, "usb-device"));
  assert.ok(hasHardwareClass(hbom.components, "wireless-adapter"));
  assert.equal(getHardwareClassCount(hbom.components, "audio-device"), 2);
  assert.equal(
    hbom.components
      .find(
        (component) =>
          getPropertyValue(component, "cdx:hbom:hardwareClass") ===
          "wireless-adapter",
      )
      ?.properties.find((property) => property.name === "cdx:hbom:connected")
      ?.value,
    "true",
  );
  assert.equal(
    hbom.components
      .find(
        (component) =>
          getPropertyValue(component, "cdx:hbom:hardwareClass") ===
          "usb-device",
      )
      ?.properties.find((property) => property.name === "cdx:hbom:deviceSerial")
      ?.value,
    "redacted:3456",
  );
  assert.equal(
    hbom.components
      .find(
        (component) =>
          component.name === "ROG DELTA S" &&
          getPropertyValue(component, "cdx:hbom:hardwareClass") ===
            "audio-device",
      )
      ?.properties.find(
        (property) => property.name === "cdx:hbom:inputChannels",
      )?.value,
    "2",
  );
  assert.equal(
    hbom.components
      .find(
        (component) =>
          component.name === "ROG DELTA S" &&
          getPropertyValue(component, "cdx:hbom:hardwareClass") ===
            "audio-device",
      )
      ?.properties.find(
        (property) => property.name === "cdx:hbom:defaultOutput",
      )?.value,
    "true",
  );
});

test("buildDarwinArm64Hbom emits camera, ifconfig-enriched network, and APFS topology components", () => {
  const hbom = buildDarwinArm64Hbom({
    sources: {
      profiler: {
        SPHardwareDataType: [
          {
            machine_name: "MacBook Pro",
            machine_model: "Mac16,7",
            chip_type: "Apple M4 Pro",
          },
        ],
        SPCameraDataType: [
          {
            _name: "MacBook Pro Camera",
            "spcamera_model-id": "MacBook Pro Camera",
            "spcamera_unique-id": "6C707041-05AC-0010-0007-000000000001",
          },
          {
            _name: "OBS Virtual Camera",
            "spcamera_model-id": "OBS Camera Extension",
            "spcamera_unique-id": "7626645E-4425-469E-9D8B-97E0FA59AC75",
          },
        ],
      },
      sysctl: {
        "machdep.cpu.brand_string": "Apple M4 Pro",
        "hw.model": "Mac16,7",
      },
      networksetup: [
        {
          hardwarePort: "Wi-Fi",
          device: "en0",
          ethernetAddress: "e2:45:88:f2:af:d4",
        },
      ],
      ifconfig: {
        en0: {
          flags: ["UP", "RUNNING", "MULTICAST"],
          mtu: 1500,
          media: "autoselect",
          status: "active",
          ipv4Count: 1,
          ipv6Count: 1,
          macAddress: "e2:45:88:f2:af:d4",
        },
      },
      apfsTopology: {
        Containers: [
          {
            APFSContainerUUID: "03EB4871-DE04-4ED7-82F7-CD13383AE027",
            ContainerReference: "disk3",
            CapacityCeiling: 994662584320,
            CapacityFree: 164422434816,
            PhysicalStores: [{ DeviceIdentifier: "disk0s2" }],
            Volumes: [
              {
                APFSVolumeUUID: "D4F8B78B-D4FE-42E9-8B08-7A6D34DC3D34",
                DeviceIdentifier: "disk3s1",
                Name: "Macintosh HD",
                Roles: ["System"],
                Encryption: true,
                FileVault: true,
                Locked: false,
                CapacityInUse: 16719212544,
              },
            ],
          },
        ],
      },
    },
  });

  assert.equal(getHardwareClassCount(hbom.components, "camera"), 2);
  assert.ok(hasHardwareClass(hbom.components, "storage-container"));
  assert.ok(hasHardwareClass(hbom.components, "storage-volume"));
  assert.equal(
    hbom.components
      .find(
        (component) =>
          getPropertyValue(component, "cdx:hbom:hardwareClass") === "camera" &&
          component.name === "OBS Virtual Camera",
      )
      ?.properties.find((property) => property.name === "cdx:hbom:isVirtual")
      ?.value,
    "true",
  );
  assert.equal(
    hbom.components
      .find(
        (component) =>
          getPropertyValue(component, "cdx:hbom:hardwareClass") ===
          "network-interface",
      )
      ?.properties.find((property) => property.name === "cdx:hbom:status")
      ?.value,
    "active",
  );
  assert.equal(
    hbom.components
      .find(
        (component) =>
          getPropertyValue(component, "cdx:hbom:hardwareClass") ===
          "storage-volume",
      )
      ?.properties.find((property) => property.name === "cdx:hbom:fileVault")
      ?.value,
    "true",
  );
});

function hasHardwareClass(components, hardwareClass) {
  return components.some(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") === hardwareClass,
  );
}

function getProcessorComponent(hbom) {
  return hbom.components.find(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") === "processor",
  );
}

function getHardwareClassCount(components, hardwareClass) {
  return components.filter(
    (component) =>
      getPropertyValue(component, "cdx:hbom:hardwareClass") === hardwareClass,
  ).length;
}

function getPropertyValue(component, name) {
  return component.properties.find((property) => property.name === name)?.value;
}
