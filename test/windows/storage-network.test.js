import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { isPlaceholderIdentity } from "../../src/common/shape.js";
import { parseWindowsEnvelope } from "../../src/windows/common/cim.js";
import { WINDOWS_COMMANDS } from "../../src/windows/common/commands.js";
import {
  buildNetworkComponents,
  selectHardwareNetAdapters,
} from "../../src/windows/common/network.js";
import { buildWindowsHbom } from "../../src/windows/common/index.js";

const FIXTURES_ROOT = fileURLToPath(
  new URL("../fixtures/windows", import.meta.url),
);

const STORAGE_SPEC = WINDOWS_COMMANDS.find(
  (spec) => spec.id === "windows-cim-storage-network",
);

// Synthetic T0 baseline for fixture-driven tests (test input, not captured).
const TEST_BASELINE = Object.freeze({
  cpuModel: "Baseline CPU",
  cpuCount: 8,
  totalMemoryBytes: 8 * 1024 * 1024 * 1024,
  osRelease: "10.0.26200",
  osName: "Baseline Windows",
});

/**
 * List fixture directories that carry a storage-network capture.
 *
 * @returns {string[]} `<arch>/<label>` paths.
 */
function storageFixtureDirectories() {
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
                "windows-cim-storage-network.stdout",
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
 * @param {boolean} [extra.withStorage] Whether to pass the storage envelope.
 * @returns {{ bom: object, platform: object, storage: object, manifest: object }} Build result.
 */
function buildFromFixture(directory, extra = {}, withStorage = true) {
  const platform = parseWindowsEnvelope(
    readFileSync(
      join(FIXTURES_ROOT, directory, "windows-cim-platform.stdout"),
      "utf8",
    ),
  );
  const storage = parseWindowsEnvelope(
    readFileSync(
      join(FIXTURES_ROOT, directory, "windows-cim-storage-network.stdout"),
      "utf8",
    ),
  );
  const manifest = JSON.parse(
    readFileSync(join(FIXTURES_ROOT, directory, "manifest.json"), "utf8"),
  );
  const bom = buildWindowsHbom({
    architecture: manifest.processArch,
    sources: {
      baseline: TEST_BASELINE,
      platformEnvelope: platform,
      ...(withStorage ? { storageNetworkEnvelope: storage } : {}),
    },
    collectedAt: "2026-10-19T00:00:00.000Z",
    ...extra,
  });
  return { bom, platform, storage, manifest };
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

test("VM fixtures with storage captures are present for all three tokens", () => {
  const labels = storageFixtureDirectories();
  for (const expected of [
    "arm64/vm-parallels-elevated",
    "arm64/vm-parallels-std-local",
    "arm64/vm-parallels-std-network",
  ]) {
    assert.ok(labels.includes(expected), `missing ${expected}`);
  }
});

test("elevated VM fixture yields one SATA SSD storage component", () => {
  const { bom } = buildFromFixture("arm64/vm-parallels-elevated");
  const storage = byClass(bom, "storage");
  assert.equal(storage.length, 1);

  const disk = storage[0];
  assert.equal(disk.name, "harddisk SSD");
  assert.equal(disk.version, "disk0");
  assert.equal(prop(disk, "cdx:hbom:diskNumber"), "0");
  assert.equal(prop(disk, "cdx:hbom:transport"), "SATA");
  assert.equal(prop(disk, "cdx:hbom:mediaType"), "SSD");
  assert.equal(prop(disk, "cdx:hbom:isRotational"), "false");
  assert.equal(prop(disk, "cdx:hbom:blockSize"), "512");
  assert.equal(prop(disk, "cdx:hbom:physicalBlockSize"), "4096");
  assert.equal(prop(disk, "cdx:hbom:healthStatus"), "Healthy");
  assert.equal(prop(disk, "cdx:hbom:operationalStatus"), "OK");
  assert.equal(prop(disk, "cdx:hbom:firmwareVersion"), "F.E0EA0C");
  assert.equal(prop(disk, "cdx:hbom:deviceSerial"), "redacted:0002");
  assert.equal(
    prop(disk, "cdx:hbom:capacityBytes"),
    "274877906944",
    "PhysicalDisk.Size wins over DiskDrive.Size on the join",
  );
  assert.equal(disk.manufacturer, undefined, "generic manufacturer dropped");
});

test("GitHub runner fixtures join two disks each and pick hardware NICs", () => {
  // Runner hardware varies per job; these pins describe the committed capture
  // (windows-capture.yml run 39388777375).
  // windows-2025: two SAS virtual disks (no media type) on the
  // DeviceId = Index join, and a Mellanox VF whose PCI segment 47551 renders
  // as b9bf next to the Hyper-V synthetic adapter.
  const amd64 = buildFromFixture("amd64/windows-2025-gha");
  assert.deepEqual(
    byClass(amd64.bom, "storage").map((disk) => [
      prop(disk, "cdx:hbom:diskNumber"),
      prop(disk, "cdx:hbom:transport"),
      prop(disk, "cdx:hbom:mediaType"),
    ]),
    [
      ["1", "SAS", undefined],
      ["0", "SAS", undefined],
    ],
  );
  const amd64Nics = byClass(amd64.bom, "network-interface");
  assert.deepEqual(amd64Nics.map((nic) => prop(nic, "cdx:hbom:driver")), ["mlx5", "netvsc"]);
  assert.equal(prop(amd64Nics[0], "cdx:hbom:pciAddress"), "b9bf:00:02.0");
  assert.equal(prop(amd64Nics[0], "cdx:hbom:vendorId"), "15b3");

  // windows-11-arm: a SAS virtual disk plus an NVMe SSD,
  // and the Azure MANA adapter, which reports HardwareInterface=true here.
  const arm64 = buildFromFixture("arm64/windows-11-arm-gha");
  const disks = byClass(arm64.bom, "storage");
  const virtualDisk = disks.find((disk) => prop(disk, "cdx:hbom:transport") === "SAS");
  assert.equal(prop(virtualDisk, "cdx:hbom:mediaType"), undefined);
  const nvme = disks.find((disk) => prop(disk, "cdx:hbom:transport") === "NVMe");
  assert.equal(prop(nvme, "cdx:hbom:mediaType"), "SSD");
  const mana = byClass(arm64.bom, "network-interface").find(
    (nic) => prop(nic, "cdx:hbom:driver") === "Mana",
  );
  assert.equal(prop(mana, "cdx:hbom:pciAddress"), "7870:00:00.0");
});

test("elevated VM fixture yields drive-lettered, system and boot volumes", () => {
  const { bom } = buildFromFixture("arm64/vm-parallels-elevated");
  const volumes = byClass(bom, "storage-volume");
  const names = volumes.map((volume) => volume.name).sort();

  // C: (boot), D: (Parallels shared folder, DriveType 5 but drive-lettered),
  // the letterless NTFS data volumes and the letterless FAT32 system volume.
  assert.equal(volumes.length, 5);
  assert.deepEqual(names, ["C:", "D:", "Volume", "Volume", "Volume"]);

  const d = volumes.find((volume) => volume.name === "D:");
  assert.equal(prop(d, "cdx:hbom:mountPoint"), "D:");
  assert.equal(prop(d, "cdx:hbom:fileSystem"), undefined);

  const c = volumes.find((volume) => volume.name === "C:");
  assert.equal(prop(c, "cdx:hbom:mountPoint"), "C:");
  assert.equal(prop(c, "cdx:hbom:fileSystem"), "NTFS");
  assert.equal(prop(c, "cdx:hbom:isBootVolume"), "true");
  assert.equal(prop(c, "cdx:hbom:isSystemVolume"), "false");
  assert.equal(Number(prop(c, "cdx:hbom:capacityBytes")) > 0, true);
  assert.equal(Number(prop(c, "cdx:hbom:freeBytes")) > 0, true);
  assert.match(prop(c, "cdx:hbom:volumeUuid"), /^redacted:/u);

  const system = volumes.find(
    (volume) => prop(volume, "cdx:hbom:isSystemVolume") === "true",
  );
  assert.ok(system, "the letterless system volume is kept");
  assert.equal(prop(system, "cdx:hbom:fileSystem"), "FAT32");
});

test("elevated VM fixture yields the virtio network interface", () => {
  const { bom } = buildFromFixture("arm64/vm-parallels-elevated");
  const interfaces = byClass(bom, "network-interface");
  const wireless = byClass(bom, "wireless-adapter");

  assert.equal(wireless.length, 0);
  assert.equal(interfaces.length, 1);
  const nic = interfaces[0];
  assert.equal(nic.name, "Parallels VirtIO Ethernet Adapter");
  assert.equal(nic.version, "Ethernet");
  assert.equal(prop(nic, "cdx:hbom:interfaceName"), "Ethernet");
  assert.equal(prop(nic, "cdx:hbom:driver"), "netkvm");
  assert.equal(prop(nic, "cdx:hbom:driverVersion"), "100.2.0.0");
  assert.equal(
    prop(nic, "cdx:hbom:driverProvider"),
    "Parallels International GmbH",
  );
  assert.equal(prop(nic, "cdx:hbom:driverDate"), "2025-11-25");
  assert.equal(prop(nic, "cdx:hbom:mtu"), "1500");
  assert.equal(prop(nic, "cdx:hbom:operState"), "up");
  assert.equal(prop(nic, "cdx:hbom:speedMbps"), "10000");
  assert.equal(prop(nic, "cdx:hbom:duplex"), "full");
  assert.equal(prop(nic, "cdx:hbom:ifindex"), "9");
  assert.equal(prop(nic, "cdx:hbom:physicalMedium"), "Unspecified");
  assert.equal(prop(nic, "cdx:hbom:vendorId"), "1af4");
  assert.equal(prop(nic, "cdx:hbom:productId"), "1000");
  assert.equal(prop(nic, "cdx:hbom:subsystemDeviceId"), "0001");
  assert.equal(prop(nic, "cdx:hbom:subsystemVendorId"), "1ab8");
  assert.equal(prop(nic, "cdx:hbom:pciAddress"), "0000:00:05.0");
  assert.match(prop(nic, "cdx:hbom:macAddress"), /^redacted:/u);
});

test("std-local storage and NIC match the elevated output", () => {
  const elevated = buildFromFixture("arm64/vm-parallels-elevated");
  const stdLocal = buildFromFixture("arm64/vm-parallels-std-local");

  // With smphost running, the standard local token gets full
  // MSFT_PhysicalDisk data (see the smp-stopped fixture for the other case);
  // DriverName stays null, so the driver still comes from ServiceName.
  const summarize = (bom) =>
    byClass(bom, "storage")
      .concat(byClass(bom, "network-interface"))
      .map((component) =>
        [
          prop(component, "cdx:hbom:hardwareClass"),
          component.name,
          prop(component, "cdx:hbom:transport"),
          prop(component, "cdx:hbom:driver"),
          prop(component, "cdx:hbom:healthStatus"),
        ].join("|"),
      );
  assert.deepEqual(summarize(stdLocal.bom), summarize(elevated.bom));
  assert.equal(
    byClass(stdLocal.bom, "storage-volume").length,
    byClass(elevated.bom, "storage-volume").length,
  );

  const diagnostics = stdLocal.bom.properties
    .filter((entry) => entry.name === "cdx:hbom:evidence:commandDiagnostic")
    .map((entry) => JSON.parse(entry.value));
  assert.deepEqual(
    diagnostics.filter((entry) => entry.id.startsWith("windows-cim-storage-network")),
    [],
    "no elevated-session diagnostic while PhysicalDisk returns data",
  );
});

test("empty PhysicalDisk under a standard token explains the gap", () => {
  // Captured as hbomstd (local logon) with the Storage Spaces SMP service
  // (smphost) stopped: MSFT_PhysicalDisk is ok with zero instances, and a
  // standard user cannot start the service. With smphost already running the
  // same token gets full data (vm-parallels-std-local).
  const { bom, storage } = buildFromFixture(
    "arm64/vm-parallels-std-local-smp-stopped",
  );
  assert.deepEqual(storage.results.physicalDisk, { ok: true, items: [] });
  assert.equal(storage.meta.elevated, false);

  const diagnostics = bom.properties
    .filter((entry) => entry.name === "cdx:hbom:evidence:commandDiagnostic")
    .map((entry) => JSON.parse(entry.value));
  assert.deepEqual(diagnostics, [
    {
      id: "windows-cim-storage-network:physical-disk",
      issue: "partial-support",
      message: "No disk bus, media or health details: Windows returns them to a standard user only while the Storage Spaces SMP service (smphost) is running, and never to a network logon; an elevated run starts it",
    },
  ]);

  const disk = byClass(bom, "storage")[0];
  assert.equal(disk.name, "harddisk SSD", "DiskDrive is still the base");
  assert.equal(prop(disk, "cdx:hbom:transport"), "IDE");
  assert.equal(prop(disk, "cdx:hbom:blockSize"), "512");
  assert.equal(prop(disk, "cdx:hbom:mediaType"), undefined);
});

test("std-network fixture denies storage and collapses to T0", () => {
  const { bom } = buildFromFixture("arm64/vm-parallels-std-network", {}, false);

  assert.equal(byClass(bom, "storage").length, 0);
  assert.equal(byClass(bom, "storage-volume").length, 0);
  assert.equal(byClass(bom, "network-interface").length, 0);
  const diagnostics = bom.properties
    .filter((entry) => entry.name === "cdx:hbom:evidence:commandDiagnostic")
    .map((entry) => JSON.parse(entry.value));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].id, "windows-cim-platform:network-logon");

  // A caller that passes the denied storage envelope anyway gets one
  // summarized network-logon diagnostic for that command, not per-class rows.
  const withDenied = buildFromFixture("arm64/vm-parallels-std-network");
  const storageDiagnostics = withDenied.bom.properties
    .filter((entry) => entry.name === "cdx:hbom:evidence:commandDiagnostic")
    .map((entry) => JSON.parse(entry.value))
    .filter((entry) => entry.id.startsWith("windows-cim-storage-network"));
  assert.deepEqual(
    storageDiagnostics.map((entry) => entry.id),
    ["windows-cim-storage-network:network-logon"],
  );
});

