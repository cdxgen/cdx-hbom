import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  classifyWindowsResultError,
  parseWindowsEnvelope,
  toWindowsResultDiagnostic,
} from "../../src/windows/common/cim.js";
import { WINDOWS_COMMANDS } from "../../src/windows/common/commands.js";
import { buildPnpDeviceIndex, parsePnpDevicesEnvelope } from "../../src/windows/common/devices.js";
import { buildWindowsHbom } from "../../src/windows/common/index.js";
import { buildHostPowerProperties, buildPowerComponents } from "../../src/windows/common/power.js";
import {
  buildFirmwareDeviceComponents,
  buildTpmComponents,
  parsePrivilegedEnvelope,
  parseTpmSpecVersion,
  parseTrustEnvelope,
} from "../../src/windows/common/trust.js";

const FIXTURES_ROOT = fileURLToPath(
  new URL("../fixtures/windows", import.meta.url),
);

// Synthetic T0 baseline for fixture-driven tests (test input, not captured).
const TEST_BASELINE = Object.freeze({
  cpuModel: "Baseline CPU",
  cpuCount: 8,
  totalMemoryBytes: 8 * 1024 * 1024 * 1024,
  osRelease: "10.0.26200",
  osName: "Baseline Windows",
});

const VM_LABELS = [
  "arm64/vm-parallels-elevated",
  "arm64/vm-parallels-std-local",
  "arm64/vm-parallels-std-network",
];

/**
 * Read and parse one captured envelope.
 *
 * @param {string} directory Fixture directory.
 * @param {string} commandId Command id.
 * @returns {object | undefined} Parsed envelope, or undefined when absent.
 */
function readEnvelope(directory, commandId) {
  const path = join(FIXTURES_ROOT, directory, `${commandId}.stdout`);
  return existsSync(path)
    ? parseWindowsEnvelope(readFileSync(path, "utf8"))
    : undefined;
}

/**
 * Build a BOM from every captured envelope of a directory.
 *
 * @param {string} directory Fixture directory.
 * @param {{ privileged?: boolean, overrides?: object, extra?: object }} [settings] Build settings.
 * @returns {object} BOM.
 */
function buildFromFixture(directory, settings = {}) {
  return buildWindowsHbom({
    architecture: "x64",
    sources: {
      baseline: TEST_BASELINE,
      platformEnvelope: readEnvelope(directory, "windows-cim-platform"),
      storageNetworkEnvelope: readEnvelope(directory, "windows-cim-storage-network"),
      displayMediaEnvelope: readEnvelope(directory, "windows-cim-display-media"),
      pnpDevicesEnvelope: readEnvelope(directory, "windows-pnp-devices"),
      trustEnvelope: readEnvelope(directory, "windows-cim-trust"),
      privilegedEnvelope:
        settings.privileged === false
          ? undefined
          : readEnvelope(directory, "windows-cim-privileged"),
      ...(settings.overrides ?? {}),
    },
    collectedAt: "2026-10-19T00:00:00.000Z",
    ...(settings.extra ?? {}),
  });
}

/**
 * Read a property value from a component or the host.
 *
 * @param {object} component Component.
 * @param {string} name Property name.
 * @returns {string | undefined} Property value.
 */
function prop(component, name) {
  return (component?.properties ?? []).find((entry) => entry.name === name)?.value;
}

/**
 * Find components by hardware class.
 *
 * @param {object} bom BOM.
 * @param {string} hardwareClass Class name.
 * @returns {object[]} Components.
 */
function byClass(bom, hardwareClass) {
  return bom.components.filter(
    (component) => prop(component, "cdx:hbom:hardwareClass") === hardwareClass,
  );
}

/**
 * Parsed command diagnostics of a BOM.
 *
 * @param {object} bom BOM.
 * @returns {object[]} Diagnostics.
 */
function diagnosticsOf(bom) {
  return bom.properties
    .filter((entry) => entry.name === "cdx:hbom:evidence:commandDiagnostic")
    .map((entry) => JSON.parse(entry.value));
}

