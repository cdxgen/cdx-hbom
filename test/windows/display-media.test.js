import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { isPlaceholderIdentity } from "../../src/common/shape.js";
import { cimUint16String, parseWindowsEnvelope } from "../../src/windows/common/cim.js";
import { WINDOWS_COMMANDS } from "../../src/windows/common/commands.js";
import {
  buildDisplayComponents,
  monitorPnpInstanceId,
  parseDisplayMediaEnvelope,
} from "../../src/windows/common/display.js";
import { buildCameraComponents } from "../../src/windows/common/media.js";
import { buildWindowsHbom } from "../../src/windows/common/index.js";
import { windowsVideoOutputTechnologyName } from "../../src/windows/common/enums.js";

const FIXTURES_ROOT = fileURLToPath(
  new URL("../fixtures/windows", import.meta.url),
);

const DISPLAY_SPEC = WINDOWS_COMMANDS.find(
  (spec) => spec.id === "windows-cim-display-media",
);

// Camera setup class GUID from
// https://learn.microsoft.com/en-us/windows-hardware/drivers/install/system-defined-device-setup-classes-available-to-vendors
const CAMERA_CLASS_GUID = "{ca3e7ab9-b4c3-4ae6-8251-579ef933890f}";

// Synthetic T0 baseline for fixture-driven tests (test input, not captured).
const TEST_BASELINE = Object.freeze({
  cpuModel: "Baseline CPU",
  cpuCount: 8,
  totalMemoryBytes: 8 * 1024 * 1024 * 1024,
  osRelease: "10.0.26200",
  osName: "Baseline Windows",
});

/**
 * List fixture directories that carry a display-media capture.
 *
 * @returns {string[]} `<arch>/<label>` paths.
 */
function displayFixtureDirectories() {
  return readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((arch) =>
      readdirSync(join(FIXTURES_ROOT, arch.name), { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(
              join(
                FIXTURES_ROOT,
                arch.name,
                entry.name,
                "windows-cim-display-media.stdout",
              ),
            ),
        )
        .map((entry) => `${arch.name}/${entry.name}`),
    );
}

/**
 * Build a BOM from a directory's captured envelopes.
 *
 * @param {string} directory Fixture directory.
 * @param {object} [extra] Extra build options.
 * @param {boolean} [withDisplay] Whether to pass the display-media envelope.
 * @returns {{ bom: object, display: object, sources: object }} Build result.
 */
function buildFromFixture(directory, extra = {}, withDisplay = true) {
  const platform = parseWindowsEnvelope(
    readFileSync(
      join(FIXTURES_ROOT, directory, "windows-cim-platform.stdout"),
      "utf8",
    ),
  );
  const display = parseWindowsEnvelope(
    readFileSync(
      join(FIXTURES_ROOT, directory, "windows-cim-display-media.stdout"),
      "utf8",
    ),
  );
  const bom = buildWindowsHbom({
    architecture: "x64",
    sources: {
      baseline: TEST_BASELINE,
      platformEnvelope: platform,
      ...(withDisplay ? { displayMediaEnvelope: display } : {}),
    },
    collectedAt: "2026-10-19T00:00:00.000Z",
    ...extra,
  });
  return { bom, display, sources: parseDisplayMediaEnvelope(display) };
}

/**
 * Read a component property value.
 *
 * @param {object} component Component.
 * @param {string} name Property name.
 * @returns {string | undefined} Property value.
 */
function prop(component, name) {
  return (component?.properties ?? []).find(
    (entry) => entry.name === name,
  )?.value;
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
    (component) =>
      prop(component, "cdx:hbom:hardwareClass") === hardwareClass,
  );
}

test("VM fixtures with display-media captures are present for all three tokens", () => {
  const labels = displayFixtureDirectories();
  for (const expected of [
    "arm64/vm-parallels-elevated",
    "arm64/vm-parallels-std-local",
    "arm64/vm-parallels-std-network",
  ]) {
    assert.ok(labels.includes(expected), `missing ${expected}`);
  }
});

