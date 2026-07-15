import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readTypecPorts } from "../src/linux/common/typec.js";

/**
 * Write a file, creating parent directories as needed.
 *
 * @param {string} filePath Destination path.
 * @param {string} contents File contents.
 * @returns {void}
 */
function writeFile(filePath, contents) {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, contents);
}

/**
 * Build the injected filesystem primitives for a captured tree.
 *
 * @param {string} base Root of the captured Type-C tree.
 * @returns {import("../src/linux/common/typec.js").TypecReaderIo} Reader IO.
 */
function fsIo(base, powerSupplyBase) {
  return {
    base,
    powerSupplyBase,
    exists: (path) => existsSync(path),
    readDir: (path) => (existsSync(path) ? readdirSync(path) : []),
    readText: (path) =>
      existsSync(path) ? readFileSync(path, "utf8").trim() : undefined,
    readLink: (path) => {
      try {
        return readlinkSync(path);
      } catch {
        return undefined;
      }
    },
    toNumber: (value) => {
      if (value === undefined) {
        return undefined;
      }
      const parsed = Number.parseInt(String(value), 10);
      return Number.isNaN(parsed) ? undefined : parsed;
    },
  };
}

test("readTypecPorts reads a captured sysfs tree from disk", () => {
  const root = mkdtempSync(join(tmpdir(), "cdx-typec-"));
  try {
    writeFile(join(root, "port0", "power_role"), "[sink] source\n");
    writeFile(join(root, "port0", "data_role"), "[host] device\n");
    writeFile(join(root, "port0", "port_type"), "dual\n");
    writeFile(join(root, "port0", "usb_power_delivery_revision"), "3.0\n");

    writeFile(join(root, "port0-cable", "plug_type"), "type-c\n");
    writeFile(join(root, "port0-cable", "type"), "active\n");
    const cableVdo = (2 << 9) | (2 << 5) | (1 << 7) | 3;
    writeFile(
      join(root, "port0-cable", "identity", "product_type_vdo1"),
      `0x${cableVdo.toString(16).padStart(8, "0")}\n`,
    );
    writeFile(
      join(root, "port0-cable", "identity", "id_header"),
      "0x1c00d90d\n",
    );

    const supply = join(
      root,
      "port0-partner",
      "usb_power_delivery",
      "source-capabilities",
      "1:fixed_supply",
    );
    writeFile(join(supply, "voltage"), "20000mV\n");
    writeFile(join(supply, "maximum_current"), "5000mA\n");

    const ports = readTypecPorts(fsIo(root));
    assert.equal(ports.length, 1);

    const [port] = ports;
    assert.equal(port.name, "port0");
    assert.equal(port.powerRole, "[sink] source");
    assert.equal(port.connected, true);
    assert.equal(port.cable.present, true);
    assert.equal(port.cable.type, "active");
    assert.equal(port.cable.plugType, "type-c");
    assert.deepEqual(port.sourceCapabilities, [
      {
        type: "fixed_supply",
        index: 1,
        voltageMillivolt: 20000,
        maxVoltageMillivolt: undefined,
        maxCurrentMilliamp: 5000,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readTypecPorts reads partner correlation, alt modes, PPS and UCSI", () => {
  const root = mkdtempSync(join(tmpdir(), "cdx-typec-"));
  const psy = mkdtempSync(join(tmpdir(), "cdx-psy-"));
  try {
    // The port directory is a symlink to a device path carrying the UCSI
    // controller id, mirroring how the kernel lays this out.
    const device = join(root, "devices", "USBC000:00", "typec", "port0");
    mkdirSync(device, { recursive: true });
    writeFileSync(join(device, "power_role"), "[source] sink\n");
    writeFileSync(join(device, "port_type"), "dual\n");
    symlinkSync(device, join(root, "port0"));

    // A partner with an identity, a linked USB device, a pd node, and a
    // DisplayPort alternate mode.
    const partner = join(root, "port0-partner");
    writeFile(join(partner, "identity", "id_header"), "0x1c0005ac\n");
    writeFile(join(partner, "identity", "product_type_vdo1"), "0x0\n");
    mkdirSync(join(partner, "2-2"), { recursive: true });
    mkdirSync(join(partner, "pd2"), { recursive: true });
    symlinkSync(join(partner, "pd2"), join(partner, "usb_power_delivery"));
    writeFile(join(root, "port0-partner.0", "svid"), "0xff01\n");
    writeFile(join(root, "port0-partner.0", "mode"), "1\n");
    writeFile(join(root, "port0-partner.0", "active"), "yes\n");

    // A full advertisement: a fixed supply and a programmable (PPS) supply.
    const caps = join(partner, "usb_power_delivery", "source-capabilities");
    writeFile(join(caps, "1:fixed_supply", "voltage"), "20000mV\n");
    writeFile(join(caps, "1:fixed_supply", "maximum_current"), "5000mA\n");
    writeFile(join(caps, "5:programmable_supply", "minimum_voltage"), "5000mV\n");
    writeFile(join(caps, "5:programmable_supply", "maximum_voltage"), "21000mV\n");
    writeFile(join(caps, "5:programmable_supply", "maximum_current"), "3000mA\n");
    // The runtime power-management directory must not become a supply.
    mkdirSync(join(caps, "power"), { recursive: true });

    // The UCSI live readout for this port: 15V at 3A.
    const supply = join(psy, "ucsi-source-psy-USBC000:001");
    writeFile(join(supply, "online"), "1\n");
    writeFile(join(supply, "voltage_now"), "15000000\n");
    writeFile(join(supply, "current_now"), "3000000\n");

    const [port] = readTypecPorts(fsIo(root, psy));

    assert.equal(port.partner.present, true);
    assert.equal(port.partner.idHeader, "0x1c0005ac");
    assert.equal(port.partner.usbName, "2-2");
    assert.equal(port.partner.pdName, "pd2");
    assert.deepEqual(port.partner.altModes, [
      { svid: 0xff01, mode: 1, active: true },
    ]);

    assert.equal(port.sourceCapabilities.length, 2);
    assert.equal(port.sourceCapabilities[1].type, "programmable_supply");
    assert.equal(port.sourceCapabilities[1].voltageMillivolt, 5000);
    assert.equal(port.sourceCapabilities[1].maxVoltageMillivolt, 21000);

    assert.equal(port.liveSupply.online, true);
    assert.equal(port.liveSupply.voltageMicrovolt, 15000000);
    assert.equal(port.liveSupply.currentMicroamp, 3000000);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(psy, { recursive: true, force: true });
  }
});

test("readTypecPorts ignores non-port entries and missing cables", () => {
  const root = mkdtempSync(join(tmpdir(), "cdx-typec-"));
  try {
    writeFile(join(root, "port0", "power_role"), "source\n");
    // A stray entry that is not a connector should be skipped.
    writeFile(join(root, "usb_power_delivery", "revision"), "3.0\n");

    const ports = readTypecPorts(fsIo(root));
    assert.equal(ports.length, 1);
    assert.equal(ports[0].cable.present, false);
    assert.deepEqual(ports[0].sourceCapabilities, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
