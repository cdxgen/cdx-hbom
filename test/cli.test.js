import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("mini CLI prints help text", () => {
  const result = spawnSync(process.execPath, ["./bin/cdx-hbom.js", "--help"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/u);
  assert.match(result.stdout, /--privileged/u);
});

test("mini CLI prints version", () => {
  const result = spawnSync(
    process.execPath,
    ["./bin/cdx-hbom.js", "--version"],
    {
      cwd: projectRoot,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0);
});

test("mini CLI fails for unknown arguments", () => {
  const result = spawnSync(process.execPath, ["./bin/cdx-hbom.js", "--nope"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument/u);
});
