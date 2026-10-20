// Windows display inventory: graphics adapters from Win32_VideoController and
// monitors from the root/wmi WmiMonitor* classes, built from the
// `windows-cim-display-media` envelope. All builders are pure.

import {
  compact,
  createHardwareComponent,
  createProperty,
  formatDisplayPhysicalSize,
  normalizeIdentityString,
  redactIdentifier,
} from "../../common/shape.js";
import {
  cimBool,
  cimDate,
  cimNumber,
  cimString,
  cimUint16String,
} from "./cim.js";
import { windowsVideoOutputTechnologyName } from "./enums.js";
import { parseDeviceInstanceId, redactInstanceId } from "./pnp.js";

// Win32_VideoController.CurrentRefreshRate: "A value of 0 (zero) indicates the
// default rate is being used, while 0xFFFFFFFF indicates the optimal rate is
// being used", so neither is a measured frequency:
// https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-videocontroller
const REFRESH_RATE_SENTINELS = new Set([0, 0xffffffff]);

// WmiMonitorID.WeekOfManufacture: "The range is from 1 through 53. Zero (0) is
// undefined" (https://learn.microsoft.com/en-us/windows/win32/wmicoreprov/wmimonitorid).
// The class mirrors the E-EDID Vendor/Product block, where week 0xFF (255)
// flags the year as a model year instead (VESA E-EDID 1.4 §3.4.4).
const UNKNOWN_MANUFACTURE_WEEKS = new Set([0, 255]);

// WMI appends `_<n>` to the PnP instance ID to key each WmiMonitor* instance
// (observed as `..._0` on every captured monitor); stripping it recovers the
// `DISPLAY\...` device instance ID the PnP tree uses.
const WMI_INSTANCE_SUFFIX = /_\d+$/u;

/**
 * @typedef {object} WindowsDisplayMediaSources
 * @property {Record<string, unknown>[]} videoControllers Win32_VideoController items.
 * @property {Record<string, unknown>[]} monitorIds WmiMonitorID items.
 * @property {Record<string, unknown>[]} monitorBasics WmiMonitorBasicDisplayParams items.
 * @property {Record<string, unknown>[]} monitorConnections WmiMonitorConnectionParams items.
 * @property {Record<string, unknown>[]} soundDevices Win32_SoundDevice items.
 * @property {Record<string, unknown>[]} mediaPnp Camera, Image and AudioEndpoint Win32_PnPEntity items.
 */

/**
 * Project a parsed `windows-cim-display-media` envelope into typed sources.
 *
 * @param {{ results?: Record<string, { ok?: boolean, items?: object[] }> }} envelope Parsed envelope.
 * @returns {WindowsDisplayMediaSources} Typed sources.
 */
export function parseDisplayMediaEnvelope(envelope) {
  const results = envelope?.results ?? {};
  return {
    videoControllers: okItems(results.videoController),
    monitorIds: okItems(results.monitorId),
    monitorBasics: okItems(results.monitorBasic),
    monitorConnections: okItems(results.monitorConnection),
    soundDevices: okItems(results.soundDevice),
    mediaPnp: okItems(results.mediaPnp),
  };
}

/**
 * Build one `display-adapter` component per Win32_VideoController.
 *
 * Vendor and product IDs are decoded only from PCI instance IDs; virtual
 * adapters enumerated under ACPI (the Parallels `ACPI\PRL4005`) or VMBUS
 * carry no documented vendor tokens and record none.
 *
 * @param {WindowsDisplayMediaSources} sources Display sources.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Build options.
 * @returns {object[]} Display adapter components.
 */
export function buildDisplayAdapterComponents(sources, options = {}) {
  return sources.videoControllers.map((controller) => {
    const pnpId = cimString(controller.PNPDeviceID);
    const ids = parseDeviceInstanceId(pnpId).ids;
    const refreshRate = cimNumber(controller.CurrentRefreshRate);
    const adapterRam = cimNumber(controller.AdapterRAM);
    const manufacturer = normalizeIdentityString(
      cimString(controller.AdapterCompatibility),
    );

    return createHardwareComponent("display-adapter", {
      name: cimString(controller.Name) ?? "Display Adapter",
      manufacturer: manufacturer ? { name: manufacturer } : undefined,
      description: cimString(controller.VideoProcessor),
      properties: compact([
        createProperty("cdx:hbom:driverVersion", cimString(controller.DriverVersion)),
        createProperty(
          "cdx:hbom:driverDate",
          cimDate(cimString(controller.DriverDate)),
        ),
        createProperty(
          "cdx:hbom:resolution",
          formatResolution(
            controller.CurrentHorizontalResolution,
            controller.CurrentVerticalResolution,
          ),
        ),
        createProperty(
          "cdx:hbom:refreshRateHz",
          refreshRate !== undefined && !REFRESH_RATE_SENTINELS.has(refreshRate)
            ? refreshRate
            : undefined,
        ),
        createProperty(
          "cdx:hbom:bitsPerPixel",
          positiveNumber(controller.CurrentBitsPerPixel),
        ),
        // AdapterRAM is a uint32, so adapters with 4 GiB or more of memory
        // cannot report their true size through this class.
        createProperty(
          "cdx:hbom:adapterRamBytes",
          adapterRam !== undefined && adapterRam > 0 ? adapterRam : undefined,
        ),
        createProperty("cdx:hbom:vendorId", ids.vendorId),
        createProperty("cdx:hbom:productId", ids.productId ?? ids.deviceId),
        createProperty("cdx:hbom:subsystemDeviceId", ids.subsystemId),
        createProperty("cdx:hbom:subsystemVendorId", ids.subsystemVendorId),
        createProperty(
          "cdx:hbom:pnpInstanceId",
          pnpId === undefined ? undefined : redactInstanceId(pnpId, options),
        ),
      ]),
    });
  });
}

