import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import {
  collectHardware,
  getCollectorTrace,
  SUPPORTED_TARGETS,
} from "../index.js";

/**
 * Override `process.platform` for the duration of a callback.
 *
 * @param {string} platform Fake platform value.
 * @param {() => unknown} callback Callback.
 * @returns {unknown} Callback result.
 */
function withPlatform(platform, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return callback();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

test("dry-run blocks every Darwin command without recording failures", async () => {
  const bom = await collectHardware({ dryRun: true });
  const trace = getCollectorTrace(bom);
  const kinds = new Set(trace.activities.map((entry) => entry.kind));

  assert.ok(trace.activities.length > 0, "dry run still traces the plan");
  assert.deepEqual([...kinds], ["command"]);
  for (const activity of trace.activities) {
    assert.equal(activity.status, "blocked");
  }
});

test("dry-run leaves the Linux BOM free of phantom diagnostics", async () => {
  await withPlatform("linux", async () => {
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