test("elevated VM fixture yields the Parallels display adapter", () => {
  const { bom } = buildFromFixture("arm64/vm-parallels-elevated");
  const adapters = byClass(bom, "display-adapter");
  assert.equal(adapters.length, 1);

  const adapter = adapters[0];
  assert.equal(adapter.name, "Parallels Display Adapter (WDDM)");
  assert.equal(adapter.manufacturer.name, "Parallels");
  assert.equal(adapter.description, "Virtual Adapter");
  assert.equal(prop(adapter, "cdx:hbom:driverVersion"), "20.18.2700.58628");
  assert.equal(prop(adapter, "cdx:hbom:driverDate"), "2026-08-11");
  assert.equal(prop(adapter, "cdx:hbom:resolution"), "1920x1080");
  assert.equal(prop(adapter, "cdx:hbom:refreshRateHz"), "60");
  assert.equal(prop(adapter, "cdx:hbom:bitsPerPixel"), "32");
  assert.equal(prop(adapter, "cdx:hbom:adapterRamBytes"), "2147483648");
  assert.equal(
    prop(adapter, "cdx:hbom:pnpInstanceId"),
    "ACPI\\PRL4005\\redacted",
  );
  // The adapter is enumerated under ACPI, which carries no vendor tokens.
  assert.equal(prop(adapter, "cdx:hbom:vendorId"), undefined);
  assert.equal(prop(adapter, "cdx:hbom:productId"), undefined);
});

test("elevated VM fixture yields the joined Parallels monitor", () => {
  const { bom } = buildFromFixture("arm64/vm-parallels-elevated");
  const displays = byClass(bom, "display");
  assert.equal(displays.length, 1);

  const display = displays[0];
  assert.equal(display.name, "Parallels Vu");
  assert.equal(display.version, "5000");
  assert.equal(display.manufacturer.name, "PRL");
  assert.equal(prop(display, "cdx:hbom:productId"), "5000");
  assert.match(prop(display, "cdx:hbom:displaySerialNumber"), /^redacted/u);
  assert.equal(prop(display, "cdx:hbom:manufactureYear"), "2013");
  assert.equal(prop(display, "cdx:hbom:manufactureWeek"), "6");
  assert.equal(prop(display, "cdx:hbom:physicalSize"), "67 x 38 cm");
  // VideoOutputTechnology 0 is HD15 on this Parallels monitor.
  assert.equal(prop(display, "cdx:hbom:connectionType"), "hd15");
  assert.equal(prop(display, "cdx:hbom:isActive"), "true");
  // The WmiMonitor* InstanceName key joins all three root/wmi classes.
  assert.equal(
    prop(display, "cdx:hbom:pnpInstanceId"),
    "DISPLAY\\PRL5000\\redacted:UID0",
  );
});

test("elevated VM fixture yields one audio controller and one endpoint", () => {
  const { bom } = buildFromFixture("arm64/vm-parallels-elevated");
  const controllers = byClass(bom, "audio-controller");
  const endpoints = byClass(bom, "audio-device");
  assert.equal(controllers.length, 1);
  assert.equal(endpoints.length, 1);

  const controller = controllers[0];
  assert.equal(controller.name, "High Definition Audio Device");
  assert.equal(controller.manufacturer.name, "Microsoft");
  assert.equal(prop(controller, "cdx:hbom:vendorId"), "1ab8");
  assert.equal(prop(controller, "cdx:hbom:productId"), "0001");
  assert.equal(prop(controller, "cdx:hbom:subsystemDeviceId"), "1ab80101");
  assert.match(
    prop(controller, "cdx:hbom:pnpInstanceId"),
    /^HDAUDIO\\FUNC_01&VEN_1AB8&DEV_0001&SUBSYS_1AB80101&REV_1001\\redacted/u,
  );

  assert.equal(endpoints[0].name, "Speakers (High Definition Audio Device)");
  assert.match(prop(endpoints[0], "cdx:hbom:present"), /^true$/u);
  assert.match(
    prop(endpoints[0], "cdx:hbom:pnpInstanceId"),
    /^SWD\\MMDEVAPI\\redacted/u,
  );
});