test("VM fixtures carry trust and privileged captures for all three tokens", () => {
  for (const label of VM_LABELS) {
    assert.ok(readEnvelope(label, "windows-cim-trust"), `${label} trust`);
    assert.ok(readEnvelope(label, "windows-cim-privileged"), `${label} privileged`);
  }
  const specs = WINDOWS_COMMANDS.map((spec) => spec.id);
  assert.deepEqual(specs.slice(-2), ["windows-cim-trust", "windows-cim-privileged"]);
  for (const spec of WINDOWS_COMMANDS) {
    assert.equal(spec.privilege, "none");
    assert.equal(spec.sudoRetryOnPermissionDenied, false);
  }
});

test("captured privilege table matches the C07 brief for every source and token", () => {
  // Source -> [elevated, std-network, std-local], as the brief's table.
  const expected = {
    "windows-cim-trust:deviceGuard": ["ok", "AccessDenied", "ok"],
    "windows-cim-trust:battery": ["ok-empty", "AccessDenied", "ok-empty"],
    "windows-cim-trust:secureBootState": ["ok", "ok", "ok"],
    "windows-cim-trust:firmwareResources": ["not-present", "not-present", "not-present"],
    "windows-cim-privileged:tpm": ["ok", "AccessDenied", "AccessDenied"],
    "windows-cim-privileged:encryptableVolume": ["ok", "AccessDenied", "AccessDenied"],
    "windows-cim-privileged:storageReliability": ["ok-empty", "AccessDenied", "AccessDenied"],
    "windows-cim-privileged:secureBootCmdlet": ["true", "SetPrivilegeFailed", "SetPrivilegeFailed"],
  };
  const labels = ["arm64/vm-parallels-elevated", "arm64/vm-parallels-std-network", "arm64/vm-parallels-std-local"];
  const describe = (result) => {
    if (result.ok) {
      if (result.kind === "cmdlet-scalar") {
        return String(result.value);
      }
      if (result.kind === "registry") {
        return "ok";
      }
      return (result.items ?? []).length === 0 ? "ok-empty" : "ok";
    }
    if (result.error?.nativeErrorCode === "AccessDenied") {
      return "AccessDenied";
    }
    if (/^SetPrivilegeFailed,/u.test(result.error?.fqid ?? "")) {
      return "SetPrivilegeFailed";
    }
    return classifyWindowsResultError(result.error);
  };
  for (const [path, outcomes] of Object.entries(expected)) {
    const [commandId, key] = path.split(":");
    labels.forEach((label, index) => {
      const envelope = readEnvelope(label, commandId);
      assert.equal(describe(envelope.results[key]), outcomes[index], `${label} ${path}`);
    });
  }
  // SetPrivilegeFailed is not a CIM error: no native code, ErrorCategory
  // PermissionDenied (captured as hbomstd on both tokens).
  const denied = readEnvelope("arm64/vm-parallels-std-local", "windows-cim-privileged").results
    .secureBootCmdlet.error;
  assert.equal(denied.nativeErrorCode, "");
  assert.equal(denied.statusCode, null);
  assert.equal(denied.category, "PermissionDenied");
  assert.equal(classifyWindowsResultError(denied), "permission-denied");
  const diagnostic = toWindowsResultDiagnostic("windows-cim-privileged", "secureBootCmdlet", denied);
  assert.equal(diagnostic.code, "SetPrivilegeFailed");
  assert.match(diagnostic.privilegeHint ?? "", /./u);
});

