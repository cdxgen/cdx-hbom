import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import { runCommand } from "../src/common/command.js";
import { createCollectorTrace } from "../src/common/trace.js";
import {
  createEdidDecodeCommand,
  createEthtoolCommand,
  createMmcliModemCommand,
  isValidLinuxEdidPath,
  isValidLinuxInterfaceName,
  isValidLinuxModemPath,
  shouldDecodeDrmEdid,
} from "../src/linux/common/index.js";

test("runCommand retries with sudo only for commands that explicitly opt in and records the retry", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "cdx-hbom-sudo-retry-"));
  const binDir = join(sandbox, "bin");
  const retryLog = join(sandbox, "sudo.log");
  const sudoPath = join(binDir, "sudo");
  const originalPath = process.env.PATH;
  const trace = createCollectorTrace();

  try {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      sudoPath,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(retryLog)}\nprintf 'retried\\n'\n`,
      { mode: 0o755 },
    );
    chmodSync(sudoPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;

    const stdout = await runCommand(
      {
        id: "drm-info-json",
        category: "graphics",
        command: process.execPath,
        args: [
          "-e",
          'process.stderr.write("Permission denied\\n"); process.exit(1);',
        ],
        parser: "json",
        purpose: "Test explicit sudo retry.",
        phase: "collector-v1",
        privilege: "optional",
        sudoRetryOnPermissionDenied: true,
      },
      { includePrivilegedEnrichment: true, trace },
    );

    assert.equal(stdout, "retried");
    assert.equal(existsSync(retryLog), true);
    assert.match(readFileSync(retryLog, "utf8"), /-n/u);
    assert.equal(
      trace.activities.some(
        (entry) =>
          entry.kind === "command-retry" && entry.id === "drm-info-json",
      ),
      true,
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(sandbox, { force: true, recursive: true });
  }
});

test("runCommand does not retry with sudo when the command has not explicitly opted in", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "cdx-hbom-no-retry-"));
  const binDir = join(sandbox, "bin");
  const retryLog = join(sandbox, "sudo.log");
  const sudoPath = join(binDir, "sudo");
  const originalPath = process.env.PATH;

  try {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      sudoPath,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(retryLog)}\nprintf 'unexpected\\n'\n`,
      { mode: 0o755 },
    );
    chmodSync(sudoPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;

    await assert.rejects(
      () =>
        runCommand(
          {
            id: "permission-probe",
            category: "platform",
            command: process.execPath,
            args: [
              "-e",
              'process.stderr.write("Permission denied\\n"); process.exit(1);',
            ],
            parser: "text",
            purpose: "Verify retry opt-in enforcement.",
            phase: "collector-v1",
            privilege: "optional",
          },
          { includePrivilegedEnrichment: true },
        ),
      (error) => {
        assert.equal(error.code, "CDX_HBOM_PERMISSION_DENIED");
        return true;
      },
    );

    assert.equal(existsSync(retryLog), false);
  } finally {
    process.env.PATH = originalPath;
    rmSync(sandbox, { force: true, recursive: true });
  }
});

