// Windows audio and camera inventory: sound devices from Win32_SoundDevice,
// audio endpoints and cameras from the setup-class-filtered Win32_PnPEntity
// items of the `windows-cim-display-media` envelope. All builders are pure.

import {
  compact,
  createHardwareComponent,
  createProperty,
  normalizeIdentityString,
} from "../../common/shape.js";
import { cimArray, cimBool, cimString } from "./cim.js";
import { pnpBomRef, pnpEnrichmentProperties } from "./devices.js";
import { windowsSetupClassName } from "./enums.js";
import {
  parseDeviceInstanceId,
  parseHardwareIds,
  redactHardwareIds,
  redactInstanceId,
} from "./pnp.js";

// Software-enumerated devices carry no physical bus: SWD is the software
// device enumerator and ROOT hosts root-enumerated (legacy/virtual) devices
// (https://learn.microsoft.com/en-us/windows-hardware/drivers/install/device-instance-ids).
const VIRTUAL_ENUMERATORS = new Set(["SWD", "ROOT"]);

/**
 * Build one `audio-controller` per Win32_SoundDevice.
 *
 * The class name matches the Linux ALSA card emitter. IDs are decoded from
 * the HD Audio (`HDAUDIO\FUNC_..&VEN_..&DEV_..`), PCI or USB instance ID.
 *
 * @param {import("./display.js").WindowsDisplayMediaSources} sources Media sources.
 * @param {{ includeSensitiveIdentifiers?: boolean, pnpIndex?: Map<string, object> }} [options={}] Build options.
 * @returns {object[]} Audio controller components.
 */
export function buildAudioControllerComponents(sources, options = {}) {
  return sources.soundDevices.map((device) => {
    const pnpId = cimString(device.PNPDeviceID);
    const ids = parseDeviceInstanceId(pnpId).ids;
    const manufacturer = normalizeIdentityString(cimString(device.Manufacturer));
    const properties = compact([
      createProperty("cdx:hbom:vendorId", ids.vendorId),
      createProperty("cdx:hbom:productId", ids.productId ?? ids.deviceId),
      createProperty("cdx:hbom:subsystemDeviceId", ids.subsystemId),
      createProperty(
        "cdx:hbom:pnpInstanceId",
        pnpId === undefined ? undefined : redactInstanceId(pnpId, options),
      ),
    ]);
    return withPnp("audio-controller", pnpId, options, {
      name:
        cimString(device.Name) ??
        cimString(device.ProductName) ??
        "Sound Device",
      manufacturer: manufacturer ? { name: manufacturer } : undefined,
      properties,
    });
  });
}

/**
 * Build one `audio-device` per AudioEndpoint PnP entity.
 *
 * The name is the endpoint friendly name. Default-device flags are not
 * recorded: they need the Core Audio COM API, which is out of scope.
 *
 * @param {import("./display.js").WindowsDisplayMediaSources} sources Media sources.
 * @param {{ includeSensitiveIdentifiers?: boolean, pnpIndex?: Map<string, object> }} [options={}] Build options.
 * @returns {object[]} Audio endpoint components.
 */
export function buildAudioEndpointComponents(sources, options = {}) {
  return sources.mediaPnp
    .filter((entity) => windowsSetupClassName(entity.ClassGuid) === "AudioEndpoint")
    .map((entity) => {
      const pnpId = cimString(entity.PNPDeviceID);
      const properties = compact([
        createProperty("cdx:hbom:driver", cimString(entity.Service)),
        createProperty("cdx:hbom:present", cimBool(entity.Present)),
        createProperty(
          "cdx:hbom:pnpInstanceId",
          pnpId === undefined ? undefined : redactInstanceId(pnpId, options),
        ),
      ]);
      return withPnp("audio-device", pnpId, options, {
        name: cimString(entity.Name) ?? "Audio Endpoint",
        properties,
      });
    });
}

/**
 * Build one `camera` per Camera or Image class PnP entity.
 *
 * USB vendor/product IDs come from the hardware IDs; a camera enumerated by
 * SWD or ROOT has no physical bus and is flagged `isVirtual`, the Darwin
 * camera emitter's property for the same idea.
 *
 * @param {import("./display.js").WindowsDisplayMediaSources} sources Media sources.
 * @param {{ includeSensitiveIdentifiers?: boolean, pnpIndex?: Map<string, object> }} [options={}] Build options.
 * @returns {object[]} Camera components.
 */
export function buildCameraComponents(sources, options = {}) {
  return sources.mediaPnp
    .filter((entity) => {
      const setupClass = windowsSetupClassName(entity.ClassGuid);
      return setupClass === "Camera" || setupClass === "Image";
    })
    .map((entity) => {
      const pnpId = cimString(entity.PNPDeviceID);
      const parsed = parseDeviceInstanceId(pnpId);
      const hardwareIds = redactHardwareIds(
        [...cimArray(entity.HardwareID), ...cimArray(entity.CompatibleID)],
        pnpId,
        options,
      );
      const ids = parseHardwareIds([...hardwareIds, pnpId]);
      const manufacturer = normalizeIdentityString(cimString(entity.Manufacturer));
      const enumerator = String(parsed.enumerator ?? "").toUpperCase();
      const properties = compact([
        createProperty("cdx:hbom:vendorId", ids.vendorId),
        createProperty("cdx:hbom:productId", ids.productId),
        createProperty(
          "cdx:hbom:isVirtual",
          VIRTUAL_ENUMERATORS.has(enumerator) ? true : undefined,
        ),
        createProperty("cdx:hbom:driver", cimString(entity.Service)),
        createProperty("cdx:hbom:present", cimBool(entity.Present)),
        createProperty(
          "cdx:hbom:pnpInstanceId",
          pnpId === undefined ? undefined : redactInstanceId(pnpId, options),
        ),
      ]);
      return withPnp("camera", pnpId, options, {
        name: cimString(entity.Name) ?? "Camera",
        manufacturer: manufacturer ? { name: manufacturer } : undefined,
        properties,
      });
    });
}

/**
 * Create a hardware component carrying its PnP bom-ref and the PnP-derived
 * driver properties when the PnP index knows the device.
 *
 * @param {string} hardwareClass Hardware class.
 * @param {string | undefined} pnpId Raw device instance ID.
 * @param {{ includeSensitiveIdentifiers?: boolean, pnpIndex?: Map<string, object> }} options Build options.
 * @param {{ name: string, manufacturer?: { name: string }, properties: object[] }} component Component fields.
 * @returns {object} Component.
 */
function withPnp(hardwareClass, pnpId, options, component) {
  const ref = pnpBomRef(options.pnpIndex, pnpId);
  return createHardwareComponent(hardwareClass, {
    ...(ref ? { "bom-ref": ref } : {}),
    ...component,
    properties: [
      ...component.properties,
      ...pnpEnrichmentProperties(options.pnpIndex, pnpId, options, component.properties),
    ],
  });
}