test("std-local display media matches the elevated output", () => {
  const elevated = buildFromFixture("arm64/vm-parallels-elevated");
  const stdLocal = buildFromFixture("arm64/vm-parallels-std-local");
  assert.equal(stdLocal.display.meta.elevated, false);

  const summarize = (bom) =>
    ["display-adapter", "display", "audio-controller", "audio-device"].flatMap(
      (className) =>
        byClass(bom, className).map(
          (component) =>
            `${className}|${component.name}|${prop(component, "cdx:hbom:driverVersion") ?? ""}|${prop(component, "cdx:hbom:physicalSize") ?? ""}`,
        ),
    );
  assert.deepEqual(summarize(stdLocal.bom), summarize(elevated.bom));

  const diagnostics = stdLocal.bom.properties
    .filter((entry) => entry.name === "cdx:hbom:evidence:commandDiagnostic")
    .map((entry) => JSON.parse(entry.value))
    .filter((entry) => entry.id.startsWith("windows-cim-display-media"));
  assert.deepEqual(diagnostics, []);
});

test("std-network display media is fully denied and collapses to the baseline", () => {
  const denied = buildFromFixture("arm64/vm-parallels-std-network");
  assert.equal(denied.display.meta.elevated, false);
  // root/cimv2 and root/wmi each paid one real denial; the rest short-circuit.
  const shortCircuited = Object.values(denied.display.results).filter(
    (result) => result.shortCircuited === true,
  );
  assert.equal(shortCircuited.length, 4);
  assert.ok(
    Object.values(denied.display.results).every(
      (result) =>
        result.ok === false &&
        result.error?.nativeErrorCode === "AccessDenied",
    ),
  );

  // The collector path would skip the command entirely; a caller passing the
  // denied envelope still gets one summarized diagnostic, not per-class rows.
  const diagnostics = denied.bom.properties
    .filter((entry) => entry.name === "cdx:hbom:evidence:commandDiagnostic")
    .map((entry) => JSON.parse(entry.value))
    .filter((entry) => entry.id.startsWith("windows-cim-display-media"));
  assert.deepEqual(
    diagnostics.map((entry) => [entry.id, entry.issue]),
    [["windows-cim-display-media:network-logon", "permission-denied"]],
  );

  const withoutDisplay = buildFromFixture(
    "arm64/vm-parallels-std-network",
    {},
    false,
  );
  for (const className of [
    "display-adapter",
    "display",
    "audio-controller",
    "audio-device",
    "camera",
  ]) {
    assert.equal(
      byClass(withoutDisplay.bom, className).length,
      0,
      `${className} absent without the display envelope`,
    );
  }
});

test("VideoOutputTechnology maps the D3DKMDT values in both signed and uint32 forms", () => {
  const cases = [
    [-2, "uninitialized"],
    [-1, "other"],
    [0, "hd15"],
    [1, "svideo"],
    [2, "composite-video"],
    [3, "component-video"],
    [4, "dvi"],
    [5, "hdmi"],
    [6, "lvds"],
    [8, "d-jpn"],
    [9, "sdi"],
    [10, "displayport"],
    [11, "displayport-embedded"],
    [12, "udi"],
    [13, "udi-embedded"],
    [14, "sdtv-dongle"],
    [15, "miracast"],
    [16, "indirect-wired"],
    // uint32 spellings of the negative constants.
    [4294967294, "uninitialized"],
    [4294967295, "other"],
    // INTERNAL is 0x80000000, not a bit flag.
    [2147483648, "internal"],
    [-2147483648, "internal"],
  ];
  for (const [code, expected] of cases) {
    assert.equal(windowsVideoOutputTechnologyName(code), expected);
  }
  // Unknown codes pass through raw, never guessed.
  assert.equal(windowsVideoOutputTechnologyName(99), "99");
  assert.equal(windowsVideoOutputTechnologyName(undefined), undefined);
  assert.equal(windowsVideoOutputTechnologyName(null), undefined);
});