test("elevated VM fixture: host security posture, TPM, firmware device and BitLocker", () => {
  const bom = buildFromFixture("arm64/vm-parallels-elevated");
  const host = bom.metadata.component;
  assert.equal(prop(host, "cdx:hbom:vbsStatus"), "off");
  assert.equal(prop(host, "cdx:hbom:securityServicesConfigured"), "none");
  assert.equal(prop(host, "cdx:hbom:securityServicesRunning"), "none");
  assert.equal(prop(host, "cdx:hbom:codeIntegrityPolicyEnforcement"), "enforced");
  assert.equal(prop(host, "cdx:hbom:usermodeCodeIntegrityPolicyEnforcement"), "off");
  assert.equal(
    prop(host, "cdx:hbom:availableSecurityProperties"),
    "secure-boot, nx-protections, mbec-gmet",
  );
  assert.equal(prop(host, "cdx:hbom:requiredSecurityProperties"), "none");
  assert.equal(prop(host, "cdx:hbom:secureBootEnabled"), "true");
  assert.equal(prop(host, "cdx:hbom:secureBootSource"), "Confirm-SecureBootUEFI");
  assert.equal(prop(host, "cdx:hbom:firmwareType"), "UEFI");
  assert.equal(prop(host, "cdx:hbom:powerSource"), undefined, "no battery on the VM");

  const tpms = byClass(bom, "tpm");
  assert.equal(tpms.length, 1);
  const tpm = tpms[0];
  assert.equal(tpm["bom-ref"], "windows-pnp:acpi:prls0000:1");
  assert.equal(tpm.name, "Trusted Platform Module 2.0");
  assert.equal(tpm.version, "2.0");
  assert.equal(tpm.manufacturer.name, "PRLS");
  assert.equal(prop(tpm, "cdx:hbom:specVersion"), "2.0");
  assert.equal(prop(tpm, "cdx:hbom:firmwareVersion"), "0.0.0.1");
  assert.equal(prop(tpm, "cdx:hbom:isEnabled"), "true");
  assert.equal(prop(tpm, "cdx:hbom:isActivated"), "true");
  assert.equal(prop(tpm, "cdx:hbom:isOwned"), "true");
  assert.equal(prop(tpm, "cdx:hbom:driver"), "TPM");
  assert.equal(prop(tpm, "cdx:hbom:infName"), "tpm.inf");
  assert.match(prop(tpm, "cdx:hbom:pnpInstanceId"), /^ACPI\\PRLS0000\\redacted/u);

  const firmware = byClass(bom, "firmware-device");
  assert.equal(firmware.length, 1);
  assert.equal(firmware[0]["bom-ref"], "windows-pnp:uefi:res_{43a56d5a-5d67-4896-ab2e-d71ed3698ba2}:1");
  assert.equal(firmware[0].name, "System Firmware");
  assert.equal(firmware[0].version, "1", "REV_1 emitted raw (radix undocumented)");
  assert.equal(prop(firmware[0], "cdx:hbom:guids"), "43a56d5a-5d67-4896-ab2e-d71ed3698ba2");
  assert.equal(prop(firmware[0], "cdx:hbom:firmwareVersion"), "1");
  assert.equal(prop(firmware[0], "cdx:hbom:lastAttemptStatus"), undefined, "no FirmwareResources key on the VM");
  assert.equal(prop(firmware[0], "cdx:hbom:infName"), "c_firmware.inf");

  const c = byClass(bom, "storage-volume").find((volume) => volume.name === "C:");
  assert.equal(prop(c, "cdx:hbom:isEncrypted"), "false");
  assert.equal(prop(c, "cdx:hbom:protectionStatus"), "off");
  assert.equal(prop(c, "cdx:hbom:encryptionMethod"), "None");
  assert.equal(prop(c, "cdx:hbom:conversionStatus"), "fully-decrypted");
  assert.equal(prop(c, "cdx:hbom:bitlockerVolumeType"), "system");
  for (const volume of byClass(bom, "storage-volume").filter((entry) => entry.name !== "C:")) {
    assert.equal(prop(volume, "cdx:hbom:isEncrypted"), undefined, "only C: is a BitLocker volume on the VM");
  }
  assert.equal(byClass(bom, "power").length, 0);
  assert.deepEqual(diagnosticsOf(bom), [], "not-present firmware resources never become diagnostics");

  // The PnP summary counts the TPM and firmware device as represented, so
  // neither appears as an unclassified ACPI/UEFI entity.
  const pnpSources = parsePnpDevicesEnvelope(readEnvelope("arm64/vm-parallels-elevated", "windows-pnp-devices"));
  const index = buildPnpDeviceIndex(pnpSources);
  assert.equal(buildTpmComponents(index, undefined, {}).length, 1, "presence comes from PnP alone");
});

