// Windows collector: T0 baseline plus the tiered PowerShell CIM batches
// (PLAN.md §4.2). `buildWindowsHbom` is pure and fixture-testable;
// `collectWindowsHardware` performs all I/O.

import os from "node:os";
import process from "node:process";

import { runCommand } from "../../common/command.js";
import {
  attemptCollection,
  collectCommandDiagnosticProperties,
  collectCommandProperties,
  toCommandDiagnostic,
  toEvidenceCommand,
} from "../../common/evidence.js";
import {
  compact,
  createProperty,
} from "../../common/shape.js";
import { createHbomDocument } from "../../common/schema.js";
import {
  normalizeTargetArchitecture,
} from "../../common/targets.js";
import { attachCollectorTrace } from "../../common/trace.js";
import {
  parseWindowsEnvelope,
  summarizeWindowsAccess,
  toWindowsResultDiagnostic,
  WINDOWS_NETWORK_LOGON_HINT,
} from "./cim.js";
import { WINDOWS_COMMANDS, getRequiredWindowsCommand } from "./commands.js";
import {
  buildWindowsBoardFirmwareChassisComponents,
  buildWindowsHostComponent,
  buildWindowsMemoryComponents,
  buildWindowsProcessorComponent,
  detectWindowsArchitecture,
  parsePlatformEnvelope,
} from "./platform.js";
import { resolveWindowsPowerShellPath } from "./powershell.js";

export {
  WINDOWS_COMMANDS,
  WINDOWS_PLATFORM_MANIFEST,
  WINDOWS_SELFTEST_COMMAND,
  WINDOWS_SELFTEST_MANIFEST,
  getRequiredWindowsCommand,
} from "./commands.js";
export {
  assertWindowsScriptInvariants,
  buildCimScript,
  resolveWindowsPowerShellPath,
  WINDOWS_POWERSHELL_BASE_ARGS,
  WINDOWS_POWERSHELL_RELATIVE_PATH,
} from "./powershell.js";
export {
  parsePlatformEnvelope,
  detectWindowsArchitecture,
  buildWindowsHostComponent,
  buildWindowsProcessorComponent,
  buildWindowsMemoryComponents,
  buildWindowsBoardFirmwareChassisComponents,
} from "./platform.js";
export {
  WINDOWS_PC_SYSTEM_TYPES_EX,
  WINDOWS_MEMORY_ERROR_CORRECTIONS,
  WINDOWS_MEMORY_FORM_FACTORS,
  WINDOWS_PROCESSOR_ARCHITECTURES,
  windowsEnumName,
} from "./enums.js";

/**
 * Return a copy of the Windows command plan.
 *
 * The executable path is re-resolved from the current environment so callers
 * (and their tests) see the powershell.exe path that would actually run, while
 * the frozen registry stays immutable.
 *
 * @returns {ReadonlyArray<object>} Command descriptors.
 */
export function getWindowsCommandPlan() {
  return WINDOWS_COMMANDS.map((spec) => ({
    ...spec,
    command: resolveWindowsPowerShellPath(),
    args: [...spec.args],
    sensitiveFields: spec.sensitiveFields
      ? [...spec.sensitiveFields]
      : undefined,
  }));
}

/**
 * Build a Windows HBOM from pre-collected sources.
 *
 * With no platform envelope (dry run, blocked PowerShell, network-logon
 * denial) the BOM is built from the T0 baseline alone and stays valid.
 *
 * @param {{
 *   architecture?: string,
 *   sources?: {
 *     baseline?: { cpuModel?: string, cpuCount?: number, totalMemoryBytes?: number, osRelease?: string, osName?: string },
 *     platformEnvelope?: ReturnType<parseWindowsEnvelope>
 *   },
 *   includeSensitiveIdentifiers?: boolean,
 *   executedCommands?: Array<{ id: string, category: string, command: string, args: string[] }>,
 *   commandDiagnostics?: object[],
 *   collectedAt?: string,
 *   trace?: object
 * }} options Build inputs.
 * @returns {object} CycloneDX BOM.
 * @throws {Error} When the detected architecture is not a supported target.
 */
