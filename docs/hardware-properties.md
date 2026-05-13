# Custom properties

`cdx-hbom` emits **official CycloneDX 1.7 JSON documents** and carries hardware-specific detail via custom `properties`.

All currently emitted custom property names use the `cdx:hbom:` prefix. This page is intended to describe the properties emitted by the current source tree, including Darwin camera/APFS enrichment and the newer Linux sensor, TPM, NVMe, MMC, graphics, and audio fields.

## Document-level properties

These properties appear at the BOM top level in `properties`.

| Property                         | Meaning                                             | Example                          |
| -------------------------------- | --------------------------------------------------- | -------------------------------- |
| `cdx:hbom:targetPlatform`        | Host operating system family that was inspected     | `darwin`                         |
| `cdx:hbom:targetArchitecture`    | Host CPU architecture                               | `arm64`                          |
| `cdx:hbom:identifierPolicy`      | Identifier privacy mode used for the document       | `redacted-by-default`            |
| `cdx:hbom:collectorProfile`      | Collector profile / target flavor                   | `darwin-arm64-v1`                |
| `cdx:hbom:osName`                | Operating system name observed during collection    | `Ubuntu`                         |
| `cdx:hbom:osVersion`             | Operating system version observed during collection | `24.04`                          |
| `cdx:hbom:evidence:fileCount`    | Number of files read during collection              | `12`                             |
| `cdx:hbom:evidence:file`         | A file read during collection                       | `/proc/cpuinfo`                  |
| `cdx:hbom:evidence:commandCount` | Number of commands used during collection           | `6`                              |
| `cdx:hbom:evidence:command`      | A command used during collection                    | `lscpu-json,cpu-memory,lscpu -J` |

## Metadata component properties

These properties commonly appear on `metadata.component`, which describes the host device itself.

| Property                         | Meaning                                               |
| -------------------------------- | ----------------------------------------------------- |
| `cdx:hbom:platform`              | Platform family for the host device                   |
| `cdx:hbom:architecture`          | Host architecture                                     |
| `cdx:hbom:chip`                  | Primary CPU / SoC marketing name                      |
| `cdx:hbom:memory`                | Installed memory summary                              |
| `cdx:hbom:serialNumber`          | Host serial number, redacted by default               |
| `cdx:hbom:platformUuid`          | Host platform UUID, redacted by default               |
| `cdx:hbom:modelNumber`           | Vendor model number / SKU-like identifier             |
| `cdx:hbom:registryEntryName`     | Low-level Darwin registry entry or hardware node name |
| `cdx:hbom:boardVendor`           | Mainboard / baseboard vendor                          |
| `cdx:hbom:boardName`             | Mainboard / baseboard product name                    |
| `cdx:hbom:biosVendor`            | Firmware vendor                                       |
| `cdx:hbom:biosVersion`           | Firmware version                                      |
| `cdx:hbom:firmwareDate`          | Firmware release date if reported                     |
| `cdx:hbom:deviceTreeRevision`    | Linux device-tree revision or board revision string   |
| `cdx:hbom:deviceTreeLinuxSerial` | Linux device-tree serial, redacted by default         |
| `cdx:hbom:deviceTreeCompatible`  | Linux device-tree compatible values                   |
| `cdx:hbom:chassisType`           | Host chassis type or form factor                      |
| `cdx:hbom:identifierPolicy`      | Identifier privacy mode applied to the host component |

## Shared component classification property

All hardware inventory components use a schema-valid CycloneDX component `type`, currently usually `device`.
The finer-grained hardware role is recorded with:

| Property                 | Meaning                      | Example                                                                |
| ------------------------ | ---------------------------- | ---------------------------------------------------------------------- |
| `cdx:hbom:hardwareClass` | Hardware role/classification | `processor`, `storage`, `camera`, `network-interface`, `power-adapter` |

## Common hardware properties

These appear across multiple hardware classes.

