import assert from "node:assert/strict";
import test from "node:test";

import { createCollectorTrace, getCollectorTrace } from "../index.js";
import { buildLinuxHbom } from "../src/linux/common/index.js";

test("buildLinuxHbom preserves explicit executed command evidence on the BOM root", () => {
  const bom = buildLinuxHbom({
    architecture: "amd64",
    sources: {
      osRelease: {
        NAME: "Ubuntu",
        VERSION_ID: "24.04",
      },
      hostnamectl: {
        HardwareVendor: "Dell Inc.",
        HardwareModel: "XPS 16 9640",
      },
      cpuInfo: [
        {
          "model name": "Intel(R) Core(TM) Ultra 7 165H",
        },
      ],
      memInfo: {
        MemTotal: {
          value: 32768000,
          unit: "kB",
        },
      },
      lscpu: {
        Architecture: "x86_64",
        "CPU(s)": "22",
        "Model name": "Intel(R) Core(TM) Ultra 7 165H",
      },
    },
    executedCommands: [
      {
        id: "lscpu-json",
        category: "cpu-memory",
        command: "/usr/bin/lscpu",
        args: ["-J"],
      },
      {
        id: "ip-link-json",
        category: "network",
        command: "/usr/sbin/ip",
        args: ["-j", "link"],
      },
    ],
  });

  assert.equal(
    bom.properties.find(
      (property) => property.name === "cdx:hbom:evidence:commandCount",
    )?.value,
    "2",
  );
  assert.deepEqual(
    bom.properties
      .filter((property) => property.name === "cdx:hbom:evidence:command")
      .map((property) => property.value),
    [
      "lscpu-json|cpu-memory|/usr/bin/lscpu -J",
      "ip-link-json|network|/usr/sbin/ip -j link",
    ],
  );
});

test("buildLinuxHbom attaches an explicit collector trace without changing JSON output", () => {
  const trace = createCollectorTrace();
  trace.activities.push({
    kind: "file-read",
    path: "/proc/cpuinfo",
    status: "completed",
    target: "/proc/cpuinfo",
    timestamp: "2026-05-13T00:00:00.000Z",
  });

  const bom = buildLinuxHbom({
    architecture: "amd64",
    sources: {
      cpuInfo: [{ "model name": "Intel(R) Core(TM) Ultra 7 165H" }],
      hostnamectl: {
        HardwareModel: "XPS 16 9640",
        HardwareVendor: "Dell Inc.",
      },
      memInfo: {
        MemTotal: {
          unit: "kB",
          value: 32768000,
        },
      },
      osRelease: {
        NAME: "Ubuntu",
      },
    },
    trace,
  });

  assert.strictEqual(getCollectorTrace(bom), trace);
  assert.equal(Object.keys(bom).includes("trace"), false);
});
