/**
 * Map cdx-hbom hardware facts to CycloneDX 2.0 native fields
 * (cdxgen/cdx-hbom#26, part of cdxgen/cdxgen#4589).
 *
 * This module is the single home of what each `cdx:hbom:*` property means in
 * the 2.0 draft, so both cdx-hbom's own 2.0 output and cdxgen's 2.0 renderer
 * can call it (the pinned draft: CycloneDX/specification 2.0-dev at
 * ea8c3605829d1da13339a0790b6da73548e42a6b). cdx-hbom stays
 * dependency-free.
 *
 * The mapping is additive: every `cdx:hbom:*` property stays, because the
 * hbom-compliance, hbom-performance and hbom-security audit rules (25 rules)
 * read them. The overlap is documented in docs/hardware-properties.md.
 *
 * Identifier rules: the 2.0 identifiers carry an asserted identity, so a
 * value is emitted only when the caller passes includeSensitiveIdentifiers,
 * the recorded identifier policy (if any) is `raw-identifiers-enabled`, and
 * the value is not a redaction marker (`redacted`, `redacted:<last4>`,
 * `withheld`). Redacted values are false identities and never become
 * identifiers.
 *
 * Not emitted: deviceType (package types like bga/smd describe packaging, not
 * the draft's device-type taxonomy) and quantity (a host collector cannot
 * observe it). Firmware slot labels stay as properties for the maintainer to
 * decide against boardLocation.designators, which the schema reserves for
 * PCB reference designators such as U5 or R12.
 */

/** Identifier policy the collectors record when raw identifiers were kept. */
export const RAW_IDENTIFIER_POLICY = "raw-identifiers-enabled";

/** Identifier policy the collectors record by default. */
export const REDACTED_IDENTIFIER_POLICY = "redacted-by-default";

const IDENTITY_SCHEMES = [
  { property: "cdx:hbom:serialNumber", scheme: "serial-number" },
  { property: "cdx:hbom:assetTag", scheme: "asset-tag" },
  { property: "cdx:hbom:macAddress", scheme: "mac-address" },
  { property: "cdx:hbom:imei", scheme: "imei" },
  { property: "cdx:hbom:modelNumber", scheme: "model-number" },
];

// Taxonomy standard names for classification.codes
// (#/$defs/cyclonedx-physical-2.0/$defs/taxonomyCode requires
// {standard, value}).
const CLASS_CODE_STANDARDS = [
  { property: "cdx:hbom:pciClassCode", standard: "PCI-SIG class code" },
  { property: "cdx:hbom:usbClass", standard: "USB-IF class code" },
];

// The draft allows classification only on device and material components.
const CLASSIFIABLE_TYPES = new Set(["device", "material"]);

// Markers produced by redactIdentifier (src/common/shape.js): a bare
// `redacted` for values of four characters or fewer, `redacted:<last4>`
// otherwise. `withheld` covers values a source declined to report. Any value
// that starts with a marker counts, which also covers hand-scrubbed captures
// such as `redacted-serial` and `redacted:mac` in test/fixtures; the check
// fails closed.
const REDACTION_MARKERS = ["redacted", "withheld"];

/**
 * Report whether an identifier value is a redaction marker rather than an
 * identity.
 *
 * @param {unknown} value Property value.
 * @returns {boolean} True when the value must not be asserted.
 */
export function isRedactedIdentifier(value) {
  if (typeof value !== "string") {
    return true;
  }
  const text = value.trim().toLowerCase();
  if (text.length === 0) {
    return true;
  }
  return REDACTION_MARKERS.some((marker) => text.startsWith(marker));
}

const propertyValue = (subject, name) =>
  (subject?.properties || []).find((entry) => entry?.name === name)?.value;

/**
 * Normalize the second argument of the mapping functions. A bare string is
 * read as the asserting party refId.
 *
 * @param {string | object | undefined} options Mapping options.
 * @returns {object} Options object.
 */
const normalizeOptions = (options) =>
  typeof options === "string" ? { partyRefId: options } : options || {};