| Property                    | Meaning                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `cdx:hbom:vendorId`         | Vendor identifier reported by the platform                           |
| `cdx:hbom:productId`        | Product identifier reported by the platform                          |
| `cdx:hbom:firmwareVersion`  | Firmware version                                                     |
| `cdx:hbom:biosRevision`     | BIOS revision when reported                                          |
| `cdx:hbom:hardwareRevision` | Hardware revision                                                    |
| `cdx:hbom:serialNumber`     | Component serial number, redacted by default                         |
| `cdx:hbom:deviceSerial`     | Device serial number, redacted by default                            |
| `cdx:hbom:address`          | Bluetooth or similar address, redacted by default                    |
| `cdx:hbom:macAddress`       | MAC address, redacted by default                                     |
| `cdx:hbom:connectionState`  | Connected / disconnected state                                       |
| `cdx:hbom:transport`        | Transport medium such as `PCIe`, `USB`, or `Built-in`                |
| `cdx:hbom:subsystem`        | Linux subsystem classification                                       |
| `cdx:hbom:status`           | Device, interface, or power-supply status                            |
| `cdx:hbom:state`            | Controller state or runtime state                                    |
| `cdx:hbom:enabled`          | Whether a feature, connector, or output is enabled                   |
| `cdx:hbom:connected`        | Whether the component is currently connected or online               |
| `cdx:hbom:assetTag`         | Asset tag, redacted by default when identifier redaction applies     |
| `cdx:hbom:driver`           | Kernel or platform driver associated with a device                   |
| `cdx:hbom:kernelModule`     | Kernel module associated with a device                               |
| `cdx:hbom:modalias`         | Linux modalias string                                                |
| `cdx:hbom:locationId`       | Darwin location identifier for a device                              |
| `cdx:hbom:revision`         | Generic device revision string                                       |
| `cdx:hbom:index`            | Linux device index when exported by the subsystem                    |
| `cdx:hbom:roles`            | Reported role list for a multi-role component such as an APFS volume |

## Processor and memory properties

| Property                    | Meaning                                           |
| --------------------------- | ------------------------------------------------- |
| `cdx:hbom:coreCount`        | Reported total core count                         |
| `cdx:hbom:logicalCpuCount`  | Reported logical CPU count                        |
| `cdx:hbom:physicalCpuCount` | Reported physical CPU count                       |
| `cdx:hbom:socketCount`      | Reported CPU socket count                         |
| `cdx:hbom:threadsPerCore`   | Reported threads per core                         |
| `cdx:hbom:cpuFamily`        | CPU family identifier                             |
| `cdx:hbom:model`            | CPU model identifier                              |
| `cdx:hbom:stepping`         | CPU stepping                                      |
| `cdx:hbom:clusterCount`     | Reported CPU cluster count                        |
| `cdx:hbom:numaNodeCount`    | Reported NUMA node count                          |
| `cdx:hbom:addressSizes`     | CPU address size capabilities reported by `lscpu` |
| `cdx:hbom:byteOrder`        | CPU byte order reported by `lscpu`                |
| `cdx:hbom:opModes`          | CPU operating modes such as `32-bit, 64-bit`      |
| `cdx:hbom:minClockMHz`      | Minimum reported CPU frequency in MHz             |
| `cdx:hbom:maxClockMHz`      | Maximum reported CPU frequency in MHz             |
| `cdx:hbom:onlineCpuSet`     | Online CPU set reported by `lscpu`                |
| `cdx:hbom:offlineCpuSet`    | Offline CPU set reported by `lscpu`               |
| `cdx:hbom:scalingPercent`   | CPU scaling percentage summary                    |
| `cdx:hbom:size`             | Human-readable memory size                        |
| `cdx:hbom:sizeBytes`        | Exact size in bytes                               |
| `cdx:hbom:memoryRangeCount` | Number of memory ranges reported by `lsmem`       |
| `cdx:hbom:memoryOnlineSize` | Online memory size reported by `lsmem`            |

## Storage, APFS, and NVMe properties

