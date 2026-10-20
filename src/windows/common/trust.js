// Windows security posture: Device Guard / VBS state, Secure Boot, TPM,
// firmware resources (ESRT) and BitLocker, built from the `windows-cim-trust`
// and `windows-cim-privileged` envelopes plus the PnP index. All functions
// are pure; see the C05 Part C brief and PLAN.md §4.2 (tiers T2/T3).

import { WINDOWS_PRIVILEGE_HINT } from "../../common/command.js";
import {
  compact,
  createHardwareComponent,
  createProperty,
  normalizeIdentityString,
} from "../../common/shape.js";
import {
  cimArray,
  cimBool,
  cimFirstItem,
  cimNumber,
  cimResultItems,
  cimString,
} from "./cim.js";
import { withPnpIdentity } from "./devices.js";
import {
  normalizeGuid,
  WINDOWS_BITLOCKER_CONVERSION_STATUSES,
  WINDOWS_BITLOCKER_ENCRYPTION_METHODS,
  WINDOWS_BITLOCKER_PROTECTION_STATUSES,
  WINDOWS_BITLOCKER_VOLUME_TYPES,
  WINDOWS_CODE_INTEGRITY_ENFORCEMENT,
  WINDOWS_ESRT_LAST_ATTEMPT_STATUSES,
  WINDOWS_SECURITY_PROPERTIES,
  WINDOWS_SECURITY_SERVICES,
  WINDOWS_VBS_STATUSES,
  windowsEnumName,
} from "./enums.js";
import { parseHardwareIds, parseVolumeDeviceId } from "./pnp.js";

// TPM 2.0 device objects carry the hardware ID MSFT0101, or a vendor _HID with
// MSFT0101 as a compatible ID (win11-vm: ACPI\PRLS0000 with compatible IDs
// ACPI\MSFT0101 and MSFT0101), per the Trusted Execution Environment ACPI
// Profile §4.3.2:
// https://learn.microsoft.com/en-us/windows-hardware/test/hlk/testref/trusted-execution-environment-acpi-profile
// TPM 1.2 (PNP0C31) is deliberately not matched: no MS Learn page states it.
const TPM_ACPI_ID = /^(?:ACPI\\|\*)?MSFT0101$/iu;

// `Win32_Tpm.ManufacturerVersion` and friends read "Not Supported" when the
// data is unavailable (Win32_Tpm class page).
const TPM_NOT_SUPPORTED = "not supported";

/**
 * @typedef {object} WindowsTrustSources
 * @property {Record<string, unknown> | undefined} deviceGuard First Win32_DeviceGuard item.
 * @property {Record<string, unknown> | undefined} secureBootRegistry `SecureBoot\State` values.
 * @property {Record<string, unknown>[]} firmwareResources `Control\FirmwareResources` subkeys.
 * @property {Record<string, unknown>[]} batteries Win32_Battery items.
 */

/**
 * @typedef {object} WindowsPrivilegedSources
 * @property {Record<string, unknown> | undefined} tpm First Win32_Tpm item.
 * @property {boolean} tpmQueried Whether Win32_Tpm answered (even with zero items).
 * @property {Record<string, unknown>[]} encryptableVolumes Win32_EncryptableVolume items.
 * @property {Record<string, unknown>[]} storageReliability MSFT_StorageReliabilityCounter items.
 * @property {boolean | undefined} secureBootCmdlet Confirm-SecureBootUEFI result.
 */

/**
 * Project a parsed `windows-cim-trust` envelope into typed sources.
 *
 * @param {{ results?: Record<string, object> }} envelope Parsed envelope.
 * @returns {WindowsTrustSources} Typed sources.
 */
export function parseTrustEnvelope(envelope) {
  const results = envelope?.results ?? {};
  return {
    deviceGuard: cimFirstItem(results.deviceGuard),
    secureBootRegistry: results.secureBootState?.ok
      ? results.secureBootState.values ?? {}
      : undefined,
    firmwareResources: cimResultItems(results.firmwareResources),
    batteries: cimResultItems(results.battery),
  };
}

/**
 * Project a parsed `windows-cim-privileged` envelope into typed sources.
 *
 * @param {{ results?: Record<string, object> }} envelope Parsed envelope.
 * @returns {WindowsPrivilegedSources} Typed sources.
 */