test("standard local token: posture from the registry, TPM from PnP only, denied privileged classes explained", () => {
  const bom = buildFromFixture("arm64/vm-parallels-std-local");
  const host = bom.metadata.component;
  assert.equal(prop(host, "cdx:hbom:vbsStatus"), "off", "Win32_DeviceGuard is readable locally");
  assert.equal(prop(host, "cdx:hbom:secureBootEnabled"), "true");
  assert.equal(prop(host, "cdx:hbom:secureBootSource"), "registry");
  assert.equal(prop(host, "cdx:hbom:firmwareType"), "UEFI");

  const tpm = byClass(bom, "tpm")[0];
  assert.ok(tpm, "the PnP tree still proves the TPM is present");
  assert.equal(tpm.name, "Trusted Platform Module 2.0");
  assert.equal(tpm.version, undefined);
  assert.equal(prop(tpm, "cdx:hbom:specVersion"), undefined);
  assert.equal(prop(tpm, "cdx:hbom:driver"), "TPM");

  const c = byClass(bom, "storage-volume").find((volume) => volume.name === "C:");
  assert.equal(prop(c, "cdx:hbom:isEncrypted"), undefined, "BitLocker state needs the privileged batch");

  const diagnostics = diagnosticsOf(bom);
  assert.deepEqual(
    diagnostics.map((entry) => [entry.id, entry.issue, entry.code]),
    [
      ["windows-cim-privileged:tpm", "permission-denied", "AccessDenied"],
      ["windows-cim-privileged:encryptableVolume", "permission-denied", "AccessDenied"],
      ["windows-cim-privileged:storageReliability", "permission-denied", "AccessDenied"],
      ["windows-cim-privileged:secureBootCmdlet", "permission-denied", "SetPrivilegeFailed"],
      ["windows-cim-privileged", "permission-denied", undefined],
    ],
  );
  for (const entry of diagnostics) {
    assert.ok(entry.privilegeHint, `${entry.id} carries the Windows privilege hint`);
  }

  // Without the privileged batch there is nothing to explain.
  assert.deepEqual(diagnosticsOf(buildFromFixture("arm64/vm-parallels-std-local", { privileged: false })), []);
});

test("network logon: trust collapses to the network-logon line, registry still yields Secure Boot", () => {
  const trust = readEnvelope("arm64/vm-parallels-std-network", "windows-cim-trust");
  assert.equal(trust.results.deviceGuard.error.nativeErrorCode, "AccessDenied");
  assert.equal(trust.results.battery.error.nativeErrorCode, "AccessDenied");
  assert.deepEqual(trust.results.secureBootState.values, { UEFISecureBootEnabled: 1 });

  const bom = buildFromFixture("arm64/vm-parallels-std-network", { privileged: false });
  const host = bom.metadata.component;
  assert.equal(prop(host, "cdx:hbom:vbsStatus"), undefined);
  assert.equal(prop(host, "cdx:hbom:secureBootEnabled"), "true");
  assert.equal(prop(host, "cdx:hbom:secureBootSource"), "registry");
  assert.equal(byClass(bom, "tpm").length, 0, "no PnP tree, no TPM evidence");
  const trustDiagnostics = diagnosticsOf(bom).filter((entry) => entry.id.startsWith("windows-cim-trust"));
  assert.deepEqual(trustDiagnostics.map((entry) => entry.id), ["windows-cim-trust:network-logon"]);
});

