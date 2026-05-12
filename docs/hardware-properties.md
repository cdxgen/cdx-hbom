# Custom properties

`cdx-hbom` emits **official CycloneDX 1.7 JSON documents** and carries hardware-specific detail via custom `properties`.

All current custom property names use the `hbom:` prefix.

## Document-level properties

These properties appear at the BOM top level in `properties`.

| Property                     | Meaning                                             | Example               |
| ---------------------------- | --------------------------------------------------- | --------------------- | --------------- | --------------------- | -------- | ------------------------------------ |
| `hbom:targetPlatform`        | Host operating system family that was inspected     | `darwin`              |
| `hbom:targetArchitecture`    | Host CPU architecture                               | `arm64`               |
| `hbom:identifierPolicy`      | Identifier privacy mode used for the document       | `redacted-by-default` |
| `hbom:collectorProfile`      | Collector profile / target flavor                   | `darwin-arm64-v1`     |
| `hbom:osName`                | Operating system name observed during collection    | `Ubuntu`              |
| `hbom:osVersion`             | Operating system version observed during collection | `24.04`               |
| `hbom:evidence:fileCount`    | Number of files read during collection              | `12`                  |
| `hbom:evidence:file`         | A file read during collection                       | `/proc/cpuinfo`       |
| `hbom:evidence:commandCount` | Number of commands used during collection           | `6`                   |
| `hbom:evidence:command`      | A command used during collection encoded as `<id>   | <category>            | <command line>` | `system-profiler-json | platform | /usr/sbin/system_profiler ... -json` |

## Metadata component properties

These properties commonly appear on `metadata.component`, which describes the host device itself.

| Property                 | Meaning                                               |
| ------------------------ | ----------------------------------------------------- |
| `hbom:platform`          | Platform family for the host device                   |
| `hbom:architecture`      | Host architecture                                     |
| `hbom:chip`              | Primary CPU / SoC marketing name                      |
| `hbom:memory`            | Installed memory summary                              |
| `hbom:serialNumber`      | Host serial number, redacted by default               |
| `hbom:platformUuid`      | Host platform UUID, redacted by default               |
| `hbom:modelNumber`       | Vendor model number / SKU-like identifier             |
| `hbom:registryEntryName` | Low-level registry entry or hardware node name        |
| `hbom:boardVendor`       | Mainboard / baseboard vendor                          |
| `hbom:boardName`         | Mainboard / baseboard product name                    |
| `hbom:biosVendor`        | Firmware vendor                                       |
| `hbom:biosVersion`       | Firmware version                                      |
| `hbom:firmwareDate`      | Firmware release date if reported                     |
| `hbom:chassisType`       | Host chassis type or form factor                      |
| `hbom:identifierPolicy`  | Identifier privacy mode applied to the host component |

## Shared component classification property

All hardware inventory components use a schema-valid CycloneDX component `type`, currently usually `device`.
The finer-grained hardware role is recorded with:

| Property             | Meaning                      | Example                                                      |
| -------------------- | ---------------------------- | ------------------------------------------------------------ |
| `hbom:hardwareClass` | Hardware role/classification | `processor`, `storage`, `network-interface`, `power-adapter` |

## Common hardware properties

| Property                | Meaning                                               |
| ----------------------- | ----------------------------------------------------- |
| `hbom:vendorId`         | Vendor ID reported by the platform                    |
| `hbom:productId`        | Product ID reported by the platform                   |
| `hbom:firmwareVersion`  | Firmware version                                      |
| `hbom:hardwareRevision` | Hardware revision                                     |
| `hbom:serialNumber`     | Component serial number, redacted by default          |
| `hbom:deviceSerial`     | Storage device serial number, redacted by default     |
| `hbom:address`          | Network/Bluetooth address, redacted by default        |
| `hbom:connectionState`  | Connected vs not-connected state                      |
| `hbom:transport`        | Transport medium such as `PCIe`, `USB`, or `Built-in` |
| `hbom:architecture`     | CPU architecture string such as `x86_64` or `arm64`   |
| `hbom:subsystem`        | Linux subsystem classification                        |
| `hbom:status`           | Device or power-supply status                         |
| `hbom:assetTag`         | Asset tag, redacted by default when sensitive         |
| `hbom:kernelModule`     | Kernel module associated with a device                |
| `hbom:driver`           | Kernel driver associated with a device                |

## Processor properties

| Property                | Meaning                     |
| ----------------------- | --------------------------- |
| `hbom:coreCount`        | Reported total core count   |
| `hbom:logicalCpuCount`  | Reported logical CPU count  |
| `hbom:physicalCpuCount` | Reported physical CPU count |
| `hbom:socketCount`      | Reported CPU socket count   |
| `hbom:threadsPerCore`   | Reported threads per core   |
| `hbom:cpuFamily`        | CPU family identifier       |
| `hbom:model`            | CPU model identifier        |
| `hbom:stepping`         | CPU stepping                |

## Memory properties

| Property         | Meaning                    |
| ---------------- | -------------------------- |
| `hbom:size`      | Human-readable memory size |
| `hbom:sizeBytes` | Exact size in bytes        |

## Storage properties

