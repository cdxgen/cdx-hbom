// Windows battery inventory from Win32_Battery items of the `windows-cim-trust`
// envelope: one `power` component per battery plus the host power-source
// properties the Linux collector also emits. All functions are pure. No
// capture host has a battery, so the shape is exercised by a derived fixture
// generated from the captured Win32_Battery schema (PLAN.md §5.4).

import {
  compact,
  createHardwareComponent,
  createProperty,
  normalizeIdentityString,
} from "../../common/shape.js";
import { cimNumber, cimPositiveNumber, cimString } from "./cim.js";
import {
  WINDOWS_BATTERY_CHEMISTRIES,
  WINDOWS_BATTERY_STATUSES,
  windowsEnumName,
} from "./enums.js";

// Win32_Battery.BatteryStatus 2 is documented as "The system has access to AC
// so no battery is being discharged. However, the battery is not necessarily
// charging", and 6-9 are the Charging states:
// https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-battery
const BATTERY_STATUS_ON_AC = 2;
const BATTERY_STATUS_CHARGING = new Set([6, 7, 8, 9]);

// EstimatedRunTime is reported in minutes; a battery driver that has no
// estimate returns BATTERY_UNKNOWN_TIME (0xFFFFFFFF seconds, per
// https://learn.microsoft.com/en-us/windows/win32/power/battery-query-information-str),
// which the class surfaces as floor(4294967295 / 60) = 71582788 minutes.
const BATTERY_UNKNOWN_RUN_TIME_MINUTES = Math.floor(0xffffffff / 60);

/**
 * Build one `power` component per Win32_Battery item.
 *
 * Property names follow the Linux and Darwin battery emitters where the
 * meaning matches (`chargePercent`, `isCharging`, `isAcAttached`,
 * `technology`, `status`).
 *
 * @param {import("./trust.js").WindowsTrustSources | undefined} trust Trust sources.
 * @returns {object[]} Power components.
 */
export function buildPowerComponents(trust) {
  return (trust?.batteries ?? []).map((battery) => {
    const status = cimNumber(battery.BatteryStatus);
    const runTime = cimNumber(battery.EstimatedRunTime);
    return createHardwareComponent("power", {
      name: cimString(battery.Name) ?? "Battery",
      properties: compact([
        createProperty("cdx:hbom:chargePercent", cimNumber(battery.EstimatedChargeRemaining)),
        createProperty(
          "cdx:hbom:isCharging",
          status === undefined ? undefined : BATTERY_STATUS_CHARGING.has(status),
        ),
        createProperty(
          "cdx:hbom:isAcAttached",
          status === undefined ? undefined : isAcAttached(status),
        ),
        createProperty("cdx:hbom:status", windowsEnumName(WINDOWS_BATTERY_STATUSES, status)),
        createProperty(
          "cdx:hbom:technology",
          normalizeIdentityString(
            windowsEnumName(WINDOWS_BATTERY_CHEMISTRIES, cimNumber(battery.Chemistry)),
          ),
        ),
        createProperty("cdx:hbom:designVoltageMv", cimPositiveNumber(battery.DesignVoltage)),
        createProperty(
          "cdx:hbom:estimatedRunTimeMinutes",
          runTime !== undefined && runTime > 0 && runTime !== BATTERY_UNKNOWN_RUN_TIME_MINUTES
            ? runTime
            : undefined,
        ),
      ]),
    });
  });
}

/**
 * Host power properties, as the Linux collector emits them: `powerSource`
 * (`AC` or `Battery`) and `isAcAttached`, only when a battery is present.
 *
 * @param {import("./trust.js").WindowsTrustSources | undefined} trust Trust sources.
 * @returns {object[]} Properties (undefined entries removed).
 */
export function buildHostPowerProperties(trust) {
  const statuses = (trust?.batteries ?? [])
    .map((battery) => cimNumber(battery.BatteryStatus))
    .filter((status) => status !== undefined);
  if (statuses.length === 0) {
    return [];
  }
  const acAttached = statuses.some((status) => isAcAttached(status));
  return compact([
    createProperty("cdx:hbom:powerSource", acAttached ? "AC" : "Battery"),
    createProperty("cdx:hbom:isAcAttached", acAttached),
  ]);
}

/**
 * Whether a BatteryStatus code implies AC power (On AC, or any Charging state).
 *
 * @param {number} status BatteryStatus code.
 * @returns {boolean} True when AC is attached.
 */
function isAcAttached(status) {
  return status === BATTERY_STATUS_ON_AC || BATTERY_STATUS_CHARGING.has(status);
}
