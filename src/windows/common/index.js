// Windows collector: T0 baseline plus the tiered PowerShell CIM batches
// (PLAN.md §4.2). `buildWindowsHbom` is pure and fixture-testable;
// `collectWindowsHardware` performs all I/O.

import os from "node:os";
import process from "node:process";

import { runCommand, summarizeScriptTarget } from "../../common/command.js";
import {
  attemptCollection,
  collectCommandDiagnosticProperties,
  collectCommandProperties,
  toCommandDiagnostic,
  toEvidenceCommand,
} from "../../common/evidence.js";
import {
  buildDependencyGraph,
  compact,
  createProperty,
} from "../../common/shape.js";
import { createHbomDocument } from "../../common/schema.js";
import {
  normalizeTargetArchitecture,
} from "../../common/targets.js";
import { attachCollectorTrace, recordCollectorTrace } from "../../common/trace.js";
import {
  cimBool,
  cimString,
  parseWindowsEnvelope,
  summarizeWindowsAccess,
  toWindowsResultDiagnostic,
  WINDOWS_NETWORK_LOGON_HINT,
} from "./cim.js";
import { WINDOWS_COMMANDS, getRequiredWindowsCommand } from "./commands.js";
import {
  parsePnputilDevices,
  parseWindowsBuild,
  selectPnputilCommand,
  toFallbackPnpEnvelope,
} from "./fallback.js";
import {
  buildPnpComponents,
  buildPnpDeviceIndex,
  buildPnpTopologyEdges,
  parsePnpDevicesEnvelope,
  pnpDevicesDiagnostics,
} from "./devices.js";
import {
  buildDisplayAdapterComponents,
  buildDisplayComponents,
  monitorPnpInstanceId,
  parseDisplayMediaEnvelope,
} from "./display.js";
import {
  buildAudioControllerComponents,
  buildAudioEndpointComponents,
  buildCameraComponents,
} from "./media.js";
import {
  buildNetworkComponents,
  selectHardwareNetAdapters,
} from "./network.js";
import {
  buildStorageComponents,
  buildStorageVolumeComponents,
  parseStorageNetworkEnvelope,
  storageNetworkDiagnostics,
} from "./storage.js";
import {
  buildWindowsBoardFirmwareChassisComponents,
  buildWindowsHostComponent,
  buildWindowsMemoryComponents,
  buildWindowsProcessorComponent,
  detectWindowsArchitecture,
  parsePlatformEnvelope,
} from "./platform.js";
import { buildHostPowerProperties, buildPowerComponents } from "./power.js";
import { resolveWindowsPowerShellPath } from "./powershell.js";
import {
  bitlockerPropertiesByVolume,
  buildFirmwareDeviceComponents,
  buildSecurityPostureProperties,
  buildTpmComponents,
  parsePrivilegedEnvelope,
  parseTrustEnvelope,
  privilegedSummaryDiagnostics,
  storageReliabilityByDeviceId,
  trustRepresentedPnpIds,
} from "./trust.js";

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
  parseStorageNetworkEnvelope,
  buildStorageComponents,
  buildStorageVolumeComponents,
  storageNetworkDiagnostics,
} from "./storage.js";
export { selectHardwareNetAdapters, buildNetworkComponents } from "./network.js";
export { WINDOWS_STORAGE_NETWORK_MANIFEST } from "./commands.js";
export {
  parseDisplayMediaEnvelope,
  buildDisplayAdapterComponents,
  buildDisplayComponents,
  monitorPnpInstanceId,
} from "./display.js";
export {
  buildAudioControllerComponents,
  buildAudioEndpointComponents,
  buildCameraComponents,
} from "./media.js";
export {
  WINDOWS_DISPLAY_MEDIA_MANIFEST,
  WINDOWS_MEDIA_PNP_CLASS_GUIDS,
  WINDOWS_PNP_DEVICES_MANIFEST,
  WINDOWS_PNP_DEVICE_PROPERTY_KEYS,
} from "./commands.js";
export {
  parsePnpDevicesEnvelope,
  buildPnpDeviceIndex,
  classifyPnpDevice,
  buildPnpComponents,
  buildPnpTopologyEdges,
  pnpBomRef,
  pnpEnrichmentProperties,
  pnpDevicesDiagnostics,
} from "./devices.js";
export {
  WINDOWS_TRUST_MANIFEST,
  WINDOWS_PRIVILEGED_MANIFEST,
} from "./commands.js";
export {
  parseTrustEnvelope,
  parsePrivilegedEnvelope,
  buildSecurityPostureProperties,
  buildTpmComponents,
  buildFirmwareDeviceComponents,
  bitlockerPropertiesByVolume,
  storageReliabilityByDeviceId,
  privilegedSummaryDiagnostics,
  parseTpmSpecVersion,
} from "./trust.js";
export { buildPowerComponents, buildHostPowerProperties } from "./power.js";
export {
  WINDOWS_PC_SYSTEM_TYPES_EX,
  WINDOWS_MEMORY_ERROR_CORRECTIONS,
  WINDOWS_MEMORY_FORM_FACTORS,
  WINDOWS_PROCESSOR_ARCHITECTURES,
  WINDOWS_VIDEO_OUTPUT_TECHNOLOGIES,
  WINDOWS_DEVICE_SETUP_CLASSES,
  windowsEnumName,
  windowsVideoOutputTechnologyName,
  windowsSetupClassName,
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
 *     platformEnvelope?: ReturnType<parseWindowsEnvelope>,
 *     storageNetworkEnvelope?: ReturnType<parseWindowsEnvelope>,
 *     displayMediaEnvelope?: ReturnType<parseWindowsEnvelope>,
 *     pnpDevicesEnvelope?: ReturnType<parseWindowsEnvelope>,
 *     trustEnvelope?: ReturnType<parseWindowsEnvelope>,
 *     privilegedEnvelope?: ReturnType<parseWindowsEnvelope>
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
  const storageEnvelope = options.sources?.storageNetworkEnvelope;
  const displayEnvelope = options.sources?.displayMediaEnvelope;
  const pnpEnvelope = options.sources?.pnpDevicesEnvelope;
  const storageSources = storageEnvelope
    ? parseStorageNetworkEnvelope(storageEnvelope)
    : undefined;
  const displaySources = displayEnvelope
    ? parseDisplayMediaEnvelope(displayEnvelope)
    : undefined;
  const pnpSources = pnpEnvelope ? parsePnpDevicesEnvelope(pnpEnvelope) : undefined;
  // The PnP index is built first so every other builder can attach its
  // bom-ref and PnP-derived driver properties by raw instance ID.
  const pnpIndex = pnpSources ? buildPnpDeviceIndex(pnpSources) : undefined;
  const trustEnvelope = options.sources?.trustEnvelope;
  const privilegedEnvelope = options.sources?.privilegedEnvelope;
  const trustSources = trustEnvelope ? parseTrustEnvelope(trustEnvelope) : undefined;
  const privilegedSources = privilegedEnvelope
    ? parsePrivilegedEnvelope(privilegedEnvelope)
    : undefined;
  const buildOptions = {
    ...options,
    ...(pnpIndex ? { pnpIndex } : {}),
    ...(privilegedSources
      ? {
          bitlocker: bitlockerPropertiesByVolume(privilegedSources),
          storageReliability: storageReliabilityByDeviceId(privilegedSources),
        }
      : {}),
  };
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
    hostProperties: [
      ...buildSecurityPostureProperties(trustSources, privilegedSources),
      ...buildHostPowerProperties(trustSources),
    ],
  };
  const timestamp = options.collectedAt ?? new Date().toISOString();
  const identifierPolicy = options.includeSensitiveIdentifiers
    ? "raw-identifiers-enabled"
    : "redacted-by-default";
  const commandDiagnostics = [
    ...(options.commandDiagnostics ?? []),
    ...envelopeDiagnostics(envelope),
    ...envelopeDiagnostics(storageEnvelope),
    ...(storageSources
      ? storageNetworkDiagnostics(storageSources, storageEnvelope?.meta)
      : []),
    ...envelopeDiagnostics(displayEnvelope),
    ...envelopeDiagnostics(pnpEnvelope),
    ...(pnpSources ? pnpDevicesDiagnostics(pnpSources) : []),
    ...envelopeDiagnostics(trustEnvelope),
    // Privileged denials are expected for non-administrators, so they are
    // never collapsed into the network-logon summary: every denied class gets
    // its line, plus one summary naming the cause.
    ...envelopeDiagnostics(privilegedEnvelope, { collapseNetworkLogon: false }),
    ...privilegedSummaryDiagnostics(privilegedEnvelope),
  ];
  const executedCommands = options.executedCommands ?? [];

  const represented = new Set([
    ...representedPnpIds(storageSources, storageEnvelope, displaySources),
    ...trustRepresentedPnpIds(pnpIndex),
  ]);
  const pnp = pnpIndex
    ? buildPnpComponents(pnpIndex, { ...buildOptions, represented })
    : undefined;

  const components = compact([
    buildWindowsProcessorComponent(context),
    ...buildWindowsMemoryComponents(context),
    ...buildWindowsBoardFirmwareChassisComponents(context),
    ...(storageSources
      ? [
          ...buildStorageComponents(storageSources, buildOptions),
          ...buildStorageVolumeComponents(storageSources, buildOptions),
          ...buildNetworkComponents(
            storageSources.netAdapters,
            storageSources.netAdapterHardware,
            storageEnvelope?.results?.netAdapter ?? { ok: false },
            storageSources.legacyNetworkAdapters,
            buildOptions,
          ),
        ]
      : []),
    ...(displaySources
      ? [
          ...buildDisplayAdapterComponents(displaySources, buildOptions),
          ...buildDisplayComponents(displaySources, buildOptions),
          ...buildAudioControllerComponents(displaySources, buildOptions),
          ...buildAudioEndpointComponents(displaySources, buildOptions),
          ...buildCameraComponents(displaySources, buildOptions),
        ]
      : []),
    ...buildTpmComponents(pnpIndex, privilegedSources, buildOptions),
    ...buildFirmwareDeviceComponents(pnpIndex, trustSources, buildOptions),
    ...buildPowerComponents(trustSources),
    ...(pnp ? pnp.components : []),
  ]);
  const hostComponent = buildWindowsHostComponent(context);
  const knownRefs = compact(components.map((component) => component["bom-ref"]));
  const dependencies = pnpIndex
    ? buildDependencyGraph(buildPnpTopologyEdges(pnpIndex, knownRefs), knownRefs)
    : [];

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
      dependencies,
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
          cimString(parsed.os?.Caption) ?? cimString(baseline.osName),
        ),
        createProperty(
          "cdx:hbom:osVersion",
          cimString(parsed.os?.Version) ?? cimString(baseline.osRelease),
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
          cimString(envelope?.meta?.psVersion),
        ),
        createProperty(
          "cdx:hbom:evidence:languageMode",
          cimString(envelope?.meta?.languageMode),
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
 *   includePrivilegedEnrichment?: boolean,
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

  const steps = [
    { id: "windows-cim-platform", sourceKey: "platformEnvelope" },
    ...(options.includeCommandEnrichment === false
      ? []
      : WINDOWS_ENRICHMENT_STEPS.filter(
          (step) =>
            step.privileged !== true || options.includePrivilegedEnrichment === true,
        )),
  ];
  let powershellIssue;
  for (const step of steps) {
    const spec = getRequiredWindowsCommand(step.id);
    if (powershellIssue !== undefined) {
      // PowerShell itself failed to start for the platform batch, so every
      // later batch would fail the same way.
      recordCollectorTrace(options.trace, {
        args: [...spec.args],
        category: spec.category,
        command: spec.command,
        id: spec.id,
        kind: "command",
        reason: `PowerShell unavailable (${powershellIssue}); later PowerShell commands are skipped`,
        status: "skipped",
        target: summarizeScriptTarget(spec),
      });
      continue;
    }
    if (
      sources.platformEnvelope !== undefined &&
      summarizeWindowsAccess(sources.platformEnvelope).allWmiDenied
    ) {
      // A network logon denies every WMI namespace (~5 s each), so later WMI
      // commands are skipped and traced instead of re-paying the denial.
      recordCollectorTrace(options.trace, {
        args: [...spec.args],
        category: spec.category,
        command: spec.command,
        id: spec.id,
        kind: "command",
        reason: "WMI denied for a network logon; later WMI commands are skipped",
        status: "skipped",
        target: summarizeScriptTarget(spec),
      });
      continue;
    }
    await attemptCollection(
      async () => {
        const stdout = await runCommand(spec, options);
        executedCommands.push(toEvidenceCommand(spec));
        sources[step.sourceKey] = parseWindowsEnvelope(stdout);
      },
      allowPartial,
      (error) => {
        recordCommandError(error);
        if (step.id === "windows-cim-platform") {
          powershellIssue = powershellFailureIssue(error);
        }
      },
    );
  }

  const languageMode = sources.platformEnvelope?.meta?.languageMode;
  const degradedReason =
    powershellIssue !== undefined
      ? `PowerShell unavailable (${powershellIssue})`
      : languageMode && languageMode !== "FullLanguage"
        ? `PowerShell language mode is ${languageMode}`
        : undefined;
  if (degradedReason) {
    await collectWindowsFallback(sources, {
      ...options,
      allowPartial,
      executedCommands,
      recordCommandError,
    });
    commandDiagnostics.push({
      id: "windows-fallback",
      issue: "partial-support",
      message: `${degradedReason}: the device inventory comes from pnputil and the processor and memory from the Node baseline; board, firmware, storage, network, display, media and trust details are missing`,
    });
  }

  return buildWindowsHbom({
    ...options,
    sources,
    executedCommands,
    commandDiagnostics,
  });
}

