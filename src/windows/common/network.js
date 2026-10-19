// Windows network inventory: hardware network and wireless adapters from
// MSFT_NetAdapter, with Win32_NetworkAdapter as the fallback when the
// NetAdapter CIM classes are unavailable. All builders are pure.

import { posix } from "node:path";

import {
  compact,
  createHardwareComponent,
  createProperty,
  redactIdentifier,
} from "../../common/shape.js";
import { cimBool, cimDate, cimNumber, cimString } from "./cim.js";
import { WINDOWS_NDIS_PHYSICAL_MEDIA, windowsEnumName } from "./enums.js";
import { parseDeviceInstanceId } from "./pnp.js";

// NdisPhysicalMedium 10 is a Bluetooth PAN over another adapter, and
// EndPointInterface adapters are not real network interfaces:
// https://learn.microsoft.com/en-us/previous-versions/windows/desktop/legacy/hh968170(v=vs.85)
const NDIS_PHYSICAL_MEDIUM_BLUETOOTH = 10;
const WIRELESS_NDIS_PHYSICAL_MEDIA = new Set([1, 9]);

// MSFT_NetAdapter.MediaConnectState: 0 Unknown, 1 Connected, 2 Disconnected.
const MEDIA_CONNECT_STATE_CONNECTED = 1;
const MEDIA_CONNECT_STATE_DISCONNECTED = 2;

// Win32_NetworkAdapter.NetConnectionStatus (fallback path):
// https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-networkadapter
const NET_CONNECTION_STATUS_CONNECTED = 2;
const DOWN_NET_CONNECTION_STATUSES = new Set([0, 7]);

/**
 * Select the hardware network adapters from MSFT_NetAdapter items.
 *
 * Every exclusion carries a reason so tests (and the report) can account for
 * each dropped adapter instead of silently losing it.
 *
 * @param {Record<string, unknown>[]} items MSFT_NetAdapter items.
 * @returns {{ selected: Record<string, unknown>[], excluded: Array<{ item: Record<string, unknown>, reason: string }> }} Selection.
 */
export function selectHardwareNetAdapters(items) {
  const selected = [];
  const excluded = [];
  for (const item of items) {
    if (cimBool(item.HardwareInterface) !== true) {
      excluded.push({ item, reason: "HardwareInterface is not true" });
      continue;
    }
    if (cimBool(item.Virtual) === true) {
      excluded.push({ item, reason: "Virtual adapter" });
      continue;
    }
    if (cimNumber(item.NdisPhysicalMedium) === NDIS_PHYSICAL_MEDIUM_BLUETOOTH) {
      excluded.push({
        item,
        reason: "Bluetooth PAN (NdisPhysicalMedium 10)",
      });
      continue;
    }
    if (cimBool(item.EndPointInterface) === true) {
      excluded.push({ item, reason: "EndPointInterface" });
      continue;
    }
    selected.push(item);
  }
  return { selected, excluded };
}

/**
 * Build network adapter components from MSFT_NetAdapter with the
 * Win32_NetworkAdapter fallback.
 *
 * The driver service name is joined from Win32_NetworkAdapter by
 * PnPDeviceID at every privilege level, because a standard user's
 * MSFT_NetAdapter.DriverName is null (PERMISSIONS-MATRIX.md); the DriverName
 * basename is only a fallback.
 *
 * @param {Array<Record<string, unknown>>} netAdapters MSFT_NetAdapter items.
 * @param {Array<Record<string, unknown>>} netAdapterHardware Hardware-info items.
 * @param {{ ok: boolean, items: Record<string, unknown>[] }} netAdapterResult Envelope result state.
 * @param {Array<Record<string, unknown>>} legacyAdapters Win32_NetworkAdapter items.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Build options.
 * @returns {object[]} Adapter components.
 */
export function buildNetworkComponents(
  netAdapters,
  netAdapterHardware,
  netAdapterResult,
  legacyAdapters,
  options = {},
) {
  if (netAdapterResult.ok) {
    const { selected } = selectHardwareNetAdapters(netAdapters);
    return selected.map((adapter) =>
      buildNetAdapterComponent(adapter, netAdapterHardware, legacyAdapters, options),
    );
  }
  return legacyAdapters
    .filter((adapter) => cimBool(adapter.PhysicalAdapter) === true)
    .map((adapter) => buildLegacyAdapterComponent(adapter, options));
}

