# Custom properties

`cdx-hbom` emits **official CycloneDX 1.7 JSON documents** and carries hardware-specific detail via custom `properties`.

All current custom property names use the `cdx:hbom:` prefix.

## Document-level properties

These properties appear at the BOM top level in `properties`.

| Property                         | Meaning                                             | Example               |
| -------------------------------- | --------------------------------------------------- | --------------------- |
| `cdx:hbom:targetPlatform`        | Host operating system family that was inspected     | `darwin`              |
| `cdx:hbom:targetArchitecture`    | Host CPU architecture                               | `arm64`               |
| `cdx:hbom:identifierPolicy`      | Identifier privacy mode used for the document       | `redacted-by-default` |
| `cdx:hbom:collectorProfile`      | Collector profile / target flavor                   | `darwin-arm64-v1`     |
| `cdx:hbom:osName`                | Operating system name observed during collection    | `Ubuntu`              |
| `cdx:hbom:osVersion`             | Operating system version observed during collection | `24.04`               |
| `cdx:hbom:evidence:fileCount`    | Number of files read during collection              | `12`                  |
| `cdx:hbom:evidence:file`         | A file read during collection                       | `/proc/cpuinfo`       |
| `cdx:hbom:evidence:commandCount` | Number of commands used during collection           | `6`                   |
| `cdx:hbom:evidence:command`      | A command used during collection                    |                       |

## Metadata component properties

These properties commonly appear on `metadata.component`, which describes the host device itself.

| Property                     | Meaning                                               |
| ---------------------------- | ----------------------------------------------------- |
| `cdx:hbom:platform`          | Platform family for the host device                   |
| `cdx:hbom:architecture`      | Host architecture                                     |
| `cdx:hbom:chip`              | Primary CPU / SoC marketing name                      |
| `cdx:hbom:memory`            | Installed memory summary                              |
| `cdx:hbom:serialNumber`      | Host serial number, redacted by default               |
| `cdx:hbom:platformUuid`      | Host platform UUID, redacted by default               |
| `cdx:hbom:modelNumber`       | Vendor model number / SKU-like identifier             |
| `cdx:hbom:registryEntryName` | Low-level registry entry or hardware node name        |
| `cdx:hbom:boardVendor`       | Mainboard / baseboard vendor                          |
| `cdx:hbom:boardName`         | Mainboard / baseboard product name                    |
| `cdx:hbom:biosVendor`        | Firmware vendor                                       |
| `cdx:hbom:biosVersion`       | Firmware version                                      |
| `cdx:hbom:firmwareDate`      | Firmware release date if reported                     |
| `cdx:hbom:chassisType`       | Host chassis type or form factor                      |
| `cdx:hbom:identifierPolicy`  | Identifier privacy mode applied to the host component |

## Shared component classification property

All hardware inventory components use a schema-valid CycloneDX component `type`, currently usually `device`.
The finer-grained hardware role is recorded with:

| Property                 | Meaning                      | Example                                                      |
| ------------------------ | ---------------------------- | ------------------------------------------------------------ |
| `cdx:hbom:hardwareClass` | Hardware role/classification | `processor`, `storage`, `network-interface`, `power-adapter` |

## Common hardware properties

| Property                    | Meaning                                               |
| --------------------------- | ----------------------------------------------------- |
| `cdx:hbom:vendorId`         | Vendor ID reported by the platform                    |
| `cdx:hbom:productId`        | Product ID reported by the platform                   |
| `cdx:hbom:firmwareVersion`  | Firmware version                                      |
| `cdx:hbom:hardwareRevision` | Hardware revision                                     |
| `cdx:hbom:serialNumber`     | Component serial number, redacted by default          |
| `cdx:hbom:deviceSerial`     | Storage device serial number, redacted by default     |
| `cdx:hbom:address`          | Network/Bluetooth address, redacted by default        |
| `cdx:hbom:connectionState`  | Connected vs not-connected state                      |
| `cdx:hbom:transport`        | Transport medium such as `PCIe`, `USB`, or `Built-in` |
| `cdx:hbom:architecture`     | CPU architecture string such as `x86_64` or `arm64`   |
| `cdx:hbom:subsystem`        | Linux subsystem classification                        |
| `cdx:hbom:status`           | Device or power-supply status                         |
| `cdx:hbom:assetTag`         | Asset tag, redacted by default when sensitive         |
| `cdx:hbom:kernelModule`     | Kernel module associated with a device                |
| `cdx:hbom:driver`           | Kernel driver associated with a device                |

