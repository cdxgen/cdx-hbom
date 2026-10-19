import { WINDOWS_PRIVILEGE_HINT } from "../../common/command.js";

/**
 * Schema marker of every PowerShell envelope emitted by the Windows runner.
 *
 * @type {string}
 */
export const WINDOWS_ENVELOPE_SCHEMA = "cdx-hbom/windows-envelope@1";

// Strings that look like .NET type names. ConvertTo-Json emits these when a
// value exceeded the serialization depth or when an embedded CIM instance was
// not projected to scalars, so their presence marks a projection bug.
const DOTNET_TYPE_STRING =
  /^(System|Microsoft\.Management\.Infrastructure)\.[\w.]+$/u;

const CIM_INSTANCE_BLOB_KEYS = new Set(["CimClass", "CimInstanceProperties"]);

// Month names of the registry / MS_SystemInformation date form, which carries
// no timezone and must therefore be parsed positionally instead of through the
// locale-dependent Date parser.
const MONTH_BY_NAME = new Map([
  ["Jan", 1],
  ["Feb", 2],
  ["Mar", 3],
  ["Apr", 4],
  ["May", 5],
  ["Jun", 6],
  ["Jul", 7],
  ["Aug", 8],
  ["Sep", 9],
  ["Oct", 10],
  ["Nov", 11],
  ["Dec", 12],
]);

/**
 * Hint attached to the single summarized diagnostic when every WMI query was
 * denied. Observed on a network logon (SSH/WinRM) standard user, whose token
 * carries the NETWORK SID and therefore needs the namespace's Remote Enable
 * right, which only Administrators hold by default.
 *
 * @type {string}
 */
export const WINDOWS_NETWORK_LOGON_HINT =
  "WMI denied for a network logon (SSH/WinRM) without administrator rights; run cdx-hbom from a local session or elevated";

/**
 * Parse the JSON envelope written by a Windows CIM command.
 *
 * The envelope is one `ConvertTo-Json -Compress` object. Parsing strips a
 * UTF-8 BOM (PowerShell can emit one), validates the schema marker, normalizes
 * every `results[k].items` value to an array (Windows PowerShell 5.1 unwraps
 * single-element arrays in some positions) and reports projection bugs as
 * warnings instead of failing the command.
 *
 * @param {string} stdout Raw command stdout.
 * @returns {{
 *   meta: { commandId: string, psVersion: string, languageMode: string, outputEncoding: string, elevated: boolean | null },
 *   results: Record<string, { ok: boolean, items?: object[], values?: Record<string, unknown>, error?: object, shortCircuited?: boolean, kind?: string }>,
 *   warnings: string[]
 * }} Parsed envelope.
 * @throws {Error} When the stdout is not JSON or carries a foreign schema.
 */
export function parseWindowsEnvelope(stdout) {
  const text = String(stdout ?? "").replace(/^\uFEFF/u, "");
  const parsed = JSON.parse(text);

  if (parsed?.schema !== WINDOWS_ENVELOPE_SCHEMA) {
    throw new Error(
      `Unexpected Windows envelope schema: ${String(parsed?.schema)}`,
    );
  }

  const warnings = [];
  const results = {};
  for (const [key, value] of Object.entries(parsed.results ?? {})) {
    const result = value ?? {};
    if (result.items === undefined || result.items === null) {
      result.items = [];
    } else if (!Array.isArray(result.items)) {
      result.items = [result.items];
    }
    results[key] = result;
    collectProjectionWarnings(result, `results.${key}`, warnings);
  }

  return {
    meta: {
      commandId: parsed.commandId,
      psVersion: parsed.psVersion,
      languageMode: parsed.languageMode,
      outputEncoding: parsed.outputEncoding,
      elevated: parsed.elevated ?? null,
    },
    results,
    warnings,
  };
}

/**
 * Walk a result value and record projection-bug warnings.
 *
 * @param {unknown} value Value to inspect.
 * @param {string} path Dotted path for the warning message.
 * @param {string[]} warnings Collected warnings.
 * @returns {void} Nothing.
 */
