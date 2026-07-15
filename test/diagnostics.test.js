import assert from "node:assert/strict";
import test from "node:test";

import {
  cableTrustNotes,
  chargingDiagnostic,
  dataLinkDiagnostic,
} from "../src/common/diagnostics.js";

test("chargingDiagnostic flags a cable rated below the charger", () => {
  const result = chargingDiagnostic({
    chargerMaxWatts: 100,
    cableMaxWatts: 60,
    negotiatedWatts: 60,
  });
  assert.equal(result.bottleneck, "cable-limit");
  assert.equal(result.isWarning, true);
});

test("chargingDiagnostic treats a tapering battery as normal", () => {
  const result = chargingDiagnostic({
    chargerMaxWatts: 100,
    cableMaxWatts: 100,
    negotiatedWatts: 20,
  });
  assert.equal(result.bottleneck, "host-limit");
  assert.equal(result.isWarning, false);
});

test("chargingDiagnostic reports a healthy contract as fine", () => {
  const result = chargingDiagnostic({
    chargerMaxWatts: 100,
    cableMaxWatts: 100,
    negotiatedWatts: 96,
  });
  assert.equal(result.bottleneck, "fine");
});

test("chargingDiagnostic handles a disconnected port", () => {
  const result = chargingDiagnostic({ connectionActive: false });
  assert.equal(result.bottleneck, "disconnected");
});

test("chargingDiagnostic reports the ceiling when no contract is negotiated", () => {
  const result = chargingDiagnostic({ chargerMaxWatts: 100, cableMaxWatts: 240 });
  assert.equal(result.bottleneck, "fine");
  assert.match(result.verdict, /up to 100W/u);
});

test("chargingDiagnostic reports unknown when no ratings are available", () => {
  const result = chargingDiagnostic({ connectionActive: true });
  assert.equal(result.bottleneck, "unknown");
});

test("chargingDiagnostic reports a low active contract as a device limit", () => {
  const result = chargingDiagnostic({
    chargerMaxWatts: 100,
    cableMaxWatts: 100,
    activeWatts: 15,
  });
  assert.equal(result.bottleneck, "device-limit");
  assert.equal(result.isWarning, false);
  assert.match(result.verdict, /15W of the 100W/u);
});

test("chargingDiagnostic reports a sink asking for less than its contract", () => {
  const result = chargingDiagnostic({
    chargerMaxWatts: 65,
    cableMaxWatts: 100,
    activeWatts: 65,
    requestedWatts: 15,
  });
  assert.equal(result.bottleneck, "sink-limit");
  assert.equal(result.isWarning, false);
  assert.match(result.verdict, /15W of the 65W/u);
});

test("chargingDiagnostic does not raise a sink limit near the contract", () => {
  const result = chargingDiagnostic({
    chargerMaxWatts: 65,
    activeWatts: 65,
    requestedWatts: 60,
  });
  assert.equal(result.bottleneck, "fine");
});

test("chargingDiagnostic flags a request pinned at 3A with no e-marker", () => {
  const result = chargingDiagnostic({
    chargerMaxWatts: 100,
    activeCurrentMilliamp: 5000,
    requestedMilliamp: 3000,
    cableCurrentRatingVisible: false,
  });
  assert.equal(result.bottleneck, "cable-no-emarker");
  assert.equal(result.isWarning, true);
  assert.match(result.verdict, /5.0A/u);
});

test("chargingDiagnostic stays quiet on 3A pin when an e-marker rating is visible", () => {
  const result = chargingDiagnostic({
    chargerMaxWatts: 100,
    cableMaxWatts: 100,
    activeWatts: 100,
    activeCurrentMilliamp: 5000,
    requestedMilliamp: 3000,
    cableCurrentRatingVisible: true,
  });
  assert.notEqual(result.bottleneck, "cable-no-emarker");
});

test("chargingDiagnostic keeps cable-limit ahead of a sink limit", () => {
  const result = chargingDiagnostic({
    chargerMaxWatts: 100,
    cableMaxWatts: 60,
    activeWatts: 60,
    requestedWatts: 10,
  });
  assert.equal(result.bottleneck, "cable-limit");
  assert.equal(result.isWarning, true);
});

test("dataLinkDiagnostic blames the connected device before the cable", () => {
  const result = dataLinkDiagnostic({
    hostGbps: 40,
    cableGbps: 40,
    deviceGbps: 10,
    negotiatedGbps: 10,
  });
  assert.equal(result.bottleneck, "device-limit");
  assert.equal(result.limitedToGbps, 10);
});

test("dataLinkDiagnostic blames the cable when it is the weak link", () => {
  const result = dataLinkDiagnostic({
    hostGbps: 40,
    cableGbps: 10,
    deviceGbps: 40,
  });
  assert.equal(result.bottleneck, "cable-limit");
  assert.equal(result.limitedToGbps, 10);
});

test("dataLinkDiagnostic reports a matched link as fine", () => {
  const result = dataLinkDiagnostic({
    hostGbps: 40,
    cableGbps: 40,
    deviceGbps: 40,
    negotiatedGbps: 40,
  });
  assert.equal(result.bottleneck, "fine");
  assert.equal(result.limitedToGbps, 40);
});

test("dataLinkDiagnostic is honest when the cable is unknown", () => {
  const result = dataLinkDiagnostic({ negotiatedGbps: 10 });
  assert.equal(result.bottleneck, "unknown-cable");
  assert.equal(result.limitedToGbps, 10);
});

test("cableTrustNotes flags a zero vendor id as an observation", () => {
  const notes = cableTrustNotes({ vendorId: 0 });
  assert.ok(notes.some((note) => note.includes("zero vendor id")));
});

test("cableTrustNotes flags an EPR claim that contradicts a 20V rating", () => {
  const notes = cableTrustNotes({ eprCapable: true, maxVbusVoltage: 20 });
  assert.ok(notes.some((note) => note.includes("extended power range")));
});

test("cableTrustNotes stays silent for a well-formed cable", () => {
  const notes = cableTrustNotes({ vendorId: 0x05ac, maxVbusVoltage: 50 });
  assert.deepEqual(notes, []);
});

test("cableTrustNotes carries decode warnings through", () => {
  const notes = cableTrustNotes({ decodeWarnings: ["Reserved cable speed"] });
  assert.deepEqual(notes, ["Reserved cable speed"]);
});
