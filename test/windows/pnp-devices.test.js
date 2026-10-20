import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { parseWindowsEnvelope } from "../../src/windows/common/cim.js";
import {
  buildPnpComponents,
  buildPnpDeviceIndex,
  buildPnpTopologyEdges,
  classifyPnpDevice,
  parsePnpDevicesEnvelope,
  pnpDevicesDiagnostics,
} from "../../src/windows/common/devices.js";
import { buildWindowsHbom } from "../../src/windows/common/index.js";

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

// Setup-class GUIDs from
// https://learn.microsoft.com/en-us/windows-hardware/drivers/install/system-defined-device-setup-classes-available-to-vendors
const BLUETOOTH_CLASS_GUID = "{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}";
const USB_CLASS_GUID = "{36fc9e60-c465-11cf-8056-444553540000}";

/**
 * List fixture directories that carry a pnp-devices capture.
 *
 * @returns {string[]} `<arch>/<label>` paths.
 */
function pnpFixtureDirectories() {
  return readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((arch) =>
      readdirSync(join(FIXTURES_ROOT, arch.name), { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(
              join(FIXTURES_ROOT, arch.name, entry.name, "windows-pnp-devices.stdout"),
            ),
        )
        .map((entry) => `${arch.name}/${entry.name}`),
    );
}

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
 * @param {object} [extra] Extra build options.
 * @returns {{ bom: object, pnp: object }} Build result.
 */
function buildFromFixture(directory, extra = {}) {
  const pnp = readEnvelope(directory, "windows-pnp-devices");
  const bom = buildWindowsHbom({
    architecture: "x64",
    sources: {
      baseline: TEST_BASELINE,
      platformEnvelope: readEnvelope(directory, "windows-cim-platform"),
      storageNetworkEnvelope: readEnvelope(directory, "windows-cim-storage-network"),
      displayMediaEnvelope: readEnvelope(directory, "windows-cim-display-media"),
      pnpDevicesEnvelope: pnp,
    },
    collectedAt: "2026-10-19T00:00:00.000Z",
    ...extra,
  });
  return { bom, pnp };
}

/**
 * Read a component property value.
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
 * Find a component by bom-ref.
 *
 * @param {object} bom BOM.
 * @param {string} ref bom-ref.
 * @returns {object | undefined} Component.
 */
function byRef(bom, ref) {
  return bom.components.find((component) => component["bom-ref"] === ref);
}

test("VM fixtures with pnp-devices captures are present for all three tokens", () => {
  const labels = pnpFixtureDirectories();
  for (const expected of [
    "arm64/vm-parallels-elevated",
    "arm64/vm-parallels-std-local",
    "arm64/vm-parallels-std-network",
  ]) {
    assert.ok(labels.includes(expected), `missing ${expected}`);
  }
});

test("every PnP entity in every fixture is classified, folded, represented or explained", () => {
  for (const directory of pnpFixtureDirectories()) {
    const envelope = readEnvelope(directory, "windows-pnp-devices");
    const sources = parsePnpDevicesEnvelope(envelope);
    const index = buildPnpDeviceIndex(sources);
    const { components, summary } = buildPnpComponents(index, {});

    const emitted = components.length;
    const accounted =
      emitted + summary.folded + summary.represented + summary.notPresent + summary.unclassified.length;
    assert.equal(
      accounted,
      index.size,
      `${directory}: ${index.size} records, ${accounted} accounted for`,
    );
    for (const entry of summary.unclassified) {
      assert.ok(
        entry.reason && entry.reason.length > 0,
        `${directory}: ${entry.id} dropped without a reason`,
      );
      assert.ok(
        !/^unrecognized enumerator/u.test(entry.reason),
        `${directory}: ${entry.reason} for ${entry.id}; classify it or add the enumerator to the table`,
      );
    }
  }
});

test("elevated VM fixture classification snapshot", () => {
  const sources = parsePnpDevicesEnvelope(
    readEnvelope("arm64/vm-parallels-elevated", "windows-pnp-devices"),
  );
  const index = buildPnpDeviceIndex(sources);
  // Redaction collapses instance IDs whose raw segments differ only beyond
  // the last four characters (the four `ACPI\...\<n>` processors, for
  // example), so the fixture index has fewer records than entities; live
  // IDs are unique. Driver rows never add records.
  const uniqueEntityIds = new Set(
    sources.entities.map((entity) => String(entity.PNPDeviceID).toLowerCase()),
  );
  assert.equal(sources.entities.length, 74);
  assert.equal(index.size, uniqueEntityIds.size);
  assert.equal(index.size, 67);

  const { summary } = buildPnpComponents(index, {});
  // Without a represented set, the PCI NIC also surfaces as a pci-device.
  assert.deepEqual(summary.counts, { "usb-controller": 2, "pci-device": 2, "usb-device": 4 });
  assert.equal(summary.folded, 5, "USB interface functions MI_00/MI_01 (keyboard) and MI_00..MI_02 (mouse)");
  assert.equal(summary.notPresent, 0);

  const byEnumerator = {};
  for (const entry of summary.unclassified) {
    byEnumerator[entry.enumerator] = (byEnumerator[entry.enumerator] ?? 0) + 1;
  }
  assert.deepEqual(byEnumerator, {
    ACPI: 10,
    ACPI_HAL: 2,
    DISPLAY: 1,
    HDAUDIO: 1,
    HID: 7,
    HTREE: 1,
    ROOT: 18,
    SCSI: 2,
    STORAGE: 4,
    SWD: 7,
    UEFI: 1,
  });
});

test("elevated VM BOM carries the USB chain, the GPU-monitor link and enriched components", () => {
  const { bom } = buildFromFixture("arm64/vm-parallels-elevated");

  assert.equal(byClass(bom, "usb-controller").length, 2);
  assert.equal(byClass(bom, "usb-device").length, 4, "two root hubs and two composite devices");
  assert.equal(byClass(bom, "pci-device").length, 1, "the NIC function is represented by the network-interface");

  const xhci = byRef(bom, "windows-pnp:pci:ven_1033&dev_0194&subsys_04001ab8&rev_04:1");
  assert.equal(xhci.name, "Renesas USB 3.10 eXtensible Host Controller - 1.10 (Microsoft)");
  assert.equal(prop(xhci, "cdx:hbom:hardwareClass"), "usb-controller");
  assert.equal(prop(xhci, "cdx:hbom:vendorId"), "1033");
  assert.equal(prop(xhci, "cdx:hbom:productId"), "0194");
  assert.equal(prop(xhci, "cdx:hbom:revision"), "04");
  assert.equal(prop(xhci, "cdx:hbom:subsystemVendorId"), "1ab8");
  assert.equal(prop(xhci, "cdx:hbom:subsystemDeviceId"), "0400");
  assert.equal(prop(xhci, "cdx:hbom:pciClassCode"), "0c03");
  assert.equal(prop(xhci, "cdx:hbom:driver"), "USBXHCI");
  assert.equal(prop(xhci, "cdx:hbom:driverVersion"), "10.0.26100.9444");
  assert.equal(prop(xhci, "cdx:hbom:driverProvider"), "Microsoft");
  assert.equal(prop(xhci, "cdx:hbom:driverDate"), "2026-09-03");
  assert.equal(prop(xhci, "cdx:hbom:driverSigned"), "true");
  assert.equal(prop(xhci, "cdx:hbom:driverSigner"), "Microsoft Windows");
  assert.equal(prop(xhci, "cdx:hbom:infName"), "usbxhci.inf");
  assert.equal(prop(xhci, "cdx:hbom:locationPath"), "PCIROOT(0)#PCI(0300)");
  assert.equal(prop(xhci, "cdx:hbom:busReportedName"), "Universal Serial Bus (USB) Controller");
  assert.equal(prop(xhci, "cdx:hbom:problemCode"), undefined);
  assert.match(prop(xhci, "cdx:hbom:pnpInstanceId"), /^PCI\\VEN_1033&DEV_0194&SUBSYS_04001AB8&REV_04\\redacted/u);
  assert.equal(xhci.manufacturer.name, "Generic USB xHCI Host Controller");
  const ehci = byRef(bom, "windows-pnp:pci:ven_8086&dev_265c&subsys_04001ab8&rev_02:1");
  assert.equal(ehci.manufacturer.name, "Intel");
  // In-box class drivers report a parenthesised class placeholder instead of
  // a vendor; it is dropped like "(Standard disk drives)" on disks.
  assert.equal(byRef(bom, "windows-pnp:usb:root_hub30:1").manufacturer, undefined, "'(Standard USB HUBs)'");

  // Composite keyboard: both HID interfaces folded in.
  const keyboard = byRef(bom, "windows-pnp:usb:vid_203a&pid_fffb:1");
  assert.equal(keyboard.name, "USB Composite Device");
  assert.equal(keyboard.manufacturer, undefined, "'(Standard USB Host Controller)' is a class placeholder");
  assert.equal(prop(keyboard, "cdx:hbom:vendorId"), "203a");
  assert.equal(prop(keyboard, "cdx:hbom:productId"), "fffb");
  assert.equal(prop(keyboard, "cdx:hbom:revision"), "0110");
  assert.equal(prop(keyboard, "cdx:hbom:usbInterfaceCount"), "2");
  assert.equal(prop(keyboard, "cdx:hbom:usbInterfaceDrivers"), "0:HidUsb, 1:HidUsb");
  assert.equal(prop(keyboard, "cdx:hbom:busReportedName"), "Virtual Keyboard");
  assert.equal(prop(keyboard, "cdx:hbom:driver"), "usbccgp");
  assert.equal(prop(keyboard, "cdx:hbom:locationPath"), "PCIROOT(0)#PCI(0300)#USBROOT(0)#USB(2)");
  const mouse = byRef(bom, "windows-pnp:usb:vid_203a&pid_fffc:1");
  assert.equal(prop(mouse, "cdx:hbom:usbInterfaceCount"), "3");
  assert.equal(prop(mouse, "cdx:hbom:usbInterfaceDrivers"), "0:HidUsb, 1:HidUsb, 2:HidUsb");
  assert.ok(
    bom.components.every((component) => !/&mi_\d\d:\d+$/u.test(component["bom-ref"] ?? "")),
    "no standalone interface components",
  );

  // Topology: controller depends on root hub, root hub on the composites
  // (parent depends on child, as in the Linux USB graph).
  const deps = new Map(bom.dependencies.map((edge) => [edge.ref, edge.dependsOn]));
  assert.deepEqual(deps.get("windows-pnp:pci:ven_1033&dev_0194&subsys_04001ab8&rev_04:1"), [
    "windows-pnp:usb:root_hub30:1",
  ]);
  assert.deepEqual(deps.get("windows-pnp:usb:root_hub30:1"), [
    "windows-pnp:usb:vid_203a&pid_fffb:1",
    "windows-pnp:usb:vid_203a&pid_fffc:1",
  ]);
  assert.deepEqual(deps.get("windows-pnp:pci:ven_8086&dev_265c&subsys_04001ab8&rev_02:1"), [
    "windows-pnp:usb:root_hub20:1",
  ]);
  // Monitor hangs off the display adapter through DEVPKEY_Device_Parent.
  assert.deepEqual(deps.get("windows-pnp:acpi:prl4005:1"), ["windows-pnp:display:prl5000:1"]);
  // HD Audio controller -> codec -> endpoint.
  assert.deepEqual(deps.get("windows-pnp:pci:ven_8086&dev_293e&subsys_04001ab8&rev_00:1"), [
    "windows-pnp:hdaudio:func_01&ven_1ab8&dev_0001&subsys_1ab80101&rev_1001:1",
  ]);
  assert.deepEqual(deps.get("windows-pnp:hdaudio:func_01&ven_1ab8&dev_0001&subsys_1ab80101&rev_1001:1"), [
    "windows-pnp:swd:mmdevapi:1",
  ]);

  // Components other builders made carry their PnP bom-ref and enrichment.
  const nic = byClass(bom, "network-interface")[0];
  assert.equal(nic["bom-ref"], "windows-pnp:pci:ven_1af4&dev_1000&subsys_00011ab8&rev_00:1");
  assert.equal(prop(nic, "cdx:hbom:driver"), "netkvm", "MSFT_NetAdapter value kept");
  assert.equal(prop(nic, "cdx:hbom:driverVersion"), "100.2.0.0", "MSFT_NetAdapter value kept");
  assert.equal(prop(nic, "cdx:hbom:pciAddress"), "0000:00:05.0", "from NetAdapterHardwareInfo, not PnP");
  assert.equal(prop(nic, "cdx:hbom:driverSigned"), "true");
  assert.equal(prop(nic, "cdx:hbom:driverSigner"), "Microsoft Windows Hardware Compatibility Publisher");
  assert.equal(prop(nic, "cdx:hbom:infName"), "oem0.inf");
  assert.equal(prop(nic, "cdx:hbom:locationPath"), "PCIROOT(0)#PCI(0500)");
  assert.equal(
    nic.properties.filter((entry) => entry.name === "cdx:hbom:driverVersion").length,
    1,
    "enrichment never duplicates a property name",
  );
  const gpu = byClass(bom, "display-adapter")[0];
  assert.equal(gpu["bom-ref"], "windows-pnp:acpi:prl4005:1");
  assert.equal(prop(gpu, "cdx:hbom:driverSigned"), "true");
  const monitor = byClass(bom, "display")[0];
  assert.equal(monitor["bom-ref"], "windows-pnp:display:prl5000:1");
  const disk = byClass(bom, "storage")[0];
  assert.match(disk["bom-ref"], /^windows-pnp:scsi:disk&ven_&prod_harddisk_ssd:1$/u);
  assert.equal(prop(disk, "cdx:hbom:driver"), "disk");
  assert.equal(byClass(bom, "audio-controller")[0]["bom-ref"],
    "windows-pnp:hdaudio:func_01&ven_1ab8&dev_0001&subsys_1ab80101&rev_1001:1");
  assert.equal(byClass(bom, "audio-device")[0]["bom-ref"], "windows-pnp:swd:mmdevapi:1");

  const diagnostics = bom.properties
    .filter((entry) => entry.name === "cdx:hbom:evidence:commandDiagnostic")
    .map((entry) => JSON.parse(entry.value));
  assert.deepEqual(diagnostics, []);
});

test("every dependency edge references an emitted bom-ref in every fixture", () => {
  for (const directory of pnpFixtureDirectories()) {
    const { bom } = buildFromFixture(directory);
    const refs = new Set(bom.components.map((component) => component["bom-ref"]).filter(Boolean));
    assert.equal(refs.size, bom.components.filter((component) => component["bom-ref"]).length, `${directory}: bom-refs are unique`);
    for (const edge of bom.dependencies ?? []) {
      assert.ok(refs.has(edge.ref), `${directory}: dangling ref ${edge.ref}`);
      for (const target of edge.dependsOn) {
        assert.ok(refs.has(target), `${directory}: dangling dependsOn ${target}`);
        assert.notEqual(target, edge.ref);
      }
    }
    // Every emitted PnP component is reachable from a bom-ref prefix.
    for (const ref of refs) {
      assert.match(ref, /^windows-pnp:[^:]+:[^:]*:\d+$/u, `${directory}: ${ref}`);
    }
  }
});

test("std-local PnP output matches elevated; std-network is denied and short-circuited", () => {
  const elevated = buildFromFixture("arm64/vm-parallels-elevated");
  const stdLocal = buildFromFixture("arm64/vm-parallels-std-local");
  assert.equal(stdLocal.pnp.meta.elevated, false);
  const summarize = (bom) =>
    bom.components
      .filter((component) => component["bom-ref"])
      .map((component) => `${component["bom-ref"]}|${prop(component, "cdx:hbom:hardwareClass")}|${prop(component, "cdx:hbom:driverVersion") ?? ""}`)
      .sort();
  assert.deepEqual(summarize(stdLocal.bom), summarize(elevated.bom));
  assert.deepEqual(stdLocal.bom.dependencies, elevated.bom.dependencies);

  const denied = readEnvelope("arm64/vm-parallels-std-network", "windows-pnp-devices");
  assert.equal(denied.results.pnpEntity.ok, false);
  assert.equal(denied.results.pnpEntity.error.nativeErrorCode, "AccessDenied");
  assert.equal(denied.results.pnpProperties.shortCircuited, true, "the pnp-properties kind honours the root/cimv2 denial");
  assert.equal(denied.results.signedDriver.shortCircuited, true);
  const { bom } = buildFromFixture("arm64/vm-parallels-std-network");
  assert.equal(byClass(bom, "usb-device").length, 0);
  assert.deepEqual(bom.dependencies ?? [], []);
  const diagnostics = bom.properties
    .filter((entry) => entry.name === "cdx:hbom:evidence:commandDiagnostic")
    .map((entry) => JSON.parse(entry.value))
    .filter((entry) => entry.id.startsWith("windows-pnp-devices"));
  assert.deepEqual(diagnostics.map((entry) => entry.id), ["windows-pnp-devices:network-logon"]);
});

test("pnp-properties results record the per-device mode and no key errors on the VM", () => {
  const envelope = readEnvelope("arm64/vm-parallels-elevated", "windows-pnp-devices");
  const result = envelope.results.pnpProperties;
  assert.equal(result.kind, "pnp-properties");
  assert.equal(result.mode, "per-device");
  assert.equal(result.deviceCount, 74);
  assert.equal(result.errorCount, 0);
  assert.deepEqual(result.keyErrors, {});
  assert.equal(result.items.length, 74 * 8, "every present device has one row per key");
  // Every entity has a DEVPKEY_Device_Parent row and only the device tree
  // root reports a null parent.
  const parents = result.items.filter((row) => row.KeyName === "DEVPKEY_Device_Parent");
  assert.equal(parents.length, 74);
  assert.deepEqual(
    parents.filter((row) => row.Data === null).map((row) => row.InstanceId.split("\\")[0]),
    ["HTREE"],
  );

  // Synthetic key failures (test input, not captured) become diagnostics.
  const sources = parsePnpDevicesEnvelope({
    results: {
      pnpProperties: {
        ok: true,
        items: [],
        keyErrors: { DEVPKEY_Device_Removable: { nativeErrorCode: "InvalidParameter", statusCode: 4 } },
        errorCount: 2,
      },
    },
  });
  assert.deepEqual(
    pnpDevicesDiagnostics(sources).map((entry) => [entry.id, entry.issue, entry.code]),
    [
      ["windows-pnp-devices:pnpProperties:DEVPKEY_Device_Removable", "partial-support", "InvalidParameter"],
      ["windows-pnp-devices:pnpProperties", "partial-support", undefined],
    ],
  );
});

test("default BOM leaks no raw instance segment, even inside bom-refs", () => {
  // The committed fixtures are already redacted, so synthetic raw segments
  // (test input, not captured) are substituted for every redacted segment,
  // consistently across entities, property rows, parent links and driver
  // rows, and the resulting BOM must not contain any of them.
  const envelope = readEnvelope("arm64/vm-parallels-elevated", "windows-pnp-devices");
  const { envelope: raw, segments } = withSyntheticRawSegments(envelope);
  const display = readEnvelope("arm64/vm-parallels-elevated", "windows-cim-display-media");
  const bom = buildWindowsHbom({
    architecture: "x64",
    sources: {
      baseline: TEST_BASELINE,
      platformEnvelope: readEnvelope("arm64/vm-parallels-elevated", "windows-cim-platform"),
      displayMediaEnvelope: display,
      pnpDevicesEnvelope: raw,
    },
  });
  assert.ok(segments.length > 50);
  const serialized = JSON.stringify(bom);
  for (const segment of segments) {
    assert.ok(!serialized.includes(segment), `raw instance segment ${segment} leaked`);
  }
  // The same chain survives with raw segments in the fixture.
  const deps = new Map(bom.dependencies.map((edge) => [edge.ref, edge.dependsOn]));
  assert.deepEqual(deps.get("windows-pnp:usb:root_hub30:1"), [
    "windows-pnp:usb:vid_203a&pid_fffb:1",
    "windows-pnp:usb:vid_203a&pid_fffc:1",
  ]);

  // includeSensitiveIdentifiers restores raw IDs in pnpInstanceId only.
  const explicit = buildWindowsHbom({
    architecture: "x64",
    sources: { baseline: TEST_BASELINE, pnpDevicesEnvelope: raw },
    includeSensitiveIdentifiers: true,
  });
  const keyboard = byRef(explicit, "windows-pnp:usb:vid_203a&pid_fffb:1");
  assert.ok(keyboard, "bom-ref is stable regardless of the identifier policy");
  assert.match(prop(keyboard, "cdx:hbom:pnpInstanceId"), /\\RAW\d+SEG$/u);
  for (const component of explicit.components) {
    assert.ok(!/RAW\d+SEG/u.test(component["bom-ref"] ?? ""), "raw segment inside a bom-ref");
  }
  for (const edge of explicit.dependencies) {
    assert.ok(!/RAW\d+SEG/u.test(JSON.stringify(edge)));
  }
});

test("derived: Bluetooth radio and devices from documented BTHENUM formats", () => {
  // No capture host has Bluetooth (C06 brief). These items are DERIVED by
  // this script: the radio reuses the captured VM USB composite device's
  // shape with its ClassGuid replaced by the documented Bluetooth class GUID,
  // and the remote devices use the device ID formats from
  // https://learn.microsoft.com/en-us/windows-hardware/drivers/bluetooth/installing-a-bluetooth-device
  // with the documented example service GUID. The 12-hex address tokens and
  // the instance segments are invented test input, not captured. Unverified
  // against real hardware.
  const radioId = "USB\\VID_203A&PID_FFFB\\RAWRADIOSERIAL";
  const deviceId = "BTHENUM\\{00001124-0000-1000-8000-00805F9B34FB}_VID&12345678_PID&abcd\\7&1a2b3c4d&0&04E52FEA9B1F_C00000000";
  const leId = "BTHLE\\DEV_04E52FEA9B1F\\8&2ea2c7d6&0&04E52FEA9B1F";
  const envelope = {
    results: {
      pnpEntity: {
        ok: true,
        items: [
          { Name: "Derived Bluetooth Radio", Manufacturer: "Derived", PNPDeviceID: radioId, ClassGuid: BLUETOOTH_CLASS_GUID, HardwareID: ["USB\\VID_203A&PID_FFFB&REV_0110", "USB\\VID_203A&PID_FFFB"], Present: true, Service: "BTHUSB", ConfigManagerErrorCode: 0 },
          { Name: "Derived Bluetooth Device", PNPDeviceID: deviceId, ClassGuid: BLUETOOTH_CLASS_GUID, HardwareID: ["BTHENUM\\{00001124-0000-1000-8000-00805F9B34FB}_VID&12345678_PID&abcd"], Present: true, Service: "BTHENUM", ConfigManagerErrorCode: 0 },
          { Name: "Derived LE Device", PNPDeviceID: leId, ClassGuid: BLUETOOTH_CLASS_GUID, HardwareID: ["BTHLE\\DEV_04E52FEA9B1F"], Present: true, Service: "BthLEEnum", ConfigManagerErrorCode: 22 },
          // A USB-class root hub keeps the radio's parent chain realistic.
          { Name: "USB Root Hub (USB 3.0)", PNPDeviceID: "USB\\ROOT_HUB30\\RAWHUB", ClassGuid: USB_CLASS_GUID, Present: true, Service: "USBHUB3", ConfigManagerErrorCode: 0 },
        ],
      },
      pnpProperties: {
        ok: true,
        kind: "pnp-properties",
        items: [
          { InstanceId: radioId, KeyName: "DEVPKEY_Device_Parent", Type: 18, Data: "USB\\ROOT_HUB30\\RAWHUB" },
          { InstanceId: deviceId, KeyName: "DEVPKEY_Device_Parent", Type: 18, Data: radioId },
          { InstanceId: leId, KeyName: "DEVPKEY_Device_Parent", Type: 18, Data: radioId },
        ],
        keyErrors: {},
      },
      signedDriver: { ok: true, items: [] },
    },
  };
  const bom = buildWindowsHbom({
    architecture: "x64",
    sources: { baseline: TEST_BASELINE, pnpDevicesEnvelope: envelope },
  });
  const controllers = byClass(bom, "bluetooth-controller");
  const devices = byClass(bom, "bluetooth-device");
  assert.equal(controllers.length, 1);
  assert.equal(devices.length, 2);
  assert.equal(prop(controllers[0], "cdx:hbom:vendorId"), "203a");
  assert.equal(prop(controllers[0], "cdx:hbom:driver"), "BTHUSB");

  const classic = devices.find((component) => component.name === "Derived Bluetooth Device");
  assert.equal(prop(classic, "cdx:hbom:address"), "redacted:b:1f", "remote address is a MAC and stays redacted (last four characters of the colon form)");
  assert.match(prop(classic, "cdx:hbom:pnpInstanceId"), /^BTHENUM\\\{00001124-0000-1000-8000-00805F9B34FB\}_VID&12345678_PID&abcd\\redacted/u);
  const le = devices.find((component) => component.name === "Derived LE Device");
  assert.equal(prop(le, "cdx:hbom:problemCode"), "22", "Device Manager code 22: disabled");
  assert.match(prop(le, "cdx:hbom:pnpInstanceId"), /^BTHLE\\DEV_redacted:9B1F\\redacted/u);

  const serialized = JSON.stringify(bom);
  assert.ok(!serialized.includes("04E52FEA9B1F"), "raw Bluetooth address leaked");
  assert.ok(!/04:e5:2f:ea:9b:1f/u.test(serialized));
  assert.ok(!serialized.includes("RAWRADIOSERIAL"));

  // Radio depends on its devices; the hub depends on the radio.
  const deps = new Map(bom.dependencies.map((edge) => [edge.ref, edge.dependsOn]));
  assert.deepEqual(deps.get(controllers[0]["bom-ref"]).sort(), devices.map((d) => d["bom-ref"]).sort());
  assert.deepEqual(deps.get("windows-pnp:usb:root_hub30:1"), [controllers[0]["bom-ref"]]);

  const explicit = buildWindowsHbom({
    architecture: "x64",
    sources: { baseline: TEST_BASELINE, pnpDevicesEnvelope: envelope },
    includeSensitiveIdentifiers: true,
  });
  assert.equal(prop(byClass(explicit, "bluetooth-device")[0], "cdx:hbom:address"), "04:e5:2f:ea:9b:1f");
});

test("hardware IDs echoing the instance segment are redacted (Hyper-V VMBus shape)", () => {
  // Shape from the GitHub-runner captures (F01): VMBus devices list their own
  // instance GUID as a hardware ID. The GUID below is synthetic test input.
  const guid = "{12345678-ABCD-4EF0-9876-FEDCBA987654}";
  const envelope = {
    results: {
      pnpEntity: {
        ok: true,
        items: [
          {
            Name: "Derived VMBus Device",
            PNPDeviceID: `PCI\\VEN_1414&DEV_00BA&SUBSYS_00B91414&REV_00\\${guid}`,
            ClassGuid: "{4d36e971-e325-11ce-bfc1-08002be10318}",
            HardwareID: [`PCI\\VEN_1414&DEV_00BA&SUBSYS_00B91414&REV_00`, `VMBUS\\${guid}`],
            CompatibleID: [`VMBUS\\${guid}`],
            Present: true,
            ConfigManagerErrorCode: 0,
          },
        ],
      },
      pnpProperties: { ok: true, kind: "pnp-properties", items: [], keyErrors: {} },
      signedDriver: { ok: true, items: [] },
    },
  };
  const bom = buildWindowsHbom({
    architecture: "x64",
    sources: { baseline: TEST_BASELINE, pnpDevicesEnvelope: envelope },
  });
  const device = byClass(bom, "pci-device")[0];
  assert.ok(device);
  assert.ok(!JSON.stringify(bom).includes(guid.slice(1, -1)), "echoed instance GUID leaked");
  assert.match(prop(device, "cdx:hbom:hardwareIds"), /VMBUS\\redacted:654\}$/u);
  assert.match(prop(device, "cdx:hbom:compatibleIds"), /^VMBUS\\redacted/u);
});

