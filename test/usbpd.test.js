import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PD_WATTS,
  bits,
  decodeActiveCableVdo2,
  decodeCableVdo,
  decodeIdHeaderVdo,
  decodeSourcePdo,
  maxSourceWatts,
  toUint32,
} from "../src/common/usbpd.js";

test("bits extracts unsigned fields", () => {
  assert.equal(bits(0b1011, 0, 1), 0b11);
  assert.equal(bits(0b1011, 2, 3), 0b10);
  assert.equal(bits(0xffffffff, 0, 31), 0xffffffff);
});

test("toUint32 accepts hex strings, numbers and rejects junk", () => {
  assert.equal(toUint32("0x1abc"), 0x1abc);
  assert.equal(toUint32("1abc"), 0x1abc);
  assert.equal(toUint32(255), 255);
  assert.equal(toUint32(undefined), undefined);
  assert.equal(toUint32("nothex"), undefined);
  assert.equal(toUint32(""), undefined);
});

test("decodeIdHeaderVdo reads the vendor id and cable type from the UFP field", () => {
  // Vendor id 0x05ac, UFP product type 3 (passive cable) in bits 27-29.
  const value = (3 << 27) | 0x05ac;
  const decoded = decodeIdHeaderVdo(value);
  assert.equal(decoded.vendorId, 0x05ac);
  assert.equal(decoded.ufpProductType, "passive-cable");
  assert.equal(decoded.isCable, true);
});

test("decodeIdHeaderVdo recognises cables that report type in the DFP field", () => {
  // Non-compliant cable: type 4 (active cable) placed in DFP bits 23-25.
  const value = (4 << 23) | 0x311c;
  const decoded = decodeIdHeaderVdo(value);
  assert.equal(decoded.vendorId, 0x311c);
  assert.equal(decoded.isCable, true);
  assert.equal(decoded.dfpProductType, "active-cable");
});

test("decodeCableVdo decodes a 5A 100W USB4 passive cable", () => {
  // speed 3 (40 Gbps), current 2 (5A), vbus 0 (20V), epr bit set.
  const value = (2 << 9) | (2 << 5) | (1 << 7) | 3;
  const decoded = decodeCableVdo(value);
  assert.equal(decoded.maxDataRateGbps, 40);
  assert.equal(decoded.maxCurrentAmps, 5);
  assert.equal(decoded.maxVbusVoltage, 40);
  // Delivery voltage clamps to 48V but 40V is under it, so 40V x 5A = 200W.
  assert.equal(decoded.maxPowerWatts, 200);
  assert.equal(decoded.eprCapable, true);
  assert.equal(decoded.cableType, "passive");
  assert.deepEqual(decoded.warnings, []);
});

test("decodeCableVdo clamps insulation voltage so watts never exceed the PD ceiling", () => {
  // vbus 3 (50V insulation rating), current 2 (5A).
  const value = (3 << 9) | (2 << 5);
  const decoded = decodeCableVdo(value);
  assert.equal(decoded.maxVbusVoltage, 50);
  // 50V is clamped to 48V for delivery: 48V x 5A = 240W, the PD ceiling.
  assert.equal(decoded.maxPowerWatts, MAX_PD_WATTS);
});

test("decodeCableVdo warns on reserved encodings", () => {
  // current field 3 is reserved.
  const value = 3 << 5;
  const decoded = decodeCableVdo(value);
  assert.equal(decoded.maxCurrentAmps, undefined);
  assert.ok(decoded.warnings.some((warning) => warning.field === "current"));
});

test("decodeActiveCableVdo2 un-inverts the protocol support bits", () => {
  // All support bits cleared means every protocol is supported.
  const decoded = decodeActiveCableVdo2(0);
  assert.equal(decoded.usb4Support, true);
  assert.equal(decoded.usb32Support, true);
  assert.equal(decoded.usb2Support, true);
  assert.equal(decoded.medium, "copper");
  assert.equal(decoded.activeElement, "redriver");
});

test("decodeSourcePdo decodes a fixed 9V 3A supply", () => {
  // Fixed supply (bits 30-31 = 0), voltage 9V (180 x 50mV), current 3A (300 x 10mA).
  const value = (180 << 10) | 300;
  const decoded = decodeSourcePdo(value);
  assert.equal(decoded.supplyType, "fixed");
  assert.equal(decoded.voltage, 9);
  assert.equal(decoded.maxCurrent, 3);
  assert.equal(decoded.maxPowerWatts, 27);
});

test("decodeSourcePdo reports non-fixed supplies without misreading bits", () => {
  const augmented = decodeSourcePdo(3 << 30);
  assert.equal(augmented.supplyType, "augmented");
  assert.equal(augmented.voltage, undefined);
});

test("maxSourceWatts returns the strongest fixed supply", () => {
  const fiveVolt = (100 << 10) | 300; // 5V 3A = 15W
  const nineVolt = (180 << 10) | 300; // 9V 3A = 27W
  assert.equal(maxSourceWatts([fiveVolt, nineVolt]), 27);
  assert.equal(maxSourceWatts([]), undefined);
});
