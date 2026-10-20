import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { toEvidenceCommand } from "../../src/common/evidence.js";
import { isPlaceholderIdentity } from "../../src/common/shape.js";
import {
  SMBIOS_CHASSIS_TYPES,
  SMBIOS_MEMORY_FORM_FACTORS,
  SMBIOS_MEMORY_TYPES,
  lookupSmbiosName,
} from "../../src/common/smbios.js";
import { parseWindowsEnvelope } from "../../src/windows/common/cim.js";
import { WINDOWS_COMMANDS } from "../../src/windows/common/commands.js";
import {
  WINDOWS_MEMORY_ERROR_CORRECTIONS,
  WINDOWS_MEMORY_FORM_FACTORS,
  WINDOWS_PC_SYSTEM_TYPES_EX,
  WINDOWS_PROCESSOR_ARCHITECTURES,
  windowsEnumName,
} from "../../src/windows/common/enums.js";
import {
  buildWindowsHbom,
  detectWindowsArchitecture,
  parsePlatformEnvelope,
} from "../../src/windows/common/index.js";

const FIXTURES_ROOT = fileURLToPath(
  new URL("../fixtures/windows", import.meta.url),
);

const PLATFORM_SPEC = WINDOWS_COMMANDS.find(
  (spec) => spec.id === "windows-cim-platform",
);

// Synthetic T0 baseline for fixture-driven tests. Unlike the captured
// envelopes this is test input defined here, not host data.
const TEST_BASELINE = Object.freeze({
  cpuModel: "Baseline CPU",
  cpuCount: 8,
  totalMemoryBytes: 8 * 1024 * 1024 * 1024,
  osRelease: "10.0.26200",
  osName: "Baseline Windows",
});

/**
 * List committed fixture directories under test/fixtures/windows.
 *
 * @returns {string[]} `<arch>/<label>` paths.
 */
