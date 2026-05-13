import process from "node:process";

import { safeSpawnSync } from "./safe.js";
import { recordCollectorTrace } from "./trace.js";

/**
 * @typedef {object} CommandSpec
 * @property {string} id Stable command identifier.
 * @property {string} category Inventory category.
 * @property {string} command Executable path or name.
 * @property {string[]} args Command arguments.
 * @property {string} parser Parser identifier.
 * @property {string} purpose Human-readable rationale.
 * @property {string} phase Rollout phase such as `collector-v1` or `planned-enrichment`.
 * @property {string[]} [sensitiveFields] Field names that should be redacted by default.
 * @property {"none" | "optional" | "required"} [privilege] Privilege expectation for the command.
 */

/**
 * Execute a command and return trimmed stdout.
 *
 * @param {CommandSpec} spec Command descriptor.
 * @param {{ timeoutMs?: number, allowedCommands?: string[], dryRun?: boolean, includePrivilegedEnrichment?: boolean, trace?: { activities: object[] } }} [options={}] Execution options.
 * @returns {Promise<string>} Trimmed stdout.
 */
export async function runCommand(spec, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const privilegeMode = spec.privilege ?? "none";
  const shouldRunWithSudo =
    options.includePrivilegedEnrichment === true &&
    privilegeMode === "required" &&
    process.getuid?.() !== 0;
  let result = executeCommand(spec, options, timeoutMs, shouldRunWithSudo);

  if (
    shouldRetryWithSudo(spec, options, result, shouldRunWithSudo) &&
    process.getuid?.() !== 0
  ) {
    result = executeCommand(spec, options, timeoutMs, true);
  }

  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();

  if (stderr) {
    recordCommandWarning(spec, options, stdout, stderr);
  }

  if (result.error || result.status !== 0) {
    throw createCommandFailure(spec, result, options);
  }

  return stdout;
}

function executeCommand(spec, options, timeoutMs, useSudo) {
  const command = useSudo ? "sudo" : spec.command;
  const args = useSudo ? ["-n", spec.command, ...spec.args] : spec.args;
  return safeSpawnSync(command, args, {
    allowedCommands: useSudo
      ? [...new Set([...(options.allowedCommands ?? []), "sudo"])]
      : options.allowedCommands,
    dryRun: options.dryRun,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    trace: options.trace,
    traceActivity: {
      category: spec.category,
      dryRunReason: `Dry run mode blocks HBOM command '${spec.id}'.`,
      id: spec.id,
      parser: spec.parser,
      phase: spec.phase,
      privileged: useSudo || undefined,
      purpose: spec.purpose,
      requestedCommand: spec.command,
      requestedArgs: [...spec.args],
    },
    timeout: timeoutMs,
  });
}

function shouldRetryWithSudo(spec, options, result, attemptedWithSudo) {
  if (
    attemptedWithSudo ||
    options.includePrivilegedEnrichment !== true ||
    (spec.privilege ?? "none") !== "optional"
  ) {
    return false;
  }

  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const errorText = [result.error?.message, stderr].filter(Boolean).join("\n");

  return (
    isPermissionLikeMessage(errorText) &&
    (result.status !== 0 || looksLikeEmptyStructuredOutput(stdout))
  );
}

function recordCommandWarning(spec, options, stdout, stderr) {
  const errorType = classifyCommandIssue({ stderr, stdout });
  if (!shouldRecordCommandWarning(errorType)) {
    return;
  }

  recordCollectorTrace(options.trace, {
    args: [...spec.args],
    category: spec.category,
    command: spec.command,
    hint: buildHintMessage(spec, errorType),
    id: spec.id,
    issue: errorType,
    kind: "command-warning",
    reason: summarizeCommandIssue(stderr),
    status: "warning",
    target: `${spec.command}${spec.args.length ? ` ${spec.args.join(" ")}` : ""}`,
  });
}

function shouldRecordCommandWarning(errorType) {
  return ["missing-command", "permission-denied", "partial-support"].includes(
    errorType,
  );
}

