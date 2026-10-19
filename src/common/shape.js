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