## Processor properties

| Property                    | Meaning                     |
| --------------------------- | --------------------------- |
| `cdx:hbom:coreCount`        | Reported total core count   |
| `cdx:hbom:logicalCpuCount`  | Reported logical CPU count  |
| `cdx:hbom:physicalCpuCount` | Reported physical CPU count |
| `cdx:hbom:socketCount`      | Reported CPU socket count   |
| `cdx:hbom:threadsPerCore`   | Reported threads per core   |
| `cdx:hbom:cpuFamily`        | CPU family identifier       |
| `cdx:hbom:model`            | CPU model identifier        |
| `cdx:hbom:stepping`         | CPU stepping                |

## Memory properties

| Property             | Meaning                    |
| -------------------- | -------------------------- |
| `cdx:hbom:size`      | Human-readable memory size |
| `cdx:hbom:sizeBytes` | Exact size in bytes        |

## Storage properties

| Property                      | Meaning                                |
| ----------------------------- | -------------------------------------- |
| `cdx:hbom:capacity`           | Human-readable capacity                |
| `cdx:hbom:capacityBytes`      | Capacity in bytes                      |
| `cdx:hbom:revision`           | Device revision                        |
| `cdx:hbom:busProtocol`        | Bus/interconnect protocol              |
| `cdx:hbom:smartStatus`        | SMART health summary                   |
| `cdx:hbom:mediaType`          | Media type                             |
| `cdx:hbom:isInternal`         | Whether the storage is internal        |
| `cdx:hbom:isRemovable`        | Whether the storage is removable       |
| `cdx:hbom:blockSize`          | Block size in bytes                    |
| `cdx:hbom:deviceTreePath`     | Device tree path                       |
| `cdx:hbom:wearPercentageUsed` | Device wear percentage if reported     |
| `cdx:hbom:isRotational`       | Whether the device is rotational media |

## Board and chassis properties

| Property                | Meaning                                  |
| ----------------------- | ---------------------------------------- |
| `cdx:hbom:assetTag`     | System or baseboard asset tag            |
| `cdx:hbom:serialNumber` | Board serial number, redacted by default |

## Firmware properties

| Property                | Meaning                   |
| ----------------------- | ------------------------- |
| `cdx:hbom:firmwareDate` | Firmware release date     |
| `cdx:hbom:biosRevision` | BIOS revision if reported |

## Display properties

| Property                       | Meaning                                    |
| ------------------------------ | ------------------------------------------ |
| `cdx:hbom:resolution`          | Resolution summary                         |
| `cdx:hbom:connectionType`      | Connection type                            |
| `cdx:hbom:displaySerialNumber` | Display serial number, redacted by default |

## Bluetooth properties

| Property                     | Meaning                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `cdx:hbom:chipset`           | Bluetooth chipset name                                           |
| `cdx:hbom:state`             | Controller state                                                 |
| `cdx:hbom:supportedServices` | Controller or device service summary                             |
| `cdx:hbom:minorType`         | Device minor type                                                |
| `cdx:hbom:rssi`              | Signal strength if reported                                      |
| `cdx:hbom:serialNumberLeft`  | Left-side serial number for paired devices, redacted by default  |
| `cdx:hbom:serialNumberRight` | Right-side serial number for paired devices, redacted by default |

## Thunderbolt / USB4 properties

