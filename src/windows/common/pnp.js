import { redactIdentifier } from "../../common/shape.js";

// Device instance IDs are `<enumerator>\<device id>\<instance id>`:
// https://learn.microsoft.com/en-us/windows-hardware/drivers/install/device-instance-ids
// (example: PCI\VEN_1000&DEV_0001&SUBSYS_00000000&REV_02\1&08)
const INSTANCE_ID_SEPARATOR = "\\";

// USB device IDs:
// https://learn.microsoft.com/en-us/windows-hardware/drivers/install/standard-usb-identifiers
// USB\VID_v(4)&PID_d(4)[&REV_r(4)][&MI_z(2)], compatible IDs
// USB\CLASS_c(2)&SUBCLASS_s(2)[&PROT_p(2)] and USB\COMPOSITE.
const USB_TOKENS = [
  ["vendorId", /(?:^|&)VID_([0-9a-fA-F]{4})(?=&|$)/u],
  ["productId", /(?:^|&)PID_([0-9a-fA-F]{4})(?=&|$)/u],
  ["revision", /(?:^|&)REV_([0-9a-fA-F]{4})(?=&|$)/u],
  ["interfaceNumber", /(?:^|&)MI_([0-9a-fA-F]{2})(?=&|$)/u],
];

// PCI device IDs:
// https://learn.microsoft.com/en-us/windows-hardware/drivers/install/identifiers-for-pci-devices
// PCI\VEN_v(4)&DEV_d(4)&SUBSYS_s(4)n(4)&REV_r(2). The SUBSYS payload is the
// subsystem identifier s(4) FIRST, then the subsystem vendor identifier n(4).
// Compatible IDs carry the class code as CC_c(2)s(2)p(2) or CC_c(2)s(2); only
// class and subclass are kept, matching the Linux pciClassCode form.
const PCI_TOKENS = [
  ["vendorId", /(?:^|&)VEN_([0-9a-fA-F]{4})(?=&|$)/u],
  ["deviceId", /(?:^|&)DEV_([0-9a-fA-F]{4})(?=&|$)/u],
  ["subsystemId", /(?:^|&)SUBSYS_([0-9a-fA-F]{4})(?:[0-9a-fA-F]{4})(?=&|$)/u],
  [
    "subsystemVendorId",
    /(?:^|&)SUBSYS_[0-9a-fA-F]{4}([0-9a-fA-F]{4})(?=&|$)/u,
  ],
  ["revision", /(?:^|&)REV_([0-9a-fA-F]{2})(?=&|$)/u],
  ["classCode", /(?:^|&)CC_([0-9a-fA-F]{4})(?:[0-9a-fA-F]{2})?(?=&|$)/u],
];

// HIDClass hardware IDs for top-level collections:
// https://learn.microsoft.com/en-us/windows-hardware/drivers/hid/hidclass-hardware-ids-for-top-level-collections
// HID\Vid_v(4)&Pid_d(4)[&Rev_r(4)][&MI_z(2)][&Colb(2)] (case-insensitive in
// practice; Windows emits VID_/PID_/REV_/MI_/COL_ uppercase).
const HID_TOKENS = [
  ["vendorId", /(?:^|&)VID_([0-9a-fA-F]{4})(?=&|$)/iu],
  ["productId", /(?:^|&)PID_([0-9a-fA-F]{4})(?=&|$)/iu],
  ["revision", /(?:^|&)REV_([0-9a-fA-F]{4})(?=&|$)/iu],
  ["interfaceNumber", /(?:^|&)MI_([0-9a-fA-F]{2})(?=&|$)/iu],
  ["collection", /(?:^|&)COL_?([0-9a-fA-F]{2})(?=&|$)/iu],
];

