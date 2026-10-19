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
 * @returns {unknown} Callback result.
 */
function withTargetPlatform(platform, architecture, callback) {
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
    return callback();
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

test("collectHardware on win32 still throws until the C03 collector lands", async () => {
  for (const architecture of ["amd64", "arm64"]) {
    await assert.rejects(
      () => collectHardware({ platform: "win32", architecture }),
      /Unsupported HBOM target: win32/u,
    );
  }
  assert.equal(
    SUPPORTED_TARGETS.find((target) => target.platform === "win32"),
    undefined,
  );
});
