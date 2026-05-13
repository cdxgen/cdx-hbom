#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";

import { collectHardware } from "../index.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const HELP_TEXT = `cdx-hbom ${packageJson.version}

Usage:
  cdx-hbom [options]

Options:
  --pretty                     Pretty-print JSON output
  --dry-run                    Block command execution and trace planned collection
  --platform <value>           Override platform selection
  --arch <value>               Override architecture selection
  --sensitive                  Include raw identifiers
  --no-command-enrichment      Disable optional command-based enrichment
  --privileged                 Enable privileged enrichment (Linux dmidecode)
  --plist-enrichment           Enable plist enrichment (Darwin)
  --strict                     Fail on partial collection errors
  --timeout <ms>               Command timeout in milliseconds
  --version                    Print version
  --help                       Print this help

Examples:
  cdx-hbom --pretty
  cdx-hbom --pretty > host-hbom.json
  cdx-hbom --privileged --pretty > linux-hbom.json
`;

async function main(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (options.version) {
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }

  const bom = await collectHardware({
    allowPartial: !options.strict,
    architecture: options.arch,
    dryRun: options.dryRun,
    includeCommandEnrichment: !options.noCommandEnrichment,
    includePlistEnrichment: options.plistEnrichment,
    includePrivilegedEnrichment: options.privileged,
    includeSensitiveIdentifiers: options.sensitive,
    platform: options.platform,
    timeoutMs: options.timeout,
  });

  process.stdout.write(
    `${JSON.stringify(bom, null, options.pretty ? 2 : 0)}\n`,
  );
}

/**
 * Parse CLI arguments.
 *
 * @param {string[]} argv Argument vector without node/script entries.
 * @returns {{
 *   arch?: string,
 *   dryRun?: boolean,
 *   help?: boolean,
 *   noCommandEnrichment?: boolean,
 *   platform?: string,
 *   plistEnrichment?: boolean,
 *   pretty?: boolean,
 *   privileged?: boolean,
 *   sensitive?: boolean,
 *   strict?: boolean,
 *   timeout?: number,
 *   version?: boolean
 * }} Parsed options.
 */
function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      result.version = true;
      continue;
    }
    if (arg === "--pretty") {
      result.pretty = true;
      continue;
    }
    if (arg === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (arg === "--sensitive") {
      result.sensitive = true;
      continue;
    }
    if (arg === "--no-command-enrichment") {
      result.noCommandEnrichment = true;
      continue;
    }
    if (arg === "--privileged") {
      result.privileged = true;
      continue;
    }
    if (arg === "--plist-enrichment") {
      result.plistEnrichment = true;
      continue;
    }
    if (arg === "--strict") {
      result.strict = true;
      continue;
    }
    if (arg === "--platform") {
      result.platform = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--arch") {
      result.arch = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--timeout") {
      const value = requireValue(argv, index, arg);
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new Error(`Invalid timeout: ${value}`);
      }
      result.timeout = parsed;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return result;
}

/**
 * Read the next CLI token as a required value.
 *
 * @param {string[]} argv Argument vector.
 * @param {number} index Current index.
 * @param {string} option Option name.
 * @returns {string} Option value.
 */
function requireValue(argv, index, option) {
  const value = argv[index + 1];

  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${option}`);
  }

  return value;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