function collectProjectionWarnings(value, path, warnings) {
  if (typeof value === "string") {
    if (DOTNET_TYPE_STRING.test(value)) {
      warnings.push(
        `${path}: '${value}' looks like an unprojected .NET type; project CIM values to scalars`,
      );
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectProjectionWarnings(item, `${path}[${index}]`, warnings),
    );
    return;
  }
  for (const key of Object.keys(value)) {
    if (CIM_INSTANCE_BLOB_KEYS.has(key)) {
      warnings.push(
        `${path}: key '${key}' marks an embedded CIM instance; project CIM values to scalars`,
      );
    }
    collectProjectionWarnings(value[key], `${path}.${key}`, warnings);
  }
}

/**
 * Normalize a CIM string value.
 *
 * Parallels virtual hardware reports whitespace-only serial and version
 * fields, so whitespace-only values collapse to `undefined`.
 *
 * @param {string | null | undefined} value Candidate value.
 * @returns {string | undefined} Trimmed value or undefined.
 */
export function cimString(value) {
  if (typeof value !== "string") {
    return value === null || value === undefined ? undefined : value;
  }
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Normalize a CIM numeric value.
 *
 * Values above 2^53 lose precision through `JSON.parse`; they are kept as
 * parsed because size fields are never used as identifiers.
 *
 * @param {string | number | null | undefined} value Candidate value.
 * @returns {number | undefined} Finite number or undefined.
 */
export function cimNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Normalize a CIM boolean value.
 *
 * @param {boolean | string | number | null | undefined} value Candidate value.
 * @returns {boolean | undefined} Boolean or undefined.
 */
export function cimBool(value) {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return undefined;
}

/**
 * Normalize a CIM date to an ISO calendar date (`YYYY-MM-DD`) in UTC.
 *
 * Accepted shapes, all observed or documented for CIM serialization:
 * - Windows PowerShell 5.1 JSON: `/Date(1708337472000)/` (epoch ms, optional
 *   numeric timezone suffix);
 * - PowerShell 7 JSON: ISO 8601;
 * - `YYYY-MM-DD` plain dates (for example `MSFT_NetAdapter.DriverDate`);
 * - the registry / `MS_SystemInformation` form `Tue, 11 Aug 2026 15:56:20`,
 *   which carries no timezone and is read as the host's wall clock.
 *
 * @param {string | null | undefined} value Candidate value.
 * @returns {string | undefined} ISO calendar date or undefined.
 */
export function cimDate(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (text.length === 0) {
    return undefined;
  }

  let match = text.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/u);
  if (match) {
    return toUtcDateString(new Date(Number(match[1])));
  }

  match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (match) {
    return text;
  }

  match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/u,
  );
  if (match) {
    if (match[7]) {
      return toUtcDateString(new Date(text.replace(" ", "T")));
    }
    return toUtcDateString(
      new Date(
        Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        ),
      ),
    );
  }

  match = text.match(
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2})$/u,
  );
  if (match) {
    return toUtcDateString(
      new Date(
        Date.UTC(
          Number(match[3]),
          MONTH_BY_NAME.get(match[2]) - 1,
          Number(match[1]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        ),
      ),
    );
  }

  return undefined;
}

/**
 * Decode a WmiMonitorID-style uint16 character array.
 *
 * Name fields of `WmiMonitorID` are UTF-16 code unit arrays zero-padded to a
 * fixed length; decoding stops at the first zero.
 *
 * @param {number[] | null | undefined} value Candidate array.
 * @returns {string | undefined} Decoded trimmed string or undefined.
 */
