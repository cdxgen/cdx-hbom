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
//   volume path: \\?\Volume{GUID}\ keeps its framing, GUID redacted
//   numeric:     same digit count with every digit turned into 4
//   literal:     REDACTED-LITERAL
//
// The script rewrites `*.stdout` files in place at the byte level (only the
// targeted values change) and exits non-zero if any literal survives. On
// success it removes `literals.txt` so the directory is safe to commit.

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { isPlaceholderIdentity } from "../../src/common/shape.js";
import {
  WINDOWS_COMMANDS,
  WINDOWS_SELFTEST_COMMAND,
} from "../../src/windows/common/commands.js";
import {
  getInstanceSegment,
  redactHardwareIds,
  redactInstanceId,
} from "../../src/windows/common/pnp.js";

const GUID_PATTERN = /^\{?([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\}?$/u;
// MAC shapes: separated 6-pair form, plus the bare 12-hex form
// MSFT_NetAdapter.PermanentAddress uses (observed on win11-vm).
const MAC_PATTERN = /^(?:([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}|[0-9A-Fa-f]{12})$/u;
const MAC_FIELD_PATTERN = /Address/iu;
const PNP_FIELD_NAMES = new Set([
  "PNPDeviceID",
  // MSFT_NetAdapter and other CIM-derived classes spell it PnPDeviceID.
  "PnPDeviceID",
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
// Messages describe survivors by position and length only: this script also
// runs in public CI logs (windows-capture.yml), so it never prints a value.
const survivors = [];
for (const name of files) {
  survivors.push(...redactFile(join(directory, name)));
}
for (const name of files) {
  const text = readFileSync(join(directory, name), "utf8");
  literals.forEach((literal, index) => {
    if (containsLiteral(text, literal)) {
      survivors.push(`${name}: literal #${index + 1} (${literal.length} chars)`);
    }
  });
}
if (survivors.length > 0) {
  console.error(`redact-fixtures: raw values still present after redaction:`);
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
 * @returns {string[]} Survivors: sensitive values still present afterwards.
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
    // Generic scans first: MAC-shaped and PnP-instance replacements then win
    // over the plain serial fallback an explicit path would otherwise pick.
    collectGenericFields(envelope, sensitive);
    for (const field of spec?.sensitiveFields ?? []) {
      collectSensitiveField(envelope, field, sensitive);
    }
  }

  const replacements = sensitive
    .map((value) => [value, replacementFor(value)])
    .filter(([value, replacement]) => value !== replacement);

  // Replace whole JSON string tokens only. A substring match would rewrite
  // unrelated values that merely contain a short serial. The same value in
  // any other string field is still replaced, which keeps joins stable.
  // Numeric sensitive values (for example Win32_Volume.SerialNumber, a
  // uint32) keep their JSON number form and are replaced as digit-bounded
  // tokens so they never match part of a longer number.
  for (const [value, replacement] of replacements) {
    if (typeof value === "number") {
      text = text.replaceAll(
        new RegExp(`(?<![0-9.])${value}(?![0-9.])`, "gu"),
        String(replacement),
      );
    } else {
      text = text.replaceAll(
        new RegExp(`"${jsonTextPattern(value)}"`, "g"),
        () => `"${escapeJson(replacement)}"`,
      );
    }
  }

  for (const literal of literals) {
    text = text.replaceAll(
      literalPattern(literal),
      () => escapeJson(LITERAL_REPLACEMENT),
    );
  }

  if (text !== original) {
    writeFileSync(filePath, text, "utf8");
  }

  // Token replacement misses a sensitive value embedded in a longer string,
  // and a raw PnP instance segment can be repeated in another field, so fail
  // closed instead. Values of 4 characters or fewer are skipped: they are too
  // short to identify a host, and redactIdentifier treats them the same.
  const leftovers = [
    ...replacements.map(([value]) => value),
    ...collectRawInstanceSegments(envelope),
  ];
  return leftovers
    .filter((value) => String(value).length > 4)
    .filter((value) =>
      typeof value === "number"
        ? new RegExp(`(?<![0-9.])${value}(?![0-9.])`, "u").test(text)
        : new RegExp(jsonTextPattern(value), "u").test(text),
    )
    .map(
      (value) =>
        `${fileName(filePath)}.stdout: sensitive value (${String(value).length} chars) still present`,
    );
}

/**
 * Collect the raw (not yet redacted) PnP instance segments of an envelope.
 *
 * @param {object | undefined} envelope Parsed envelope.
 * @returns {string[]} Raw instance segments.
 */
function collectRawInstanceSegments(envelope) {
  const segments = [];
  for (const result of Object.values(envelope?.results ?? {})) {
    for (const item of [...(result?.items ?? [])]) {
      const segment = getInstanceSegment(item?.PNPDeviceID ?? item?.PnPDeviceID);
      if (segment && !segment.startsWith("redacted")) {
        segments.push(segment);
      }
    }
  }
  return segments;
}

/**
 * Collect values of one `resultKey.field` sensitive path.
 *
 * Fields holding PnP identifiers always redact through the instance-segment
 * rule (two-part hardware IDs pass through unchanged), so listing them in a
 * spec's `sensitiveFields` documents sensitivity without mangling whole IDs.
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
  const transform = PNP_FIELD_NAMES.has(name) ? redactInstanceId : undefined;
  for (const item of [...(result?.items ?? [])]) {
    collectFieldValue(item, name, sensitive, transform, true);
  }
  if (result?.values) {
    collectFieldValue(result.values, name, sensitive, transform, true);
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
      const instanceId = item.PNPDeviceID ?? item.PnPDeviceID;
      for (const [name, value] of Object.entries(item)) {
        if (PNP_FIELD_NAMES.has(name)) {
          collectFieldValue(item, name, sensitive, (entry) =>
            redactHardwareIds([redactInstanceId(entry)], instanceId)[0],
          );
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
 * Collect string and numeric values of one item field.
 *
 * Numeric sensitive values (uint32 serials such as
 * `Win32_Volume.SerialNumber`) serialize as JSON numbers; they are redacted
 * with the digit count preserved so the fixture keeps a number in that
 * position. Numbers count as sensitive only at explicit `sensitiveFields`
 * paths — the generic MAC-shape scan over `*Address*` field names must not
 * swallow unrelated numbers such as `AddressWidth`.
 *
 * @param {object} item CIM instance object.
 * @param {string} name Field name.
 * @param {string[]} sensitive Collector array.
 * @param {(value: string) => string} [transform] Optional explicit replacement fn.
 * @param {boolean} [allowNumbers=false] Whether numeric values are sensitive here.
 * @returns {void} Nothing.
 */
function collectFieldValue(
  item,
  name,
  sensitive,
  transform = undefined,
  allowNumbers = false,
) {
  const value = item?.[name];
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    if (typeof entry === "number") {
      if (
        allowNumbers &&
        Number.isFinite(entry) &&
        replacementFor(entry) !== entry
      ) {
        sensitive.push(entry);
      }
      continue;
    }
    if (typeof entry !== "string" || entry.trim().length === 0) {
      continue;
    }
    if (transform) {
      const replacement = transform(entry);
      if (replacement !== entry) {
        assignments.set(entry, replacement);
        sensitive.push(entry);
      }
    } else if (!isPlaceholderIdentity(entry)) {
      // Placeholders such as Hyper-V's `None` identify nothing, and many
      // unrelated fields share them, so they stay as captured.
      sensitive.push(entry);
    }
  }
}

/**
 * Compute (or look up) the deterministic replacement for a sensitive value.
 *
 * @param {string | number} value Raw value.
 * @returns {string | number} Replacement value.
 */
function replacementFor(value) {
  if (assignments.has(value)) {
    return assignments.get(value);
  }

  if (typeof value === "number") {
    // Same digit count with every digit replaced by 4: type-stable,
    // format-preserving and idempotent (an all-4s value maps to itself), at
    // the cost of collapsing distinct numeric serials into one placeholder.
    const replacement = Number(String(value).replace(/\d/gu, "4"));
    assignments.set(value, replacement);
    return replacement;
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
 * Build a regex source matching a value as it appears in captured JSON text.
 *
 * Windows PowerShell's `ConvertTo-Json` HTML-escapes `& < > '` as
 * `\u0026`-style sequences (observed in VM-FINDINGS §3), while plain JSON
 * keeps them literal, so each such character matches either form. Backslashes
 * and quotes match their JSON-escaped spellings.
 *
 * @param {string} value Raw value.
 * @returns {string} Regex source.
 */
function jsonTextPattern(value) {
  const bs = "\\";
  let source = "";
  for (const ch of value) {
    if (ch === bs) {
      source += `${bs}${bs}${bs}${bs}`;
    } else if (ch === '"') {
      source += `${bs}${bs}"`;
    } else if (ch === "&") {
      source += `(?:${bs}${bs}u0026|&)`;
    } else if (ch === "<") {
      source += `(?:${bs}${bs}u003c|<)`;
    } else if (ch === ">") {
      source += `(?:${bs}${bs}u003e|>)`;
    } else if (ch === "'") {
      source += `(?:${bs}${bs}u0027|')`;
    } else if (ch === "\n") {
      source += `${bs}n`;
    } else if (ch === "\r") {
      source += `${bs}r`;
    } else if (ch === "\t") {
      source += `${bs}t`;
    } else if ("*+?^${}()|[]".includes(ch)) {
      source += bs + ch;
    } else {
      source += ch;
    }
  }
  return source;
}

/**
 * Build a case-insensitive pattern matching a literal in captured JSON text.
 *
 * @param {string} literal Literal value.
 * @returns {RegExp} Pattern with the `g` and `i` flags.
 */
function literalPattern(literal) {
  return new RegExp(jsonTextPattern(literal), "gi");
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