function createCommandFailure(spec, result, options) {
  const privilegeMode = spec.privilege ?? "none";
  const stderr = String(result.stderr ?? "").trim();
  const stdout = String(result.stdout ?? "").trim();
  const errorType = classifyCommandIssue({
    error: result.error,
    stderr,
    stdout,
    status: result.status,
  });
  const issueSummary = summarizeCommandIssue(
    stderr ||
      result.error?.message ||
      `exit code ${result.status ?? "unknown"}`,
  );
  const error = new Error(
    `${spec.id} failed with ${errorType ?? "command-error"}: ${issueSummary}`,
  );

  error.code = mapCommandFailureCode(errorType);
  error.commandId = spec.id;
  error.command = spec.command;
  error.args = [...spec.args];
  error.category = spec.category;
  error.phase = spec.phase;
  error.exitCode = result.status ?? undefined;
  error.stderr = stderr || undefined;
  error.stdout = stdout || undefined;
  error.issue = errorType;
  error.installHint = getInstallHint(spec.command);
  error.privilegeHint =
    privilegeMode === "none"
      ? undefined
      : "Retry with --privileged to allow a non-interactive sudo attempt for permission-sensitive Linux commands.";
  error.suppressedDiagnostic = shouldSuppressCommandDiagnostic(
    spec,
    errorType,
    issueSummary,
  );

  if (!error.suppressedDiagnostic) {
    recordCollectorTrace(options.trace, {
      args: [...spec.args],
      category: spec.category,
      command: spec.command,
      exitCode: result.status ?? undefined,
      hint: buildHintMessage(spec, errorType),
      id: spec.id,
      issue: errorType,
      kind: "command-diagnostic",
      reason: issueSummary,
      status: "failed",
      target: `${spec.command}${spec.args.length ? ` ${spec.args.join(" ")}` : ""}`,
    });
  }

  return error;
}

function shouldSuppressCommandDiagnostic(spec, errorType, issueSummary) {
  const id = String(spec?.id ?? "");
  const message = String(issueSummary ?? "").toLowerCase();

  if (
    id.startsWith("ethtool-driver-info:") &&
    ["command-error", "partial-support"].includes(errorType ?? "") &&
    /(operation not supported|cannot get driver information|no data available)/u.test(
      message,
    )
  ) {
    return true;
  }

  if (
    id === "lsmem-json" &&
    ["command-error", "partial-support"].includes(errorType ?? "") &&
    /cannot open \/sys\/devices\/system\/memory/u.test(message)
  ) {
    return true;
  }

  return false;
}

function classifyCommandIssue({ error, stderr, stdout, status }) {
  const text = [error?.message, stderr]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  if (
    error?.code === "ENOENT" ||
    /command not found|not installed/u.test(text)
  ) {
    return "missing-command";
  }
  if (error?.code === "ETIMEDOUT") {
    return "timeout";
  }
  if (isPermissionLikeMessage(text)) {
    return "permission-denied";
  }
  if (status === 0 && !stderr) {
    return undefined;
  }
  if (/operation not supported|not supported/u.test(text) && stdout) {
    return "partial-support";
  }
  return "command-error";
}

function isPermissionLikeMessage(value) {
  return /permission denied|operation not permitted|must be root|can't read memory from \/dev\/mem|a password is required|sudo:/u.test(
    String(value ?? "").toLowerCase(),
  );
}

function looksLikeEmptyStructuredOutput(stdout) {
  const normalized = String(stdout ?? "").trim();
  return normalized === "" || normalized === "{}" || normalized === "[]";
}

function buildHintMessage(spec, errorType) {
  if (errorType === "missing-command") {
    return getInstallHint(spec.command);
  }
  if (
    errorType === "permission-denied" &&
    (spec.privilege ?? "none") !== "none"
  ) {
    return "Retry with --privileged to allow a non-interactive sudo attempt for permission-sensitive Linux commands.";
  }
  return undefined;
}

function summarizeCommandIssue(message) {
  return String(message ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");
}

function mapCommandFailureCode(errorType) {
  switch (errorType) {
    case "missing-command":
      return "CDX_HBOM_COMMAND_NOT_FOUND";
    case "permission-denied":
      return "CDX_HBOM_PERMISSION_DENIED";
    case "timeout":
      return "CDX_HBOM_COMMAND_TIMEOUT";
    default:
      return "CDX_HBOM_COMMAND_FAILED";
  }
}

export function getInstallHint(command) {
  const hints = {
    boltctl:
      "Command not found: install the Linux package providing boltctl (for example `bolt` on Debian/Ubuntu, Fedora/RHEL, and Arch).",
    cpupower:
      "Command not found: install the Linux package providing cpupower (for example `linux-tools-common` or a matching `linux-tools-*` package on Debian/Ubuntu, `kernel-tools` on Fedora/RHEL, or `cpupower` on Arch).",
    dmidecode: "Command not found: install `dmidecode`.",
    drm_info:
      "Command not found: install the Linux package providing drm_info (commonly `drm-info`).",
    "edid-decode":
      "Command not found: install the Linux package providing edid-decode (commonly `edid-decode`).",
    fwupdmgr:
      "Command not found: install the Linux package providing fwupdmgr (commonly `fwupd`).",
    lshw: "Command not found: install `lshw`.",
    lsusb:
      "Command not found: install the Linux package providing lsusb (commonly `usbutils`).",
    lspci:
      "Command not found: install the Linux package providing lspci (commonly `pciutils`).",
    mmcli:
      "Command not found: install the Linux package providing mmcli (commonly `modemmanager`).",
    upower: "Command not found: install `upower`.",
  };

  return hints[specOrCommandName(command)] ?? undefined;
}

function specOrCommandName(command) {
  return (
    String(command ?? "")
      .split(/[\\/]/u)
      .at(-1) ?? String(command ?? "")
  );
}
