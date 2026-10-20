import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import {
  collectHardware,
  getCollectorTrace,
  SUPPORTED_TARGETS,
} from "../index.js";

/**
 * Override `process.platform` and `process.arch` for a callback.
 *
 * @param {string} platform Fake platform value.
 * @param {string} architecture Fake architecture value.
 * @param {() => unknown} callback Callback.
 * @returns {Promise<unknown>} Callback result, awaited before restoring.
 */
async function withTargetPlatform(platform, architecture, callback) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: platform,
  });
  Object.defineProperty(process, "arch", { ...archDescriptor, value: architecture });
  try {
    return await callback();
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    Object.defineProperty(process, "arch", archDescriptor);
  }
}

test("dry-run blocks every Darwin command without recording failures", async () => {
  // The Darwin collector guards on the host platform, so the test fakes
  // darwin/arm64 to stay exercisable from Windows CI.
  const bom = await withTargetPlatform("darwin", "arm64", () =>
    collectHardware({ dryRun: true }),
  );
  const trace = getCollectorTrace(bom);
  const kinds = new Set(trace.activities.map((entry) => entry.kind));

  assert.ok(trace.activities.length > 0, "dry run still traces the plan");
  assert.deepEqual([...kinds], ["command"]);
  for (const activity of trace.activities) {
    assert.equal(activity.status, "blocked");
  }
});

test("dry-run leaves the Linux BOM free of phantom diagnostics", async () => {
  await withTargetPlatform("linux", "amd64", async () => {
    const bom = await collectHardware({
      platform: "linux",
      architecture: "amd64",
      dryRun: true,
    });
    const trace = getCollectorTrace(bom);

    for (const activity of trace.activities) {
      assert.notEqual(activity.kind, "command-diagnostic");
      assert.notEqual(activity.kind, "command-warning");
    }
    const diagnosticProperties = (bom.properties ?? []).filter((property) =>
      property.name === "cdx:hbom:evidence:commandDiagnostic",
    );
    assert.deepEqual(diagnosticProperties, []);
  });
});

test("collectHardware routes win32 to the Windows collector", async () => {
  for (const architecture of ["amd64", "arm64"]) {
    assert.ok(
      SUPPORTED_TARGETS.some(
        (target) =>
          target.platform === "win32" && target.architecture === architecture,
      ),
      `win32/${architecture} is a supported target`,
    );
  }
  // On a non-Windows host the collector refuses to run; the platform gate
  // lives inside the collector, matching Linux and Darwin. On Windows the
  // same call collects for real.
  if (process.platform === "win32") {
    const bom = await collectHardware({
      platform: "win32",
      architecture: "amd64",
    });
    assert.equal(bom.specVersion, "1.7");
  } else {
    await assert.rejects(
      () => collectHardware({ platform: "win32", architecture: "amd64" }),
      /Windows collector must run on win32/u,
    );
  }
});

test("dry-run on win32 builds a T0 BOM with only blocked command activities", async () => {
  const bom = await withTargetPlatform("win32", "x64", () =>
    collectHardware({ platform: "win32", dryRun: true }),
  );
  const trace = getCollectorTrace(bom);
  const kinds = new Set(trace.activities.map((entry) => entry.kind));

  assert.deepEqual([...kinds], ["command"]);
  for (const activity of trace.activities) {
    assert.equal(activity.status, "blocked");
    assert.match(
      activity.target,
      /windows-(?:cim-platform|cim-storage-network|cim-display-media|pnp-devices|cim-trust|cim-privileged) script sha256:[0-9a-f]{12}$/u,
      "trace target uses the C02 short script form",
    );
  }

  const diagnosticProperties = (bom.properties ?? []).filter((property) =>
    property.name === "cdx:hbom:evidence:commandDiagnostic",
  );
  assert.deepEqual(diagnosticProperties, []);
  assert.equal(bom.specVersion, "1.7");
  const architectureSource = (bom.properties ?? []).find(
    (property) => property.name === "cdx:hbom:architectureSource",
  );
  assert.equal(architectureSource?.value, "process");
});

test("dry-run on win32 plans the privileged batch only when requested", async () => {
  const planned = async (options) => {
    const bom = await withTargetPlatform("win32", "x64", () =>
      collectHardware({ platform: "win32", dryRun: true, ...options }),
    );
    return getCollectorTrace(bom).activities.map((entry) => entry.id);
  };

  const defaults = await planned({});
  assert.deepEqual(defaults, [
    "windows-cim-platform",
    "windows-cim-storage-network",
    "windows-cim-display-media",
    "windows-pnp-devices",
    "windows-cim-trust",
  ]);

  const privileged = await planned({ includePrivilegedEnrichment: true });
  assert.deepEqual(privileged, [...defaults, "windows-cim-privileged"]);

  // Privileged collection is enrichment: without enrichment nothing but the
  // platform batch is planned, whatever the privileged flag says.
  const baselineOnly = await planned({
    includeCommandEnrichment: false,
    includePrivilegedEnrichment: true,
  });
  assert.deepEqual(baselineOnly, ["windows-cim-platform"]);
});