| Property                      | Meaning                                          |
| ----------------------------- | ------------------------------------------------ |
| `cdx:hbom:capacity`           | Human-readable capacity                          |
| `cdx:hbom:capacityBytes`      | Capacity in bytes                                |
| `cdx:hbom:capacityInUse`      | Bytes in use for a volume                        |
| `cdx:hbom:capacityQuota`      | Quota in bytes when reported                     |
| `cdx:hbom:capacityReserve`    | Reserved bytes when reported                     |
| `cdx:hbom:freeBytes`          | Free bytes reported by the platform              |
| `cdx:hbom:busProtocol`        | Bus / interconnect protocol                      |
| `cdx:hbom:smartStatus`        | SMART health summary                             |
| `cdx:hbom:mediaType`          | Media type                                       |
| `cdx:hbom:isInternal`         | Whether the storage is internal                  |
| `cdx:hbom:isRemovable`        | Whether the storage is removable                 |
| `cdx:hbom:isRotational`       | Whether the storage is rotational media          |
| `cdx:hbom:blockSize`          | Block size in bytes                              |
| `cdx:hbom:bsdName`            | Darwin BSD storage name                          |
| `cdx:hbom:deviceTreePath`     | Darwin device-tree path                          |
| `cdx:hbom:wearPercentageUsed` | Flash wear percentage if reported                |
| `cdx:hbom:container`          | Parent container reference for a volume          |
| `cdx:hbom:containerUuid`      | APFS container UUID, redacted by default         |
| `cdx:hbom:volumeUuid`         | APFS volume UUID, redacted by default            |
| `cdx:hbom:physicalStores`     | APFS physical backing stores                     |
| `cdx:hbom:isEncrypted`        | Whether a volume is encrypted                    |
| `cdx:hbom:fileVault`          | Whether FileVault is enabled for a volume        |
| `cdx:hbom:isLocked`           | Whether a volume is locked                       |
| `cdx:hbom:pciAddress`         | PCI address associated with a storage controller |
| `cdx:hbom:namespaceCount`     | Number of NVMe namespaces                        |
| `cdx:hbom:namespaces`         | Namespace identifiers or names                   |

## Network and wireless properties

| Property                         | Meaning                                                           |
| -------------------------------- | ----------------------------------------------------------------- |
| `cdx:hbom:mtu`                   | Interface MTU                                                     |
| `cdx:hbom:media`                 | Media selection / negotiated media string                         |
| `cdx:hbom:flags`                 | Interface flag list                                               |
| `cdx:hbom:ipv4Count`             | Number of IPv4 addresses observed                                 |
| `cdx:hbom:ipv6Count`             | Number of IPv6 addresses observed                                 |
| `cdx:hbom:operState`             | Linux interface operational state                                 |
| `cdx:hbom:speedMbps`             | Interface speed in Mbps when reported                             |
| `cdx:hbom:duplex`                | Duplex mode                                                       |
| `cdx:hbom:ifindex`               | Interface index                                                   |
| `cdx:hbom:linkType`              | Linux interface/link type                                         |
| `cdx:hbom:busInfo`               | Driver-reported bus location from `ethtool`                       |
| `cdx:hbom:kernelVersion`         | Driver version or kernel version reported by the networking stack |
| `cdx:hbom:supportedPhyModes`     | Wi-Fi PHY modes supported by the adapter                          |
| `cdx:hbom:supportedChannelCount` | Number of supported Wi-Fi channels                                |
| `cdx:hbom:countryCode`           | Wireless country code                                             |
| `cdx:hbom:channel`               | Current wireless channel                                          |
| `cdx:hbom:phyMode`               | Current wireless PHY mode                                         |
| `cdx:hbom:linkRateMbps`          | Current wireless link rate in Mbps                                |
| `cdx:hbom:securityMode`          | Current wireless security mode                                    |

## Audio properties

