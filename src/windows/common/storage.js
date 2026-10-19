// Windows storage inventory: physical disks built from Win32_DiskDrive and
// enriched from MSFT_PhysicalDisk, plus Win32_Volume storage volumes. All
// builders are pure; see PLAN.md §4.2 and the C04 brief.

import {
  compact,
  createHardwareComponent,
  createProperty,
  formatBytes,
  isPlaceholderIdentity,
  redactIdentifier,
} from "../../common/shape.js";
import { cimArray, cimBool, cimNumber, cimString } from "./cim.js";
import {
  WINDOWS_OPERATIONAL_STATUSES,
  WINDOWS_STORAGE_BUS_TYPES,
  WINDOWS_STORAGE_HEALTH_STATUSES,
  WINDOWS_STORAGE_MEDIA_TYPES,
  windowsEnumName,
} from "./enums.js";
import { parseDeviceInstanceId, parseVolumeDeviceId } from "./pnp.js";

// Win32_DiskDrive.Manufacturer is `(Standard disk drives)` for every generic
// disk, which names the driver, not a vendor:
// https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-diskdrive
const GENERIC_DISK_MANUFACTURERS = new Set(["(standard disk drives)"]);

// Win32_DiskDrive.Capabilities value 7 is "Supports Removable Media":
// https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-diskdrive
const CAPABILITY_REMOVABLE_MEDIA = 7;

/**
 * @typedef {object} WindowsStorageNetworkSources
 * @property {Record<string, unknown>[]} physicalDisks MSFT_PhysicalDisk items.
 * @property {Record<string, unknown>[]} diskDrives Win32_DiskDrive items.
 * @property {Record<string, unknown>[]} volumes Win32_Volume items.
 * @property {Record<string, unknown>[]} netAdapters MSFT_NetAdapter items.
 * @property {Record<string, unknown>[]} netAdapterHardware MSFT_NetAdapterHardwareInfoSettingData items.
 * @property {Record<string, unknown>[]} legacyNetworkAdapters Win32_NetworkAdapter items.
 */

/**
 * Project a parsed `windows-cim-storage-network` envelope into typed sources.
 *
 * @param {{ results?: Record<string, { ok?: boolean, items?: object[] }> }} envelope Parsed envelope.
 * @returns {WindowsStorageNetworkSources} Typed sources.
 */
export function parseStorageNetworkEnvelope(envelope) {
  const results = envelope?.results ?? {};
  return {
    physicalDisks: okItems(results.physicalDisk),
    diskDrives: okItems(results.diskDrive),
    volumes: okItems(results.volume),
    netAdapters: okItems(results.netAdapter),
    netAdapterHardware: okItems(results.netAdapterHardware),
    legacyNetworkAdapters: okItems(results.networkAdapterLegacy),
  };
}

/**
 * Build one `storage` component per physical disk (Win32_DiskDrive), enriched
 * from MSFT_PhysicalDisk when the join matches.
 *
 * A standard user gets zero MSFT_PhysicalDisk instances with no error
 * (PERMISSIONS-MATRIX.md), so DiskDrive is the base and PhysicalDisk the
 * enrichment: bus type, media type, health, sector sizes and spindle data
 * simply disappear instead of the disk disappearing.
 *
 * @param {WindowsStorageNetworkSources} sources Storage sources.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Build options.
 * @returns {object[]} Storage components.
 */
