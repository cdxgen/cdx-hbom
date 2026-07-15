import assert from "node:assert/strict";
import test from "node:test";

import {
  createTypecComponents,
  isBusPortName,
  parseTypecRole,
  selectActivePdo,
  summarizeSourceCapabilities,
  ucsiController,
} from "../src/linux/common/typec.js";

/**
 * Find a component by its hardware class.
 *
 * @param {object[]} components Component list.
 * @param {string} hardwareClass Hardware class to match.
 * @returns {object | undefined} Matching component.
 */
function byClass(components, hardwareClass) {
  return components.find(
    (component) =>
      component.properties.find(
        (property) => property.name === "cdx:hbom:hardwareClass",
      )?.value === hardwareClass,
  );
}

/**
 * Find a property value on a component by name.
 *
 * @param {object} component Component to inspect.
 * @param {string} name Property name.
 * @returns {string | undefined} Property value.
 */
function propertyValue(component, name) {
  return component.properties.find((property) => property.name === name)?.value;
}

test("parseTypecRole reads the selected role from brackets", () => {
  assert.deepEqual(parseTypecRole("[sink] source"), {
    current: "sink",
    supported: ["sink", "source"],
  });
  assert.deepEqual(parseTypecRole("source"), {
    current: "source",
    supported: ["source"],
  });
  assert.deepEqual(parseTypecRole(undefined), {
    current: undefined,
    supported: [],
  });
});

test("createTypecComponents emits a port and a decoded cable", () => {
  const { components, dependencies } = createTypecComponents([
    {
      name: "port0",
      powerRole: "[sink] source",
      dataRole: "[host] device",
      portType: "dual",
      pdRevision: "3.0",
      cable: {
        present: true,
        plugType: "type-c",
        // speed 3 (40 Gbps), current 2 (5A), vbus 0 (20V), epr set.
        productTypeVdo1: `0x${((2 << 5) | (1 << 7) | 3).toString(16)}`,
      },
    },
  ]);

  const port = components.find(
    (component) =>
      propertyValue(component, "cdx:hbom:hardwareClass") === "usb-c-port",
  );
  assert.ok(port);
  assert.equal(propertyValue(port, "cdx:hbom:portRole"), "dual");
  assert.equal(propertyValue(port, "cdx:hbom:powerRole"), "sink");
  assert.equal(port["bom-ref"], "typec-port-port0");

  const cable = components.find(
    (component) =>
      propertyValue(component, "cdx:hbom:hardwareClass") === "cable",
  );
  assert.ok(cable);
  assert.equal(propertyValue(cable, "cdx:hbom:maxDataRateGbps"), "40");
  assert.equal(propertyValue(cable, "cdx:hbom:maxCurrentAmps"), "5");
  assert.equal(propertyValue(cable, "cdx:hbom:cableClass"), "usb-c");

  assert.deepEqual(dependencies, [
    { ref: "typec-port-port0", dependsOn: ["typec-cable-port0"] },
  ]);
});

test("createTypecComponents flags a cable that limits charging", () => {
  const { components } = createTypecComponents([
    {
      name: "port0",
      powerRole: "[sink] source",
      connected: true,
      // A 100W charger: 20V at 5A fixed supply.
      sourceCapabilities: [
        { type: "fixed_supply", voltageMillivolt: 20000, maxCurrentMilliamp: 5000 },
      ],
      cable: {
        present: true,
        // A 3A cable at 20V tops out at 60W, below the 100W charger.
        productTypeVdo1: `0x${((1 << 5) | 0).toString(16)}`,
      },
    },
  ]);

  const port = components.find(
    (component) =>
      propertyValue(component, "cdx:hbom:hardwareClass") === "usb-c-port",
  );
  assert.equal(propertyValue(port, "cdx:hbom:chargerMaxWatts"), "100");
  assert.equal(propertyValue(port, "cdx:hbom:chargingBottleneck"), "cable-limit");
});

test("ucsiController extracts the controller id from a device path", () => {
  assert.equal(
    ucsiController("/sys/devices/platform/USBC000:00/typec/port0"),
    "USBC000:00",
  );
  assert.equal(ucsiController("/sys/class/typec/port0"), undefined);
});

test("isBusPortName accepts bus-port names and rejects others", () => {
  assert.equal(isBusPortName("2-2"), true);
  assert.equal(isBusPortName("2-2.1.4"), true);
  assert.equal(isBusPortName("identity"), false);
  assert.equal(isBusPortName("pd1"), false);
  assert.equal(isBusPortName("port0-partner.0"), false);
});

test("summarizeSourceCapabilities takes the peak fixed supply and lists profiles", () => {
  const { chargerWatts, profiles } = summarizeSourceCapabilities([
    { type: "fixed_supply", voltageMillivolt: 5000, maxCurrentMilliamp: 3000 },
    { type: "fixed_supply", voltageMillivolt: 20000, maxCurrentMilliamp: 5000 },
    {
      type: "programmable_supply",
      voltageMillivolt: 5000,
      maxVoltageMillivolt: 21000,
      maxCurrentMilliamp: 3000,
    },
  ]);
  assert.equal(chargerWatts, 100);
  assert.equal(profiles.length, 3);
});

