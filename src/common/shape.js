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