export function cimUint16String(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const end = value.indexOf(0);
  const codes = end === -1 ? value : value.slice(0, end);
  const text = codes
    .map((code) => String.fromCharCode(code))
    .join("")
    .trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Normalize a value that CIM may serialize as a scalar or an array.
 *
 * @param {unknown} value Candidate value.
 * @returns {unknown[]} Array value.
 */
export function cimArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

/**
 * Format a Date as an ISO calendar date.
 *
 * @param {Date} date Parsed date.
 * @returns {string | undefined} `YYYY-MM-DD` or undefined when invalid.
 */
function toUtcDateString(date) {
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toISOString().slice(0, 10);
}

/**
 * Classify a Windows CIM result error into the shared diagnostic vocabulary.
 *
 * Classification uses only non-localized fields (`nativeErrorCode`,
 * `statusCode`, and the type names inside `fqid`/`category`); the exception
 * message is localized and never inspected.
 *
 * @param {{ nativeErrorCode?: string | number, statusCode?: string | number, category?: string, fqid?: string }} error Captured error object.
 * @returns {"permission-denied" | "not-present" | "partial-support" | "command-error"} Issue.
 */
export function classifyWindowsResultError(error) {
  const nativeErrorCode = String(error?.nativeErrorCode ?? "");
  const statusCode = Number(error?.statusCode);
  const stableText = `${String(error?.fqid ?? "")} ${String(error?.category ?? "")}`;

  if (nativeErrorCode === "AccessDenied" || statusCode === 2) {
    return "permission-denied";
  }
  if (
    [
      "InvalidNamespace",
      "InvalidClass",
      "NoProperties",
      // `Get-CimClass` reports an absent class as NotFound/6 (captured on
      // win11-vm for root/wmi BatteryStaticData); `Get-CimInstance` reports
      // the same absence as InvalidClass/5. Both mean the hardware is absent.
      "NotFound",
    ].includes(nativeErrorCode) ||
    statusCode === 3 ||
    statusCode === 5 ||
    statusCode === 6 ||
    /ItemNotFoundException|PathNotFound|ObjectNotFound/u.test(stableText)
  ) {
    return "not-present";
  }
  if (nativeErrorCode === "NotSupported" || statusCode === 7) {
    return "partial-support";
  }
  return "command-error";
}

/**
 * Summarize WMI access across an envelope.
 *
 * `allWmiDenied` is true when at least one WMI query ran and every one of them
 * failed with `AccessDenied` (short-circuited entries replay the same error).
 * Registry results are excluded: the registry stays readable under a network
 * logon even when WMI is denied. Collectors use this to emit a single
 * network-logon diagnostic instead of dozens of per-class lines.
 *
 * @param {{ results?: Record<string, object> }} envelope Parsed envelope.
 * @returns {{ allWmiDenied: boolean }} Access summary.
 */
export function summarizeWindowsAccess(envelope) {
  const results = Object.values(envelope?.results ?? {}).filter(
    (result) => result?.kind !== "registry",
  );

  return {
    allWmiDenied:
      results.length > 0 &&
      results.every(
        (result) =>
          result?.ok === false &&
          result?.error?.nativeErrorCode === "AccessDenied",
      ),
  };
}

/**
 * Build a command diagnostic for one failed envelope result.
 *
 * Mirrors the Linux `toCommandDiagnostic` shape. `not-present` results stay
 * out of the diagnostic list (the hardware is simply absent), and `dry-run`
 * never reaches diagnostics at all.
 *
 * @param {string} commandId Envelope command identifier.
 * @param {string} key Result key.
 * @param {{ nativeErrorCode?: string | number, statusCode?: string | number, category?: string, fqid?: string, shortCircuited?: boolean, issue?: string }} error Result error or thrown command error.
 * @returns {{ id: string, issue: string, code: string | undefined, message: string, privilegeHint: string | undefined } | undefined} Diagnostic or undefined.
 */
export function toWindowsResultDiagnostic(commandId, key, error) {
  const issue =
    error?.issue === "dry-run"
      ? "dry-run"
      : classifyWindowsResultError(error);

  if (issue === "not-present" || issue === "dry-run") {
    return undefined;
  }

  const nativeErrorCode = String(error?.nativeErrorCode ?? "");
  const statusCode = Number(error?.statusCode);
  const message = [
    nativeErrorCode,
    Number.isFinite(statusCode) ? `status ${statusCode}` : undefined,
    error?.shortCircuited === true ? "short-circuited" : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id: `${commandId}:${key}`,
    issue,
    code: nativeErrorCode ||
      (Number.isFinite(statusCode) ? String(statusCode) : undefined),
    message: message.length > 0 ? message : "WMI query failed",
    privilegeHint: issue === "permission-denied" ? WINDOWS_PRIVILEGE_HINT : undefined,
  };
}