/**
 * Classify a `windows-cim-platform` failure as PowerShell being unusable.
 *
 * A dry run, a timeout or a script error is not: PowerShell started, so the
 * fallback would add nothing the trace does not already explain. Anything
 * that stops the process from starting (missing binary, AppLocker or WDAC
 * denial, allowlist block) or yields unparseable output is.
 *
 * @param {{ issue?: string, suppressedDiagnostic?: boolean } | undefined} error Command error.
 * @returns {string | undefined} Issue name, or undefined when PowerShell ran.
 */
function powershellFailureIssue(error) {
  const issue = error?.issue;
  if (error?.suppressedDiagnostic === true || issue === "dry-run" || issue === "timeout") {
    return undefined;
  }
  return issue ?? "command-error";
}

/**
 * Fill the PnP envelope from the T4 fallback (C10, pnputil) when no
 * PowerShell batch produced one. pnputil is enrichment and honours
 * `includeCommandEnrichment: false`.
 *
 * @param {Record<string, unknown>} sources Collector sources (mutated).
 * @param {object} options Collector options plus `executedCommands` and `recordCommandError`.
 * @returns {Promise<void>} Nothing.
 */
async function collectWindowsFallback(sources, options) {
  const run = async (spec, parse) => {
    await attemptCollection(
      async () => {
        const stdout = await runCommand(spec, options);
        options.executedCommands.push(toEvidenceCommand(spec));
        parse(stdout);
      },
      options.allowPartial,
      options.recordCommandError,
    );
  };

  if (sources.pnpDevicesEnvelope === undefined && options.includeCommandEnrichment !== false) {
    const spec = selectPnputilCommand(parseWindowsBuild(sources.baseline?.osRelease));
    if (!spec) {
      return;
    }
    await run(spec, (stdout) => {
      const { devices, recognized } = parsePnputilDevices(stdout);
      if (!recognized) {
        options.recordCommandError({
          commandId: spec.id,
          category: spec.category,
          command: spec.command,
          issue: "partial-support",
          message: "pnputil output has no English field labels; the PnP device inventory was skipped",
        });
        return;
      }
      sources.pnpDevicesEnvelope = toFallbackPnpEnvelope(devices);
    });
  }
}

