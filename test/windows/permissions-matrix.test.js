import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPermissionsMatrix,
  describeResult,
  extractPermissionsMatrix,
  renderPermissionsMatrix,
} from "../../scripts/windows/permissions-matrix.mjs";
import { WINDOWS_COMMANDS } from "../../src/windows/common/commands.js";

const TROUBLESHOOTING = fileURLToPath(
  new URL("../../windows-troubleshooting.md", import.meta.url),
);

test("the committed Windows permissions matrix matches the fixtures", () => {
  const committed = extractPermissionsMatrix(
    // Windows checkouts may convert docs to CRLF (core.autocrlf).
    readFileSync(TROUBLESHOOTING, "utf8").replaceAll("\r\n", "\n"),
  );
  const generated = renderPermissionsMatrix(buildPermissionsMatrix());
  assert.equal(
    committed,
    generated,
    "windows-troubleshooting.md drifted from the fixtures; run `node scripts/windows/permissions-matrix.mjs --update windows-troubleshooting.md`",
  );
});

test("the matrix covers every collector command and the three standard VM tokens", () => {
  const matrix = buildPermissionsMatrix();
  for (const label of ["vm-parallels-elevated", "vm-parallels-std-local", "vm-parallels-std-network"]) {
    assert.ok(matrix.labels.includes(label), label);
  }
  const commands = new Set(matrix.rows.map((row) => row.source.split(":")[0]));
  for (const spec of WINDOWS_COMMANDS) {
    assert.ok(commands.has(spec.id), `${spec.id} has no row`);
  }
  // Rows only ever carry the documented vocabulary.
  const vocabulary = /^(ok(?: \((?:true|false)\))?|empty|denied(?: \(short-circuited\))?|absent|error|not captured)$/u;
  for (const row of matrix.rows) {
    for (const [label, outcome] of Object.entries(row.outcomes)) {
      assert.match(outcome, vocabulary, `${row.source} ${label}: ${outcome}`);
    }
  }
  // The documented claims: the privileged classes are denied to a standard
  // local user, the registry stays readable over a network logon, and the
  // smphost-stopped capture is the only empty MSFT_PhysicalDisk.
  const outcome = (source, label) => matrix.rows.find((row) => row.source === source).outcomes[label];
  for (const key of ["tpm", "encryptableVolume", "storageReliability", "secureBootCmdlet"]) {
    assert.equal(outcome(`windows-cim-privileged:${key}`, "vm-parallels-std-local"), "denied", key);
  }
  assert.equal(outcome("windows-cim-trust:secureBootState", "vm-parallels-std-network"), "ok");
  assert.equal(outcome("windows-cim-storage-network:physicalDisk", "vm-parallels-std-local-smp-stopped"), "empty");
  assert.equal(outcome("windows-cim-storage-network:physicalDisk", "vm-parallels-std-local"), "ok");
});

test("describeResult maps envelope results to the documented vocabulary", () => {
  assert.equal(describeResult(undefined), "not captured");
  assert.equal(describeResult({ ok: true, items: [{}] }), "ok");
  assert.equal(describeResult({ ok: true, items: [] }), "empty");
  assert.equal(describeResult({ ok: true, kind: "registry", values: { X: 1 } }), "ok");
  assert.equal(describeResult({ ok: true, kind: "cmdlet-scalar", value: true }), "ok (true)");
  assert.equal(describeResult({ ok: false, error: { nativeErrorCode: "AccessDenied", statusCode: 2 } }), "denied");
  assert.equal(
    describeResult({ ok: false, shortCircuited: true, error: { nativeErrorCode: "AccessDenied" } }),
    "denied (short-circuited)",
  );
  assert.equal(
    describeResult({ ok: false, error: { fqid: "SetPrivilegeFailed,Foo", category: "PermissionDenied" } }),
    "denied",
  );
  assert.equal(describeResult({ ok: false, error: { nativeErrorCode: "InvalidClass", statusCode: 5 } }), "absent");
  assert.equal(
    describeResult({ ok: false, error: { fqid: "PathNotFound,Microsoft.PowerShell.Commands.GetChildItemCommand", category: "ObjectNotFound" } }),
    "absent",
  );
  assert.equal(describeResult({ ok: false, error: { nativeErrorCode: "NotSupported", statusCode: 7 } }), "error");
});
