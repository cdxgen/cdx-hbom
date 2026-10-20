import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  WINDOWS_FALLBACK_COMMANDS,
  parsePnputilDevices,
  parseWindowsBuild,
  selectPnputilCommand,
  toFallbackPnpEnvelope,
} from "../../src/windows/common/fallback.js";
import { buildWindowsHbom, getWindowsCommandPlan } from "../../src/windows/common/index.js";

const FALLBACK_DIR = fileURLToPath(
  new URL("../fixtures/windows-fallback/arm64/vm-parallels-elevated", import.meta.url),
);
// Synthetic T0 baseline (test input, not captured).
const TEST_BASELINE = Object.freeze({
  cpuModel: "Baseline CPU",
  cpuCount: 4,
  totalMemoryBytes: 8 * 1024 * 1024 * 1024,
  osRelease: "10.0.26200",
  osName: "Baseline Windows",
});

function fixture(dir, id) {
  return readFileSync(join(dir, `${id}.stdout`), "utf8");
}

function prop(component, name) {
  return component.properties?.find((entry) => entry.name === name)?.value;
}

function fallbackSources() {
  const { devices } = parsePnputilDevices(fixture(FALLBACK_DIR, "windows-pnputil-devices"));
  return {
    baseline: TEST_BASELINE,
    pnpDevicesEnvelope: toFallbackPnpEnvelope(devices),
  };
}

test("the pnputil fallback yields the PnP device inventory with parent links", () => {
  const { devices, recognized } = parsePnputilDevices(
    fixture(FALLBACK_DIR, "windows-pnputil-devices"),
  );
  assert.equal(recognized, true);
  assert.ok(devices.length > 50, `${devices.length} devices parsed`);
  assert.ok(devices.every((device) => device.instanceId));
  assert.ok(devices.filter((device) => device.parent).length > devices.length / 2);
  assert.ok(devices.some((device) => device.children.length > 1), "multi-line Children");
  const firmware = devices.find((device) => device.className === "Firmware");
  assert.ok(firmware?.drivers.some((driver) => /Installed/u.test(driver.status)));

  const bom = buildWindowsHbom({ sources: fallbackSources(), collectedAt: "2026-10-20T00:00:00Z" });
  const pnpComponents = bom.components.filter((component) =>
    String(component["bom-ref"] ?? "").startsWith("windows-pnp:"),
  );
  assert.ok(pnpComponents.length > 0, "PnP components are emitted");
  assert.ok(
    pnpComponents.some((component) => prop(component, "cdx:hbom:driverVersion")),
    "installed driver versions reach the components",
  );
});

test("localized pnputil output is reported as unrecognized, not misparsed", () => {
  const german = "Microsoft-PnP-Dienstprogramm\r\n\r\nInstanz-ID:  ACPI\\PRL4005\\0\r\nGerätebeschreibung: Gerät\r\n";
  assert.deepEqual(parsePnputilDevices(german), { devices: [], recognized: false });
});

test("pnputil flags are gated on the OS build", () => {
  assert.equal(parseWindowsBuild("10.0.26200"), 26200);
  assert.equal(parseWindowsBuild("bogus"), undefined);
  assert.deepEqual(selectPnputilCommand(26200).args, [
    "/enum-devices",
    "/connected",
    "/relations",
    "/drivers",
  ]);
  assert.deepEqual(selectPnputilCommand(18363).args, [
    "/enum-devices",
    "/connected",
    "/relations",
  ]);
  assert.equal(selectPnputilCommand(17763), undefined);
});

test("fallback commands use absolute System32 paths and stay out of the command plan", () => {
  for (const spec of WINDOWS_FALLBACK_COMMANDS) {
    assert.match(spec.command, /^[A-Za-z]:\\.+\\System32\\pnputil\.exe$/u);
    assert.equal(spec.phase, "fallback");
  }
  const planIds = getWindowsCommandPlan().map((spec) => spec.id);
  for (const spec of WINDOWS_FALLBACK_COMMANDS) {
    assert.equal(planIds.includes(spec.id), false, `${spec.id} is not planned`);
  }
});

test("committed pnputil fixture carries only redacted instance segments", () => {
  for (const line of fixture(FALLBACK_DIR, "windows-pnputil-devices").split(/\r?\n/u)) {
    const match = line.match(/^(?:Instance ID|Parent|Children):\s*(\S+)/u);
    const parts = match ? match[1].split("\\") : [];
    if (parts.length >= 3) {
      assert.match(parts.at(-1), /^redacted/u, `raw instance segment (${match[1].slice(0, 24)}...)`);
    }
  }
});