| Property                       | Meaning                                               |
| ------------------------------ | ----------------------------------------------------- |
| `cdx:hbom:transport`           | Audio transport such as built-in or external          |
| `cdx:hbom:inputChannels`       | Number of input channels                              |
| `cdx:hbom:outputChannels`      | Number of output channels                             |
| `cdx:hbom:defaultInput`        | Whether the audio device is the default input         |
| `cdx:hbom:defaultOutput`       | Whether the audio device is the default output        |
| `cdx:hbom:defaultSystemOutput` | Whether the audio device is the default system output |
| `cdx:hbom:sampleRate`          | Single effective sample rate                          |
| `cdx:hbom:sampleRates`         | Multiple supported or observed sample rates           |
| `cdx:hbom:inputSources`        | Input source list                                     |
| `cdx:hbom:outputSources`       | Output source list                                    |
| `cdx:hbom:cardNumber`          | Linux ALSA card number                                |
| `cdx:hbom:cardId`              | Linux ALSA card identifier                            |
| `cdx:hbom:kernelId`            | Linux kernel-facing audio card identifier             |
| `cdx:hbom:longName`            | Extended ALSA card description                        |
| `cdx:hbom:pcmDeviceCount`      | Number of PCM devices attached to a card              |
| `cdx:hbom:deviceNumber`        | Linux PCM device number                               |
| `cdx:hbom:pcmId`               | Linux PCM device identifier                           |
| `cdx:hbom:playbackStreamCount` | Number of playback streams                            |
| `cdx:hbom:captureStreamCount`  | Number of capture streams                             |

## Camera properties

| Property                  | Meaning                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `cdx:hbom:cameraModelId`  | Darwin camera model identifier                             |
| `cdx:hbom:cameraUniqueId` | Darwin camera unique identifier, redacted by default       |
| `cdx:hbom:isVirtual`      | Whether the camera appears to be virtual / software-backed |

## Display, graphics, and video properties

| Property                       | Meaning                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| `cdx:hbom:resolution`          | Resolution summary                                          |
| `cdx:hbom:connectionType`      | Display connection type                                     |
| `cdx:hbom:displaySerialNumber` | Display serial number, redacted by default                  |
| `cdx:hbom:displayAdapter`      | Parent graphics adapter for a display connector             |
| `cdx:hbom:displayConnector`    | Display connector or output name                            |
| `cdx:hbom:displayConnectorType`| DRM/KMS connector type such as `HDMI-A` or `DP`            |
| `cdx:hbom:edidVersion`         | EDID version                                                |
| `cdx:hbom:preferredResolution` | Preferred resolution from EDID                              |
| `cdx:hbom:physicalSize`        | Physical display dimensions                                 |
| `cdx:hbom:manufactureWeek`     | Display manufacture week                                    |
| `cdx:hbom:manufactureYear`     | Display manufacture year                                    |
| `cdx:hbom:connectorCount`      | Number of graphics/display connectors represented           |
| `cdx:hbom:instanceCount`       | Number of Linux device instances grouped into one component |
| `cdx:hbom:index`               | Linux video / graphics index                                |
| `cdx:hbom:drmConnectorId`      | Numeric DRM/KMS connector identifier                        |
| `cdx:hbom:dpms`                | DRM/KMS power-management state for a connector              |
| `cdx:hbom:kernelDevices`       | Kernel device node names represented by the component       |
| `cdx:hbom:drmNode`             | DRM device node such as `/dev/dri/card1`                    |
| `cdx:hbom:drmBusType`          | DRM-reported bus type such as `PCI` or `platform`           |
| `cdx:hbom:drmAvailableNodes`   | Number of DRM node types exposed by the adapter             |
| `cdx:hbom:framebufferMinWidth` | Minimum framebuffer width supported by the adapter          |
| `cdx:hbom:framebufferMaxWidth` | Maximum framebuffer width supported by the adapter          |
| `cdx:hbom:framebufferMinHeight`| Minimum framebuffer height supported by the adapter         |
| `cdx:hbom:framebufferMaxHeight`| Maximum framebuffer height supported by the adapter         |
| `cdx:hbom:ofName`              | Open Firmware / device-tree name                            |
| `cdx:hbom:ofCompatible`        | Open Firmware compatible values                             |
| `cdx:hbom:modes`               | Supported display or video modes                            |
| `cdx:hbom:maxBitsPerChannel`   | Maximum bits-per-channel reported for a connector           |
| `cdx:hbom:colorspace`          | Active or supported DRM colorspace selection                |
| `cdx:hbom:contentProtection`   | DRM content-protection state                                |
| `cdx:hbom:crtcId`              | Current bound CRTC identifier                               |
| `cdx:hbom:clientCapabilities`  | DRM client capabilities supported by the driver             |
| `cdx:hbom:driverDescription`   | Driver-reported graphics description                        |
| `cdx:hbom:driverVersion`       | Driver-reported graphics version                            |
| `cdx:hbom:kernelRelease`       | Kernel release reported by the DRM driver                   |
| `cdx:hbom:variableRefreshEnabled` | Whether VRR is enabled on the connector                  |

