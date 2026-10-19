#!/usr/bin/env node
// Capture Windows CIM command output for repo fixtures. Runs on Windows only,
// inside a checkout of this repository:
//
//   node scripts/windows/capture-fixtures.mjs --out tmp/capture --label vm-parallels-elevated [--selftest] [--commands id1,id2] [--literal value]
//
// Each requested registry command runs through the real `runCommand` path and
// its stdout is stored byte-exact as `<id>.stdout` plus one `manifest.json`
// (see PLAN.md §5.2). Host and user strings are written to `literals.txt` for
// the redactor; delete nothing by hand — `redact-fixtures.mjs` consumes and
// removes the file.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import process from "node:process";

import { runCommand } from "../../src/common/command.js";
import { parseWindowsEnvelope } from "../../src/windows/common/cim.js";
import {
  WINDOWS_COMMANDS,
  WINDOWS_SELFTEST_COMMAND,
} from "../../src/windows/common/commands.js";

// Win32_Processor.Architecture value map (MS Learn):
// https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-processor
const PROCESSOR_ARCHITECTURE_BY_CODE = new Map([
  [9, "amd64"],
  [12, "arm64"],
]);

const options = parseArgs(process.argv.slice(2));

if (process.platform !== "win32") {
  console.error(
    "capture-fixtures.mjs must run on Windows; it captures live CIM output",
  );
  process.exit(1);
}
if (!options.out || !options.label) {
  console.error("--out <dir> and --label <label> are required");
  process.exit(2);
}

const specs = selectSpecs(options.commands, options.selftest);
const literals = collectLiterals(options.literals);

mkdirSync(options.out, { recursive: true });

const manifest = {
  label: options.label,
  capturedAt: new Date().toISOString(),
  nodeVersion: process.version,
  processArch: process.arch,
  osRelease: os.release(),
  hardwareArch: undefined,
  elevated: undefined,
  languageMode: undefined,
  psVersion: undefined,
  commands: [],
};

for (const spec of specs) {
  const startedAt = Date.now();
  let stdout = "";
  let exitCode = 0;
  try {
    stdout = await runCommand(spec, {});
  } catch (error) {
    exitCode = error.exitCode ?? 1;
    stdout = error.stdout ?? "";
  }
  const durationMs = Date.now() - startedAt;

  writeFileSync(join(options.out, `${spec.id}.stdout`), stdout, "utf8");

  manifest.commands.push({
    id: spec.id,
    argsSha256: createHash("sha256")
      .update(JSON.stringify(spec.args))
      .digest("hex"),
    exitCode,
    durationMs,
    bytes: Buffer.byteLength(stdout, "utf8"),
    provenance: "captured",
  });

  absorbEnvelopeMeta(stdout, spec);
  console.log(
    `${spec.id}: exit ${exitCode}, ${durationMs} ms, ${Buffer.byteLength(stdout, "utf8")} bytes`,
  );
}

writeFileSync(
  join(options.out, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
writeFileSync(join(options.out, "literals.txt"), `${[...literals].join("\n")}\n`, "utf8");

console.log(`captured ${manifest.commands.length} commands to ${options.out}`);

/**
 * Parse CLI flags.
 *
 * @param {string[]} argv Argument vector.
 * @returns {{ out?: string, label?: string, commands?: string[], selftest?: boolean, literals: string[] }} Options.
 */
function parseArgs(argv) {
  const result = { literals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      result.out = argv[++index];
    } else if (arg === "--label") {
      result.label = argv[++index];
    } else if (arg === "--commands") {
      result.commands = String(argv[++index] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    } else if (arg === "--selftest") {
      result.selftest = true;
    } else if (arg === "--literal") {
      result.literals.push(argv[++index]);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return result;
}

/**
 * Select the specs to capture.
 *
 * @param {string[] | undefined} requested Optional command id filter.
 * @param {boolean | undefined} selftest Append the selftest command.
 * @returns {ReadonlyArray<object>} Selected specs.
 */
function selectSpecs(requested, selftest) {
  let specs = WINDOWS_COMMANDS;
  if (requested) {
    specs = WINDOWS_COMMANDS.filter((spec) => requested.includes(spec.id));
    const unknown = requested.filter(
      (id) => !WINDOWS_COMMANDS.some((spec) => spec.id === id),
    );
    if (unknown.length > 0) {
      console.error(`Unknown Windows command ids: ${unknown.join(", ")}`);
      process.exit(2);
    }
  }
  return selftest ? [...specs, WINDOWS_SELFTEST_COMMAND] : [...specs];
}

/**
 * Gather literal strings the redactor must scrub.
 *
 * The hostname and user names are not selected by any manifest property, but
 * they can surface incidentally (device descriptions, driver providers), so
 * they are passed as defense in depth.
 *
 * @param {string[]} explicit Literals from `--literal` flags.
 * @returns {Set<string>} Deduplicated literals.
 */
function collectLiterals(explicit) {
  const values = new Set(
    [
      ...explicit,
      os.hostname(),
      os.userInfo().username,
      process.env.COMPUTERNAME,
      process.env.USERNAME,
      process.env.USERDOMAIN,
    ].filter((value) => typeof value === "string" && value.length > 0),
  );
  return values;
}

/**
 * Absorb envelope metadata into the manifest.
 *
 * @param {string} stdout Captured stdout.
 * @param {{ id: string }} spec Executed spec.
 * @returns {void} Nothing; mutates the manifest.
 */
function absorbEnvelopeMeta(stdout, spec) {
  let envelope;
  try {
    envelope = parseWindowsEnvelope(stdout);
  } catch {
    return;
  }

  if (manifest.elevated === undefined) {
    manifest.elevated = envelope.meta.elevated;
    manifest.languageMode = envelope.meta.languageMode;
    manifest.psVersion = envelope.meta.psVersion;
  }

  const architecture = envelope.results.processor?.items?.[0]?.Architecture;
  const hardwareArch = PROCESSOR_ARCHITECTURE_BY_CODE.get(
    Number(architecture),
  );
  if (spec.id === "windows-cim-platform" && hardwareArch) {
    manifest.hardwareArch = hardwareArch;
  } else if (manifest.hardwareArch === undefined && hardwareArch) {
    manifest.hardwareArch = hardwareArch;
  }
}
