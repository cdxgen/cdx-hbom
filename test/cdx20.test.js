import assert from "node:assert/strict";
import test from "node:test";

import {
  identifierIsAssertable,
  isRedactedIdentifier,
  mapCdx20HardwareComponent,
  RAW_IDENTIFIER_POLICY,
  REDACTED_IDENTIFIER_POLICY,
  toCdx20HardwareComponent,
} from "../src/common/cdx20.js";
import { redactIdentifier } from "../src/common/shape.js";

test("isRedactedIdentifier treats every redaction marker as redacted", () => {
  for (const value of [
    undefined,
    null,
    "",
    "  ",
    "redacted",
    "REDACTED",
    "redacted:3456",
    "withheld",
    "withheld:policy",
    "redacted-serial",
    "redacted:mac",
    redactIdentifier("ab12"),
    redactIdentifier("SN-123456"),
  ]) {
    assert.equal(isRedactedIdentifier(value), true, String(value));
  }
  assert.equal(redactIdentifier("ab12"), "redacted");
  for (const value of ["SN-123456", "00:11:22:33:44:55", "C02XYZ"]) {
    assert.equal(isRedactedIdentifier(value), false, value);
  }
});

test("identifierIsAssertable requires the option, a raw policy and a raw value", () => {
  const component = (policy, value = "SN-123456") => ({
    properties: [
      ...(policy ? [{ name: "cdx:hbom:identifierPolicy", value: policy }] : []),
      { name: "cdx:hbom:serialNumber", value },
    ],
  });
  const name = "cdx:hbom:serialNumber";
  const on = { includeSensitiveIdentifiers: true };
  assert.equal(identifierIsAssertable(component(), name), false);
  assert.equal(identifierIsAssertable(component(RAW_IDENTIFIER_POLICY), name), false);
  assert.equal(identifierIsAssertable(component(), name, on), true);
  assert.equal(
    identifierIsAssertable(component(RAW_IDENTIFIER_POLICY), name, on),
    true,
  );
  assert.equal(
    identifierIsAssertable(component(REDACTED_IDENTIFIER_POLICY), name, on),
    false,
  );
  // "include" is not a value any collector writes.
  assert.equal(identifierIsAssertable(component("include"), name, on), false);
  assert.equal(
    identifierIsAssertable(component(), name, {
      ...on,
      identifierPolicy: REDACTED_IDENTIFIER_POLICY,
    }),
    false,
  );
  for (const value of ["redacted", "redacted:3456", "withheld"]) {
    assert.equal(
      identifierIsAssertable(component(RAW_IDENTIFIER_POLICY, value), name, on),
      false,
      value,
    );
  }
});

test("mapCdx20HardwareComponent appends identifiers and reports the party", () => {
  const nic = {
    "bom-ref": "device:nic",
    type: "device",
    name: "nic",
    manufacturer: { name: "Acme" },
    identifiers: [
      {
        party: "party-cdxgen",
        identities: [{ scheme: "purl", value: "pkg:generic/acme/nic@1" }],
      },
    ],
    properties: [
      { name: "cdx:hbom:serialNumber", value: "SN-123456" },
      { name: "cdx:hbom:macAddress", value: "00:11:22:33:44:55" },
      { name: "cdx:hbom:assetTag", value: "redacted" },
      { name: "cdx:hbom:hardwareClass", value: "network-adapter" },
      { name: "cdx:hbom:pciClassCode", value: "0200" },
      { name: "cdx:hbom:deviceType", value: "bga" },
      { name: "cdx:hbom:quantity", value: "4" },
      { name: "cdx:hbom:deviceLocator", value: "DIMM3" },
    ],
  };
  const snapshot = structuredClone(nic);
  const { component, partyRefIds } = mapCdx20HardwareComponent(nic, {
    partyRefId: "party-hbom",
    includeSensitiveIdentifiers: true,
  });
  assert.deepEqual(nic, snapshot, "the input is not mutated");
  assert.deepEqual(partyRefIds, ["party-hbom"]);
  assert.equal(component.refId, "device:nic");
  assert.equal(component["bom-ref"], undefined);
  assert.deepEqual(component.properties, nic.properties);
  assert.deepEqual(component.identifiers, [
    nic.identifiers[0],
    {
      party: "party-hbom",
      identities: [
        { scheme: "serial-number", value: "SN-123456" },
        { scheme: "mac-address", value: "00:11:22:33:44:55" },
      ],
    },
  ]);
  assert.deepEqual(component.classification, {
    category: "network-adapter",
    codes: [{ standard: "PCI-SIG class code", value: "0200" }],
  });
  assert.deepEqual(component.parties, [
    { roles: [{ role: "manufacturer" }], organization: { name: "Acme" } },
  ]);
  assert.equal(component.manufacturer, undefined);
  assert.equal(component.deviceType, undefined);
  assert.equal(component.quantity, undefined);
  assert.equal(component.boardLocation, undefined);

  const usb = toCdx20HardwareComponent({
    type: "device",
    name: "hub",
    properties: [{ name: "cdx:hbom:usbClass", value: "09" }],
  });
  assert.deepEqual(usb.classification, {
    codes: [{ standard: "USB-IF class code", value: "09" }],
  });
});

test("mapCdx20HardwareComponent emits no identifiers by default or without a party", () => {
  const nic = {
    type: "device",
    name: "nic",
    identifiers: [
      {
        party: "party-cdxgen",
        identities: [{ scheme: "purl", value: "pkg:generic/acme/nic@1" }],
      },
    ],
    properties: [{ name: "cdx:hbom:serialNumber", value: "SN-123456" }],
  };
  const byDefault = mapCdx20HardwareComponent(nic, { partyRefId: "party-hbom" });
  assert.deepEqual(byDefault.partyRefIds, []);
  assert.deepEqual(byDefault.component.identifiers, nic.identifiers);
  const noParty = mapCdx20HardwareComponent(nic, {
    includeSensitiveIdentifiers: true,
  });
  assert.deepEqual(noParty.partyRefIds, []);
  assert.deepEqual(noParty.component.identifiers, nic.identifiers);
  // A bare string is read as the party refId; the option is still required.
  assert.deepEqual(toCdx20HardwareComponent(nic, "party-hbom").identifiers, nic.identifiers);
  // classification is only allowed on device and material components.
  const firmware = toCdx20HardwareComponent({
    type: "firmware",
    name: "bios",
    properties: [{ name: "cdx:hbom:hardwareClass", value: "firmware" }],
  });
  assert.equal(firmware.classification, undefined);
});