export function buildWindowsHbom(options = {}) {
  const envelope = options.sources?.platformEnvelope;
  const parsed = envelope
    ? parsePlatformEnvelope(envelope)
    : {
        computerSystem: undefined,
        product: undefined,
        bios: undefined,
        baseBoard: undefined,
        enclosure: undefined,
        processors: [],
        memoryModules: [],
        memoryArrays: [],
        os: undefined,
        msSystemInformation: undefined,
      };
  const baseline = options.sources?.baseline ?? {};
  const fallbackArchitecture = normalizeTargetArchitecture(
    options.architecture,
  );
  const detected = detectWindowsArchitecture(
    parsed.processors,
    fallbackArchitecture,
  );
  const context = {
    ...options,
    sources: parsed,
    baseline,
    detected,
  };
  const timestamp = options.collectedAt ?? new Date().toISOString();
  const identifierPolicy = options.includeSensitiveIdentifiers
    ? "raw-identifiers-enabled"
    : "redacted-by-default";
  const commandDiagnostics = [
    ...(options.commandDiagnostics ?? []),
    ...envelopeDiagnostics(envelope),
  ];
  const executedCommands = options.executedCommands ?? [];

  const components = compact([
    buildWindowsProcessorComponent(context),
    ...buildWindowsMemoryComponents(context),
    ...buildWindowsBoardFirmwareChassisComponents(context),
  ]);
  const hostComponent = buildWindowsHostComponent(context);

  return attachCollectorTrace(
    createHbomDocument({
      metadata: {
        timestamp,
        lifecycles: [{ phase: "operations" }],
        component: hostComponent,
        tools: {
          components: [
            {
              type: "application",
              name: "cdx-hbom",
            },
          ],
        },
        properties: [],
      },
      components,
      properties: compact([
        createProperty("cdx:hbom:targetPlatform", "windows"),
        createProperty("cdx:hbom:targetArchitecture", detected.architecture),
        createProperty("cdx:hbom:identifierPolicy", identifierPolicy),
        createProperty(
          "cdx:hbom:collectorProfile",
          `windows-${detected.architecture}-v1`,
        ),
        createProperty(
          "cdx:hbom:osName",
          cimText(parsed.os?.Caption) ?? cimText(baseline.osName),
        ),
        createProperty(
          "cdx:hbom:osVersion",
          cimText(parsed.os?.Version) ?? cimText(baseline.osRelease),
        ),
        createProperty("cdx:hbom:architectureSource", detected.source),
        ...(fallbackArchitecture && fallbackArchitecture !== detected.architecture
          ? [
              createProperty(
                "cdx:hbom:collectorProcessArchitecture",
                fallbackArchitecture,
              ),
            ]
          : []),
        createProperty(
          "cdx:hbom:evidence:powershellVersion",
          cimText(envelope?.meta?.psVersion),
        ),
        createProperty(
          "cdx:hbom:evidence:languageMode",
          cimText(envelope?.meta?.languageMode),
        ),
        ...(envelope?.meta?.elevated === null ||
        envelope?.meta?.elevated === undefined
          ? []
          : [
              createProperty(
                "cdx:hbom:evidence:elevated",
                String(envelope.meta.elevated),
              ),
            ]),
        createProperty(
          "cdx:hbom:evidence:commandCount",
          executedCommands.length,
        ),
        ...collectCommandProperties(executedCommands),
        createProperty(
          "cdx:hbom:evidence:commandDiagnosticCount",
          commandDiagnostics.length,
        ),
        ...collectCommandDiagnosticProperties(commandDiagnostics),
      ]),
    }),
    options.trace,
  );
}

/**
 * Collect Windows hardware inventory.
 *
 * The T0 baseline (Node `os` module) always runs; the `windows-cim-platform`
 * batch runs through `runCommand` unless the whole collection is a dry run,
 * in which case the blocked spawn is still traced. Every WMI query denied by
 * a network logon collapses into a single diagnostic with the network-logon
 * hint (PLAN.md §4.3).
 *
 * @param {{
 *   architecture?: string,
 *   includeSensitiveIdentifiers?: boolean,
 *   includeCommandEnrichment?: boolean,
 *   timeoutMs?: number,
 *   allowPartial?: boolean,
 *   allowedCommands?: string[],
 *   dryRun?: boolean,
 *   trace?: object
 * }} [options={}] Collector options.
 * @returns {Promise<object>} CycloneDX BOM.
 * @throws {Error} When run outside win32 or the target is unsupported.
 */