test("adapter selection explains every exclusion", () => {
  for (const directory of storageFixtureDirectories()) {
    const { storage } = buildFromFixture(directory);
    const items = storage.results.netAdapter?.items ?? [];
    const { selected, excluded } = selectHardwareNetAdapters(items);
    for (const exclusion of excluded) {
      assert.ok(
        exclusion.reason && exclusion.reason.length > 0,
        `${directory}: ${exclusion.item?.Name ?? "?"} dropped without a reason`,
      );
    }
    void selected;
  }

  // Synthetic multi-adapter case (test input, not captured) covering each
  // documented exclusion reason plus a wireless selection.
  const synthetic = [
    { Name: "Wifi", HardwareInterface: true, Virtual: false, NdisPhysicalMedium: 9, EndPointInterface: false },
    { Name: "WanMiniport", HardwareInterface: false },
    { Name: "Hyper-V", HardwareInterface: true, Virtual: true },
    { Name: "BtPan", HardwareInterface: true, Virtual: false, NdisPhysicalMedium: 10, EndPointInterface: false },
    { Name: "Endpoint", HardwareInterface: true, Virtual: false, NdisPhysicalMedium: 0, EndPointInterface: true },
  ];
  const result = selectHardwareNetAdapters(synthetic);
  assert.deepEqual(
    result.selected.map((item) => item.Name),
    ["Wifi"],
  );
  assert.deepEqual(
    result.excluded.map((entry) => entry.reason),
    [
      "HardwareInterface is not true",
      "Virtual adapter",
      "Bluetooth PAN (NdisPhysicalMedium 10)",
      "EndPointInterface",
    ],
  );
});