| Property                        | Meaning                              |
| ------------------------------- | ------------------------------------ |
| `cdx:hbom:deviceName`           | Device or bus name                   |
| `cdx:hbom:domainUuid`           | Bus domain UUID, redacted by default |
| `cdx:hbom:switchUid`            | Switch UID, redacted by default      |
| `cdx:hbom:routeString`          | Route string                         |
| `cdx:hbom:receptacleCount`      | Number of receptacles represented    |
| `cdx:hbom:receptacleIds`        | Receptacle identifiers               |
| `cdx:hbom:linkStatus`           | Link status summary                  |
| `cdx:hbom:speed`                | Reported bus speed                   |
| `cdx:hbom:receptacleStatus`     | Receptacle status summary            |
| `cdx:hbom:microFirmwareVersion` | Micro firmware version summary       |

## PCI properties

| Property                   | Meaning               |
| -------------------------- | --------------------- |
| `cdx:hbom:pciSlot`         | PCI slot / address    |
| `cdx:hbom:pciClass`        | PCI class description |
| `cdx:hbom:pciClassCode`    | PCI class code        |
| `cdx:hbom:subsystemVendor` | PCI subsystem vendor  |
| `cdx:hbom:subsystemDevice` | PCI subsystem device  |
| `cdx:hbom:driver`          | Bound kernel driver   |
| `cdx:hbom:kernelModule`    | Kernel module name    |

## USB properties

| Property             | Meaning           |
| -------------------- | ----------------- |
| `cdx:hbom:usbBus`    | USB bus number    |
| `cdx:hbom:usbDevice` | USB device number |

## Power properties

| Property                       | Meaning                                              |
| ------------------------------ | ---------------------------------------------------- |
| `cdx:hbom:powerSource`         | Current power source                                 |
| `cdx:hbom:chargePercent`       | Battery charge percentage                            |
| `cdx:hbom:isAcAttached`        | Whether AC power is attached                         |
| `cdx:hbom:isCharging`          | Whether the battery is charging                      |
| `cdx:hbom:batteryId`           | Battery runtime identifier, redacted by default      |
| `cdx:hbom:cycleCount`          | Battery cycle count                                  |
| `cdx:hbom:health`              | Battery health summary                               |
| `cdx:hbom:maximumCapacity`     | Maximum capacity percentage                          |
| `cdx:hbom:fullyCharged`        | Whether the battery is fully charged                 |
| `cdx:hbom:atWarningLevel`      | Whether the battery is at warning level              |
| `cdx:hbom:deviceName`          | Battery device name                                  |
| `cdx:hbom:cellRevision`        | Battery cell revision                                |
| `cdx:hbom:batterySerialNumber` | Battery serial number, redacted by default           |
| `cdx:hbom:connected`           | Whether the power adapter is connected               |
| `cdx:hbom:chargerId`           | Charger identifier                                   |
| `cdx:hbom:family`              | Charger family identifier                            |
| `cdx:hbom:watts`               | Charger wattage                                      |
| `cdx:hbom:powerSupplyType`     | Linux power-supply type such as `Battery` or `Mains` |

## Linux network properties

| Property             | Meaning                               |
| -------------------- | ------------------------------------- |
| `cdx:hbom:operState` | Linux interface operational state     |
| `cdx:hbom:mtu`       | Interface MTU                         |
| `cdx:hbom:speedMbps` | Interface speed in Mbps when reported |
| `cdx:hbom:duplex`    | Duplex mode                           |
| `cdx:hbom:ifindex`   | Interface index                       |
| `cdx:hbom:linkType`  | Linux interface/link type             |

## Privacy-sensitive properties

These properties may contain unique identifiers and remain redacted by default:

- `cdx:hbom:serialNumber`
- `cdx:hbom:platformUuid`
- `cdx:hbom:deviceSerial`
- `cdx:hbom:displaySerialNumber`
- `cdx:hbom:address`
- `cdx:hbom:batteryId`
- `cdx:hbom:batterySerialNumber`
- `cdx:hbom:domainUuid`
- `cdx:hbom:switchUid`
- `cdx:hbom:serialNumberLeft`
- `cdx:hbom:serialNumberRight`