## Bluetooth properties

| Property                     | Meaning                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `cdx:hbom:chipset`           | Bluetooth chipset name                                           |
| `cdx:hbom:state`             | Bluetooth controller state                                       |
| `cdx:hbom:supportedServices` | Bluetooth controller supported services                          |
| `cdx:hbom:services`          | Service list for a paired Bluetooth device                       |
| `cdx:hbom:minorType`         | Bluetooth device minor type                                      |
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

## USB properties

| Property                             | Meaning                          |
| ------------------------------------ | -------------------------------- |
| `cdx:hbom:usbController`             | Parent USB controller name       |
| `cdx:hbom:usbBus`                    | USB bus number                   |
| `cdx:hbom:usbDevice`                 | USB device number                |
| `cdx:hbom:usbVersion`                | USB version                      |
| `cdx:hbom:usbKernelName`             | Linux USB kernel device name     |
| `cdx:hbom:usbDevpath`                | Linux USB device path            |
| `cdx:hbom:usbClass`                  | USB class code / class name      |
| `cdx:hbom:usbClassName`              | USB class name from verbose descriptors |
| `cdx:hbom:usbSubclass`               | USB subclass                     |
| `cdx:hbom:usbSubclassName`           | USB subclass name from verbose descriptors |
| `cdx:hbom:usbProtocol`               | USB protocol                     |
| `cdx:hbom:usbProtocolName`           | USB protocol name from verbose descriptors |
| `cdx:hbom:currentAvailable`          | Available USB bus power/current  |
| `cdx:hbom:currentRequired`           | Required USB bus power/current   |
| `cdx:hbom:extraOperatingCurrentUsed` | Additional USB operating current |

## PCI properties

| Property                     | Meaning                         |
| ---------------------------- | ------------------------------- |
| `cdx:hbom:pciSlot`           | PCI slot / address summary      |
| `cdx:hbom:pciAddress`        | PCI address                     |
| `cdx:hbom:pciClass`          | PCI class description           |
| `cdx:hbom:pciClassCode`      | PCI class code                  |
| `cdx:hbom:subsystemVendor`   | PCI subsystem vendor            |
| `cdx:hbom:subsystemDevice`   | PCI subsystem device            |
| `cdx:hbom:subsystemVendorId` | PCI subsystem vendor identifier |
| `cdx:hbom:subsystemDeviceId` | PCI subsystem device identifier |

## Power properties

| Property                       | Meaning                                              |
| ------------------------------ | ---------------------------------------------------- |
| `cdx:hbom:powerSource`         | Current power source                                 |
| `cdx:hbom:chargePercent`       | Battery charge percentage                            |
| `cdx:hbom:isAcAttached`        | Whether AC power is attached                         |
| `cdx:hbom:isCharging`          | Whether the battery is charging                      |
| `cdx:hbom:scope`               | Power-supply scope such as `System`                  |
| `cdx:hbom:batteryId`           | Battery runtime identifier, redacted by default      |
| `cdx:hbom:cycleCount`          | Battery cycle count                                  |
| `cdx:hbom:health`              | Battery health summary                               |
| `cdx:hbom:maximumCapacity`     | Maximum capacity percentage                          |
| `cdx:hbom:fullyCharged`        | Whether the battery is fully charged                 |
| `cdx:hbom:atWarningLevel`      | Whether the battery is at warning level              |
| `cdx:hbom:deviceName`          | Battery or charger device name                       |
| `cdx:hbom:cellRevision`        | Battery cell revision                                |
| `cdx:hbom:batterySerialNumber` | Battery serial number, redacted by default           |
| `cdx:hbom:chargerId`           | Charger identifier                                   |
| `cdx:hbom:family`              | Charger family identifier                            |
| `cdx:hbom:watts`               | Charger wattage                                      |
| `cdx:hbom:powerSupplyType`     | Linux power-supply type such as `Battery` or `Mains` |
| `cdx:hbom:technology`          | Linux battery chemistry / technology                 |
| `cdx:hbom:powerNow`            | Instantaneous power draw reported by Linux           |