// Enrichment batches run after `windows-cim-platform`, in order, and are
// skipped when `includeCommandEnrichment` is false. Each one fills
// `sources[sourceKey]` with its parsed envelope for `buildWindowsHbom`. The
// privileged batch additionally needs `includePrivilegedEnrichment`; it is
// gated by the option alone and never elevates (PLAN.md §4.3).
const WINDOWS_ENRICHMENT_STEPS = Object.freeze([
  Object.freeze({
    id: "windows-cim-storage-network",
    sourceKey: "storageNetworkEnvelope",
  }),
  Object.freeze({
    id: "windows-cim-display-media",
    sourceKey: "displayMediaEnvelope",
  }),
  Object.freeze({
    id: "windows-pnp-devices",
    sourceKey: "pnpDevicesEnvelope",
  }),
  Object.freeze({
    id: "windows-cim-trust",
    sourceKey: "trustEnvelope",
  }),
  Object.freeze({
    id: "windows-cim-privileged",
    sourceKey: "privilegedEnvelope",
    privileged: true,
  }),
]);

/**
 * Collect the PnP instance IDs of devices that the storage, network, display
 * and media builders already turn into components, so the PnP builder enriches
 * those components instead of emitting a second one for the same device.
 *
 * Only adapters that `buildNetworkComponents` would actually emit count:
 * an excluded adapter's PCI function must still surface as a pci-device.
 *
 * @param {import("./storage.js").WindowsStorageNetworkSources | undefined} storageSources Storage/network sources.
 * @param {{ results?: Record<string, { ok?: boolean }> } | undefined} storageEnvelope Storage envelope.
 * @param {import("./display.js").WindowsDisplayMediaSources | undefined} displaySources Display/media sources.
 * @returns {Set<string>} Lower-cased instance IDs.
 */