// HD Audio device IDs:
// https://learn.microsoft.com/en-us/windows-hardware/drivers/install/identifiers-for-hdaudio-devices
// HDAUDIO\FUNC_nn&VEN_v(4)&DEV_d(4)&SUBSYS_s(8)&REV_r(4).
const HDAUDIO_TOKENS = [
  ["functionCode", /(?:^|&)FUNC_([0-9a-fA-F]{2})(?=&|$)/u],
  ["vendorId", /(?:^|&)VEN_([0-9a-fA-F]{4})(?=&|$)/u],
  ["deviceId", /(?:^|&)DEV_([0-9a-fA-F]{4})(?=&|$)/u],
  ["subsystemId", /(?:^|&)SUBSYS_([0-9a-fA-F]{8})(?=&|$)/u],
  ["revision", /(?:^|&)REV_([0-9a-fA-F]{4})(?=&|$)/u],
];

// UEFI firmware-resource device IDs:
// https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/windows-uefi-firmware-update-platform
// (hardware IDs and example GUID in
// .../bringup/authoring-an-update-driver-package:
// UEFI\RES_{RESOURCE_GUID} and UEFI\RES_{RESOURCE_GUID}&REV_XXX).
const UEFI_RESOURCE_PATTERN = /^RES_\{([0-9a-fA-F-]{36})\}(?:&REV_(\d+))?$/u;
const UEFI_REVISION_PATTERN = /(?:^|&)REV_(\d+)(?=&|$)/iu;

// Volume device IDs (`\\?\Volume{GUID}\`), the Win32_Volume key format:
// https://learn.microsoft.com/en-us/previous-versions/windows/desktop/legacy/aa394515(v=vs.85)
// Only the GUID is per-machine; the framing identifies nothing. The braces
// also accept the redacted token this module produces, so fixture-driven
// builds keep a redactable volume identifier.
const VOLUME_PATH_PATTERN =
  /^\\\\\?\\Volume\{([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}|redacted(?::[0-9A-Za-z]+)?)\}\\?$/iu;