test("legacy Win32_NetworkAdapter backs the netAdapter failure path", () => {
  const { storage } = buildFromFixture("arm64/vm-parallels-elevated");
  const failed = {
    ...storage,
    results: {
      ...storage.results,
      netAdapter: {
        ok: false,
        error: {
          nativeErrorCode: "InvalidClass",
          statusCode: 5,
          category: "MetadataError",
        },
      },
    },
  };
  const bom = buildWindowsHbom({
    architecture: "x64",
    sources: {
      baseline: TEST_BASELINE,
      platformEnvelope: buildFromFixture("arm64/vm-parallels-elevated")
        .platform,
      storageNetworkEnvelope: failed,
    },
  });

  const interfaces = byClass(bom, "network-interface");
  assert.equal(interfaces.length, 1, "one PhysicalAdapter=true instance");
  const nic = interfaces[0];
  assert.equal(nic.name, "Parallels VirtIO Ethernet Adapter");
  assert.equal(prop(nic, "cdx:hbom:driver"), "netkvm");
  assert.match(prop(nic, "cdx:hbom:macAddress"), /^redacted:/u);
  assert.equal(prop(nic, "cdx:hbom:ifindex"), "9");
  assert.equal(prop(nic, "cdx:hbom:operState"), "up");
  assert.equal(prop(nic, "cdx:hbom:speedMbps"), "10000");
  assert.equal(prop(nic, "cdx:hbom:mtu"), undefined);
});