test("selectActivePdo matches the fixed supply nearest the live voltage", () => {
  const caps = [
    { type: "fixed_supply", voltageMillivolt: 5000, maxCurrentMilliamp: 3000 },
    { type: "fixed_supply", voltageMillivolt: 20000, maxCurrentMilliamp: 5000 },
  ];
  assert.equal(selectActivePdo(caps, 19_800_000).voltageMillivolt, 20000);
  assert.equal(selectActivePdo(caps, 5_100_000).voltageMillivolt, 5000);
  assert.equal(selectActivePdo(caps, undefined), undefined);
  // A reading far from any profile pins nothing.
  assert.equal(selectActivePdo(caps, 12_000_000), undefined);
});

test("createTypecComponents models a partner and links it to its USB device", () => {
  const { components, dependencies } = createTypecComponents([
    {
      name: "port0",
      powerRole: "[source] sink",
      connected: true,
      cable: { present: true, productTypeVdo1: "0x3" },
      partner: {
        present: true,
        idHeader: `0x${((1 << 27) | 0x05ac).toString(16)}`,
        usbName: "2-2",
        pdName: "pd2",
        altModes: [{ svid: 0xff01, mode: 1, active: true }],
      },
    },
  ]);

  const partner = byClass(components, "usb-c-hub");
  assert.ok(partner);
  assert.equal(propertyValue(partner, "cdx:hbom:linkedUsbDevice"), "2-2");
  assert.equal(propertyValue(partner, "cdx:hbom:powerDeliveryNode"), "pd2");
  assert.equal(propertyValue(partner, "cdx:hbom:displayPortCapable"), "true");
  assert.equal(propertyValue(partner, "cdx:hbom:vendorName"), "Apple");

  // Chain reads port to cable to partner to the enumerated USB device.
  assert.deepEqual(
    dependencies.find((edge) => edge.ref === "typec-cable-port0")?.dependsOn,
    ["typec-partner-port0"],
  );
  assert.deepEqual(
    dependencies.find((edge) => edge.ref === "typec-partner-port0")?.dependsOn,
    ["usb-device-2-2"],
  );
});

test("createTypecComponents refines the cable class from Thunderbolt alt mode", () => {
  const { components } = createTypecComponents([
    {
      name: "port0",
      cable: {
        present: true,
        productTypeVdo1: `0x${((2 << 5) | 3).toString(16)}`,
        altModes: [{ svid: 0x8087, mode: 1, active: true }],
      },
    },
  ]);
  const cable = byClass(components, "cable");
  assert.equal(propertyValue(cable, "cdx:hbom:cableClass"), "thunderbolt");
  assert.equal(
    propertyValue(cable, "cdx:hbom:alternateModes"),
    "Thunderbolt",
  );
});

test("createTypecComponents feeds the UCSI readout into the charging verdict", () => {
  const { components } = createTypecComponents([
    {
      name: "port0",
      powerRole: "[sink] source",
      connected: true,
      // A 100W charger advertising 20V/5A.
      sourceCapabilities: [
        {
          type: "fixed_supply",
          voltageMillivolt: 20000,
          maxCurrentMilliamp: 5000,
        },
      ],
      // The sink only pulls 20V at 1A, far below the contract: a benign
      // sink limit rather than a cable or charger fault.
      liveSupply: { voltageMicrovolt: 20_000_000, currentMicroamp: 1_000_000 },
    },
  ]);
  const port = byClass(components, "usb-c-port");
  assert.equal(propertyValue(port, "cdx:hbom:negotiatedWatts"), "20");
  assert.equal(propertyValue(port, "cdx:hbom:chargingBottleneck"), "sink-limit");
  assert.equal(propertyValue(port, "cdx:hbom:chargingWarning"), undefined);
});

test("createTypecComponents skips ports without a name", () => {
  const { components } = createTypecComponents([{ powerRole: "source" }]);
  assert.deepEqual(components, []);
});

test("createTypecComponents hides the vendor id unless sensitive output is requested", () => {
  const record = [
    {
      name: "port0",
      cable: {
        present: true,
        idHeader: "0x000005ac",
        productTypeVdo1: "0x3",
      },
    },
  ];

  const redacted = createTypecComponents(record);
  const redactedCable = redacted.components.find(
    (component) =>
      component.properties.find(
        (property) => property.name === "cdx:hbom:hardwareClass",
      )?.value === "cable",
  );
  assert.equal(propertyValue(redactedCable, "cdx:hbom:vendorId"), undefined);

  const sensitive = createTypecComponents(record, {
    includeSensitiveIdentifiers: true,
  });
  const sensitiveCable = sensitive.components.find(
    (component) =>
      component.properties.find(
        (property) => property.name === "cdx:hbom:hardwareClass",
      )?.value === "cable",
  );
  assert.equal(propertyValue(sensitiveCable, "cdx:hbom:vendorId"), "0x05ac");
});