test("privileged batch without PnP data still yields a TPM from Win32_Tpm, and none when Win32_Tpm is empty", () => {
  const privileged = readEnvelope("arm64/vm-parallels-elevated", "windows-cim-privileged");
  const fromTpmOnly = buildTpmComponents(undefined, parsePrivilegedEnvelope(privileged), {});
  assert.equal(fromTpmOnly.length, 1);
  assert.equal(fromTpmOnly[0].name, "Trusted Platform Module 2.0");
  assert.equal(fromTpmOnly[0]["bom-ref"], undefined);
  assert.equal(prop(fromTpmOnly[0], "cdx:hbom:specVersion"), "2.0");

  // The GitHub runners answer Win32_Tpm with ok:true and zero items (selftest
  // fixtures): no TPM is exposed, so nothing is emitted.
  const emptyTpm = parsePrivilegedEnvelope({
    results: { tpm: { ok: true, items: [] } },
  });
  assert.equal(emptyTpm.tpmQueried, true);
  assert.deepEqual(buildTpmComponents(undefined, emptyTpm, {}), []);

  assert.equal(parseTpmSpecVersion("2.0, 0, 1.16"), "2.0");
  assert.equal(parseTpmSpecVersion("1.2, 2, 0"), "1.2");
  assert.equal(parseTpmSpecVersion("Not Supported"), undefined);
  assert.equal(parseTpmSpecVersion(undefined), undefined);
});

test("firmware device joins Control\\FirmwareResources and names ESRT statuses", () => {
  const index = buildPnpDeviceIndex(
    parsePnpDevicesEnvelope(readEnvelope("arm64/vm-parallels-elevated", "windows-pnp-devices")),
  );
  // Synthetic registry rows (test input; the key is absent on the VM) using
  // the VM's captured resource GUID and the documented NTSTATUS values; a
  // REG_DWORD above 0x7FFFFFFF reads back as a negative Int32.
  const trust = parseTrustEnvelope({
    results: {
      firmwareResources: {
        ok: true,
        kind: "registry-children",
        items: [
          {
            Name: "{43A56D5A-5D67-4896-AB2E-D71ED3698BA2}",
            LastAttemptStatus: -1073741823,
            LastAttemptVersion: 2,
            Version: 1,
          },
        ],
      },
    },
  });
  const [device] = buildFirmwareDeviceComponents(index, trust, {});
  assert.equal(prop(device, "cdx:hbom:lastAttemptStatus"), "unsuccessful");
  assert.equal(prop(device, "cdx:hbom:lastAttemptVersion"), "2");
  assert.equal(prop(device, "cdx:hbom:firmwareVersion"), "1");

  const success = parseTrustEnvelope({
    results: {
      firmwareResources: {
        ok: true,
        items: [{ Name: "{43a56d5a-5d67-4896-ab2e-d71ed3698ba2}", LastAttemptStatus: 0 }],
      },
    },
  });
  assert.equal(prop(buildFirmwareDeviceComponents(index, success, {})[0], "cdx:hbom:lastAttemptStatus"), "success");
  const unknown = parseTrustEnvelope({
    results: {
      firmwareResources: {
        ok: true,
        items: [{ Name: "{43a56d5a-5d67-4896-ab2e-d71ed3698ba2}", LastAttemptStatus: -1073741819 }],
      },
    },
  });
  assert.equal(
    prop(buildFirmwareDeviceComponents(index, unknown, {})[0], "cdx:hbom:lastAttemptStatus"),
    "0xc0000005",
    "unknown NTSTATUS values stay raw",
  );
});

test("derived: firmware REV_ token is emitted raw, whatever its radix", () => {
  // Derived from the captured UEFI device shape: the hardware IDs follow
  // https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/plug-and-play-device
  // (UEFI\RES_{GUID}&REV_<version>, UEFI\RES_{GUID}); the GUID and REV value
  // are test input. No document states whether REV_ is hexadecimal or
  // decimal, so `0100` must survive untouched.
  const guid = "6bd4efb9-23cc-4b4a-ac37-016517413e9a";
  const envelope = {
    results: {
      pnpEntity: {
        ok: true,
        items: [
          {
            Name: "Derived Device Firmware",
            PNPDeviceID: `UEFI\\RES_{${guid.toUpperCase()}}\\0`,
            ClassGuid: "{f2e7dd72-6468-4e36-b6f1-6488f42c1b52}",
            HardwareID: [`UEFI\\RES_{${guid}}&REV_0100`, `UEFI\\RES_{${guid}}`],
            CompatibleID: ["UEFI\\CC_00010001", "GenFirmwareResource"],
            Present: true,
            ConfigManagerErrorCode: 0,
          },
        ],
      },
    },
  };
  const index = buildPnpDeviceIndex(parsePnpDevicesEnvelope(envelope));
  const [device] = buildFirmwareDeviceComponents(index, undefined, {});
  assert.equal(device.version, "0100");
  assert.equal(prop(device, "cdx:hbom:firmwareVersion"), "0100");
  assert.equal(prop(device, "cdx:hbom:guids"), guid);
  assert.equal(device["bom-ref"], `windows-pnp:uefi:res_{${guid}}:1`);
});

