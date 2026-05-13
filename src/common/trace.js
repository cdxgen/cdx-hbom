import { AsyncLocalStorage } from "node:async_hooks";

const collectorTraceStorage = new AsyncLocalStorage();
export const HBOM_TRACE_SYMBOL = Symbol.for("@cdxgen/cdx-hbom.trace");

/**
 * Create a collector trace ledger.
 *
 * @returns {{ activities: object[] }} Trace ledger.
 */
export function createCollectorTrace() {
  return {
    activities: [],
  };
}

/**
 * Run a callback with an active collector trace.
 *
 * @template T
 * @param {{ activities: object[] } | undefined} trace Trace ledger.
 * @param {() => T} callback Callback.
 * @returns {T} Callback result.
 */
export function withCollectorTrace(trace, callback) {
  return collectorTraceStorage.run(normalizeCollectorTrace(trace), callback);
}

/**
 * Resolve a collector trace from an explicit value or the async context.
 *
 * @param {{ activities: object[] } | undefined} [trace] Explicit trace ledger.
 * @returns {{ activities: object[] } | undefined} Trace ledger.
 */
export function resolveCollectorTrace(trace = undefined) {
  return trace ?? collectorTraceStorage.getStore();
}

/**
 * Record a collector trace activity.
 *
 * @param {{ activities: object[] } | undefined} trace Trace ledger.
 * @param {object} activity Trace activity.
 * @returns {object | undefined} Recorded activity.
 */
export function recordCollectorTrace(trace, activity) {
  const resolvedTrace = resolveCollectorTrace(trace);

  if (!resolvedTrace) {
    return undefined;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    ...activity,
  };
  resolvedTrace.activities.push(entry);
  return entry;
}

/**
 * Attach a collector trace to a returned BOM object.
 *
 * @template {object} T
 * @param {T} bom CycloneDX BOM object.
 * @param {{ activities: object[] } | undefined} trace Trace ledger.
 * @returns {T} BOM object with an attached non-enumerable trace.
 */
export function attachCollectorTrace(bom, trace) {
  const resolvedTrace = resolveCollectorTrace(trace);

  if (!bom || typeof bom !== "object" || !resolvedTrace) {
    return bom;
  }

  Object.defineProperty(bom, HBOM_TRACE_SYMBOL, {
    configurable: true,
    enumerable: false,
    value: resolvedTrace,
  });
  return bom;
}

/**
 * Read a collector trace from a BOM object or trace ledger.
 *
 * @param {unknown} value BOM object or trace ledger.
 * @returns {{ activities: object[] } | undefined} Trace ledger.
 */
export function getCollectorTrace(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value.activities)) {
    return /** @type {{ activities: object[] }} */ (value);
  }

  return /** @type {{ activities: object[] } | undefined} */ (
    value[HBOM_TRACE_SYMBOL]
  );
}

function normalizeCollectorTrace(trace) {
  if (trace && Array.isArray(trace.activities)) {
    return trace;
  }

  return createCollectorTrace();
}