test("classifyPnpDevice explains GitHub-runner enumerators", () => {
  // Enumerators seen only on the Hyper-V runners (selftest pnpIds fixtures).
  const index = new Map();
  for (const [id, classGuid] of [
    ["VMBUS\\{F8615163-DF3E-46C5-913F-F2D2F965ED0E}\\redacted:0001", "{4d36e972-e325-11ce-bfc1-08002be10318}"],
    ["UMB\\UMB\\redacted:0002", "{4d36e97d-e325-11ce-bfc1-08002be10318}"],
    ["MANA_BUS\\VEN_1414&ROLE_004C\\redacted:0003", "{4d36e972-e325-11ce-bfc1-08002be10318}"],
    ["TS_USB_HUB_ENUMERATOR\\UMB\\redacted:0004", "{4d36e97d-e325-11ce-bfc1-08002be10318}"],
  ]) {
    const sources = parsePnpDevicesEnvelope({
      results: { pnpEntity: { ok: true, items: [{ PNPDeviceID: id, ClassGuid: classGuid, Present: true }] } },
    });
    const single = buildPnpDeviceIndex(sources);
    const record = [...single.values()][0];
    const decision = classifyPnpDevice(record, single);
    assert.equal(decision.hardwareClass, undefined, id);
    assert.match(decision.reason, /VMBus|UMBus|MANA|Remote Desktop/u, id);
    index.set(record.key, record);
  }
});