| Property                  | Meaning                                |
| ------------------------- | -------------------------------------- |
| `hbom:capacity`           | Human-readable capacity                |
| `hbom:capacityBytes`      | Capacity in bytes                      |
| `hbom:revision`           | Device revision                        |
| `hbom:busProtocol`        | Bus/interconnect protocol              |
| `hbom:smartStatus`        | SMART health summary                   |
| `hbom:mediaType`          | Media type                             |
| `hbom:isInternal`         | Whether the storage is internal        |
| `hbom:isRemovable`        | Whether the storage is removable       |
| `hbom:blockSize`          | Block size in bytes                    |
| `hbom:deviceTreePath`     | Device tree path                       |
| `hbom:wearPercentageUsed` | Device wear percentage if reported     |
| `hbom:isRotational`       | Whether the device is rotational media |

## Board and chassis properties

| Property            | Meaning                                  |
| ------------------- | ---------------------------------------- |
| `hbom:assetTag`     | System or baseboard asset tag            |
| `hbom:serialNumber` | Board serial number, redacted by default |

## Firmware properties

| Property            | Meaning                   |
| ------------------- | ------------------------- |
| `hbom:firmwareDate` | Firmware release date     |
| `hbom:biosRevision` | BIOS revision if reported |

## Display properties

| Property                   | Meaning                                    |
| -------------------------- | ------------------------------------------ |
| `hbom:resolution`          | Resolution summary                         |
| `hbom:connectionType`      | Connection type                            |
| `hbom:displaySerialNumber` | Display serial number, redacted by default |

## Bluetooth properties

| Property                 | Meaning                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `hbom:chipset`           | Bluetooth chipset name                                           |
| `hbom:state`             | Controller state                                                 |
| `hbom:supportedServices` | Controller or device service summary                             |
| `hbom:minorType`         | Device minor type                                                |
| `hbom:rssi`              | Signal strength if reported                                      |
| `hbom:serialNumberLeft`  | Left-side serial number for paired devices, redacted by default  |
| `hbom:serialNumberRight` | Right-side serial number for paired devices, redacted by default |

## Thunderbolt / USB4 properties

| Property                    | Meaning                              |
| --------------------------- | ------------------------------------ |
| `hbom:deviceName`           | Device or bus name                   |
| `hbom:domainUuid`           | Bus domain UUID, redacted by default |
| `hbom:switchUid`            | Switch UID, redacted by default      |
| `hbom:routeString`          | Route string                         |
| `hbom:receptacleCount`      | Number of receptacles represented    |
| `hbom:receptacleIds`        | Receptacle identifiers               |
| `hbom:linkStatus`           | Link status summary                  |
| `hbom:speed`                | Reported bus speed                   |
| `hbom:receptacleStatus`     | Receptacle status summary            |
| `hbom:microFirmwareVersion` | Micro firmware version summary       |

## PCI properties

| Property               | Meaning               |
| ---------------------- | --------------------- |
| `hbom:pciSlot`         | PCI slot / address    |
| `hbom:pciClass`        | PCI class description |
| `hbom:pciClassCode`    | PCI class code        |
| `hbom:subsystemVendor` | PCI subsystem vendor  |
| `hbom:subsystemDevice` | PCI subsystem device  |
| `hbom:driver`          | Bound kernel driver   |
| `hbom:kernelModule`    | Kernel module name    |

## USB properties

| Property         | Meaning           |
| ---------------- | ----------------- |
| `hbom:usbBus`    | USB bus number    |
| `hbom:usbDevice` | USB device number |

## Power properties

| Property                   | Meaning                                              |
| -------------------------- | ---------------------------------------------------- |
| `hbom:powerSource`         | Current power source                                 |
| `hbom:chargePercent`       | Battery charge percentage                            |
| `hbom:isAcAttached`        | Whether AC power is attached                         |
| `hbom:isCharging`          | Whether the battery is charging                      |
| `hbom:batteryId`           | Battery runtime identifier, redacted by default      |
| `hbom:cycleCount`          | Battery cycle count                                  |
| `hbom:health`              | Battery health summary                               |
| `hbom:maximumCapacity`     | Maximum capacity percentage                          |
| `hbom:fullyCharged`        | Whether the battery is fully charged                 |
| `hbom:atWarningLevel`      | Whether the battery is at warning level              |
| `hbom:deviceName`          | Battery device name                                  |
| `hbom:cellRevision`        | Battery cell revision                                |
| `hbom:batterySerialNumber` | Battery serial number, redacted by default           |
| `hbom:connected`           | Whether the power adapter is connected               |
| `hbom:chargerId`           | Charger identifier                                   |
| `hbom:family`              | Charger family identifier                            |
| `hbom:watts`               | Charger wattage                                      |
| `hbom:powerSupplyType`     | Linux power-supply type such as `Battery` or `Mains` |

## Linux network properties

| Property         | Meaning                               |
| ---------------- | ------------------------------------- |
| `hbom:operState` | Linux interface operational state     |
| `hbom:mtu`       | Interface MTU                         |
| `hbom:speedMbps` | Interface speed in Mbps when reported |
| `hbom:duplex`    | Duplex mode                           |
| `hbom:ifindex`   | Interface index                       |
| `hbom:linkType`  | Linux interface/link type             |

## Privacy-sensitive properties

These properties may contain unique identifiers and should remain redacted by default:

- `hbom:serialNumber`
- `hbom:platformUuid`
- `hbom:deviceSerial`
- `hbom:displaySerialNumber`
- `hbom:address`
- `hbom:batteryId`
- `hbom:batterySerialNumber`
- `hbom:domainUuid`
- `hbom:switchUid`
- `hbom:serialNumberLeft`
- `hbom:serialNumberRight`