export function parsePrivilegedEnvelope(envelope) {
  const results = envelope?.results ?? {};
  return {
    tpm: cimFirstItem(results.tpm),
    tpmQueried: results.tpm?.ok === true,
    encryptableVolumes: cimResultItems(results.encryptableVolume),
    storageReliability: cimResultItems(results.storageReliability),
    secureBootCmdlet: results.secureBootCmdlet?.ok
      ? cimBool(results.secureBootCmdlet.value)
      : undefined,
  };
}

/**
 * Host security-posture properties for `metadata.component`.
 *
 * Secure Boot comes from `Confirm-SecureBootUEFI` when the privileged batch
 * ran, otherwise from the registry (decision D2), and `secureBootSource`
 * names the source. `firmwareType` is `UEFI` only when a Secure Boot state
 * could be read: the state lives in UEFI variables, so reading it proves UEFI
 * firmware, while its absence proves nothing and `BIOS` is never inferred.
 *
 * @param {WindowsTrustSources | undefined} trust Trust sources.
 * @param {WindowsPrivilegedSources | undefined} privileged Privileged sources.
 * @returns {object[]} Properties (undefined entries removed).
 */
export function buildSecurityPostureProperties(trust, privileged) {
  const guard = trust?.deviceGuard;
  const secureBoot = resolveSecureBoot(trust, privileged);
  return compact([
    createProperty(
      "cdx:hbom:vbsStatus",
      windowsEnumName(WINDOWS_VBS_STATUSES, cimNumber(guard?.VirtualizationBasedSecurityStatus)),
    ),
    createProperty(
      "cdx:hbom:securityServicesConfigured",
      enumList(WINDOWS_SECURITY_SERVICES, guard?.SecurityServicesConfigured),
    ),
    createProperty(
      "cdx:hbom:securityServicesRunning",
      enumList(WINDOWS_SECURITY_SERVICES, guard?.SecurityServicesRunning),
    ),
    createProperty(
      "cdx:hbom:codeIntegrityPolicyEnforcement",
      windowsEnumName(
        WINDOWS_CODE_INTEGRITY_ENFORCEMENT,
        cimNumber(guard?.CodeIntegrityPolicyEnforcementStatus),
      ),
    ),
    createProperty(
      "cdx:hbom:usermodeCodeIntegrityPolicyEnforcement",
      windowsEnumName(
        WINDOWS_CODE_INTEGRITY_ENFORCEMENT,
        cimNumber(guard?.UsermodeCodeIntegrityPolicyEnforcementStatus),
      ),
    ),
    createProperty(
      "cdx:hbom:availableSecurityProperties",
      enumList(WINDOWS_SECURITY_PROPERTIES, guard?.AvailableSecurityProperties),
    ),
    createProperty(
      "cdx:hbom:requiredSecurityProperties",
      enumList(WINDOWS_SECURITY_PROPERTIES, guard?.RequiredSecurityProperties),
    ),
    createProperty("cdx:hbom:secureBootEnabled", secureBoot.enabled),
    createProperty("cdx:hbom:secureBootSource", secureBoot.source),
    createProperty(
      "cdx:hbom:firmwareType",
      secureBoot.enabled === undefined ? undefined : "UEFI",
    ),
  ]);
}

/**
 * Build `tpm` components.
 *
 * Presence comes from the PnP tree: a SecurityDevices entity carrying the
 * TPM 2.0 ACPI ID. The privileged Win32_Tpm instance enriches it with the
 * specification version, manufacturer, firmware version and state flags.
 * When PnP data is unavailable but Win32_Tpm answered with an instance, the
 * component is built from Win32_Tpm alone. Win32_Tpm answering with zero
 * instances (the GitHub runners) means no TPM is exposed and adds nothing.
 *
 * @param {Map<string, import("./devices.js").PnpDeviceRecord> | undefined} pnpIndex Device index.
 * @param {WindowsPrivilegedSources | undefined} privileged Privileged sources.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Build options.
 * @returns {object[]} TPM components.
 */
