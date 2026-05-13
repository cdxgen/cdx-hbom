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
      assert.match(error.privilegeHint, /--privileged/u);
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