test("BitLocker joins volumes by GUID, then by drive letter", () => {
  const elevated = readEnvelope("arm64/vm-parallels-elevated", "windows-cim-privileged");
  const captured = elevated.results.encryptableVolume.items[0];
  // Synthetic additional volumes (test input): one letterless volume matched
  // by GUID only, one letter-only volume matched by drive letter, using the
  // documented ProtectionStatus/EncryptionMethod/ConversionStatus/VolumeType
  // codes.
  const privileged = {
    ...elevated,
    results: {
      ...elevated.results,
      encryptableVolume: {
        ok: true,
        items: [
          captured,
          {
            DriveLetter: null,
            ProtectionStatus: 1,
            ConversionStatus: 1,
            EncryptionMethod: 7,
            VolumeType: 1,
            DeviceID: "\\\\?\\Volume{redacted:d70c}\\",
          },
          {
            DriveLetter: "D:",
            ProtectionStatus: 2,
            ConversionStatus: 2,
            EncryptionMethod: 4294967295,
            VolumeType: 2,
            DeviceID: "\\\\?\\Volume{redacted:zzzz}\\",
          },
        ],
      },
    },
  };
  const storage = readEnvelope("arm64/vm-parallels-elevated", "windows-cim-storage-network");
  const letterless = storage.results.volume.items.find(
    (volume) => volume.DriveLetter === null && /redacted:d70c/u.test(volume.DeviceID),
  );
  assert.ok(letterless, "the fixture has a letterless volume ending in d70c");

  const bom = buildFromFixture("arm64/vm-parallels-elevated", {
    overrides: { privilegedEnvelope: privileged },
  });
  const volumes = byClass(bom, "storage-volume");
  const encrypted = volumes.find((volume) => prop(volume, "cdx:hbom:volumeUuid") === "redacted:d70c");
  assert.equal(prop(encrypted, "cdx:hbom:isEncrypted"), "true");
  assert.equal(prop(encrypted, "cdx:hbom:protectionStatus"), "on");
  assert.equal(prop(encrypted, "cdx:hbom:encryptionMethod"), "XTS_AES_256");
  assert.equal(prop(encrypted, "cdx:hbom:conversionStatus"), "fully-encrypted");
  assert.equal(prop(encrypted, "cdx:hbom:bitlockerVolumeType"), "fixed-disk");

  const d = volumes.find((volume) => volume.name === "D:");
  assert.equal(prop(d, "cdx:hbom:isEncrypted"), "false", "PROTECTION UNKNOWN is not encrypted");
  assert.equal(prop(d, "cdx:hbom:protectionStatus"), "unknown");
  assert.equal(prop(d, "cdx:hbom:encryptionMethod"), "UNKNOWN");
  assert.equal(prop(d, "cdx:hbom:conversionStatus"), "encryption-in-progress");
  assert.equal(prop(d, "cdx:hbom:bitlockerVolumeType"), "removable");
});