export function buildTpmComponents(pnpIndex, privileged, options = {}) {
  const records = findTpmRecords(pnpIndex);
  const tpm = privileged?.tpm;
  const tpmProperties = tpm ? tpmInstanceProperties(tpm) : [];
  const spec = tpm ? parseTpmSpecVersion(cimString(tpm.SpecVersion)) : undefined;
  const manufacturer = tpm ? tpmManufacturer(tpm) : undefined;

  if (records.length === 0) {
    if (!tpm) {
      return [];
    }
    return [
      createHardwareComponent("tpm", {
        name: spec ? `Trusted Platform Module ${spec}` : "Trusted Platform Module",
        version: spec,
        manufacturer: manufacturer ? { name: manufacturer } : undefined,
        properties: tpmProperties,
      }),
    ];
  }

  return records.map((record) => {
    const entity = record.entity ?? {};
    const properties = compact([
      ...tpmProperties,
      createProperty("cdx:hbom:driver", cimString(entity.Service)),
    ]);
    return createHardwareComponent("tpm", {
      name: cimString(entity.Name) ?? "Trusted Platform Module",
      version: spec,
      manufacturer: manufacturer ? { name: manufacturer } : undefined,
      ...withPnpIdentity(pnpIndex, record.id, options, properties),
    });
  });
}

/**
 * Build one `firmware-device` per Firmware-class PnP device (`UEFI\RES_{GUID}`).
 *
 * The version is the `REV_` token of the versioned hardware ID (decision D3),
 * emitted as the raw string because no document states its radix. When the
 * registry holds `Control\FirmwareResources\{GUID}` for the resource, the
 * last update attempt's status and version are added.
 *
 * @param {Map<string, import("./devices.js").PnpDeviceRecord> | undefined} pnpIndex Device index.
 * @param {WindowsTrustSources | undefined} trust Trust sources.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Build options.
 * @returns {object[]} Firmware device components.
 */