/**
 * Whether a hardware component may expose an identifier. All of these must
 * hold: the caller set includeSensitiveIdentifiers, the identifier policy
 * recorded on the component (or passed as options.identifierPolicy, the
 * document-level value) is absent or `raw-identifiers-enabled`, and the value
 * is not a redaction marker.
 *
 * @param {object} component A 1.x-shaped hardware component
 * @param {string} propertyName The cdx:hbom:* identifier property name
 * @param {{ includeSensitiveIdentifiers?: boolean,
 *   identifierPolicy?: string }} [options] Mapping options
 * @returns {boolean}
 */
export function identifierIsAssertable(component, propertyName, options) {
  const { includeSensitiveIdentifiers = false, identifierPolicy } =
    normalizeOptions(options);
  if (includeSensitiveIdentifiers !== true) {
    return false;
  }
  const policy =
    propertyValue(component, "cdx:hbom:identifierPolicy") ?? identifierPolicy;
  if (policy !== undefined && policy !== RAW_IDENTIFIER_POLICY) {
    return false;
  }
  return !isRedactedIdentifier(propertyValue(component, propertyName));
}

/**
 * Map one cdx-hbom component to its 2.0 form and report which parties the
 * result references.
 *
 * Adds identifiers from the sensitive identifier properties (appended after
 * any identifiers the component already has, such as purl identities),
 * classification from hardwareClass and the class codes, and the
 * manufacturer as an inline manufacturer party. Renames bom-ref to refId.
 *
 * @param {object} component A 1.x-shaped cdx-hbom component
 * @param {{ partyRefId?: string, includeSensitiveIdentifiers?: boolean,
 *   identifierPolicy?: string }} [options] partyRefId is the refId of the
 *   party asserting the identities (a party, never a tool refId);
 *   identifiers are emitted only when it is set
 * @returns {{ component: object, partyRefIds: string[] }} The mapped
 *   component (the input is not mutated and every cdx:hbom:* property is
 *   kept) and the party refIds it references, which the caller must declare
 *   in definitions.parties
 */
export function mapCdx20HardwareComponent(component, options) {
  const normalized = normalizeOptions(options);
  const { partyRefId } = normalized;
  const partyRefIds = [];
  const mapped = { ...component };
  delete mapped["bom-ref"];
  if (component["bom-ref"]) {
    mapped.refId = component["bom-ref"];
  }
  const identities = [];
  for (const { property, scheme } of IDENTITY_SCHEMES) {
    if (identifierIsAssertable(component, property, normalized)) {
      identities.push({ scheme, value: propertyValue(component, property) });
    }
  }
  if (identities.length && partyRefId) {
    mapped.identifiers = [
      ...(Array.isArray(component.identifiers) ? component.identifiers : []),
      { party: partyRefId, identities },
    ];
    partyRefIds.push(partyRefId);
  }
  const hardwareClass = propertyValue(component, "cdx:hbom:hardwareClass");
  const codes = CLASS_CODE_STANDARDS.map(({ property, standard }) => {
    const value = propertyValue(component, property);
    return typeof value === "string" && value.length
      ? { standard, value }
      : undefined;
  }).filter(Boolean);
  if (
    CLASSIFIABLE_TYPES.has(component.type) &&
    (hardwareClass || codes.length)
  ) {
    mapped.classification = {
      ...(component.classification || {}),
      ...(hardwareClass ? { category: hardwareClass } : {}),
      ...(codes.length ? { codes } : {}),
    };
  }
  // manufacturer is a 1.x member; 2.0 expresses it as a party role.
  const manufacturer = component.manufacturer;
  delete mapped.manufacturer;
  if (manufacturer && typeof manufacturer === "object" && manufacturer.name) {
    mapped.parties = [
      ...(Array.isArray(component.parties) ? component.parties : []),
      {
        roles: [{ role: "manufacturer" }],
        organization: { name: manufacturer.name },
      },
    ];
  }
  return { component: mapped, partyRefIds };
}

/**
 * Map one cdx-hbom component to its 2.0 form. Use mapCdx20HardwareComponent
 * when the caller needs to know which parties to declare.
 *
 * @param {object} component A 1.x-shaped cdx-hbom component
 * @param {{ partyRefId?: string, includeSensitiveIdentifiers?: boolean,
 *   identifierPolicy?: string } | string} [options] Mapping options; a bare
 *   string is read as partyRefId
 * @returns {object} The mapped component
 */
export function toCdx20HardwareComponent(component, options) {
  return mapCdx20HardwareComponent(component, options).component;
}