export function buildStorageComponents(sources, options = {}) {
  return sources.diskDrives.map((drive) => {
    const disk = matchPhysicalDisk(sources.physicalDisks, drive);
    const index = cimNumber(drive.Index);
    const pnpIds = parseDeviceInstanceId(drive.PNPDeviceID).ids;
    const mediaTypeCode = cimNumber(disk?.MediaType);
    const busTypeName = disk
      ? windowsEnumName(WINDOWS_STORAGE_BUS_TYPES, cimNumber(disk.BusType))
      : undefined;

    return createHardwareComponent("storage", {
      name:
        cimString(disk?.FriendlyName) ??
        cimString(drive.Model) ??
        "Disk Drive",
      manufacturer: diskOrDriveManufacturer(disk, drive),
      version: index === undefined ? undefined : `disk${index}`,
      properties: compact([
        createProperty("cdx:hbom:diskNumber", index),
        createProperty(
          "cdx:hbom:capacityBytes",
          cimNumber(disk?.Size) ?? cimNumber(drive.Size),
        ),
        createProperty(
          "cdx:hbom:capacity",
          formatBytes(cimNumber(disk?.Size) ?? cimNumber(drive.Size)),
        ),
        createProperty(
          "cdx:hbom:deviceSerial",
          redactSerial(disk?.SerialNumber ?? drive.SerialNumber, options),
        ),
        createProperty(
          "cdx:hbom:firmwareVersion",
          cimString(disk?.FirmwareVersion) ?? cimString(drive.FirmwareRevision),
        ),
        // InterfaceType is the documented coarse fallback (SCSI, IDE, USB,
        // 1394, HDC); NVMe disks often surface as SCSI there.
        createProperty("cdx:hbom:transport", busTypeName ?? cimString(drive.InterfaceType)),
        createProperty(
          "cdx:hbom:mediaType",
          mediaTypeCode === 0
            ? undefined
            : windowsEnumName(WINDOWS_STORAGE_MEDIA_TYPES, mediaTypeCode),
        ),
        createProperty("cdx:hbom:isRotational", isRotational(disk, mediaTypeCode)),
        createProperty(
          "cdx:hbom:isRemovable",
          cimArray(drive.Capabilities).some(
            (capability) => cimNumber(capability) === CAPABILITY_REMOVABLE_MEDIA,
          )
            ? true
            : undefined,
        ),
        createProperty(
          "cdx:hbom:blockSize",
          cimNumber(disk?.LogicalSectorSize) ?? cimNumber(drive.BytesPerSector),
        ),
        createProperty(
          "cdx:hbom:physicalBlockSize",
          cimNumber(disk?.PhysicalSectorSize),
        ),
        createProperty(
          "cdx:hbom:healthStatus",
          windowsEnumName(
            WINDOWS_STORAGE_HEALTH_STATUSES,
            cimNumber(disk?.HealthStatus),
          ),
        ),
        createProperty(
          "cdx:hbom:operationalStatus",
          cimArray(disk?.OperationalStatus)
            .map((code) =>
              windowsEnumName(WINDOWS_OPERATIONAL_STATUSES, cimNumber(code)),
            )
            .filter(Boolean)
            .join(", "),
        ),
        createProperty("cdx:hbom:vendorId", pnpIds.vendorId),
        createProperty("cdx:hbom:productId", pnpIds.productId ?? pnpIds.deviceId),
      ]),
    });
  });
}

/**
 * Build one `storage-volume` component per drive-lettered or local volume.
 *
 * Volumes without a drive letter are kept when DriveType reports a removable
 * (2) or local (3) disk, per the Win32_Volume DriveType value map.
 *
 * @param {WindowsStorageNetworkSources} sources Storage sources.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Build options.
 * @returns {object[]} Volume components.
 */
export function buildStorageVolumeComponents(sources, options = {}) {
  return sources.volumes
    .filter((volume) => {
      const driveType = cimNumber(volume.DriveType);
      return (
        cimString(volume.DriveLetter) !== undefined ||
        driveType === 2 ||
        driveType === 3
      );
    })
    .map((volume) => {
      const driveLetter = cimString(volume.DriveLetter);
      const volumeGuid = parseVolumeDeviceId(volume.DeviceID);
      return createHardwareComponent("storage-volume", {
        name: driveLetter ?? "Volume",
        properties: compact([
          createProperty("cdx:hbom:capacityBytes", cimNumber(volume.Capacity)),
          createProperty(
            "cdx:hbom:capacity",
            formatBytes(cimNumber(volume.Capacity)),
          ),
          createProperty("cdx:hbom:freeBytes", cimNumber(volume.FreeSpace)),
          createProperty("cdx:hbom:fileSystem", cimString(volume.FileSystem)),
          createProperty("cdx:hbom:mountPoint", driveLetter),
          createProperty(
            "cdx:hbom:volumeUuid",
            volumeGuid === undefined
              ? undefined
              : redactIdentifier(volumeGuid, options),
          ),
          createProperty("cdx:hbom:isBootVolume", cimBool(volume.BootVolume)),
          createProperty("cdx:hbom:isSystemVolume", cimBool(volume.SystemVolume)),
        ]),
      });
    });
}