export function buildFirmwareDeviceComponents(pnpIndex, trust, options = {}) {
  if (!pnpIndex) {
    return [];
  }
  const resources = new Map(
    (trust?.firmwareResources ?? [])
      .map((row) => [normalizeGuid(cimString(row.Name)), row])
      .filter(([guid]) => guid !== undefined),
  );
  const components = [];
  for (const record of [...pnpIndex.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    if (record.setupClass !== "Firmware") {
      continue;
    }
    const entity = record.entity ?? {};
    const guid = record.parsed.ids.resourceGuid;
    const ids = parseHardwareIds([...cimArray(entity.HardwareID), ...cimArray(entity.CompatibleID)]);
    const revision = ids.uefiRevision ?? record.parsed.ids.resourceRevision;
    const resource = guid ? resources.get(guid) : undefined;
    const lastAttemptStatus = cimNumber(resource?.LastAttemptStatus);
    const properties = compact([
      createProperty("cdx:hbom:guids", guid),
      createProperty("cdx:hbom:firmwareVersion", revision),
      createProperty(
        "cdx:hbom:lastAttemptStatus",
        lastAttemptStatus === undefined
          ? undefined
          : (WINDOWS_ESRT_LAST_ATTEMPT_STATUSES[lastAttemptStatus >>> 0] ??
            `0x${(lastAttemptStatus >>> 0).toString(16).padStart(8, "0")}`),
      ),
      createProperty("cdx:hbom:lastAttemptVersion", cimNumber(resource?.LastAttemptVersion)),
    ]);
    components.push(
      createHardwareComponent("firmware-device", {
        name: cimString(entity.Name) ?? "Firmware Resource",
        version: revision,
        ...withPnpIdentity(pnpIndex, record.id, options, properties),
      }),
    );
  }
  return components;
}

/**
 * Lower-cased instance IDs of the PnP devices the trust builders represent
 * (TPM and firmware resources), so the PnP builder enriches them rather than
 * counting them as unclassified.
 *
 * @param {Map<string, import("./devices.js").PnpDeviceRecord> | undefined} pnpIndex Device index.
 * @returns {string[]} Instance ID keys.
 */
export function trustRepresentedPnpIds(pnpIndex) {
  if (!pnpIndex) {
    return [];
  }
  return [
    ...findTpmRecords(pnpIndex).map((record) => record.key),
    ...[...pnpIndex.values()]
      .filter((record) => record.setupClass === "Firmware")
      .map((record) => record.key),
  ];
}

/**
 * BitLocker properties keyed by volume: the Win32_Volume device path (works
 * for letterless volumes) and the drive letter.
 *
 * `isEncrypted` follows ProtectionStatus 1 (PROTECTION ON), the state the
 * cdxgen `hbom-security` rules read.
 *
 * @param {WindowsPrivilegedSources | undefined} privileged Privileged sources.
 * @returns {Map<string, object[]>} Properties keyed by lower-cased device ID and by drive letter.
 */
export function bitlockerPropertiesByVolume(privileged) {
  const map = new Map();
  for (const volume of privileged?.encryptableVolumes ?? []) {
    const protection = cimNumber(volume.ProtectionStatus);
    const properties = compact([
      createProperty("cdx:hbom:isEncrypted", protection === undefined ? undefined : protection === 1),
      createProperty(
        "cdx:hbom:protectionStatus",
        windowsEnumName(WINDOWS_BITLOCKER_PROTECTION_STATUSES, protection),
      ),
      createProperty(
        "cdx:hbom:encryptionMethod",
        windowsEnumName(WINDOWS_BITLOCKER_ENCRYPTION_METHODS, cimNumber(volume.EncryptionMethod)),
      ),
      createProperty(
        "cdx:hbom:conversionStatus",
        windowsEnumName(WINDOWS_BITLOCKER_CONVERSION_STATUSES, cimNumber(volume.ConversionStatus)),
      ),
      createProperty(
        "cdx:hbom:bitlockerVolumeType",
        windowsEnumName(WINDOWS_BITLOCKER_VOLUME_TYPES, cimNumber(volume.VolumeType)),
      ),
    ]);
    const guid = parseVolumeDeviceId(cimString(volume.DeviceID));
    if (guid !== undefined) {
      map.set(`guid:${guid}`, properties);
    }
    const letter = cimString(volume.DriveLetter);
    if (letter !== undefined) {
      map.set(`letter:${letter.toUpperCase()}`, properties);
    }
  }
  return map;
}

/**
 * Storage reliability properties keyed by `MSFT_StorageReliabilityCounter.DeviceId`,
 * which equals `MSFT_PhysicalDisk.DeviceId` and therefore `Win32_DiskDrive.Index`.
 *
 * Units per the class page: Wear is a percentage, Temperature degrees Celsius,
 * PowerOnHours hours.
 *
 * @param {WindowsPrivilegedSources | undefined} privileged Privileged sources.
 * @returns {Map<string, object[]>} Properties keyed by device id string.
 */
export function storageReliabilityByDeviceId(privileged) {
  const map = new Map();
  for (const counter of privileged?.storageReliability ?? []) {
    const deviceId = cimString(counter.DeviceId);
    if (deviceId === undefined) {
      continue;
    }
    map.set(
      deviceId,
      compact([
        createProperty("cdx:hbom:wearPercentageUsed", cimNumber(counter.Wear)),
        createProperty("cdx:hbom:temperatureCelsius", cimNumber(counter.Temperature)),
        createProperty("cdx:hbom:powerOnHours", cimNumber(counter.PowerOnHours)),
      ]),
    );
  }
  return map;
}

/**
 * The one summary diagnostic for a privileged batch that ran without
 * administrator rights: the per-class permission-denied diagnostics explain
 * each gap, this one explains the cause.
 *
 * @param {{ meta?: { elevated?: boolean | null } } | undefined} privilegedEnvelope Parsed envelope.
 * @returns {object[]} Zero or one diagnostic.
 */
export function privilegedSummaryDiagnostics(privilegedEnvelope) {
  if (!privilegedEnvelope || privilegedEnvelope.meta?.elevated !== false) {
    return [];
  }
  return [
    {
      id: "windows-cim-privileged",
      issue: "permission-denied",
      message:
        "the privileged batch ran without administrator rights; TPM, BitLocker, storage reliability and the Secure Boot cmdlet need an elevated session",
      privilegeHint: WINDOWS_PRIVILEGE_HINT,
    },
  ];
}

/**
 * Parse the TCG specification version out of `Win32_Tpm.SpecVersion`.
 *
 * The documented format is `"<major>.<minor>, <revision>, <errata>"` (for
 * example `"2.0, 0, 1.16"`); only the first field is a TPM version.
 *
 * @param {string | undefined} value SpecVersion string.
 * @returns {string | undefined} `major.minor` or undefined.
 */
export function parseTpmSpecVersion(value) {
  if (value === undefined || value.toLowerCase() === TPM_NOT_SUPPORTED) {
    return undefined;
  }
  const first = value.split(",")[0]?.trim();
  return first && /^\d+\.\d+$/u.test(first) ? first : undefined;
}

/**
 * Find PnP records that are TPM 2.0 device objects.
 *
 * @param {Map<string, import("./devices.js").PnpDeviceRecord> | undefined} pnpIndex Device index.
 * @returns {import("./devices.js").PnpDeviceRecord[]} Matching records.
 */
function findTpmRecords(pnpIndex) {
  if (!pnpIndex) {
    return [];
  }
  return [...pnpIndex.values()]
    .filter((record) => {
      if (record.setupClass !== "SecurityDevices") {
        return false;
      }
      const entity = record.entity ?? {};
      return [...cimArray(entity.HardwareID), ...cimArray(entity.CompatibleID)].some(
        (id) => TPM_ACPI_ID.test(String(id ?? "")),
      );
    })
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/**
 * Properties from a Win32_Tpm instance.
 *
 * @param {Record<string, unknown>} tpm Win32_Tpm item.
 * @returns {object[]} Properties.
 */
function tpmInstanceProperties(tpm) {
  return compact([
    createProperty("cdx:hbom:specVersion", parseTpmSpecVersion(cimString(tpm.SpecVersion))),
    createProperty("cdx:hbom:firmwareVersion", tpmText(tpm.ManufacturerVersion)),
    createProperty("cdx:hbom:isEnabled", cimBool(tpm.IsEnabled_InitialValue)),
    createProperty("cdx:hbom:isActivated", cimBool(tpm.IsActivated_InitialValue)),
    createProperty("cdx:hbom:isOwned", cimBool(tpm.IsOwned_InitialValue)),
  ]);
}

/**
 * Resolve the TPM manufacturer from `ManufacturerIdTxt`, falling back to the
 * documented decoding of `ManufacturerId` (each byte an ASCII character).
 *
 * @param {Record<string, unknown>} tpm Win32_Tpm item.
 * @returns {string | undefined} Manufacturer code.
 */
function tpmManufacturer(tpm) {
  const text = tpmText(tpm.ManufacturerIdTxt);
  if (text !== undefined) {
    return text;
  }
  const id = cimNumber(tpm.ManufacturerId);
  if (id === undefined || id === 0) {
    return undefined;
  }
  const bytes = [24, 16, 8, 0].map((shift) => (id >>> shift) & 0xff).filter((byte) => byte !== 0);
  const decoded = String.fromCharCode(...bytes).trim();
  return decoded.length > 0 ? decoded : undefined;
}

/**
 * Normalize a Win32_Tpm text field, dropping the "Not Supported" placeholder.
 *
 * @param {unknown} value Raw value.
 * @returns {string | undefined} Text or undefined.
 */
function tpmText(value) {
  const text = normalizeIdentityString(cimString(value));
  return text !== undefined && text.toLowerCase() !== TPM_NOT_SUPPORTED ? text : undefined;
}

/**
 * Resolve Secure Boot state and its source.
 *
 * @param {WindowsTrustSources | undefined} trust Trust sources.
 * @param {WindowsPrivilegedSources | undefined} privileged Privileged sources.
 * @returns {{ enabled: boolean | undefined, source: string | undefined }} State.
 */
function resolveSecureBoot(trust, privileged) {
  if (privileged?.secureBootCmdlet !== undefined) {
    return { enabled: privileged.secureBootCmdlet, source: "Confirm-SecureBootUEFI" };
  }
  const value = cimNumber(trust?.secureBootRegistry?.UEFISecureBootEnabled);
  if (value === undefined) {
    return { enabled: undefined, source: undefined };
  }
  return { enabled: value === 1, source: "registry" };
}

/**
 * Map an array-valued enum property to a comma-separated name list.
 *
 * @param {Readonly<Record<number, string>>} table Enum table.
 * @param {unknown} value Scalar or array of codes.
 * @returns {string | undefined} Names, or undefined when empty.
 */
function enumList(table, value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const names = cimArray(value)
    .map((code) => windowsEnumName(table, cimNumber(code)))
    .filter((name) => name !== undefined);
  return names.length > 0 ? names.join(", ") : undefined;
}