## Linux sensor, thermal, and TPM properties

| Property                          | Meaning                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `cdx:hbom:temperatureSensorCount` | Number of hwmon temperature sensors grouped into the component |
| `cdx:hbom:temperatureReadings`    | Formatted temperature sensor readings                          |
| `cdx:hbom:fanCount`               | Number of fan sensors grouped into the component               |
| `cdx:hbom:fanReadings`            | Formatted fan RPM readings                                     |
| `cdx:hbom:pwmValues`              | PWM values associated with a fan device                        |
| `cdx:hbom:temperatureCelsius`     | Thermal-zone temperature in Celsius                            |
| `cdx:hbom:mode`                   | Thermal-zone mode                                              |

## Linux MMC / SDIO properties

| Property                     | Meaning                                |
| ---------------------------- | -------------------------------------- |
| `cdx:hbom:mmcType`           | MMC/SD card or controller type         |
| `cdx:hbom:mmcName`           | MMC/SD name                            |
| `cdx:hbom:mmcManufacturerId` | MMC manufacturer ID                    |
| `cdx:hbom:mmcOemId`          | MMC OEM ID                             |
| `cdx:hbom:mmcDate`           | MMC manufacture date                   |
| `cdx:hbom:mmcSerialNumber`   | MMC serial number, redacted by default |
| `cdx:hbom:deviceId`          | Device identifier such as SDIO ID      |

## Miscellaneous platform-specific properties

These are emitted in narrower situations but are still part of the current surface area:

| Property                  | Meaning                                             |
| ------------------------- | --------------------------------------------------- |
| `cdx:hbom:busInfo`        | Bus location / topology information                 |
| `cdx:hbom:clockHz`        | Bus or device clock reported by `lshw`              |
| `cdx:hbom:kernelDevices`  | Kernel device nodes grouped into a single component |
| `cdx:hbom:kernelId`       | Kernel-facing identifier                            |
| `cdx:hbom:kernelVersion`  | Kernel or driver version                            |
| `cdx:hbom:isClaimed`      | Whether the Linux device is currently claimed       |
| `cdx:hbom:modes`          | Supported operating or display modes                |
| `cdx:hbom:physicalStores` | Physical stores backing an APFS container           |
| `cdx:hbom:sampleRate`     | Single sample rate                                  |
| `cdx:hbom:sampleRates`    | Multiple sample rates                               |
| `cdx:hbom:width`          | Device width / bit width reported by `lshw`         |

## Privacy-sensitive properties

These properties may contain unique identifiers and remain redacted by default when identifier redaction is enabled:

- `cdx:hbom:address`
- `cdx:hbom:assetTag`
- `cdx:hbom:batteryId`
- `cdx:hbom:batterySerialNumber`
- `cdx:hbom:cameraUniqueId`
- `cdx:hbom:containerUuid`
- `cdx:hbom:deviceSerial`
- `cdx:hbom:deviceTreeLinuxSerial`
- `cdx:hbom:displaySerialNumber`
- `cdx:hbom:domainUuid`
- `cdx:hbom:macAddress`
- `cdx:hbom:mmcSerialNumber`
- `cdx:hbom:platformUuid`
- `cdx:hbom:serialNumber`
- `cdx:hbom:serialNumberLeft`
- `cdx:hbom:serialNumberRight`
- `cdx:hbom:switchUid`
- `cdx:hbom:volumeUuid`