function representedPnpIds(storageSources, storageEnvelope, displaySources) {
  const ids = [];
  if (storageSources) {
    ids.push(...storageSources.diskDrives.map((drive) => drive.PNPDeviceID));
    if (storageEnvelope?.results?.netAdapter?.ok) {
      ids.push(
        ...selectHardwareNetAdapters(storageSources.netAdapters).selected.map(
          (adapter) => adapter.PnPDeviceID,
        ),
      );
    } else {
      ids.push(
        ...storageSources.legacyNetworkAdapters
          .filter((adapter) => cimBool(adapter.PhysicalAdapter) === true)
          .map((adapter) => adapter.PNPDeviceID),
      );
    }
  }
  if (displaySources) {
    ids.push(
      ...displaySources.videoControllers.map((controller) => controller.PNPDeviceID),
      ...displaySources.monitorIds.map((monitor) =>
        monitorPnpInstanceId(cimString(monitor.InstanceName)),
      ),
      ...displaySources.soundDevices.map((device) => device.PNPDeviceID),
      ...displaySources.mediaPnp.map((entity) => entity.PNPDeviceID),
    );
  }
  return new Set(
    ids.map((id) => cimString(id)?.toLowerCase()).filter((id) => id !== undefined),
  );
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
 * @param {{ collapseNetworkLogon?: boolean }} [options={}] `collapseNetworkLogon: false` keeps per-class denials.
 * @returns {object[]} Diagnostics.
 */
function envelopeDiagnostics(envelope, options = {}) {
  if (!envelope) {
    return [];
  }

  const commandId = envelope.meta?.commandId ?? "windows-cim-platform";
  if (
    options.collapseNetworkLogon !== false &&
    summarizeWindowsAccess(envelope).allWmiDenied
  ) {
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