/**
 * Derive storage diagnostics for a parsed storage envelope.
 *
 * A non-elevated session gets zero MSFT_PhysicalDisk instances with no
 * error, which silently drops bus/media/health detail; one diagnostic says
 * so instead of leaving the gap unexplained.
 *
 * @param {WindowsStorageNetworkSources} sources Storage sources.
 * @param {{ elevated?: boolean | null }} meta Envelope metadata.
 * @returns {object[]} Diagnostics.
 */
export function storageNetworkDiagnostics(sources, meta = {}) {
  if (
    meta.elevated === false &&
    sources.diskDrives.length > 0 &&
    sources.physicalDisks.length === 0
  ) {
    return [
      {
        id: "windows-cim-storage-network:physical-disk",
        issue: "partial-support",
        message: "Storage bus/media/health details need an elevated session",
      },
    ];
  }
  return [];
}

/**
 * Join one MSFT_PhysicalDisk to a Win32_DiskDrive.
 *
 * `MSFT_PhysicalDisk.DeviceId` is the string form of `PHYSICALDRIVE*n*`,
 * which matches `Win32_DiskDrive.Index` (the C04 brief documents the join;
 * the captured fixtures verify it).
 *
 * @param {Record<string, unknown>[]} physicalDisks Physical disk items.
 * @param {Record<string, unknown>} drive Disk drive item.
 * @returns {Record<string, unknown> | undefined} Matched physical disk.
 */
function matchPhysicalDisk(physicalDisks, drive) {
  const index = cimNumber(drive.Index);
  if (index === undefined) {
    return undefined;
  }
  return physicalDisks.find(
    (disk) => cimString(disk.DeviceId) === String(index),
  );
}

/**
 * Resolve a non-generic disk manufacturer.
 *
 * @param {Record<string, unknown> | undefined} disk Physical disk item.
 * @param {Record<string, unknown>} drive Disk drive item.
 * @returns {{ name: string } | undefined} Manufacturer.
 */
function diskOrDriveManufacturer(disk, drive) {
  const candidates = [cimString(disk?.Manufacturer), cimString(drive.Manufacturer)];
  const name = candidates.find(
    (value) =>
      value !== undefined && !GENERIC_DISK_MANUFACTURERS.has(value.toLowerCase()),
  );
  return name === undefined ? undefined : { name };
}

/**
 * Decide whether a disk rotates.
 *
 * MediaType 3 is HDD, 4 SSD and 5 SCM (MSFT_PhysicalDisk); otherwise a
 * positive SpindleSpeed (RPM) is the only rotational signal.
 *
 * @param {Record<string, unknown> | undefined} disk Physical disk item.
 * @param {number | undefined} mediaTypeCode MediaType code.
 * @returns {boolean | undefined} Rotational flag.
 */
function isRotational(disk, mediaTypeCode) {
  if (mediaTypeCode === 3) {
    return true;
  }
  if (mediaTypeCode === 4 || mediaTypeCode === 5) {
    return false;
  }
  const spindleSpeed = cimNumber(disk?.SpindleSpeed);
  return spindleSpeed !== undefined && spindleSpeed > 0 ? true : undefined;
}

/**
 * Redact a disk serial, dropping vendor placeholders.
 *
 * @param {unknown} value Raw serial.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Redaction options.
 * @returns {string | undefined} Redacted serial.
 */
function redactSerial(value, options) {
  const text = cimString(value);
  if (text === undefined || isPlaceholderIdentity(text)) {
    return undefined;
  }
  return redactIdentifier(text, options);
}

/**
 * Return the items of a successful envelope result.
 *
 * @param {{ ok?: boolean, items?: object[] } | undefined} result Envelope result.
 * @returns {Record<string, unknown>[]} Items, empty when the result failed.
 */
function okItems(result) {
  return result?.ok ? [...(result.items ?? [])] : [];
}