test("default BOM leaks none of the storage fixtures' sensitive values", () => {
  for (const directory of storageFixtureDirectories()) {
    const raw = JSON.parse(
      readFileSync(
        join(FIXTURES_ROOT, directory, "windows-cim-storage-network.stdout"),
        "utf8",
      ),
    );
    const values = collectSensitiveValues(raw);
    const { bom } = buildFromFixture(directory);
    const serialized = JSON.stringify(bom);
    for (const value of values) {
      assert.ok(
        !serialized.includes(value),
        `${directory}: raw sensitive value leaked into the default BOM`,
      );
    }
    if (values.length > 0) {
      const explicit = buildFromFixture(directory, {
        includeSensitiveIdentifiers: true,
      }).bom;
      assert.equal(explicit.specVersion, "1.7");
    }
  }
});

test("numeric volume serials never appear as identifiers", () => {
  const { bom } = buildFromFixture("arm64/vm-parallels-elevated");
  const serialized = JSON.stringify(bom);
  for (const volume of byClass(bom, "storage-volume")) {
    assert.equal(prop(volume, "cdx:hbom:volumeSerial"), undefined);
  }
  assert.ok(!/"value":"4444444444"/u.test(serialized));
});

/**
 * Collect sensitive values from a raw storage envelope.
 *
 * @param {{ results?: Record<string, { items?: object[] }> }} envelope Raw envelope.
 * @returns {(string | number)[]} Non-placeholder sensitive values.
 */