test("runCommand does not retry on warning-only stderr with successful structured output", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "cdx-hbom-empty-output-"));
  const binDir = join(sandbox, "bin");
  const retryLog = join(sandbox, "sudo.log");
  const sudoPath = join(binDir, "sudo");
  const originalPath = process.env.PATH;
  const trace = createCollectorTrace();

  try {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      sudoPath,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(retryLog)}\nprintf 'unexpected\\n'\n`,
      { mode: 0o755 },
    );
    chmodSync(sudoPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;

    const stdout = await runCommand(
      {
        id: "drm-info-json",
        category: "graphics",
        command: process.execPath,
        args: [
          "-e",
          'process.stderr.write("Permission denied\\n"); process.stdout.write("{}\\n"); process.exit(0);',
        ],
        parser: "json",
        purpose: "Verify successful output is not retried.",
        phase: "collector-v1",
        privilege: "optional",
        sudoRetryOnPermissionDenied: true,
      },
      { includePrivilegedEnrichment: true, trace },
    );

    assert.equal(stdout, "{}");
    assert.equal(existsSync(retryLog), false);
    assert.equal(
      trace.activities.some((entry) => entry.kind === "command-retry"),
      false,
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(sandbox, { force: true, recursive: true });
  }
});

test("Linux runtime validators accept common legitimate values", () => {
  assert.equal(isValidLinuxInterfaceName("eth0"), true);
  assert.equal(isValidLinuxInterfaceName("veth8f3d1@if2"), true);
  assert.equal(
    isValidLinuxModemPath("/org/freedesktop/ModemManager1/Modem/0"),
    true,
  );
  assert.equal(
    isValidLinuxEdidPath("/sys/class/drm/card0-HDMI-A-1/edid"),
    true,
  );

  assert.deepEqual(createEthtoolCommand("wlp4s0").args, ["-i", "wlp4s0"]);
  assert.deepEqual(
    createMmcliModemCommand("/org/freedesktop/ModemManager1/Modem/0").args,
    ["-m", "/org/freedesktop/ModemManager1/Modem/0", "-J"],
  );
  assert.deepEqual(
    createEdidDecodeCommand({
      name: "card0-HDMI-A-1",
      edidPath: "/sys/class/drm/card0-HDMI-A-1/edid",
    }).args,
    ["/sys/class/drm/card0-HDMI-A-1/edid"],
  );
});

test("shouldDecodeDrmEdid skips disconnected or empty DRM connectors", () => {
  assert.equal(
    shouldDecodeDrmEdid({
      kind: "connector",
      name: "card0-HDMI-A-1",
      edidPath: "/sys/class/drm/card0-HDMI-A-1/edid",
      edidByteLength: 0,
      status: "disconnected",
      enabled: "disabled",
    }),
    false,
  );

  assert.equal(
    shouldDecodeDrmEdid({
      kind: "connector",
      name: "card0-Writeback-1",
      edidPath: "/sys/class/drm/card0-Writeback-1/edid",
      status: "unknown",
      enabled: "disabled",
    }),
    false,
  );
});

test("shouldDecodeDrmEdid keeps connected connectors with usable EDID data", () => {
  assert.equal(
    shouldDecodeDrmEdid({
      kind: "connector",
      name: "card0-HDMI-A-1",
      edidPath: "/sys/class/drm/card0-HDMI-A-1/edid",
      edidByteLength: 256,
      status: "connected",
      enabled: "enabled",
    }),
    true,
  );
});

test("createEthtoolCommand rejects unsafe interface names and records a trace event", () => {
  const trace = createCollectorTrace();

  assert.throws(
    () => createEthtoolCommand("-p", { trace }),
    (error) => {
      assert.equal(error.code, "CDX_HBOM_INVALID_COMMAND_ARGUMENT");
      assert.equal(error.issue, "invalid-command-argument");
      assert.equal(error.argumentName, "interfaceName");
      return true;
    },
  );

  assert.equal(trace.activities[0]?.kind, "command-input-rejected");
  assert.equal(trace.activities[0]?.argumentName, "interfaceName");
});

test("createMmcliModemCommand rejects unsafe modem paths and records a trace event", () => {
  const trace = createCollectorTrace();

  assert.throws(
    () => createMmcliModemCommand("--help", { trace }),
    (error) => {
      assert.equal(error.code, "CDX_HBOM_INVALID_COMMAND_ARGUMENT");
      assert.equal(error.issue, "invalid-command-argument");
      assert.equal(error.argumentName, "modemPath");
      return true;
    },
  );

  assert.equal(trace.activities[0]?.kind, "command-input-rejected");
  assert.equal(trace.activities[0]?.argumentName, "modemPath");
});

test("createEdidDecodeCommand rejects non-sysfs EDID paths and records a trace event", () => {
  const trace = createCollectorTrace();

  assert.throws(
    () =>
      createEdidDecodeCommand(
        {
          name: "card0-HDMI-A-1",
          edidPath: "/tmp/crafted_edid",
        },
        { trace },
      ),
    (error) => {
      assert.equal(error.code, "CDX_HBOM_INVALID_COMMAND_ARGUMENT");
      assert.equal(error.issue, "invalid-command-argument");
      assert.equal(error.argumentName, "edidPath");
      return true;
    },
  );

  assert.equal(trace.activities[0]?.kind, "command-input-rejected");
  assert.equal(trace.activities[0]?.argumentName, "edidPath");
});
