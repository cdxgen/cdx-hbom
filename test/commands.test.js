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
  assert.ok(plan[0].args.includes("SPUSBDataType"));
  assert.ok(plan[0].args.includes("SPAirPortDataType"));
  assert.ok(plan[0].args.includes("SPAudioDataType"));
  assert.ok(plan[0].args.includes("SPCameraDataType"));
  assert.ok(
    plan.some(
      (spec) =>
        spec.id === "platform-registry" && spec.phase === "planned-enrichment",
    ),
  );
  assert.ok(plan.some((spec) => spec.id === "apfs-topology"));
  assert.ok(plan.some((spec) => spec.id === "interface-details"));
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
  assert.ok(linuxAmd64Plan.some((spec) => spec.id === "lsusb-verbose"));
  assert.ok(
    linuxAmd64Plan.some((spec) => spec.id === "cpupower-frequency-info"),
  );
  assert.ok(linuxArm64Plan.some((spec) => spec.id === "cpupower-idle-info"));
  assert.ok(linuxAmd64Plan.some((spec) => spec.id === "drm-info-json"));
  assert.ok(linuxAmd64Plan.some((spec) => spec.id === "upower-dump"));
  assert.ok(linuxArm64Plan.some((spec) => spec.id === "fwupdmgr-devices-json"));
  assert.ok(linuxArm64Plan.some((spec) => spec.id === "boltctl-list-all"));
  assert.ok(linuxArm64Plan.some((spec) => spec.id === "mmcli-list-json"));
  assert.ok(linuxAmd64Plan.some((spec) => spec.id === "ethtool-driver-info"));
  assert.ok(linuxArm64Plan.some((spec) => spec.id === "mmcli-modem-json"));
  assert.deepEqual(
    linuxAmd64Plan.find((spec) => spec.id === "ethtool-driver-info")?.args,
    ["-i", "<interface>"],
  );
  assert.equal(
    linuxAmd64Plan.find((spec) => spec.id === "drm-info-json")
      ?.sudoRetryOnPermissionDenied,
    true,
  );
  assert.deepEqual(
    linuxArm64Plan.find((spec) => spec.id === "mmcli-modem-json")?.args,
    ["-m", "<modem-path>", "-J"],
  );
  assert.ok(linuxAmd64Plan.some((spec) => spec.id === "edid-decode"));
  assert.deepEqual(
    linuxAmd64Plan.find((spec) => spec.id === "edid-decode")?.args,
    ["<edid-path>"],
  );

  assert.throws(
    () =>
      getCommandPlan({
        platform: "linux",
        architecture: "ppc64",
      }),
    /Unsupported HBOM target/u,
  );
});

test("getCommandPlan returns the Windows collector plan for both architectures", () => {
  for (const architecture of ["amd64", "arm64"]) {
    const plan = getCommandPlan({ platform: "win32", architecture });
    const planByAlias = getCommandPlan({ platform: "windows", architecture });

    assert.ok(Array.isArray(plan));
    assert.equal(plan.length, 1);
    assert.equal(plan[0].id, "windows-cim-platform");
    assert.equal(plan[0].phase, "collector-v1");
    assert.equal(plan[0].parser, "windows-envelope");
    assert.equal(plan[0].privilege, "none");
    assert.equal(plan[0].sudoRetryOnPermissionDenied, false);
    assert.equal(plan[0].timeoutMs, 60000);
    assert.ok(
      plan[0].command.endsWith(
        "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ),
    );
    assert.deepEqual(plan[0].args.slice(0, 4), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    assert.ok(
      plan[0].args[4].length > 0 && plan[0].args[4].length <= 8000,
      "script within the length budget",
    );
    assert.deepEqual(planByAlias[0].args, plan[0].args);
  }
});