function collectSensitiveValues(envelope) {
  const values = [];
  for (const field of STORAGE_SPEC.sensitiveFields ?? []) {
    const separator = field.indexOf(".");
    const result = envelope.results?.[field.slice(0, separator)] ?? {};
    const name = field.slice(separator + 1);
    for (const item of result.items ?? []) {
      const value = item?.[name];
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (typeof entry === "number" && Number.isFinite(entry)) {
          if (String(entry).length > 4 && entry !== 4444444444) {
            values.push(entry);
          }
          continue;
        }
        if (
          typeof entry === "string" &&
          entry.trim().length > 0 &&
          !isPlaceholderIdentity(entry) &&
          !/^(?:REDACTED-SERIAL|redacted)/u.test(entry)
        ) {
          values.push(entry);
        }
      }
    }
  }
  return values;
}

test("ServiceName join survives the live instance-ID case difference", () => {
  // Live shape observed on win11-vm: MSFT_NetAdapter lower-cases the
  // instance segment while Win32_NetworkAdapter upper-cases it (not visible
  // in the committed fixtures, whose redacted segments match exactly).
  // Test input derived from those two live spellings.
  const components = buildNetworkComponents(
    [
      {
        Name: "Ethernet",
        InterfaceDescription: "Parallels VirtIO Ethernet Adapter",
        HardwareInterface: true,
        Virtual: false,
        EndPointInterface: false,
        PnPDeviceID: "PCI\\VEN_1AF4&DEV_1000\\3&3259bad1&0&28",
        DriverName: "\\SystemRoot\\System32\\drivers\\netkvm.sys",
      },
    ],
    [],
    { ok: true },
    [
      {
        Name: "Parallels VirtIO Ethernet Adapter",
        PhysicalAdapter: true,
        ServiceName: "netkvm",
        PNPDeviceID: "PCI\\VEN_1AF4&DEV_1000\\3&3259BAD1&0&28",
      },
    ],
    {},
  );
  assert.equal(components.length, 1);
  assert.equal(prop(components[0], "cdx:hbom:driver"), "netkvm");
});