test("monitorPnpInstanceId strips the WMI instance suffix", () => {
  assert.equal(
    monitorPnpInstanceId("DISPLAY\\PRL5000\\3&21DE92E8&0&UID0_0"),
    "DISPLAY\\PRL5000\\3&21DE92E8&0&UID0",
  );
  assert.equal(monitorPnpInstanceId(undefined), undefined);
  assert.equal(
    monitorPnpInstanceId("DISPLAY\\PRL5000\\3&21DE92E8&0&UID10"),
    "DISPLAY\\PRL5000\\3&21DE92E8&0&UID10",
  );
});

test("derived: camera mapping from a captured PnP item", () => {
  // No capture host has a camera (C05 brief, "Gap"). The item below is
  // DERIVED by this script from a captured mediaPnp-shaped entry: the USB
  // device is the VM's captured keyboard composite device (VID_203A/PID_FFFB
  // with its hardware/compatible IDs from the selftest fixture); only the
  // ClassGuid is replaced with the documented Camera GUID and the name is
  // invented. Unverified against real hardware.
  const derivedUsbCamera = {
    Name: "Derived USB Camera",
    Manufacturer: "Derived",
    PNPDeviceID: "USB\\VID_203A&PID_FFFB\\redacted:D1.1",
    ClassGuid: CAMERA_CLASS_GUID,
    HardwareID: [
      "USB\\VID_203A&PID_FFFB&REV_0110",
      "USB\\VID_203A&PID_FFFB",
    ],
    CompatibleID: ["USB\\DevClass_00&SubClass_00&Prot_00", "USB\\COMPOSITE"],
    Present: true,
    Status: "OK",
    Service: "usbvideo",
  };
  const derivedVirtualCamera = {
    ...derivedUsbCamera,
    Name: "Derived Virtual Camera",
    PNPDeviceID: "SWD\\PROXIMITY\\redacted:CAM1",
    HardwareID: ["SWD\\PROXIMITY\\CAM"],
  };
  const components = buildCameraComponents(
    { mediaPnp: [derivedUsbCamera, derivedVirtualCamera] },
    {},
  );
  assert.equal(components.length, 2);

  const [usb, virtual] = components;
  assert.equal(prop(usb, "cdx:hbom:vendorId"), "203a");
  assert.equal(prop(usb, "cdx:hbom:productId"), "fffb");
  assert.equal(prop(usb, "cdx:hbom:driver"), "usbvideo");
  assert.equal(prop(usb, "cdx:hbom:present"), "true");
  assert.equal(prop(usb, "cdx:hbom:isVirtual"), undefined);
  assert.equal(usb.name, "Derived USB Camera");
  assert.equal(virtual.name, "Derived Virtual Camera");
  assert.equal(prop(virtual, "cdx:hbom:isVirtual"), "true");
  assert.equal(prop(virtual, "cdx:hbom:vendorId"), undefined);
});

test("default BOM leaks none of the display fixtures' sensitive values", () => {
  for (const directory of displayFixtureDirectories()) {
    const raw = JSON.parse(
      readFileSync(
        join(FIXTURES_ROOT, directory, "windows-cim-display-media.stdout"),
        "utf8",
      ),
    );
    const { bom } = buildFromFixture(directory);
    const serialized = JSON.stringify(bom);
    for (const value of collectSensitiveValues(raw)) {
      assert.ok(
        !serialized.includes(value),
        `${directory}: raw sensitive value leaked into the default BOM`,
      );
    }
  }
});

