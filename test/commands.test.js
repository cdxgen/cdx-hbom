import assert from "node:assert/strict";
import test from "node:test";

import { getCommandPlan } from "../index.js";

test("getCommandPlan returns the Darwin arm64 collector plan", () => {
  const plan = getCommandPlan({
    platform: "darwin",
    architecture: "arm64",
  });

  assert.ok(Array.isArray(plan));
  assert.ok(plan.length >= 4);
  assert.equal(plan[0].id, "system-profiler-json");
  assert.equal(plan[0].phase, "collector-v1");
  assert.ok(
    plan.some(
      (spec) =>
        spec.id === "platform-registry" && spec.phase === "planned-enrichment",
    ),
  );
});

test("getCommandPlan rejects unsupported targets", () => {
  const linuxAmd64Plan = getCommandPlan({
    platform: "linux",
    architecture: "amd64",
  });
  const linuxX64Plan = getCommandPlan({
    platform: "linux",
    architecture: "x64",
  });
  const linuxArm64Plan = getCommandPlan({
    platform: "linux",
    architecture: "arm64",
  });
  const linuxAarch64Plan = getCommandPlan({
    platform: "linux",
    architecture: "aarch64",
  });

  assert.ok(linuxAmd64Plan.some((spec) => spec.id === "lscpu-json"));
  assert.ok(linuxX64Plan.some((spec) => spec.id === "lscpu-json"));
  assert.ok(linuxAmd64Plan.some((spec) => spec.id === "lsblk-json"));
  assert.ok(linuxArm64Plan.some((spec) => spec.id === "ip-link-json"));
  assert.ok(linuxAarch64Plan.some((spec) => spec.id === "ip-link-json"));

  assert.throws(
    () =>
      getCommandPlan({
        platform: "linux",
        architecture: "ppc64",
      }),
    /Unsupported HBOM target/u,
  );
});
