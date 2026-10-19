// Shared evidence plumbing for command-executing collectors: the
// `cdx:hbom:evidence:*` property serialization, thrown-command diagnostic
// mapping, and the allowPartial wrapper. Lifted from the Linux collector;
// Linux behavior is unchanged.

import { summarizeScriptArgs } from "./command.js";
import { compact, createProperty } from "./shape.js";

/**
 * Run a collection step, swallowing its error when partial output is allowed.
 *
 * @param {() => Promise<void> | void} action Collection step.
 * @param {boolean} allowPartial Whether a failed step may be skipped.
 * @param {(error: Error) => void} [onError] Error observer for diagnostics.
 * @returns {Promise<void>} Nothing.
 */
export async function attemptCollection(action, allowPartial, onError) {
  try {
    await action();
  } catch (error) {
    onError?.(error);
    if (!allowPartial) {
      throw error;
    }
  }
}

/**
 * Record an executed command spec as evidence input.
 *
 * Windows CIM specs record a script digest instead of the script itself
 * (`summarizeScriptArgs`); every other spec keeps its full arguments.
 *
 * @param {{ id: string, category: string, command: string, args: string[], parser?: string }} spec Command spec.
 * @returns {{ id: string, category: string, command: string, args: string[] }} Evidence command.
 */
export function toEvidenceCommand(spec) {
  return {
    id: spec.id,
    category: spec.category,
    command: spec.command,
    args: summarizeScriptArgs(spec) ?? [...spec.args],
  };
}

/**
 * Map a thrown command error to a serialized diagnostic.
 *
 * @param {Error | undefined} error Thrown error.
 * @returns {object | undefined} Diagnostic or undefined.
 */
export function toCommandDiagnostic(error) {
  if (
    !error ||
    typeof error !== "object" ||
    error.suppressedDiagnostic === true
  ) {
    return undefined;
  }

  return compactObject({
    id: getStringValue(error.commandId),
    category: getStringValue(error.category),
    command: getStringValue(error.command),
    args: Array.isArray(error.args) ? error.args.join(" ") : undefined,
    argumentName: getStringValue(error.argumentName),
    argumentValue: getStringValue(error.argumentValue),
    issue: getStringValue(error.issue),
    code: getStringValue(error.code),
    exitCode: getNumberValue(error.exitCode),
    message: getStringValue(error.message),
    installHint: getStringValue(error.installHint),
    privilegeHint: getStringValue(error.privilegeHint),
  });
}

/**
 * Serialize executed commands as `cdx:hbom:evidence:command` properties.
 *
 * @param {Array<{ id: string, category: string, command: string, args: string[] }>} commands Executed commands.
 * @returns {object[]} Properties.
 */
export function collectCommandProperties(commands) {
  return commands.map((entry) =>
    createProperty(
      "cdx:hbom:evidence:command",
      `${entry.id}|${entry.category}|${entry.command}${entry.args.length ? ` ${entry.args.join(" ")}` : ""}`,
    ),
  );
}

/**
 * Serialize command diagnostics as `cdx:hbom:evidence:commandDiagnostic` properties.
 *
 * @param {object[]} diagnostics Captured diagnostics.
 * @returns {object[]} Properties.
 */
export function collectCommandDiagnosticProperties(diagnostics) {
  return diagnostics.map((entry) =>
    createProperty("cdx:hbom:evidence:commandDiagnostic", JSON.stringify(entry)),
  );
}

/**
 * Drop undefined entries from an object.
 *
 * @param {Record<string, unknown>} value Candidate object.
 * @returns {Record<string, unknown>} Compacted object.
 */
function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined),
  );
}

/**
 * Trim a string value or return undefined.
 *
 * @param {unknown} value Candidate value.
 * @returns {string | undefined} Trimmed string or undefined.
 */
function getStringValue(value) {
  return typeof value === "string" ? value.trim() : undefined;
}

/**
 * Coerce a value to a number or return undefined.
 *
 * @param {unknown} value Candidate value.
 * @returns {number | undefined} Number or undefined.
 */
function getNumberValue(value) {
  return typeof value === "number"
    ? value
    : typeof value === "string" && value !== ""
      ? toNumber(value)
      : undefined;
}

/**
 * Parse a decimal integer.
 *
 * @param {string} value Candidate string.
 * @returns {number | undefined} Integer or undefined.
 */
function toNumber(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}
