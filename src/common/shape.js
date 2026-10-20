/**
 * @typedef {object} HbomProperty
 * @property {string} name Property name.
 * @property {string} value Property value.
 */

/**
 * @typedef {object} HbomComponent
 * @property {string} type HBOM component type.
 * @property {string} name Display name.
 * @property {string} [version] Version or model identifier.
 * @property {{ name: string }} [manufacturer] Manufacturer.
 * @property {string} [description] Optional description.
 * @property {HbomProperty[]} [properties] Additional metadata.
 */

// Vendor placeholders that firmware tables report instead of a real identity
// value (observed on Linux DMI and on Hyper-V CIM). They identify nothing.
const PLACEHOLDER_IDENTITY_VALUES = new Set([
  "default string",
  "to be filled by o.e.m.",
  "not specified",
  "unknown",
  "none",
]);

/**
 * Report whether a string is a vendor placeholder rather than an identity.
 *
 * @param {string | undefined | null} value Candidate value.
 * @returns {boolean} True for placeholder values, compared case-insensitively.
 */
export function isPlaceholderIdentity(value) {
  return PLACEHOLDER_IDENTITY_VALUES.has(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

/**
 * Normalize a vendor-reported identity string, dropping empty values, `N/A`
 * and vendor placeholders so they never surface as an identity.
 *
 * @param {string | undefined | null} value Candidate value.
 * @returns {string | undefined} Trimmed identity or undefined.
 */
export function normalizeIdentityString(value) {
  if (!value || value === "N/A") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || isPlaceholderIdentity(normalized)) {
    return undefined;
  }
  return normalized;
}

/**
 * Format a byte count with binary units, for example `16.0 GB`.
 *
 * @param {number | undefined | null} bytes Byte count.
 * @returns {string | undefined} Formatted size or undefined.
 */
export function formatBytes(bytes) {
  if (!bytes || Number.isNaN(bytes)) {
    return undefined;
  }

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Format a display's physical size as `W x H cm`.
 *
 * Numbers pass through; numeric strings are parsed as base-10 integers, the
 * way the Linux EDID path has always read sysfs values. Either dimension
 * missing yields `undefined`.
 *
 * @param {number | string | undefined | null} widthCm Width in centimetres.
 * @param {number | string | undefined | null} heightCm Height in centimetres.
 * @returns {string | undefined} Formatted size or undefined.
 */
export function formatDisplayPhysicalSize(widthCm, heightCm) {
  const normalizedWidth = toDisplayDimension(widthCm);
  const normalizedHeight = toDisplayDimension(heightCm);

  return normalizedWidth !== undefined && normalizedHeight !== undefined
    ? `${normalizedWidth} x ${normalizedHeight} cm`
    : undefined;
}

/**
 * Normalize one physical display dimension.
 *
 * @param {number | string | undefined | null} value Candidate dimension.
 * @returns {number | undefined} Number or undefined.
 */
function toDisplayDimension(value) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Return a redacted representation for sensitive identifiers unless explicitly allowed.
 *
 * @param {string | undefined | null} value Identifier value.
 * @param {{ includeSensitiveIdentifiers?: boolean }} [options={}] Redaction options.
 * @returns {string | undefined} Safe value.
 */
export function redactIdentifier(value, options = {}) {
  if (!value) {
    return undefined;
  }

  if (options.includeSensitiveIdentifiers === true) {
    return value;
  }

  if (value.length <= 4) {
    return "redacted";
  }

  return `redacted:${value.slice(-4)}`;
}

/**
 * Create a property object when a value is present.
 *
 * @param {string} name Property name.
 * @param {string | number | boolean | undefined | null} value Property value.
 * @returns {HbomProperty | undefined} Property or undefined.
 */
export function createProperty(name, value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return {
    name,
    value: String(value),
  };
}

/**
 * Remove empty values from a list.
 *
 * @template T
 * @param {(T | undefined | null | false)[]} values Candidate values.
 * @returns {T[]} Filtered values.
 */
export function compact(values) {
  return values.filter(Boolean);
}

/**
 * Create a component-like object.
 *
 * @param {HbomComponent} component Component definition.
 * @returns {HbomComponent} Component definition.
 */
export function createComponent(component) {
  return component;
}

/**
 * Create a schema-valid CycloneDX hardware component.
 *
 * CycloneDX 1.7 does not define dedicated component `type` values for many
 * hardware categories, so `cdx-hbom` emits them as `type: "device"` and records
 * the finer-grained role via the `cdx:hbom:hardwareClass` custom property.
 *
 * @param {string} hardwareClass Hardware role/classification.
 * @param {HbomComponent} component Component definition.
 * @returns {HbomComponent} Component definition.
 */
export function createHardwareComponent(hardwareClass, component) {
  return createComponent({
    ...component,
    type: "device",
    properties: compact([
      createProperty("cdx:hbom:hardwareClass", hardwareClass),
      ...(component.properties ?? []),
    ]),
  });
}

/**
 * Build a CycloneDX `dependencies` graph from a list of edges.
 *
 * Each edge names a component `bom-ref` and the refs it depends on. Edges that
 * share a `ref` are merged, references to unknown components are dropped so the
 * graph never dangles, and self-references are ignored. This lets collectors
 * express hardware topology such as a charger feeding a port, a port carrying a
 * cable, and a cable connecting a device.
 *
 * @param {Array<{ ref: string, dependsOn?: string[] }>} edges Dependency edges.
 * @param {Iterable<string>} [knownRefs] Refs that exist in the component list.
 * @returns {Array<{ ref: string, dependsOn: string[] }>} Dependency graph.
 */
export function buildDependencyGraph(edges, knownRefs) {
  const known = knownRefs ? new Set(knownRefs) : undefined;
  const merged = new Map();

  for (const edge of edges) {
    if (!edge?.ref) {
      continue;
    }
    if (known && !known.has(edge.ref)) {
      continue;
    }

    const targets = merged.get(edge.ref) ?? new Set();
    for (const dependency of edge.dependsOn ?? []) {
      if (dependency === edge.ref) {
        continue;
      }
      if (known && !known.has(dependency)) {
        continue;
      }
      targets.add(dependency);
    }
    merged.set(edge.ref, targets);
  }

  return Array.from(merged, ([ref, targets]) => ({
    ref,
    dependsOn: Array.from(targets),
  }));
}
