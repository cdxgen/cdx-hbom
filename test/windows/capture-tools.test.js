import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CAPTURE_SCRIPT = join(REPO_ROOT, "scripts/windows/capture-fixtures.mjs");
const REDACT_SCRIPT = join(REPO_ROOT, "scripts/windows/redact-fixtures.mjs");
const ELEVATED_FIXTURE = fileURLToPath(
  new URL(
    "../fixtures/windows/arm64/vm-parallels-elevated",
    import.meta.url,
  ),
);

/**
 * Run one of the tool scripts.
 *
 * @param {string} script Script path.
 * @param {string[]} args Script arguments.
 * @returns {{ status: number | null, stdout: string, stderr: string }} Result.
 */
function runTool(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

test("capture-fixtures refuses to run off Windows", { skip: process.platform === "win32" }, () => {
  const result = runTool(CAPTURE_SCRIPT, ["--out", "tmp/nope", "--label", "x"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must run on Windows/u);
});

test("redact-fixtures scrubs literals, stays deterministic and idempotent", () => {
  const work = join(REPO_ROOT, "tmp", "redact-tool-test");
  rmSync(work, { recursive: true, force: true });
  // A copy of the committed (already redacted) captured fixture exercises the
  // literal scrub and the pass-through of previously redacted values.
  cpSync(ELEVATED_FIXTURE, work, { recursive: true });

  const first = runTool(REDACT_SCRIPT, [work, "--literal", "Parallels"]);
  assert.equal(first.status, 0, first.stderr);
  const redactedOnce = readFileSync(
    join(work, "windows-cim-platform.stdout"),
    "utf8",
  );
  assert.equal(redactedOnce.includes("Parallels"), false);
  assert.ok(redactedOnce.includes("REDACTED-LITERAL"));

  // Already-redacted serials keep their stable assignment on a second pass.
  const second = runTool(REDACT_SCRIPT, [work]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(
    readFileSync(join(work, "windows-cim-platform.stdout"), "utf8"),
    redactedOnce,
  );

  // The manifest stays untouched so freshness hashes keep matching.
  assert.deepEqual(
    JSON.parse(readFileSync(join(work, "manifest.json"), "utf8")).commands,
    JSON.parse(readFileSync(join(ELEVATED_FIXTURE, "manifest.json"), "utf8"))
      .commands,
  );
  rmSync(work, { recursive: true, force: true });
});

test("redact-fixtures leaves every committed fixture byte-identical", () => {
  const fixturesRoot = fileURLToPath(
    new URL("../fixtures/windows", import.meta.url),
  );
  for (const arch of readdirSync(fixturesRoot)) {
    for (const label of readdirSync(join(fixturesRoot, arch))) {
      const source = join(fixturesRoot, arch, label);
      const work = join(REPO_ROOT, "tmp", "redact-fixed-point", arch, label);
      rmSync(work, { recursive: true, force: true });
      cpSync(source, work, { recursive: true });

      const result = runTool(REDACT_SCRIPT, [work]);
      assert.equal(result.status, 0, result.stderr);
      for (const name of readdirSync(source)) {
        assert.equal(
          readFileSync(join(work, name), "utf8"),
          readFileSync(join(source, name), "utf8"),
          `${arch}/${label}/${name} changed when redacted again`,
        );
      }
      rmSync(work, { recursive: true, force: true });
    }
  }
});

test("redact-fixtures replaces fresh serial, GUID, MAC and PnP values", () => {
  // A synthetic in-test envelope (not a repo fixture) covering the value
  // shapes the redactor must handle on a fresh capture.
  const work = join(REPO_ROOT, "tmp", "redact-tool-fresh");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(
    join(work, "windows-cim-platform.stdout"),
    JSON.stringify({
      schema: "cdx-hbom/windows-envelope@1",
      results: {
        bios: {
          ok: true,
          items: [{ Manufacturer: "Vendor A", SerialNumber: "SER-123456" }],
        },
        computerSystemProduct: {
          ok: true,
          items: [{ UUID: "6bd4efb9-23cc-4b4a-ac37-016517413e9a" }],
        },
        nic: {
          ok: true,
          items: [{ MACAddress: "AA:BB:CC:11:22:33" }],
        },
        // Hyper-V (windows-2025-gha) reports `None` for the memory serial and
        // for unrelated fields alike; the placeholder must stay untouched.
        physicalMemory: {
          ok: true,
          items: [{ SerialNumber: "None", PartNumber: "None" }],
        },
        pnpIds: {
          ok: true,
          items: [
            { PNPDeviceID: "USB\\VID_203A&PID_FFFB\\KBD1.1", HardwareID: [] },
          ],
        },
      },
    }),
    "utf8",
  );
  writeFileSync(
    join(work, "manifest.json"),
    JSON.stringify({
      label: "synthetic",
      commands: [
        {
          id: "windows-cim-platform",
          argsSha256: "0".repeat(64),
          exitCode: 0,
          durationMs: 1,
          bytes: 1,
          provenance: "captured",
        },
      ],
    }),
    "utf8",
  );

  const result = runTool(REDACT_SCRIPT, [work]);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(
    readFileSync(join(work, "windows-cim-platform.stdout"), "utf8"),
  );
  assert.equal(
    envelope.results.bios.items[0].SerialNumber,
    "REDACTED-SERIAL-0001",
  );
  assert.equal(
    envelope.results.computerSystemProduct.items[0].UUID,
    "00000000-0000-4000-8000-000000000001",
  );
  assert.equal(envelope.results.nic.items[0].MACAddress, "02:00:00:00:00:01");
  assert.deepEqual(envelope.results.physicalMemory.items[0], {
    SerialNumber: "None",
    PartNumber: "None",
  });
  assert.equal(
    envelope.results.pnpIds.items[0].PNPDeviceID,
    "USB\\VID_203A&PID_FFFB\\redacted:D1.1",
  );
  rmSync(work, { recursive: true, force: true });
});

test("redact-fixtures fails closed when a serial is embedded in another string", () => {
  const work = join(REPO_ROOT, "tmp", "redact-tool-embedded");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // Synthetic in-test envelope: the serial also appears inside a longer,
  // non-sensitive value, which whole-token replacement cannot reach.
  writeFileSync(
    join(work, "windows-cim-platform.stdout"),
    JSON.stringify({
      schema: "cdx-hbom/windows-envelope@1",
      results: {
        bios: {
          ok: true,
          items: [
            { SerialNumber: "SER-123456", Version: "Build SER-123456 rev" },
          ],
        },
      },
    }),
    "utf8",
  );

  const result = runTool(REDACT_SCRIPT, [work]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sensitive value \(10 chars\) still present/u);
  // Messages reach public CI logs, so they never repeat the value.
  assert.equal(result.stderr.includes("SER-123456"), false);
  rmSync(work, { recursive: true, force: true });
});

test("redact-fixtures scrubs literals even in unparseable stdout files", () => {
  const work = join(REPO_ROOT, "tmp", "redact-tool-fail");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(
    join(work, "windows-cim-platform.stdout"),
    "cdx-hbom/windows-envelope@1",
    "utf8",
  );

  const result = runTool(REDACT_SCRIPT, [work, "--literal", "envelope@1"]);
  assert.equal(result.status, 0, "unparseable files still get literal scrubbing");
  assert.equal(
    readFileSync(join(work, "windows-cim-platform.stdout"), "utf8"),
    "cdx-hbom/windows-REDACTED-LITERAL",
  );
  rmSync(work, { recursive: true, force: true });
});

test("redact-fixtures redacts volume GUIDs and numeric serials", () => {
  // Synthetic in-test envelope covering the two windows-cim-storage-network
  // gaps: a Win32_Volume device path whose GUID must not survive, and a
  // uint32 volume serial that serializes as a JSON number.
  const volumeGuid = "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d";
  const work = join(REPO_ROOT, "tmp", "redact-tool-volume");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(
    join(work, "windows-cim-storage-network.stdout"),
    JSON.stringify({
      schema: "cdx-hbom/windows-envelope@1",
      results: {
        volume: {
          ok: true,
          items: [
            {
              DeviceID: `\\\\?\\Volume{${volumeGuid}}\\`,
              DriveLetter: "C:",
              DriveType: 3,
              SerialNumber: 3081031936,
              Capacity: 68719476736,
            },
          ],
        },
      },
    }),
    "utf8",
  );

  const result = runTool(REDACT_SCRIPT, [work]);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(
    readFileSync(join(work, "windows-cim-storage-network.stdout"), "utf8"),
  );
  const volume = envelope.results.volume.items[0];
  assert.equal(volume.DeviceID, "\\\\?\\Volume{redacted:4c5d}\\");
  // The numeric serial stays a number of the same magnitude...
  assert.equal(typeof volume.SerialNumber, "number");
  assert.equal(volume.SerialNumber, 4444444444);
  // ...and unrelated numbers around it are untouched.
  assert.equal(volume.Capacity, 68719476736);
  assert.equal(volume.DriveType, 3);
  // Re-running is stable and nothing raw survives.
  const rawText = readFileSync(
    join(work, "windows-cim-storage-network.stdout"),
    "utf8",
  );
  assert.equal(rawText.includes(volumeGuid), false);
  assert.equal(rawText.includes("3081031936"), false);
  const second = runTool(REDACT_SCRIPT, [work]);
  assert.equal(second.status, 0, second.stderr);
  rmSync(work, { recursive: true, force: true });
});