/**
 * Build one `display` component per WmiMonitorID instance, joined on
 * `InstanceName` with the basic display and connection parameters.
 *
 * Name fields are uint16 code arrays zero-padded to a fixed length and are
 * decoded with `cimUint16String`. The manufacturer is the three-letter PnP
 * vendor ID exactly as the EDID carries it; it is not expanded to a vendor
 * name because no official table ships with the OS. Property names follow the
 * Linux EDID (`display`) and Darwin display emitters.
 *
 * @param {WindowsDisplayMediaSources} sources Display sources.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Build options.
 * @returns {object[]} Display components.
 */
export function buildDisplayComponents(sources, options = {}) {
  return sources.monitorIds.map((monitor) => {
    const instanceName = cimString(monitor.InstanceName);
    const basic = findByInstanceName(sources.monitorBasics, instanceName);
    const connection = findByInstanceName(
      sources.monitorConnections,
      instanceName,
    );
    const manufacturerId = cimUint16String(monitor.ManufacturerName);
    const productCode = cimUint16String(monitor.ProductCodeID);
    const serial = cimUint16String(monitor.SerialNumberID);
    const week = cimNumber(monitor.WeekOfManufacture);
    const pnpId = monitorPnpInstanceId(instanceName);

    return createHardwareComponent("display", {
      name: cimUint16String(monitor.UserFriendlyName) ?? "Display",
      version: productCode,
      manufacturer: manufacturerId ? { name: manufacturerId } : undefined,
      properties: compact([
        createProperty("cdx:hbom:productId", productCode),
        createProperty(
          "cdx:hbom:displaySerialNumber",
          serial === undefined ? undefined : redactIdentifier(serial, options),
        ),
        createProperty(
          "cdx:hbom:manufactureYear",
          positiveNumber(monitor.YearOfManufacture),
        ),
        createProperty(
          "cdx:hbom:manufactureWeek",
          week !== undefined && !UNKNOWN_MANUFACTURE_WEEKS.has(week)
            ? week
            : undefined,
        ),
        createProperty(
          "cdx:hbom:physicalSize",
          formatDisplayPhysicalSize(
            positiveNumber(basic?.MaxHorizontalImageSize),
            positiveNumber(basic?.MaxVerticalImageSize),
          ),
        ),
        createProperty(
          "cdx:hbom:connectionType",
          windowsVideoOutputTechnologyName(
            cimNumber(connection?.VideoOutputTechnology),
          ),
        ),
        createProperty("cdx:hbom:isActive", cimBool(monitor.Active)),
        createProperty(
          "cdx:hbom:pnpInstanceId",
          pnpId === undefined ? undefined : redactInstanceId(pnpId, options),
        ),
      ]),
    });
  });
}

/**
 * Recover the PnP device instance ID from a WmiMonitor* InstanceName.
 *
 * @param {string | undefined} instanceName WMI instance name.
 * @returns {string | undefined} Device instance ID or undefined.
 */
export function monitorPnpInstanceId(instanceName) {
  if (instanceName === undefined) {
    return undefined;
  }
  return instanceName.replace(WMI_INSTANCE_SUFFIX, "");
}

/**
 * Format a resolution as `WxH`, matching the Linux EDID emitter.
 *
 * @param {unknown} horizontal Horizontal pixel count.
 * @param {unknown} vertical Vertical pixel count.
 * @returns {string | undefined} Resolution or undefined.
 */
function formatResolution(horizontal, vertical) {
  const width = positiveNumber(horizontal);
  const height = positiveNumber(vertical);
  return width !== undefined && height !== undefined
    ? `${width}x${height}`
    : undefined;
}

/**
 * Find the WmiMonitor* item sharing an InstanceName.
 *
 * @param {Record<string, unknown>[]} items Candidate items.
 * @param {string | undefined} instanceName Join key.
 * @returns {Record<string, unknown> | undefined} Matched item.
 */
function findByInstanceName(items, instanceName) {
  if (instanceName === undefined) {
    return undefined;
  }
  const target = instanceName.toLowerCase();
  return items.find(
    (item) => cimString(item.InstanceName)?.toLowerCase() === target,
  );
}

/**
 * Normalize a CIM number, dropping zero sentinels.
 *
 * @param {unknown} value Candidate value.
 * @returns {number | undefined} Positive number or undefined.
 */
function positiveNumber(value) {
  const number = cimNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
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
