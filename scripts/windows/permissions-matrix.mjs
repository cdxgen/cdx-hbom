#!/usr/bin/env node
// Generate the Windows permissions matrix from the committed fixtures:
//
//   node scripts/windows/permissions-matrix.mjs                              # markdown table on stdout
//   node scripts/windows/permissions-matrix.mjs --json                       # machine-readable form
//   node scripts/windows/permissions-matrix.mjs --update windows-troubleshooting.md
//
// Every row is one envelope result (`<command>:<key>`) of a collector command;
// every column is one captured label under test/fixtures/windows/<arch>/, so
// the table states only what a real capture showed. The committed copy lives
// in windows-troubleshooting.md between the permissions-matrix markers, and
// test/windows/permissions-matrix.test.js fails when it drifts.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseWindowsEnvelope } from "../../src/windows/common/cim.js";
import { WINDOWS_COMMANDS } from "../../src/windows/common/commands.js";

const FIXTURES_ROOT = fileURLToPath(new URL("../../test/fixtures/windows", import.meta.url));

/**
 * Preferred column order: the three standard VM tokens first, then the
 * service-state variant, then the GitHub-hosted runners.
 */
const LABEL_ORDER = [
  "vm-parallels-elevated",
  "vm-parallels-std-local",
  "vm-parallels-std-local-smp-stopped",
  "vm-parallels-std-network",
  "windows-2025-gha",
  "windows-11-arm-gha",
];

/**
 * Short column headings for the labels.
 */
const LABEL_HEADINGS = {
  "vm-parallels-elevated": "admin",
  "vm-parallels-std-local": "std-local",
  "vm-parallels-std-local-smp-stopped": "std-local, smphost stopped",
  "vm-parallels-std-network": "std-network",
  "windows-2025-gha": "GitHub windows-2025 (admin)",
  "windows-11-arm-gha": "GitHub windows-11-arm (admin)",
};

/**
 * Build the matrix from the fixture tree.
 *
 * @returns {{ labels: string[], rows: Array<{ source: string, outcomes: Record<string, string> }> }} Matrix.
 */
export function buildPermissionsMatrix() {
  const labels = [];
  const envelopes = new Map();
  for (const arch of directories(FIXTURES_ROOT)) {
    for (const label of directories(join(FIXTURES_ROOT, arch))) {
      const manifestPath = join(FIXTURES_ROOT, arch, label, "manifest.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      labels.push(label);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      for (const command of manifest.commands) {
        const path = join(FIXTURES_ROOT, arch, label, `${command.id}.stdout`);
        if (!existsSync(path)) {
          continue;
        }
        let envelope;
        try {
          envelope = parseWindowsEnvelope(readFileSync(path, "utf8"));
        } catch {
          continue;
        }
        envelopes.set(`${label}|${command.id}`, envelope);
      }
    }
  }
  labels.sort(
    (a, b) =>
      (LABEL_ORDER.indexOf(a) === -1 ? 99 : LABEL_ORDER.indexOf(a)) -
        (LABEL_ORDER.indexOf(b) === -1 ? 99 : LABEL_ORDER.indexOf(b)) || a.localeCompare(b),
  );

  const rows = [];
  for (const spec of WINDOWS_COMMANDS) {
    const keys = new Set();
    for (const label of labels) {
      const envelope = envelopes.get(`${label}|${spec.id}`);
      for (const key of Object.keys(envelope?.results ?? {})) {
        keys.add(key);
      }
    }
    for (const key of keys) {
      const outcomes = {};
      for (const label of labels) {
        const envelope = envelopes.get(`${label}|${spec.id}`);
        outcomes[label] = envelope ? describeResult(envelope.results[key]) : "not captured";
      }
      rows.push({ source: `${spec.id}:${key}`, outcomes });
    }
  }
  return { labels, rows };
}

/**
 * Describe one envelope result with the vocabulary of the end-user docs.
 *
 * @param {object | undefined} result Envelope result.
 * @returns {string} One of ok, empty, denied, absent, error, not captured.
 */