test("synthetic raw serials and instance segments stay redacted by default", () => {
  // The committed fixtures are already redacted, so the redaction path is
  // proven with synthetic raw values injected into a captured envelope shape
  // (test inputs, not captured data).
  const { display } = buildFromFixture("arm64/vm-parallels-elevated");
  const rawSerial = "CN0X1234567";
  const rawInstance = "DISPLAY\\PRL5000\\4&2A7B04EF&0&UID99999";
  const envelope = {
    ...display,
    results: {
      ...display.results,
      monitorId: {
        ok: true,
        items: [
          {
            ...display.results.monitorId.items[0],
            InstanceName: `${rawInstance}_0`,
            SerialNumberID: encodeUint16Text(rawSerial),
          },
        ],
      },
    },
  };
  const sources = parseDisplayMediaEnvelope(envelope);
  const defaultDisplays = buildDisplayComponents(sources, {});
  assert.equal(
    prop(defaultDisplays[0], "cdx:hbom:displaySerialNumber"),
    "redacted:4567",
  );
  assert.equal(
    prop(defaultDisplays[0], "cdx:hbom:pnpInstanceId"),
    "DISPLAY\\PRL5000\\redacted:9999",
  );
  const serialized = JSON.stringify(defaultDisplays);
  assert.ok(!serialized.includes(rawSerial));
  assert.ok(!serialized.includes(rawInstance));

  const explicit = buildDisplayComponents(sources, {
    includeSensitiveIdentifiers: true,
  });
  assert.equal(prop(explicit[0], "cdx:hbom:displaySerialNumber"), rawSerial);
  assert.equal(
    prop(explicit[0], "cdx:hbom:pnpInstanceId"),
    `${rawInstance}`,
    "raw identifiers are restored, with the WMI suffix still stripped",
  );
});

/**
 * Collect sensitive values from a raw display-media envelope.
 *
 * Decodes WmiMonitorID uint16 text fields, so a captured-but-unredacted
 * serial is checked in its string form.
 *
 * @param {{ results?: Record<string, { items?: object[] }> }} envelope Raw envelope.
 * @returns {string[]} Non-placeholder sensitive values.
 */
function collectSensitiveValues(envelope) {
  const values = [];
  for (const field of DISPLAY_SPEC.sensitiveFields ?? []) {
    const separator = field.indexOf(".");
    const result = envelope.results?.[field.slice(0, separator)] ?? {};
    const name = field.slice(separator + 1);
    for (const item of [...(result.items ?? [])]) {
      const value = item?.[name];
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (Array.isArray(entry) && entry.every((code) => typeof code === "number")) {
          const decoded = cimUint16String(entry);
          if (
            decoded !== undefined &&
            !isPlaceholderIdentity(decoded) &&
            !/^(?:REDACTED|redacted)/u.test(decoded)
          ) {
            values.push(decoded);
          }
          continue;
        }
        if (
          typeof entry === "string" &&
          entry.trim().length > 0 &&
          !isPlaceholderIdentity(entry) &&
          !/^(?:REDACTED|redacted)/u.test(entry)
        ) {
          // PnP IDs are compared by their instance segment only, because the
          // BOM deliberately keeps the device part; segments the redactor
          // already replaced carry nothing to leak.
          const segment = entry.includes("\\") ? entry.split("\\").at(-1) : entry;
          if (!/^(?:REDACTED|redacted)/u.test(segment)) {
            values.push(segment);
          }
        }
      }
    }
  }
  return values.filter((value) => value !== undefined && value.length > 4);
}

/**
 * Encode text as a zero-padded uint16 code array.
 *
 * @param {string} text Text to encode.
 * @returns {number[]} 16-element code array.
 */
function encodeUint16Text(text) {
  const codes = [...text].map((ch) => ch.charCodeAt(0));
  while (codes.length < 16) {
    codes.push(0);
  }
  return codes;
}
