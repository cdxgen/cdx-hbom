#!/usr/bin/env node
// Deterministically redact captured Windows fixtures in a directory:
//
//   node scripts/windows/redact-fixtures.mjs <dir> [--literal value]...
//
// Inputs: each spec's `sensitiveFields` (envelope paths such as
// `bios.SerialNumber`), PnP instance segments and MAC-like tokens in
// `PNPDeviceID`/`DeviceID`/`HardwareID`/`CompatibleID`/`InstanceName` values,
// MAC-shaped values in fields named `*Address*`/`MACAddress`, and every
// `--literal` value (plus `literals.txt` written by capture-fixtures.mjs).
//
// Replacements are format-preserving and stable per value across the whole
// directory, so joins between files survive:
//   serial-like: REDACTED-SERIAL-0001
//   GUID:        00000000-0000-4000-8000-0000000000NN (braces and case kept)
//   MAC:         02-00-00-00-00-NN (separators and case kept)
//   literal:     REDACTED-LITERAL
//
// The script rewrites `*.stdout` files in place at the byte level (only the
// targeted values change) and exits non-zero if any literal survives. On
// success it removes `literals.txt` so the directory is safe to commit.

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import {
  WINDOWS_COMMANDS,
  WINDOWS_SELFTEST_COMMAND,
} from "../../src/windows/common/commands.js";
import { redactInstanceId } from "../../src/windows/common/pnp.js";

const GUID_PATTERN = /^\{?([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\}?$/u;
const MAC_PATTERN = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/u;
const MAC_FIELD_PATTERN = /Address/iu;
const PNP_FIELD_NAMES = new Set([
  "PNPDeviceID",
  "DeviceID",
  "HardwareID",
  "CompatibleID",
  "InstanceName",
]);
const LITERAL_REPLACEMENT = "REDACTED-LITERAL";

// Values produced by this redactor (and by `redactInstanceId`) are stable on
// re-processing.
const ALREADY_REDACTED =
  /^(?:REDACTED-SERIAL-\d+|REDACTED-LITERAL|\{?00000000-0000-4000-8000-0000000000\d{2}\}?|02[:-]00[:-]00[:-]00[:-]00[:-][0-9a-f]{2}|redacted:.*)$/iu;

const directory = process.argv[2];
const explicitLiterals = [];
for (let index = 3; index < process.argv.length; index += 1) {
  if (process.argv[index] === "--literal") {
    explicitLiterals.push(process.argv[++index]);
  }
}

if (!directory) {
  console.error("usage: redact-fixtures.mjs <dir> [--literal value]...");
  process.exit(2);
}

const literals = loadLiterals(directory, explicitLiterals);
const specsById = new Map(
  [...WINDOWS_COMMANDS, WINDOWS_SELFTEST_COMMAND].map((spec) => [spec.id, spec]),
);

// Deterministic value -> replacement map shared across every file.
const assignments = new Map();
const counters = { serial: 0, guid: 0, mac: 0 };

const files = readdirSync(directory).filter((name) =>
  name.endsWith(".stdout"),
);
for (const name of files) {
  redactFile(join(directory, name));
}

const survivors = [];
for (const name of files) {
  const text = readFileSync(join(directory, name), "utf8");
  for (const literal of literals) {
    if (containsLiteral(text, literal)) {
      survivors.push(`${name}: ${literal}`);
    }
  }
}
if (survivors.length > 0) {
  console.error(`redact-fixtures: literals still present after redaction:`);
  for (const survivor of survivors) {
    console.error(`  ${survivor}`);
  }
  process.exit(1);
}

const literalsPath = join(directory, "literals.txt");
if (existsSync(literalsPath)) {
  rmSync(literalsPath);
}
console.log(`redacted ${files.length} files in ${directory}`);

/**
 * Load every literal the redactor must scrub.
 *
 * @param {string} directory Capture directory.
 * @param {string[]} explicit Literals from `--literal` flags.
 * @returns {string[]} Deduplicated literals.
 */
function loadLiterals(directory, explicit) {
  const values = new Set(explicit.filter((value) => value && value.length > 0));
  const literalsPath = join(directory, "literals.txt");
  if (existsSync(literalsPath)) {
    for (const line of readFileSync(literalsPath, "utf8").split(/\r?\n/u)) {
      if (line.trim().length > 0) {
        values.add(line.trim());
      }
    }
  }
  return [...values];
}

/**
 * Redact one captured stdout file in place.
 *
 * @param {string} filePath File to redact.
 * @returns {void} Nothing.
 */
function redactFile(filePath) {
  const original = readFileSync(filePath, "utf8");
  let text = original;

  const spec = specsById.get(fileName(filePath));
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    envelope = undefined;
  }

  const sensitive = [];
  if (envelope?.results) {
    for (const field of spec?.sensitiveFields ?? []) {
      collectSensitiveField(envelope, field, sensitive);
    }
    collectGenericFields(envelope, sensitive);
  }

  const replacements = sensitive
    .map((value) => [value, replacementFor(value)])
    .filter(([value, replacement]) => value !== replacement);

  // Longest first so a value that contains another targeted value as a
  // substring is replaced before its inner part can match.
  replacements.sort((a, b) => b[0].length - a[0].length);
  for (const [value, replacement] of replacements) {
    text = text.replaceAll(
      escapeJson(value),
      escapeJson(replacement),
    );
  }

  for (const literal of literals) {
    text = text.replace(
      literalPattern(literal),
      escapeJson(LITERAL_REPLACEMENT),
    );
  }

  if (text !== original) {
    writeFileSync(filePath, text, "utf8");
  }
}

/**
 * Collect values of one `resultKey.field` sensitive path.
 *
 * @param {object} envelope Parsed envelope.
 * @param {string} field Path such as `bios.SerialNumber`.
 * @param {string[]} sensitive Collector array.
 * @returns {void} Nothing.
 */
function collectSensitiveField(envelope, field, sensitive) {
  const separator = field.indexOf(".");
  if (separator === -1) {
    return;
  }
  const result = envelope.results?.[field.slice(0, separator)];
  const name = field.slice(separator + 1);
  for (const item of [...(result?.items ?? [])]) {
    collectFieldValue(item, name, sensitive);
  }
  if (result?.values) {
    collectFieldValue(result.values, name, sensitive);
  }
}

/**
 * Collect MAC-shaped and PnP instance values from every result.
 *
 * @param {object} envelope Parsed envelope.
 * @param {string[]} sensitive Collector array.
 * @returns {void} Nothing.
 */
function collectGenericFields(envelope, sensitive) {
  for (const result of Object.values(envelope.results ?? {})) {
    for (const item of [...(result?.items ?? [])]) {
      if (!item || typeof item !== "object") {
        continue;
      }
      for (const [name, value] of Object.entries(item)) {
        if (PNP_FIELD_NAMES.has(name)) {
          collectFieldValue(item, name, sensitive, redactInstanceId);
          continue;
        }
        if (MAC_FIELD_PATTERN.test(name)) {
          collectFieldValue(item, name, sensitive, macReplacement);
        }
      }
    }
  }
}

/**
 * Collect string values of one item field.
 *
 * @param {object} item CIM instance object.
 * @param {string} name Field name.
 * @param {string[]} sensitive Collector array.
 * @param {(value: string) => string} [transform] Optional explicit replacement fn.
 * @returns {void} Nothing.
 */
function collectFieldValue(item, name, sensitive, transform = undefined) {
  const value = item?.[name];
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      continue;
    }
    if (transform) {
      const replacement = transform(entry);
      if (replacement !== entry) {
        assignments.set(entry, replacement);
        sensitive.push(entry);
      }
    } else {
      sensitive.push(entry);
    }
  }
}