test("derived: battery from the captured Win32_Battery schema", () => {
  // No capture host has a battery. The items below are DERIVED by this test
  // from the captured class schema (test/fixtures/windows/schema, provenance
  // "schema"): every property name must exist in the schema, and the values
  // come from the documented ranges on
  // https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-battery
  // (BatteryStatus 2 "system has access to AC", 1 discharging, 6 charging;
  // Chemistry 6 Lithium-ion; DesignVoltage in millivolts; EstimatedRunTime
  // in minutes). Unverified against real hardware.
  const schema = JSON.parse(
    readFileSync(join(FIXTURES_ROOT, "schema", "Win32_Battery.schema.json"), "utf8"),
  );
  assert.equal(schema.provenance, "schema");
  assert.equal(schema.className, "Win32_Battery");
  assert.equal(schema.instanceCount, 0, "the VM has no battery instance");
  const names = new Set(schema.properties.map((property) => property.name));
  const derive = (overrides) => {
    const item = {
      Name: "Derived Battery",
      EstimatedChargeRemaining: 87,
      BatteryStatus: 2,
      Chemistry: 6,
      DesignVoltage: 11400,
      EstimatedRunTime: Math.floor(0xffffffff / 60),
      Availability: 3,
      ...overrides,
    };
    for (const key of Object.keys(item)) {
      assert.ok(names.has(key), `${key} is a Win32_Battery property`);
    }
    return item;
  };
  assert.deepEqual(
    schema.properties.find((property) => property.name === "BatteryStatus").valueMap,
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
    "the live ValueMap matches the documented BatteryStatus codes",
  );

  const onAc = parseTrustEnvelope({ results: { battery: { ok: true, items: [derive({})] } } });
  const [acBattery] = buildPowerComponents(onAc);
  assert.equal(prop(acBattery, "cdx:hbom:hardwareClass"), "power");
  assert.equal(acBattery.name, "Derived Battery");
  assert.equal(prop(acBattery, "cdx:hbom:chargePercent"), "87");
  assert.equal(prop(acBattery, "cdx:hbom:isCharging"), "false");
  assert.equal(prop(acBattery, "cdx:hbom:isAcAttached"), "true");
  assert.equal(prop(acBattery, "cdx:hbom:status"), "On AC");
  assert.equal(prop(acBattery, "cdx:hbom:technology"), "Lithium-ion");
  assert.equal(prop(acBattery, "cdx:hbom:designVoltageMv"), "11400");
  assert.equal(
    prop(acBattery, "cdx:hbom:estimatedRunTimeMinutes"),
    undefined,
    "71582788 is BATTERY_UNKNOWN_TIME in minutes and is omitted",
  );
  assert.deepEqual(
    buildHostPowerProperties(onAc).map((entry) => [entry.name, entry.value]),
    [["cdx:hbom:powerSource", "AC"], ["cdx:hbom:isAcAttached", "true"]],
  );

  const discharging = parseTrustEnvelope({
    results: { battery: { ok: true, items: [derive({ BatteryStatus: 1, EstimatedRunTime: 143, Chemistry: 2 })] } },
  });
  const [battery] = buildPowerComponents(discharging);
  assert.equal(prop(battery, "cdx:hbom:isCharging"), "false");
  assert.equal(prop(battery, "cdx:hbom:isAcAttached"), "false");
  assert.equal(prop(battery, "cdx:hbom:status"), "Discharging");
  assert.equal(prop(battery, "cdx:hbom:estimatedRunTimeMinutes"), "143");
  assert.equal(prop(battery, "cdx:hbom:technology"), undefined, "Unknown chemistry is omitted");
  assert.deepEqual(
    buildHostPowerProperties(discharging).map((entry) => entry.value),
    ["Battery", "false"],
  );

  const charging = parseTrustEnvelope({
    results: { battery: { ok: true, items: [derive({ BatteryStatus: 6 })] } },
  });
  assert.equal(prop(buildPowerComponents(charging)[0], "cdx:hbom:isCharging"), "true");
  assert.equal(prop(buildPowerComponents(charging)[0], "cdx:hbom:isAcAttached"), "true");

  // The whole BOM path: a derived battery on top of the elevated fixture.
  const bom = buildFromFixture("arm64/vm-parallels-elevated", {
    overrides: {
      trustEnvelope: {
        ...readEnvelope("arm64/vm-parallels-elevated", "windows-cim-trust"),
        results: {
          ...readEnvelope("arm64/vm-parallels-elevated", "windows-cim-trust").results,
          battery: { ok: true, items: [derive({})] },
        },
      },
    },
  });
  assert.equal(byClass(bom, "power").length, 1);
  assert.equal(prop(bom.metadata.component, "cdx:hbom:powerSource"), "AC");
  assert.equal(prop(bom.metadata.component, "cdx:hbom:isAcAttached"), "true");
});