function fixtureDirectories() {
  return readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((arch) =>
      readdirSync(join(FIXTURES_ROOT, arch.name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${arch.name}/${entry.name}`),
    );
}

/**
 * Load a fixture's parsed platform envelope.
 *
 * @param {string} directory Fixture directory.
 * @returns {{ envelope: object, manifest: object, raw: string }} Fixture data.
 */
function loadPlatformFixture(directory) {
  const raw = readFileSync(
    join(FIXTURES_ROOT, directory, "windows-cim-platform.stdout"),
    "utf8",
  );
  const manifest = JSON.parse(
    readFileSync(join(FIXTURES_ROOT, directory, "manifest.json"), "utf8"),
  );
  return {
    envelope: parseWindowsEnvelope(raw),
    manifest,
    raw,
  };
}

/**
 * Build a BOM from a fixture envelope.
 *
 * The fallback architecture is the fixture's captured process architecture
 * (the VM captures ran under emulated x64 Node), matching a live collection.
 *
 * @param {string} directory Fixture directory.
 * @param {object} [extra] Extra build options.
 * @returns {{ bom: object, envelope: object, manifest: object, raw: string }} Build result.
 */
function buildFromFixture(directory, extra = {}) {
  const { envelope, manifest, raw } = loadPlatformFixture(directory);
  const bom = buildWindowsHbom({
    architecture: manifest.processArch,
    sources: { platformEnvelope: envelope, baseline: TEST_BASELINE },
    collectedAt: "2026-10-19T00:00:00.000Z",
    ...extra,
  });
  return { bom, envelope, manifest, raw };
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

for (const directory of fixtureDirectories()) {
  test(`windows platform BOM builds from ${directory}`, () => {
    const { bom } = buildFromFixture(directory);

    assert.equal(bom.bomFormat, "CycloneDX");
    assert.equal(bom.specVersion, "1.7");
    assert.ok(bom.serialNumber.startsWith("urn:uuid:"));
    assert.ok(bom.metadata.component, "metadata.component is present");
    assert.equal(bom.metadata.component.type, "device");
    assert.equal(
      prop(bom.metadata.component, "cdx:hbom:platform"),
      "windows",
    );
    for (const component of bom.components) {
      assert.ok(
        prop(component, "cdx:hbom:hardwareClass"),
        `${component.name} carries cdx:hbom:hardwareClass`,
      );
    }
  });
}

test("VM fixture detects arm64 under an emulated x64 process", () => {
  const { bom, envelope } = buildFromFixture("arm64/vm-parallels-elevated");
  const root = (name) => prop({ properties: bom.properties }, name);

  assert.equal(root("cdx:hbom:targetArchitecture"), "arm64");
  assert.equal(root("cdx:hbom:architectureSource"), "Win32_Processor");
  assert.equal(root("cdx:hbom:collectorProcessArchitecture"), "amd64");
  assert.equal(root("cdx:hbom:collectorProfile"), "windows-arm64-v1");
  assert.equal(root("cdx:hbom:osName"), "Microsoft Windows 11 Pro");
  assert.equal(root("cdx:hbom:osVersion"), "10.0.26200");
  assert.equal(root("cdx:hbom:evidence:powershellVersion"), envelope.meta.psVersion);
  assert.equal(root("cdx:hbom:evidence:languageMode"), "FullLanguage");
  assert.equal(root("cdx:hbom:evidence:elevated"), "true");
});

test("VM fixture host metadata matches the captured envelope", () => {
  const { bom } = buildFromFixture("arm64/vm-parallels-elevated");
  const host = bom.metadata.component;
  const computerSystem =
    bom.components && loadPlatformFixture("arm64/vm-parallels-elevated");

  assert.equal(host.name, "Parallels ARM Virtual Machine");
  assert.equal(host.version, "0.1");
  assert.equal(
    host.manufacturer.name,
    "Parallels International GmbH.",
  );
  assert.equal(prop(host, "cdx:hbom:chip"), "Apple Silicon");
  assert.equal(prop(host, "cdx:hbom:memory"), "16 GB");
  assert.equal(prop(host, "cdx:hbom:modelNumber"), "Parallels_ARM_VM");
  assert.equal(prop(host, "cdx:hbom:systemFamily"), "Parallels VM");
  assert.equal(prop(host, "cdx:hbom:pcSystemType"), "slate");
  assert.equal(prop(host, "cdx:hbom:hypervisorPresent"), "true");
  assert.equal(prop(host, "cdx:hbom:smbiosVersion"), "3.6");
  assert.equal(prop(host, "cdx:hbom:firmwareDate"), "2026-08-11");
  assert.ok(computerSystem, "envelope readable");
});

test("VM fixture groups four single-core processor instances", () => {
  const { bom } = buildFromFixture("arm64/vm-parallels-elevated");
  const processors = byClass(bom, "processor");

  assert.equal(processors.length, 1);
  const processor = processors[0];
  assert.equal(processor.name, "Apple Silicon");
  assert.equal(prop(processor, "cdx:hbom:architecture"), "arm64");
  assert.equal(prop(processor, "cdx:hbom:coreCount"), "4");
  assert.equal(prop(processor, "cdx:hbom:logicalCpuCount"), "4");
  assert.equal(prop(processor, "cdx:hbom:socketCount"), "4");
  assert.equal(prop(processor, "cdx:hbom:cpuFamily"), "257");
  assert.equal(prop(processor, "cdx:hbom:maxClockMHz"), "3072");
  assert.equal(prop(processor, "cdx:hbom:currentClockMHz"), "3072");
  assert.equal(prop(processor, "cdx:hbom:l2CacheKiB"), "16384");
  assert.equal(
    prop(processor, "cdx:hbom:l3CacheKiB"),
    undefined,
    "zero L3 cache is omitted",
  );
  assert.equal(prop(processor, "cdx:hbom:socketDesignation"), "CPU");
  assert.equal(prop(processor, "cdx:hbom:vendorId"), undefined);
});

test("VM fixture memory matches the single DIMM", () => {
  const { bom } = buildFromFixture("arm64/vm-parallels-elevated");
  const memories = byClass(bom, "memory");
  const modules = byClass(bom, "memory-module");

  assert.equal(memories.length, 1);
  assert.equal(modules.length, 1);
  assert.equal(prop(memories[0], "cdx:hbom:sizeBytes"), "17179869184");
  assert.equal(prop(memories[0], "cdx:hbom:size"), "16 GB");
  assert.equal(prop(memories[0], "cdx:hbom:visibleMemoryBytes"), "17173250048");
  assert.equal(prop(memories[0], "cdx:hbom:memoryModuleCount"), "1");
  assert.equal(prop(memories[0], "cdx:hbom:maxCapacityBytes"), "17179869184");
  assert.equal(prop(memories[0], "cdx:hbom:memoryErrorCorrection"), "None");

  assert.equal(modules[0].name, "Physical Memory 0");
  assert.equal(prop(modules[0], "cdx:hbom:capacityBytes"), "17179869184");
  assert.equal(prop(modules[0], "cdx:hbom:memoryType"), "DRAM");
  assert.equal(prop(modules[0], "cdx:hbom:formFactor"), "DIMM");
  assert.equal(
    prop(modules[0], "cdx:hbom:configuredSpeedMTs"),
    undefined,
    "zero ConfiguredClockSpeed is omitted",
  );
  assert.equal(
    prop(modules[0], "cdx:hbom:configuredVoltageMv"),
    undefined,
    "zero ConfiguredVoltage is omitted",
  );
});

test("VM fixture firmware, board and unknown chassis", () => {
  const { bom } = buildFromFixture("arm64/vm-parallels-elevated");

  const firmwares = byClass(bom, "firmware");
  assert.equal(firmwares.length, 1);
  assert.equal(firmwares[0].type, "firmware");
  assert.equal(firmwares[0].name, "27.0.0 (58628)");
  assert.equal(prop(firmwares[0], "cdx:hbom:firmwareDate"), "2026-08-11");
  assert.equal(prop(firmwares[0], "cdx:hbom:biosRevision"), "0.1");
  assert.equal(
    prop(firmwares[0], "cdx:hbom:embeddedControllerVersion"),
    undefined,
    "embedded controller 255.255 is omitted",
  );
  assert.equal(prop(firmwares[0], "cdx:hbom:smbiosVersion"), "3.6");

  assert.equal(byClass(bom, "board").length, 1);
  assert.equal(byClass(bom, "board")[0].name, "Parallels ARM Virtual Platform");

  assert.equal(
    byClass(bom, "chassis").length,
    0,
    "ChassisTypes [2] (Unknown) emits no chassis component",
  );
});

test("amd64 GHA fixture collapses one multi-core processor instance", () => {
  const { bom, manifest } = buildFromFixture("amd64/windows-2025-gha");
  const processors = byClass(bom, "processor");
  const modules = byClass(bom, "memory-module");

  assert.equal(manifest.processArch, "x64");
  assert.equal(processors.length, 1);
  assert.equal(
    processors[0].name,
    "AMD EPYC 7763 64-Core Processor",
    "trailing spaces are trimmed",
  );
  assert.equal(prop(processors[0], "cdx:hbom:architecture"), "amd64");
  assert.equal(prop(processors[0], "cdx:hbom:coreCount"), "2");
  assert.equal(prop(processors[0], "cdx:hbom:logicalCpuCount"), "4");
  assert.equal(prop(processors[0], "cdx:hbom:socketCount"), "1");
  assert.equal(prop(processors[0], "cdx:hbom:vendorId"), "AuthenticAMD");
  assert.equal(
    prop(processors[0], "cdx:hbom:socketDesignation"),
    undefined,
    "the None socket designation is dropped",
  );

  assert.equal(modules.length, 2);
  assert.equal(modules[0].name, "M0001");
  assert.equal(prop(modules[0], "cdx:hbom:capacityBytes"), "1073741824");
  assert.equal(
    prop(modules[0], "cdx:hbom:bankLabel"),
    undefined,
    "the None bank label is dropped",
  );
  assert.equal(
    prop(modules[0], "cdx:hbom:serialNumber"),
    undefined,
    "the None module serial is dropped, not redacted",
  );
  // The runner reports SMBIOSMemoryType 2 and FormFactor 0, both `Unknown`.
  assert.equal(prop(modules[0], "cdx:hbom:memoryType"), undefined);
  assert.equal(prop(modules[0], "cdx:hbom:formFactor"), undefined);

  const host = bom.metadata.component;
  assert.equal(
    prop(host, "cdx:hbom:modelNumber"),
    undefined,
    "the None SKU is dropped",
  );
  assert.equal(prop(host, "cdx:hbom:chassisType"), "desktop");
  assert.equal(prop(host, "cdx:hbom:pcSystemType"), "desktop");
  assert.equal(prop(host, "cdx:hbom:firmwareDate"), "2026-04-22");

  const chassis = byClass(bom, "chassis");
  assert.equal(chassis.length, 1);
  assert.equal(chassis[0].name, "desktop");
  assert.equal(prop(chassis[0], "cdx:hbom:assetTag"), "redacted:0004");
});

test("evidence properties carry a script digest, not the PowerShell script", () => {
  const { bom } = buildFromFixture("arm64/vm-parallels-elevated", {
    executedCommands: [toEvidenceCommand(PLATFORM_SPEC)],
  });
  const evidence = (bom.properties ?? [])
    .filter((property) => property.name === "cdx:hbom:evidence:command")
    .map((property) => property.value);

  assert.equal(evidence.length, 1);
  assert.match(
    evidence[0],
    /^windows-cim-platform\|platform\|.+powershell\.exe -Command windows-cim-platform script sha256:[0-9a-f]{12}$/u,
  );
  assert.equal(evidence[0].includes("ConvertTo-Json"), false);
});

test("arm64 GHA fixture reports Cobalt 100 with four cores", () => {
  const { bom } = buildFromFixture("arm64/windows-11-arm-gha");
  const processor = byClass(bom, "processor")[0];

  assert.equal(processor.name, "Cobalt 100");
  assert.equal(prop(processor, "cdx:hbom:coreCount"), "4");
  assert.equal(prop(processor, "cdx:hbom:logicalCpuCount"), "4");
  assert.equal(prop(processor, "cdx:hbom:socketCount"), "1");
  assert.equal(prop(bom.metadata.component, "cdx:hbom:architecture"), "arm64");
});

test("std-local fixture matches the elevated platform data", () => {
  const elevated = buildFromFixture("arm64/vm-parallels-elevated");
  const stdLocal = buildFromFixture("arm64/vm-parallels-std-local");

  assert.equal(
    prop(stdLocal.bom.metadata.component, "cdx:hbom:modelNumber"),
    prop(elevated.bom.metadata.component, "cdx:hbom:modelNumber"),
  );
  assert.equal(
    prop(stdLocal.bom.metadata.component, "cdx:hbom:serialNumber"),
    "redacted:0001",
  );
  assert.equal(stdLocal.bom.components.length, elevated.bom.components.length);
  assert.equal(
    prop({ properties: stdLocal.bom.properties }, "cdx:hbom:evidence:elevated"),
    "false",
  );
});

test("std-network fixture collapses to one network-logon diagnostic", () => {
  const { bom } = buildFromFixture("arm64/vm-parallels-std-network");
  const diagnostics = bom.properties
    .filter((entry) => entry.name === "cdx:hbom:evidence:commandDiagnostic")
    .map((entry) => JSON.parse(entry.value));

  assert.equal(diagnostics.length, 1);
  assert.equal(
    diagnostics[0].id,
    "windows-cim-platform:network-logon",
  );
  assert.equal(diagnostics[0].issue, "permission-denied");
  assert.match(
    diagnostics[0].privilegeHint,
    /network logon/u,
    "carries the network-logon hint",
  );

  const root = (name) => prop({ properties: bom.properties }, name);
  assert.equal(root("cdx:hbom:architectureSource"), "process");
  assert.equal(byClass(bom, "memory-module").length, 0);
  assert.equal(byClass(bom, "memory").length, 1, "memory falls back to T0");
  assert.equal(
    prop(byClass(bom, "memory")[0], "cdx:hbom:sizeBytes"),
    String(TEST_BASELINE.totalMemoryBytes),
  );
});

test("default BOM leaks none of the fixtures' sensitive values", () => {
  for (const directory of fixtureDirectories()) {
    const { raw, manifest } = loadPlatformFixture(directory);
    const envelope = JSON.parse(raw);

    const sensitiveValues = collectSensitiveValues(envelope);
    const hasData = Object.values(envelope.results ?? {}).some(
      (result) => result?.ok === true,
    );
    assert.ok(
      !hasData || sensitiveValues.length > 0,
      `${directory} exposes at least one sensitive field value`,
    );

    const { bom } = buildFromFixture(directory);
    const serialized = JSON.stringify(bom);
    for (const value of sensitiveValues) {
      assert.ok(
        !serialized.includes(value),
        `${directory}: raw sensitive value ${value} leaked into the default BOM`,
      );
    }

    const explicit = buildFromFixture(directory, {
      includeSensitiveIdentifiers: true,
    }).bom;
    assert.equal(explicit.specVersion, "1.7");
    assert.equal(
      prop(explicit.metadata.component, "cdx:hbom:identifierPolicy"),
      "raw-identifiers-enabled",
    );
    void manifest;
  }
});

test("no fixture placeholder value is emitted verbatim", () => {
  const { bom } = buildFromFixture("amd64/windows-2025-gha");
  // `None` may survive only as the documented MemoryErrorCorrection enum
  // name; every placeholder identity string the fixture carries must be gone.
  const noneProperties = [];
  for (const component of [
    bom.metadata.component,
    ...bom.components,
  ]) {
    for (const entry of component?.properties ?? []) {
      if (entry.value === "None") {
        noneProperties.push(entry.name);
      }
    }
  }
  assert.deepEqual(noneProperties, ["cdx:hbom:memoryErrorCorrection"]);
});

test("T0-only build still yields a valid BOM with processor and memory", () => {
  const bom = buildWindowsHbom({
    architecture: "amd64",
    sources: { baseline: TEST_BASELINE },
    collectedAt: "2026-10-19T00:00:00.000Z",
  });

  assert.equal(bom.specVersion, "1.7");
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(
    prop({ properties: bom.properties }, "cdx:hbom:architectureSource"),
    "process",
  );
  assert.equal(
    prop({ properties: bom.properties }, "cdx:hbom:osName"),
    "Baseline Windows",
  );

  const processor = byClass(bom, "processor")[0];
  assert.equal(processor.name, "Baseline CPU");
  assert.equal(prop(processor, "cdx:hbom:logicalCpuCount"), "8");

  const memory = byClass(bom, "memory")[0];
  assert.equal(
    prop(memory, "cdx:hbom:sizeBytes"),
    String(TEST_BASELINE.totalMemoryBytes),
  );
});

test("empty sources still build a valid document", () => {
  const bom = buildWindowsHbom({ architecture: "arm64" });
  assert.equal(bom.specVersion, "1.7");
  assert.equal(bom.components.length, 1);
  assert.equal(
    prop(bom.components[0], "cdx:hbom:hardwareClass"),
    "processor",
  );
});

test("architecture detection throws for unsupported processors", () => {
  assert.throws(
    () => detectWindowsArchitecture([{ Architecture: 0 }], "amd64"),
    /Unsupported HBOM target: win32\/x86/u,
  );
  assert.throws(
    () => detectWindowsArchitecture([{ Architecture: 5 }], "amd64"),
    /Unsupported HBOM target: win32\/arm/u,
  );
  assert.deepEqual(detectWindowsArchitecture([], "arm64"), {
    architecture: "arm64",
    source: "process",
  });
  assert.deepEqual(detectWindowsArchitecture([{ Architecture: 9 }], "arm64"), {
    architecture: "amd64",
    source: "Win32_Processor",
  });
});

test("parsePlatformEnvelope reads values only from successful results", () => {
  const { envelope } = loadPlatformFixture("arm64/vm-parallels-std-network");
  const sources = parsePlatformEnvelope(envelope);

  assert.equal(sources.processors.length, 0);
  assert.equal(sources.computerSystem, undefined);
  assert.equal(sources.memoryModules.length, 0);

  const elevated = parsePlatformEnvelope(
    loadPlatformFixture("arm64/vm-parallels-elevated").envelope,
  );
  assert.equal(elevated.processors.length, 4);
  assert.equal(elevated.computerSystem.Model, "Parallels ARM Virtual Machine");
});

test("enum tables map fixture codes to documented names", () => {
  // Codes below appear in committed fixtures; names come from the cited docs.
  assert.equal(WINDOWS_PROCESSOR_ARCHITECTURES[12], "arm64");
  assert.equal(WINDOWS_PROCESSOR_ARCHITECTURES[9], "amd64");
  assert.equal(WINDOWS_PC_SYSTEM_TYPES_EX[8], "slate");
  assert.equal(WINDOWS_PC_SYSTEM_TYPES_EX[1], "desktop");
  assert.equal(WINDOWS_MEMORY_FORM_FACTORS[8], "DIMM");
  assert.equal(WINDOWS_MEMORY_ERROR_CORRECTIONS[3], "None");
  assert.equal(SMBIOS_MEMORY_TYPES[3], "DRAM");
  assert.equal(SMBIOS_MEMORY_TYPES[2], "Unknown");
  assert.equal(SMBIOS_CHASSIS_TYPES[3], "desktop");
  assert.equal(SMBIOS_MEMORY_FORM_FACTORS[9], "DIMM");
  assert.equal(SMBIOS_MEMORY_TYPES[38], "LPDDR6");

  // Unknown codes pass through raw instead of being guessed.
  assert.equal(lookupSmbiosName(SMBIOS_MEMORY_TYPES, 99), "99");
  assert.equal(windowsEnumName(WINDOWS_PC_SYSTEM_TYPES_EX, 77), "77");
});

test("fixtures directory holds the expected capture labels", () => {
  const labels = fixtureDirectories();
  for (const expected of [
    "arm64/vm-parallels-elevated",
    "arm64/vm-parallels-std-local",
    "arm64/vm-parallels-std-network",
    "arm64/vm-parallels-std-local-smp-stopped",
    "amd64/windows-2025-gha",
    "arm64/windows-11-arm-gha",
  ]) {
    assert.ok(labels.includes(expected), `missing ${expected}`);
    assert.ok(
      existsSync(join(FIXTURES_ROOT, expected, "windows-cim-platform.stdout")),
    );
  }
});

/**
 * Collect raw sensitive string values from a fixture envelope.
 *
 * @param {{ results?: Record<string, { items?: object[] }> }} envelope Raw envelope.
 * @returns {string[]} Non-placeholder sensitive values.
 */
function collectSensitiveValues(envelope) {
  const values = [];
  for (const field of PLATFORM_SPEC.sensitiveFields ?? []) {
    const separator = field.indexOf(".");
    const result = envelope.results?.[field.slice(0, separator)] ?? {};
    const name = field.slice(separator + 1);
    for (const item of result.items ?? []) {
      const value = item?.[name];
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (
          typeof entry === "string" &&
          entry.trim().length > 0 &&
          !isPlaceholderIdentity(entry)
        ) {
          values.push(entry);
        }
      }
    }
  }
  return values;
}