/**
 * Replace every redacted instance segment in a fixture envelope with a unique
 * synthetic raw segment, consistently across all rows.
 *
 * @param {object} envelope Parsed (redacted) envelope.
 * @returns {{ envelope: object, segments: string[] }} Modified copy and segments.
 */
function withSyntheticRawSegments(envelope) {
  const mapping = new Map();
  const segments = [];
  const rewrite = (value) => {
    if (typeof value !== "string") {
      return value;
    }
    const parts = value.split("\\");
    if (parts.length < 3 || !/^redacted/u.test(parts.at(-1))) {
      return value;
    }
    const key = value.toLowerCase();
    if (!mapping.has(key)) {
      const segment = `RAW${mapping.size + 1}SEG`;
      mapping.set(key, segment);
      segments.push(segment);
    }
    parts[parts.length - 1] = mapping.get(key);
    return parts.join("\\");
  };
  const copy = JSON.parse(JSON.stringify(envelope));
  for (const item of copy.results.pnpEntity.items) {
    item.PNPDeviceID = rewrite(item.PNPDeviceID);
  }
  for (const row of copy.results.pnpProperties.items) {
    row.InstanceId = rewrite(row.InstanceId);
    if (row.KeyName === "DEVPKEY_Device_Parent") {
      row.Data = rewrite(row.Data);
    }
  }
  for (const driver of copy.results.signedDriver.items) {
    driver.DeviceID = rewrite(driver.DeviceID);
  }
  return { envelope: copy, segments };
}