test("derived: storage reliability counters from the captured schema enrich the disk", () => {
  // DERIVED from test/fixtures/windows/schema/MSFT_StorageReliabilityCounter.schema.json
  // (0 instances on the VM). DeviceId joins MSFT_PhysicalDisk.DeviceId, the
  // string form of Win32_DiskDrive.Index; units per
  // https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-storagereliabilitycounter
  // (Wear percent, Temperature degrees Celsius, PowerOnHours hours). Values
  // are test input. Unverified against real hardware.
  const schema = JSON.parse(
    readFileSync(join(FIXTURES_ROOT, "schema", "MSFT_StorageReliabilityCounter.schema.json"), "utf8"),
  );
  assert.equal(schema.provenance, "schema");
  const names = new Set(schema.properties.map((property) => property.name));
  const counter = {
    DeviceId: "0",
    Wear: 3,
    Temperature: 41,
    PowerOnHours: 1234,
    ReadErrorsTotal: 0,
    WriteErrorsTotal: 0,
  };
  for (const key of Object.keys(counter)) {
    assert.ok(names.has(key), `${key} is an MSFT_StorageReliabilityCounter property`);
  }
  const elevated = readEnvelope("arm64/vm-parallels-elevated", "windows-cim-privileged");
  const bom = buildFromFixture("arm64/vm-parallels-elevated", {
    overrides: {
      privilegedEnvelope: {
        ...elevated,
        results: { ...elevated.results, storageReliability: { ok: true, items: [counter] } },
      },
    },
  });
  const disk = byClass(bom, "storage")[0];
  assert.equal(prop(disk, "cdx:hbom:diskNumber"), "0");
  assert.equal(prop(disk, "cdx:hbom:wearPercentageUsed"), "3");
  assert.equal(prop(disk, "cdx:hbom:temperatureCelsius"), "41");
  assert.equal(prop(disk, "cdx:hbom:powerOnHours"), "1234");

  // Without the privileged batch the disk carries none of them.
  const plain = buildFromFixture("arm64/vm-parallels-elevated", { privileged: false });
  assert.equal(prop(byClass(plain, "storage")[0], "cdx:hbom:wearPercentageUsed"), undefined);
});

test("default BOM leaks none of the trust and privileged fixtures' sensitive values", () => {
  for (const label of VM_LABELS) {
    const raw = JSON.parse(
      readFileSync(join(FIXTURES_ROOT, label, "windows-cim-privileged.stdout"), "utf8"),
    );
    const bom = buildFromFixture(label);
    const serialized = JSON.stringify(bom);
    for (const item of raw.results.encryptableVolume?.items ?? []) {
      const guid = String(item.DeviceID ?? "").match(/\{([^}]+)\}/u)?.[1];
      if (guid && !/^redacted/u.test(guid)) {
        assert.ok(!serialized.includes(guid), `${label}: volume GUID leaked`);
      }
    }
  }
  // Synthetic raw volume GUID (test input) must not reach the BOM through
  // the BitLocker join.
  const elevated = readEnvelope("arm64/vm-parallels-elevated", "windows-cim-privileged");
  const rawGuid = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const bom = buildFromFixture("arm64/vm-parallels-elevated", {
    overrides: {
      privilegedEnvelope: {
        ...elevated,
        results: {
          ...elevated.results,
          encryptableVolume: {
            ok: true,
            items: [{ DriveLetter: "C:", ProtectionStatus: 1, DeviceID: `\\\\?\\Volume{${rawGuid}}\\` }],
          },
        },
      },
    },
  });
  assert.ok(!JSON.stringify(bom).includes(rawGuid));
  const c = byClass(bom, "storage-volume").find((volume) => volume.name === "C:");
  assert.equal(prop(c, "cdx:hbom:isEncrypted"), "true", "the drive-letter fallback still joins");
});