export async function collectWindowsHardware(options = {}) {
  if (process.platform !== "win32") {
    throw new Error(
      `Windows collector must run on win32. Current host is ${process.platform}/${process.arch}.`,
    );
  }

  const allowPartial = options.allowPartial ?? true;
  const executedCommands = [];
  const commandDiagnostics = [];
  const sources = { baseline: readWindowsBaseline() };
  const recordCommandError = (error) => {
    const diagnostic = toCommandDiagnostic(error);
    if (diagnostic) {
      commandDiagnostics.push(diagnostic);
    }
  };

  const platformSpec = getRequiredWindowsCommand("windows-cim-platform");
  await attemptCollection(
    async () => {
      const stdout = await runCommand(platformSpec, options);
      executedCommands.push(toEvidenceCommand(platformSpec));
      sources.platformEnvelope = parseWindowsEnvelope(stdout);
    },
    allowPartial,
    recordCommandError,
  );

  return buildWindowsHbom({
    ...options,
    sources,
    executedCommands,
    commandDiagnostics,
  });
}

/**
 * Read the T0 baseline from the Node `os` module.
 *
 * This is the only source that works when PowerShell is missing, blocked or
 * dry-run, mirroring the Linux `/proc` baseline.
 *
 * @returns {{ cpuModel: string | undefined, cpuCount: number | undefined, totalMemoryBytes: number | undefined, osRelease: string, osName: string }} Baseline.
 */
function readWindowsBaseline() {
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model,
    cpuCount: cpus.length > 0 ? cpus.length : undefined,
    totalMemoryBytes: os.totalmem(),
    osRelease: os.release(),
    osName: os.version(),
  };
}

/**
 * Derive diagnostics from a parsed envelope.
 *
 * A network-logon denial (every WMI query denied) becomes one diagnostic so
 * the BOM does not carry a line per class; per-class errors stay in the
 * trace. `not-present` results (hardware simply absent) never become
 * diagnostics. Envelope warnings, including a non-UTF-8 console encoding,
 * surface as `partial-support`.
 *
 * @param {{ meta?: { commandId?: string, outputEncoding?: string }, results?: Record<string, object>, warnings?: string[] } | undefined} envelope Parsed envelope.
 * @returns {object[]} Diagnostics.
 */
function envelopeDiagnostics(envelope) {
  if (!envelope) {
    return [];
  }

  const commandId = envelope.meta?.commandId ?? "windows-cim-platform";
  if (summarizeWindowsAccess(envelope).allWmiDenied) {
    return [
      {
        id: `${commandId}:network-logon`,
        issue: "permission-denied",
        code: "AccessDenied",
        message: "every WMI query was denied by the namespace",
        privilegeHint: WINDOWS_NETWORK_LOGON_HINT,
      },
    ];
  }

  const diagnostics = [];
  for (const [key, result] of Object.entries(envelope.results ?? {})) {
    if (result?.ok === false) {
      const diagnostic = toWindowsResultDiagnostic(commandId, key, result.error);
      if (diagnostic) {
        diagnostics.push(diagnostic);
      }
    }
  }
  for (const warning of envelope.warnings ?? []) {
    diagnostics.push({
      id: `${commandId}:envelope`,
      issue: "partial-support",
      message: warning,
    });
  }
  if (envelope.meta?.outputEncoding === "default") {
    diagnostics.push({
      id: `${commandId}:output-encoding`,
      issue: "partial-support",
      message:
        "console output encoding is not UTF-8; non-ASCII text may be lossy",
    });
  }
  return diagnostics;
}

/**
 * Trim a scalar to a display string.
 *
 * @param {unknown} value Candidate value.
 * @returns {string | undefined} Trimmed string or undefined.
 */
function cimText(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
