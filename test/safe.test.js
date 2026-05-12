import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  commandsExecuted,
  safeExistsSync,
  safeMkdirSync,
  safeReadFileSync,
  safeSpawnSync,
} from "../index.js";

test("safeExistsSync reports existing and missing paths without throwing", () => {
  assert.equal(safeExistsSync(process.cwd()), true);
  assert.equal(safeExistsSync(join(process.cwd(), "definitely-missing-path")), false);
});

test("safeMkdirSync creates a directory and treats EEXIST as success", () => {
  const root = mkdtempSync(join(tmpdir(), "cdx-hbom-safe-"));
  const directory = join(root, "nested");

  assert.equal(safeMkdirSync(directory, { recursive: true }), directory);
  assert.equal(safeMkdirSync(directory, { recursive: true }), directory);
  assert.equal(safeExistsSync(directory), true);

  rmSync(root, { force: true, recursive: true });
});

test("safeReadFileSync returns a Buffer when encoding null is requested", () => {
  const root = mkdtempSync(join(tmpdir(), "cdx-hbom-safe-"));
  const filePath = join(root, "binary.bin");

  writeFileSync(filePath, Buffer.from([0x00, 0xe0, 0x41, 0x71]));

  const result = safeReadFileSync(filePath, { encoding: null });

  assert.equal(Buffer.isBuffer(result), true);
  assert.equal(result?.toString("hex"), "00e04171");

  rmSync(root, { force: true, recursive: true });
});

test("safeSpawnSync executes allowed commands and tracks them", () => {
  commandsExecuted.clear();
  const result = safeSpawnSync(
    process.execPath,
    ["-e", "console.log('ok')"],
    {
      allowedCommands: [basename(process.execPath)],
    },
  );

  assert.equal(result.status, 0);
  assert.match(String(result.stdout), /ok/u);
  assert.equal(commandsExecuted.has(process.execPath), true);
});

test("safeSpawnSync blocks commands outside the allowlist", () => {
  const result = safeSpawnSync(process.execPath, ["-e", "console.log('blocked')"], {
    allowedCommands: ["echo"],
  });

  assert.equal(result.status, 1);
  assert.match(String(result.error?.message), /allowlist/u);
});