/**
 * Build one MSFT_NetAdapter component.
 *
 * @param {Record<string, unknown>} adapter Adapter item.
 * @param {Array<Record<string, unknown>>} netAdapterHardware Hardware-info items.
 * @param {Array<Record<string, unknown>>} legacyAdapters Win32_NetworkAdapter items.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Build options.
 * @returns {object} Component.
 */
function buildNetAdapterComponent(
  adapter,
  netAdapterHardware,
  legacyAdapters,
  options,
) {
  const ndisMedium = cimNumber(adapter.NdisPhysicalMedium);
  const hardwareClass = WIRELESS_NDIS_PHYSICAL_MEDIA.has(ndisMedium)
    ? "wireless-adapter"
    : "network-interface";
  const componentId = parseDeviceInstanceId(adapter.ComponentID).ids;
  const legacy = findLegacyByInstanceId(legacyAdapters, adapter.PnPDeviceID);
  const connectState = cimNumber(adapter.MediaConnectState);

  return createHardwareComponent(hardwareClass, {
    name: cimString(adapter.InterfaceDescription) ?? cimString(adapter.DriverDescription) ?? "Network Adapter",
    version: cimString(adapter.Name),
    manufacturer: cimString(legacy?.Manufacturer)
      ? { name: cimString(legacy.Manufacturer) }
      : undefined,
    properties: compact([
      createProperty("cdx:hbom:interfaceName", cimString(adapter.Name)),
      createProperty("cdx:hbom:driver", netAdapterDriver(adapter, legacy)),
      createProperty(
        "cdx:hbom:driverVersion",
        cimString(adapter.DriverVersionString),
      ),
      createProperty("cdx:hbom:driverProvider", cimString(adapter.DriverProvider)),
      createProperty("cdx:hbom:driverDate", cimDate(cimString(adapter.DriverDate))),
      createProperty(
        "cdx:hbom:macAddress",
        redactMacAddress(adapter.PermanentAddress, options),
      ),
      createProperty("cdx:hbom:mtu", cimNumber(adapter.MtuSize)),
      createProperty(
        "cdx:hbom:speedMbps",
        connectState === MEDIA_CONNECT_STATE_CONNECTED
          ? Math.round((cimNumber(adapter.ReceiveLinkSpeed) ?? 0) / 1e6) || undefined
          : undefined,
      ),
      createProperty(
        "cdx:hbom:duplex",
        cimBool(adapter.FullDuplex) === undefined
          ? undefined
          : cimBool(adapter.FullDuplex)
            ? "full"
            : "half",
      ),
      createProperty(
        "cdx:hbom:operState",
        connectState === MEDIA_CONNECT_STATE_CONNECTED
          ? "up"
          : connectState === MEDIA_CONNECT_STATE_DISCONNECTED
            ? "down"
            : undefined,
      ),
      createProperty("cdx:hbom:ifindex", cimNumber(adapter.InterfaceIndex)),
      createProperty(
        "cdx:hbom:physicalMedium",
        windowsEnumName(WINDOWS_NDIS_PHYSICAL_MEDIA, ndisMedium),
      ),
      createProperty("cdx:hbom:vendorId", componentId.vendorId),
      createProperty(
        "cdx:hbom:productId",
        componentId.productId ?? componentId.deviceId,
      ),
      createProperty("cdx:hbom:subsystemDeviceId", componentId.subsystemId),
      createProperty("cdx:hbom:subsystemVendorId", componentId.subsystemVendorId),
      createProperty(
        "cdx:hbom:pciAddress",
        pciAddressFor(cimString(adapter.Name), netAdapterHardware),
      ),
    ]),
  });
}

/**
 * Build one Win32_NetworkAdapter fallback component.
 *
 * Used when the NetAdapter CIM classes are unavailable (for example Server
 * Core); only properties the legacy class actually carries are mapped.
 *
 * @param {Record<string, unknown>} adapter Adapter item.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Build options.
 * @returns {object} Component.
 */
