import assert from "node:assert/strict";
import test from "node:test";

import {
  formatVendorId,
  isHexFallback,
  lookupVendor,
} from "../src/common/vendors.js";

test("lookupVendor returns a canonical name for a known id", () => {
  assert.equal(lookupVendor(0x05ac), "Apple");
  assert.equal(lookupVendor(0x8087), "Intel");
});

test("lookupVendor falls back to a hex string for an unknown id", () => {
  assert.equal(lookupVendor(0xdead), "0xdead");
});

test("lookupVendor masks to sixteen bits", () => {
  assert.equal(lookupVendor(0x1_05ac), "Apple");
});

test("lookupVendor returns undefined when no id is given", () => {
  assert.equal(lookupVendor(undefined), undefined);
  assert.equal(lookupVendor(null), undefined);
});

test("formatVendorId zero-pads to four hex digits", () => {
  assert.equal(formatVendorId(0x5ac), "0x05ac");
  assert.equal(formatVendorId(0), "0x0000");
});

test("isHexFallback distinguishes a fallback from a real name", () => {
  assert.equal(isHexFallback(lookupVendor(0xdead)), true);
  assert.equal(isHexFallback(lookupVendor(0x05ac)), false);
  assert.equal(isHexFallback(undefined), false);
});