// Bluetooth PnP IDs:
// https://learn.microsoft.com/en-us/windows-hardware/drivers/bluetooth/installing-a-bluetooth-device
// BTHENUM\{ServiceGUID}[_VID&nnnnnnnn[_PID&nnnn] | _LOCALMFG&nnnn], plus
// BTHLE device and instance IDs carrying the remote radio address as a
// 12-hex-digit token (DEV_ / BluetoothDevice_ / trailing _<MAC>).
const BTH_SERVICE_GUID_PATTERN = /\{([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\}/u;
const BTH_TOKENS = [
  ["vendorId", /VID&([0-9a-fA-F]{8})(?=&|_|$)/u],
  ["productId", /PID&([0-9a-fA-F]{4})(?=&|_|$)/u],
  ["localManufacturer", /LOCALMFG&([0-9a-fA-F]{4})(?=&|_|$)/u],
];
const BTH_MAC_LIKE_TOKEN =
  /(?:DEV_|BluetoothDevice_|[\\&_])([0-9A-Fa-f]{12})(?![0-9A-Fa-f])/u;

// Enumerators whose device IDs carry no vendor/product tokens to decode.
const OPAQUE_ENUMERATORS = new Set([
  "SWD",
  "ROOT",
  "DISPLAY",
  "SCSI",
  "STORAGE",
]);

const TOKEN_TABLES_BY_ENUMERATOR = new Map([
  ["USB", USB_TOKENS],
  ["PCI", PCI_TOKENS],
  ["HID", HID_TOKENS],
  ["HDAUDIO", HDAUDIO_TOKENS],
]);

/**
 * Parse a Windows device instance ID into its segments.
 *
 * The instance ID format is `enumerator\device-id\instance-id`, where the
 * device-id part may itself contain separators (for example
 * `USB\VID_203A&PID_FFFB&MI_01\6&8A7A4EF&0&0001`). Hex identifiers are
 * lower-cased. `ids` holds the per-enumerator tokens documented by Microsoft
 * Learn; unknown enumerators keep the device ID opaque.
 *
 * @param {string} id Device instance ID.
 * @returns {{
 *   enumerator: string | undefined,
 *   deviceId: string | undefined,
 *   instance: string | undefined,
 *   ids: Record<string, string>
 * }} Parsed segments.
 */
export function parseDeviceInstanceId(id) {
  const text = String(id ?? "");
  const firstSeparator = text.indexOf(INSTANCE_ID_SEPARATOR);
  if (firstSeparator === -1) {
    return {
      enumerator: text.length > 0 ? text : undefined,
      deviceId: undefined,
      instance: undefined,
      ids: {},
    };
  }

  const enumerator = text.slice(0, firstSeparator);
  const remainder = text.slice(firstSeparator + 1);
  const lastSeparator = remainder.lastIndexOf(INSTANCE_ID_SEPARATOR);
  const deviceId =
    lastSeparator === -1
      ? remainder
      : remainder.slice(0, lastSeparator);
  const instance =
    lastSeparator === -1 ? undefined : remainder.slice(lastSeparator + 1);

  return {
    enumerator: enumerator.length > 0 ? enumerator : undefined,
    deviceId: deviceId.length > 0 ? deviceId : undefined,
    instance,
    ids: parseEnumeratorIds(enumerator, deviceId, instance),
  };
}

/**
 * Decode the documented identifier tokens of one enumerator.
 *
 * @param {string} enumerator Enumerator segment.
 * @param {string | undefined} deviceId Device ID segment.
 * @param {string | undefined} instance Instance segment.
 * @returns {Record<string, string>} Decoded tokens.
 */
function parseEnumeratorIds(enumerator, deviceId, instance) {
  const normalized = String(enumerator ?? "").toUpperCase();
  const ids = {};
  const subject = String(deviceId ?? "");

  const tokenTable = TOKEN_TABLES_BY_ENUMERATOR.get(normalized);
  if (tokenTable) {
    for (const [name, pattern] of tokenTable) {
      const match = subject.match(pattern);
      if (match) {
        ids[name] = match[1].toLowerCase();
      }
    }
    return ids;
  }

  if (normalized === "UEFI") {
    const match = subject.match(UEFI_RESOURCE_PATTERN);
    if (match) {
      ids.resourceGuid = match[1].toLowerCase();
      if (match[2]) {
        ids.resourceRevision = match[2];
      }
    }
    return ids;
  }

  if (normalized === "BTHENUM" || normalized === "BTHLE") {
    const guidMatch = subject.match(BTH_SERVICE_GUID_PATTERN);
    if (guidMatch) {
      ids.serviceGuid = guidMatch[1].toLowerCase();
    }
    for (const [name, pattern] of BTH_TOKENS) {
      const match = subject.match(pattern);
      if (match) {
        ids[name] = match[1].toLowerCase();
      }
    }
    const addressMatch = `${subject}\\${String(instance ?? "")}`.match(
      BTH_MAC_LIKE_TOKEN,
    );
    if (addressMatch) {
      ids.deviceAddress = addressMatch[1].toLowerCase();
    }
    return ids;
  }

  return ids;
}

/**
 * Extract identification tokens from hardware and compatible IDs.
 *
 * Windows orders hardware IDs from most specific to most generic, so the
 * first ID that yields a vendor/product pair wins. USB compatible IDs
 * (`USB\CLASS_..&SUBCLASS_..&PROT_..`) and UEFI `REV_` version tokens are
 * collected wherever they appear.
 *
 * @param {string[] | string | null | undefined} list Hardware IDs plus compatible IDs.
 * @returns {{
 *   vendorId?: string,
 *   productId?: string,
 *   revision?: string,
 *   subsystemId?: string,
 *   subsystemVendorId?: string,
 *   pciClassCode?: string,
 *   usbClass?: string,
 *   usbSubclass?: string,
 *   usbProtocol?: string,
 *   uefiRevision?: string
 * }} Best-match tokens.
 */
export function parseHardwareIds(list) {
  const result = {};
  const ids = Array.isArray(list) ? list : list ? [list] : [];

  for (const entry of ids) {
    const parsed = parseDeviceInstanceId(entry);
    const normalized = String(parsed.enumerator ?? "").toUpperCase();
    // USB and HID carry VID/PID pairs; PCI and HD Audio name their product
    // token DEV_ instead, exposed as `deviceId` by parseDeviceInstanceId.
    const productToken = parsed.ids.productId ?? parsed.ids.deviceId;

    if (
      !result.vendorId &&
      parsed.ids.vendorId &&
      productToken &&
      TOKEN_TABLES_BY_ENUMERATOR.has(normalized)
    ) {
      result.vendorId = parsed.ids.vendorId;
      result.productId = productToken;
      if (parsed.ids.revision) {
        result.revision = parsed.ids.revision;
      }
    }

    if (normalized === "PCI") {
      if (result.subsystemId === undefined && parsed.ids.subsystemId) {
        result.subsystemId = parsed.ids.subsystemId;
        result.subsystemVendorId = parsed.ids.subsystemVendorId;
      }
      if (result.pciClassCode === undefined && parsed.ids.classCode) {
        result.pciClassCode = parsed.ids.classCode;
      }
    }

    if (
      result.usbClass === undefined &&
      normalized === "USB" &&
      parsed.deviceId
    ) {
      const match = parsed.deviceId.match(
        /^(?:^|&)CLASS_([0-9a-fA-F]{2})&SUBCLASS_([0-9a-fA-F]{2})(?:&PROT_([0-9a-fA-F]{2}))?$/iu,
      );
      if (match) {
        result.usbClass = match[1].toLowerCase();
        result.usbSubclass = match[2].toLowerCase();
        if (match[3]) {
          result.usbProtocol = match[3].toLowerCase();
        }
      }
    }

    if (result.uefiRevision === undefined && normalized === "UEFI") {
      const match = parsed.deviceId?.match(UEFI_REVISION_PATTERN);
      if (match) {
        result.uefiRevision = match[1];
      }
    }
  }

  return result;
}

/**
 * Redact the instance-specific segment of a device instance ID.
 *
 * A device instance ID is `enumerator\device-id\instance-id`
 * (device-instance-ids), so the instance segment exists only when the string
 * has at least three separator-delimited parts. Two-part strings are
 * hardware or compatible IDs (`USB\COMPOSITE`, `USB\CLASS_...`) and pass
 * through unchanged. The instance segment, when present, can be a device
 * serial (the USB iSerialNumber) or a Bluetooth radio address, so it is
 * replaced through `redactIdentifier` unless raw identifiers were requested.
 * Inside BTHENUM/BTHLE device-ID segments, MAC-like 12-hex-digit tokens are
 * redacted as well. Volume device paths (`\\?\Volume{GUID}\`) carry no
 * enumerator; only their GUID is per-machine, so just the GUID is redacted
 * while the path framing survives.
 *
 * @param {string} id Device instance ID or hardware ID.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Redaction options.
 * @returns {string} Redacted identifier.
 */
export function redactInstanceId(id, options = {}) {
  const text = String(id ?? "");
  if (
    text.length === 0 ||
    options.includeSensitiveIdentifiers === true
  ) {
    return text;
  }

  const volumeMatch = text.match(VOLUME_PATH_PATTERN);
  if (volumeMatch) {
    return text.replace(
      volumeMatch[1],
      redactIdentifier(volumeMatch[1], options) ?? volumeMatch[1],
    );
  }

  const lastSeparator = text.lastIndexOf(INSTANCE_ID_SEPARATOR);
  const firstSeparator = text.indexOf(INSTANCE_ID_SEPARATOR);
  if (
    // No enumerator: a device path such as Win32_DiskDrive's
    // `\\.\PHYSICALDRIVE0`, not a device instance ID.
    firstSeparator <= 0 ||
    // Two-part strings are hardware/compatible IDs without an instance
    // segment; the instance segment starts at the third part.
    lastSeparator === firstSeparator
  ) {
    return text;
  }

  const devicePart = text.slice(0, lastSeparator);
  const instanceSegment = text.slice(lastSeparator + 1);
  // Segments this module already produced (`redacted`, `redacted:xxxx`) pass
  // through, so fixture-driven builds and repeated redaction are stable.
  const redactedInstance = /^redacted(?::|$)/u.test(instanceSegment)
    ? instanceSegment
    : (redactIdentifier(instanceSegment, options) ?? instanceSegment);

  const enumerator = text.slice(0, firstSeparator);
  const safeDevicePart = /^(BTHENUM|BTHLE)$/iu.test(enumerator)
    ? devicePart.replaceAll(
        new RegExp(BTH_MAC_LIKE_TOKEN.source, "gu"),
        (match, token) => match.replace(token, redactIdentifier(token, options) ?? token),
      )
    : devicePart;

  return `${safeDevicePart}${INSTANCE_ID_SEPARATOR}${redactedInstance}`;
}

/**
 * Redact hardware or compatible IDs that repeat the device's instance segment,
 * and Bluetooth hardware IDs that embed the remote radio's address.
 *
 * Hyper-V VMBus devices list their own instance GUID as a hardware ID
 * (`VMBUS\{instance}`), observed for most VMBus devices in the windows-2025
 * and windows-11-arm GitHub runner captures. Such an entry carries the same
 * per-machine value that `redactInstanceId` removes from the instance ID, so
 * it is redacted the same way and the two still match. BTHENUM/BTHLE hardware
 * IDs (`BTHLE\DEV_<address>`) get the same MAC-token redaction as their
 * device instance IDs.
 *
 * @param {string[] | string | null | undefined} list Hardware or compatible IDs.
 * @param {string | undefined} instanceId The device's PNPDeviceID.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Redaction options.
 * @returns {string[]} IDs with echoed instance segments redacted.
 */
export function redactHardwareIds(list, instanceId, options = {}) {
  const ids = Array.isArray(list) ? list : list ? [list] : [];
  if (options.includeSensitiveIdentifiers === true) {
    return [...ids];
  }
  const instance = getInstanceSegment(instanceId);
  return ids.map((id) => {
    const text = String(id ?? "");
    const separator = text.indexOf(INSTANCE_ID_SEPARATOR);
    if (separator <= 0) {
      return text;
    }
    // Bluetooth hardware IDs (`BTHLE\DEV_<address>`) carry the remote
    // radio's address in the device-ID segment itself.
    if (/^(BTHENUM|BTHLE)$/iu.test(text.slice(0, separator))) {
      return text.replaceAll(
        new RegExp(BTH_MAC_LIKE_TOKEN.source, "gu"),
        (match, token) => match.replace(token, redactIdentifier(token, options) ?? token),
      );
    }
    const devicePart = text.slice(separator + 1);
    if (
      !instance ||
      devicePart === "redacted" ||
      devicePart.toLowerCase() !== instance.toLowerCase()
    ) {
      return text;
    }
    return `${text.slice(0, separator + 1)}${redactIdentifier(devicePart, options) ?? devicePart}`;
  });
}

/**
 * Extract the per-machine GUID of a Win32_Volume device path.
 *
 * @param {string | undefined} id Device ID such as `\\?\Volume{GUID}\`.
 * @returns {string | undefined} Lower-cased GUID or undefined.
 */
export function parseVolumeDeviceId(id) {
  const match = String(id ?? "").match(VOLUME_PATH_PATTERN);
  return match === null ? undefined : match[1].toLowerCase();
}

/**
 * Return the instance segment of a device instance ID, if it has one.
 *
 * @param {string | undefined} id Device instance ID.
 * @returns {string | undefined} Raw instance segment.
 */
export function getInstanceSegment(id) {
  const text = String(id ?? "");
  const first = text.indexOf(INSTANCE_ID_SEPARATOR);
  const last = text.lastIndexOf(INSTANCE_ID_SEPARATOR);
  return first > 0 && last !== first ? text.slice(last + 1) : undefined;
}
