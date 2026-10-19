import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { runCommand } from "../src/common/command.js";
import { createCollectorTrace } from "../src/common/trace.js";

test("runCommand classifies missing commands and includes install hints", async () => {
  await assert.rejects(
    () =>
      runCommand({
        id: "boltctl-list-all",
        category: "bus",
        command: "/definitely/missing/boltctl",
        args: ["list", "--all"],
        parser: "boltctl-text",
        purpose: "Test missing command classification.",
        phase: "collector-v1",
      }),
    (error) => {
      assert.equal(error.code, "CDX_HBOM_COMMAND_NOT_FOUND");
      assert.equal(error.issue, "missing-command");
      assert.match(
        error.installHint,
        /install the Linux package providing boltctl/u,
      );
      return true;
    },
  );
});

test("runCommand classifies permission-denied failures", async () => {
  await assert.rejects(
    () =>
      runCommand({
        id: "permission-probe",
        category: "platform",
        command: process.execPath,
        args: [
          "-e",
          'process.stderr.write("Permission denied\\n"); process.exit(1);',
        ],
        parser: "text",
        purpose: "Test permission classification.",
        phase: "collector-v1",
        privilege: "optional",
      }),
    (error) => {
      assert.equal(error.code, "CDX_HBOM_PERMISSION_DENIED");
      assert.equal(error.issue, "permission-denied");
      assert.match(
        error.privilegeHint,
        process.platform === "win32"
          ? /never requests elevation on Windows/u
          : /--privileged/u,
      );
      return true;
    },
  );
});

test("runCommand records partial permission warnings when stdout remains usable", async () => {
  const trace = createCollectorTrace();
  const stdout = await runCommand(
    {
      id: "warning-probe",
      category: "graphics",
      command: process.execPath,
      args: [
        "-e",
        'process.stderr.write("/dev/dri/card0: Permission denied\\n"); process.stdout.write("{}\\n");',
      ],
      parser: "json",
      purpose: "Test warning recording.",
      phase: "collector-v1",
      privilege: "optional",
    },
    { trace },
  );

  assert.equal(stdout, "{}");
  assert.equal(
    trace.activities.some(
      (entry) =>
        entry.kind === "command-warning" && entry.issue === "permission-denied",
    ),
    true,
  );
});

test("runCommand suppresses noisy generic stderr when stdout remains usable", async () => {
  const trace = createCollectorTrace();
  const stdout = await runCommand(
    {
      id: "generic-stderr-probe",
      category: "platform",
      command: process.execPath,
      args: [
        "-e",
        'process.stderr.write("output may be incomplete\\n"); process.stdout.write("ok\\n");',
      ],
      parser: "text",
      purpose: "Test stderr warning suppression.",
      phase: "collector-v1",
    },
    { trace },
  );

  assert.equal(stdout, "ok");
  assert.equal(
    trace.activities.some((entry) => entry.kind === "command-warning"),
    false,
  );
});

test("runCommand suppresses low-value diagnostics for unsupported ethtool interfaces", async () => {
  const trace = createCollectorTrace();

  await assert.rejects(
    () =>
      runCommand(
        {
          id: "ethtool-driver-info:eth999",
          category: "network",
          command: process.execPath,
          args: [
            "-e",
            'process.stderr.write("Cannot get driver information: Operation not supported\\n"); process.exit(1);',
          ],
          parser: "text",
          purpose: "Test low-value diagnostic suppression.",
          phase: "collector-v1",
        },
        { trace },
      ),
    (error) => {
      assert.equal(error.suppressedDiagnostic, true);
      return true;
    },
  );

  assert.equal(
    trace.activities.some((entry) => entry.kind === "command-diagnostic"),
    false,
  );
});

test("runCommand prefers the spec timeout over the built-in default", async () => {
  const trace = createCollectorTrace();
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      runCommand(
        {
          id: "timeout-probe",
          category: "platform",
          command: process.execPath,
          args: ["-e", "setTimeout(() => {}, 60000);"],
          parser: "text",
          purpose: "Test spec timeout precedence.",
          phase: "collector-v1",
          timeoutMs: 250,
        },
        { trace },
      ),
    (error) => {
      assert.equal(error.issue, "timeout");
      return true;
    },
  );

  const activity = trace.activities.find((entry) => entry.kind === "command");
  assert.ok(Date.now() - startedAt < 10000);
  assert.ok(activity, "spawn activity recorded");
});

test("runCommand reports dry-run blocks without diagnostics or warnings", async () => {
  const trace = createCollectorTrace();

  await assert.rejects(
    () =>
      runCommand(
        {
          id: "dry-run-probe",
          category: "platform",
          command: process.execPath,
          args: ["-e", "process.stdout.write('never runs');"],
          parser: "text",
          purpose: "Test dry-run classification.",
          phase: "collector-v1",
        },
        { trace, dryRun: true },
      ),
    (error) => {
      assert.equal(error.code, "CDX_HBOM_DRY_RUN");
      assert.equal(error.issue, "dry-run");
      assert.equal(error.suppressedDiagnostic, true);
      assert.equal(error.privilegeHint, undefined);
      return true;
    },
  );

  assert.deepEqual(
    trace.activities.map((entry) => `${entry.kind}:${entry.status}`),
    ["command:blocked"],
  );
});

test("runCommand summarizes windows-envelope targets by script digest", async () => {
  const { WINDOWS_COMMANDS } = await import(
    "../src/windows/common/commands.js"
  );
  const { createHash } = await import("node:crypto");
  const trace = createCollectorTrace();
  const spec = WINDOWS_COMMANDS[0];

  await assert.rejects(
    () => runCommand(spec, { trace, dryRun: true }),
    (error) => {
      assert.equal(error.issue, "dry-run");
      return true;
    },
  );

  const activity = trace.activities.find((entry) => entry.kind === "command");
  const digest = createHash("sha256")
    .update(spec.args.at(-1))
    .digest("hex")
    .slice(0, 12);
  assert.equal(
    activity.target,
    `${spec.command} -Command ${spec.id} script sha256:${digest}`,
  );
  // The full script stays auditable through args/requestedArgs.
  assert.deepEqual(activity.args, spec.args);
  assert.deepEqual(activity.requestedArgs, spec.args);
});