export function describeResult(result) {
  if (!result) {
    return "not captured";
  }
  if (result.ok === true) {
    if (result.kind === "registry") {
      return Object.keys(result.values ?? {}).length > 0 ? "ok" : "empty";
    }
    if (result.kind === "cmdlet-scalar") {
      return `ok (${String(result.value)})`;
    }
    return (result.items ?? []).length > 0 ? "ok" : "empty";
  }
  const error = result.error ?? {};
  if (
    error.nativeErrorCode === "AccessDenied" ||
    Number(error.statusCode) === 2 ||
    /^SetPrivilegeFailed,/u.test(String(error.fqid ?? "")) ||
    error.category === "PermissionDenied"
  ) {
    return result.shortCircuited ? "denied (short-circuited)" : "denied";
  }
  if (
    ["InvalidNamespace", "InvalidClass", "NotFound", "NoProperties"].includes(
      String(error.nativeErrorCode ?? ""),
    ) ||
    /ItemNotFoundException|PathNotFound|ObjectNotFound/u.test(
      `${String(error.fqid ?? "")} ${String(error.category ?? "")}`,
    )
  ) {
    return "absent";
  }
  return "error";
}

/**
 * Render the matrix as a markdown table.
 *
 * @param {{ labels: string[], rows: Array<{ source: string, outcomes: Record<string, string> }> }} matrix Matrix.
 * @returns {string} Markdown.
 */
export function renderPermissionsMatrix(matrix) {
  const headings = matrix.labels.map((label) => LABEL_HEADINGS[label] ?? label);
  const lines = [
    `| Source | ${headings.join(" | ")} |`,
    `| --- | ${headings.map(() => "---").join(" | ")} |`,
  ];
  for (const row of matrix.rows) {
    lines.push(
      `| \`${row.source}\` | ${matrix.labels.map((label) => row.outcomes[label]).join(" | ")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Markers that delimit the committed table inside a markdown file.
 */
export const MATRIX_START_MARKER = "<!-- permissions-matrix:start -->";
export const MATRIX_END_MARKER = "<!-- permissions-matrix:end -->";

/**
 * Replace the table between the markers of a markdown document.
 *
 * @param {string} markdown Document text.
 * @param {string} table Rendered table.
 * @returns {string} Updated document.
 * @throws {Error} When the markers are missing.
 */
export function embedPermissionsMatrix(markdown, table) {
  const start = markdown.indexOf(MATRIX_START_MARKER);
  const end = markdown.indexOf(MATRIX_END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("permissions-matrix markers not found");
  }
  return `${markdown.slice(0, start + MATRIX_START_MARKER.length)}\n${table}${markdown.slice(end)}`;
}

/**
 * Extract the table currently committed between the markers.
 *
 * @param {string} markdown Document text.
 * @returns {string} Committed table.
 */
export function extractPermissionsMatrix(markdown) {
  const start = markdown.indexOf(MATRIX_START_MARKER);
  const end = markdown.indexOf(MATRIX_END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    return "";
  }
  return markdown.slice(start + MATRIX_START_MARKER.length, end).replace(/^\n/u, "");
}

/**
 * List subdirectory names.
 *
 * @param {string} path Directory.
 * @returns {string[]} Names.
 */
function directories(path) {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const matrix = buildPermissionsMatrix();
  const updateIndex = process.argv.indexOf("--update");
  if (updateIndex !== -1) {
    const target = process.argv[updateIndex + 1];
    if (!target) {
      console.error("usage: permissions-matrix.mjs --update <markdown file>");
      process.exit(2);
    }
    const updated = embedPermissionsMatrix(
      readFileSync(target, "utf8"),
      renderPermissionsMatrix(matrix),
    );
    writeFileSync(target, updated, "utf8");
    console.log(`updated ${target}`);
  } else if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`);
  } else {
    process.stdout.write(renderPermissionsMatrix(matrix));
  }
}
