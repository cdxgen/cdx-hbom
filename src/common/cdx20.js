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
 * value is emitted only when includeSensitiveIdentifiers was set AND the
 * value is not redacted. The default `redacted:<last4>` form and withheld
 * values are false identities and never become identifiers.
 *
 * Not emitted: deviceType (package types like bga/smd describe packaging, not
 * the draft's device-type taxonomy) and quantity (a host collector cannot
 * observe it). Firmware slot labels stay as properties for the maintainer to
 * decide against boardLocation.designators, which the schema reserves for
 * PCB reference designators such as U5 or R12.
 */

const IDENTITY_SCHEMES = [
  { property: "cdx:hbom:serialNumber", scheme: "serial-number" },
  { property: "cdx:hbom:assetTag", scheme: "asset-tag" },
  { property: "cdx:hbom:macAddress", scheme: "mac-address" },
  { property: "cdx:hbom:imei", scheme: "imei" },
  { property: "cdx:hbom:modelNumber", scheme: "model-number" },
];

const isRedacted = (value) =>
  typeof value !== "string" ||
  value.length === 0 ||
  value.startsWith("redacted:");

const propertyValue = (subject, name) =>
  (subject?.properties || []).find((entry) => entry?.name === name)?.value;

/**
 * Whether a hardware component is currently allowed to expose identifiers:
 * the caller must have set includeSensitiveIdentifiers and the value must
 * not be a redaction marker.
 *
 * @param {object} component A 1.x-shaped hardware component
 * @param {string} propertyName The cdx:hbom:* identifier property name
 * @returns {boolean}
 */
export function identifierIsAssertable(component, propertyName) {
  // The identifierPolicy property records what the collector did: only the
  // include policy ever publishes the full value.
  const policy = propertyValue(component, "cdx:hbom:identifierPolicy");
  if (policy !== "include") {
    return false;
  }
  return !isRedacted(propertyValue(component, propertyName));
}

/**
 * Map one cdx-hbom component to its 2.0 form: identifiers from the sensitive
 * identifier properties, classification from hardwareClass and the class
 * codes, and the manufacturer property as a manufacturer party.
 *
 * @param {object} component A 1.x-shaped cdx-hbom component
 * @param {string} [partyRefId] refId of the asserting party (cdxgen's
 *   cdxgen party or cdx-hbom's tool); identifiers assert identity, which
 *   the draft requires to be attributed
 * @returns {object} The component with 2.0 native members added; the input
 *   is not mutated and every cdx:hbom:* property is kept
 */
export function toCdx20HardwareComponent(component, partyRefId) {
  const mapped = { ...component };
  delete mapped["bom-ref"];
  if (component["bom-ref"]) {
    mapped.refId = component["bom-ref"];
  }
  const identities = [];
  for (const { property, scheme } of IDENTITY_SCHEMES) {
    if (identifierIsAssertable(component, property)) {
      identities.push({ scheme, value: propertyValue(component, property) });
    }
  }
  if (identities.length && partyRefId) {
    mapped.identifiers = [
      { party: partyRefId, identities },
    ];
  }
  const hardwareClass = propertyValue(component, "cdx:hbom:hardwareClass");
  const pciClassCode = propertyValue(component, "cdx:hbom:pciClassCode");
  const usbClass = propertyValue(component, "cdx:hbom:usbClass");
  const codes = [pciClassCode, usbClass].filter(Boolean);
  if (hardwareClass || codes.length) {
    mapped.classification = {
      ...(hardwareClass ? { category: hardwareClass } : {}),
      ...(codes.length ? { codes } : {}),
    };
  }
  const manufacturer = component.manufacturer;
  if (manufacturer && typeof manufacturer === "object" && manufacturer.name) {
    mapped.parties = [
      ...(mapped.parties || []),
      {
        roles: [{ role: "manufacturer" }],
        organization: { name: manufacturer.name },
      },
    ];
    delete mapped.manufacturer;
  }
  return mapped;
}