function buildLegacyAdapterComponent(adapter, options) {
  const connectionStatus = cimNumber(adapter.NetConnectionStatus);
  return createHardwareComponent("network-interface", {
    name: cimString(adapter.Name) ?? "Network Adapter",
    manufacturer: cimString(adapter.Manufacturer)
      ? { name: cimString(adapter.Manufacturer) }
      : undefined,
    properties: compact([
      createProperty("cdx:hbom:driver", cimString(adapter.ServiceName)),
      createProperty(
        "cdx:hbom:macAddress",
        redactMacAddress(adapter.MACAddress, options),
      ),
      createProperty("cdx:hbom:ifindex", cimNumber(adapter.InterfaceIndex)),
      createProperty(
        "cdx:hbom:speedMbps",
        connectionStatus === NET_CONNECTION_STATUS_CONNECTED
          ? Math.round((cimNumber(adapter.Speed) ?? 0) / 1e6) || undefined
          : undefined,
      ),
      createProperty(
        "cdx:hbom:operState",
        connectionStatus === NET_CONNECTION_STATUS_CONNECTED
          ? "up"
          : DOWN_NET_CONNECTION_STATUSES.has(connectionStatus)
            ? "down"
            : undefined,
      ),
      createProperty("cdx:hbom:adapterType", cimString(adapter.AdapterType)),
    ]),
  });
}

/**
 * Resolve the driver name for an MSFT_NetAdapter.
 *
 * The Win32_NetworkAdapter.ServiceName join works at every privilege level;
 * the MSFT_NetAdapter.DriverName basename (minus `.sys`) is the fallback.
 *
 * @param {Record<string, unknown>} adapter Adapter item.
 * @param {Record<string, unknown> | undefined} legacy Matched legacy adapter.
 * @returns {string | undefined} Driver service name.
 */
function netAdapterDriver(adapter, legacy) {
  const serviceName = cimString(legacy?.ServiceName);
  if (serviceName !== undefined) {
    return serviceName;
  }
  const driverName = cimString(adapter.DriverName);
  if (driverName === undefined) {
    return undefined;
  }
  const base = posix.basename(driverName).replace(/\.sys$/iu, "");
  return base.length > 0 ? base : undefined;
}

/**
 * Find the Win32_NetworkAdapter carrying the same PnP device instance ID.
 *
 * @param {Array<Record<string, unknown>>} legacyAdapters Legacy items.
 * @param {unknown} instanceId PnPDeviceID to match.
 * @returns {Record<string, unknown> | undefined} Matched adapter.
 */
function findLegacyByInstanceId(legacyAdapters, instanceId) {
  const target = cimString(instanceId);
  if (target === undefined) {
    return undefined;
  }
  return legacyAdapters.find(
    (adapter) => cimString(adapter.PNPDeviceID) === target,
  );
}

/**
 * Normalize a MAC to lower-case colon form (matching Linux) and redact it.
 *
 * @param {unknown} value Raw address.
 * @param {{ includeSensitiveIdentifiers?: boolean }} options Redaction options.
 * @returns {string | undefined} Redacted address.
 */
function redactMacAddress(value, options) {
  const text = cimString(value);
  if (text === undefined) {
    return undefined;
  }
  const hex = text.replaceAll(/[^0-9A-Fa-f]/gu, "");
  if (hex.length !== 12) {
    return redactIdentifier(text, options);
  }
  return redactIdentifier(
    hex.toLowerCase().replace(/(..)(?=.)/gu, "$1:"),
    options,
  );
}

/**
 * Format the PCI address of an adapter from its hardware-info item.
 *
 * `SSSS:BB:DD.F` in lower-case hex, matching the Linux pciAddress format.
 *
 * @param {string | undefined} adapterName MSFT_NetAdapter.Name.
 * @param {Array<Record<string, unknown>>} netAdapterHardware Hardware items.
 * @returns {string | undefined} PCI address.
 */
function pciAddressFor(adapterName, netAdapterHardware) {
  if (adapterName === undefined) {
    return undefined;
  }
  const hardware = netAdapterHardware.find(
    (item) => cimString(item.Name) === adapterName,
  );
  if (!hardware) {
    return undefined;
  }
  const segment = cimNumber(hardware.SegmentNumber);
  const bus = cimNumber(hardware.BusNumber);
  const device = cimNumber(hardware.DeviceNumber);
  const func = cimNumber(hardware.FunctionNumber);
  if (
    segment === undefined ||
    bus === undefined ||
    device === undefined ||
    func === undefined
  ) {
    return undefined;
  }
  return `${toHex(segment, 4)}:${toHex(bus, 2)}:${toHex(device, 2)}.${toHex(func, 1)}`;
}

/**
 * Format a number as fixed-width lower-case hex.
 *
 * @param {number} value Number.
 * @param {number} width Digit width.
 * @returns {string} Hex string.
 */
function toHex(value, width) {
  return value.toString(16).padStart(width, "0");
}