/**
 * Compute (or look up) the deterministic replacement for a sensitive value.
 *
 * @param {string} value Raw value.
 * @returns {string} Replacement value.
 */
function replacementFor(value) {
  if (assignments.has(value)) {
    return assignments.get(value);
  }

  // Already-redacted values pass through unchanged, so re-running the
  // redactor over a redacted directory cannot churn stable joins.
  if (ALREADY_REDACTED.test(value)) {
    assignments.set(value, value);
    return value;
  }

  let replacement;
  if (GUID_PATTERN.test(value)) {
    counters.guid += 1;
    const guid = `00000000-0000-4000-8000-0000000000${pad(counters.guid, 2)}`;
    replacement = value.startsWith("{")
      ? `{${guid}}`
      : /[A-F]/.test(value.replace(/[^0-9A-Fa-f]/gu, ""))
        ? guid.toUpperCase()
        : guid;
  } else if (MAC_PATTERN.test(value)) {
    counters.mac += 1;
    const suffix = pad(counters.mac, 2);
    const separator = value.includes(":") ? ":" : "-";
    replacement = `02${separator}00${separator}00${separator}00${separator}00${separator}${suffix}`;
  } else {
    counters.serial += 1;
    replacement = `REDACTED-SERIAL-${pad(counters.serial, 4)}`;
  }

  assignments.set(value, replacement);
  return replacement;
}

/**
 * Compute the MAC replacement for a MAC-shaped value.
 *
 * @param {string} value Raw value.
 * @returns {string} Replacement value.
 */
function macReplacement(value) {
  return replacementFor(value);
}

/**
 * Zero-pad a counter.
 *
 * @param {number} value Counter value.
 * @param {number} width Digit width.
 * @returns {string} Padded decimal.
 */
function pad(value, width) {
  return String(value).padStart(width, "0");
}

/**
 * JSON-escape a string the way it appears inside a JSON document.
 *
 * @param {string} value Raw value.
 * @returns {string} Escaped value.
 */
function escapeJson(value) {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * Build a case-insensitive pattern matching a literal in raw or JSON-escaped text.
 *
 * @param {string} literal Literal value.
 * @returns {RegExp} Pattern with the `g` flag.
 */
function literalPattern(literal) {
  const alternatives = [literal, escapeJson(literal)]
    .filter((candidate) => candidate.length > 0)
    .map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return new RegExp(alternatives.join("|"), "gi");
}

/**
 * Report whether a literal occurs in redacted text.
 *
 * @param {string} text File text.
 * @param {string} literal Literal value.
 * @returns {boolean} True when present.
 */
function containsLiteral(text, literal) {
  return literalPattern(literal).test(text);
}

/**
 * Extract the file name without extensions.
 *
 * @param {string} filePath File path.
 * @returns {string} Base name.
 */
function fileName(filePath) {
  return filePath.split(/[\\/]/u).at(-1).replace(/\.stdout$/u, "");
}
