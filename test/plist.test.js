import assert from "node:assert/strict";
import test from "node:test";

import { parsePlistArray, parsePlistDict } from "../index.js";

test("parsePlistDict parses diskutil-style plist dictionaries", () => {
  const parsed = parsePlistDict(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>BusProtocol</key>
  <string>Apple Fabric</string>
  <key>DeviceBlockSize</key>
  <integer>4096</integer>
  <key>DeviceIdentifier</key>
  <string>disk0</string>
  <key>Internal</key>
  <true/>
  <key>SMARTDeviceSpecificKeysMayVaryNotGuaranteed</key>
  <dict>
    <key>PERCENTAGE_USED</key>
    <integer>2</integer>
  </dict>
</dict>
</plist>`);

  assert.deepEqual(parsed, {
    BusProtocol: "Apple Fabric",
    DeviceBlockSize: 4096,
    DeviceIdentifier: "disk0",
    Internal: true,
    SMARTDeviceSpecificKeysMayVaryNotGuaranteed: {
      PERCENTAGE_USED: 2,
    },
  });
});

test("parsePlistArray parses ioreg-style plist arrays and preserves data payloads", () => {
  const parsed = parsePlistArray(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
  <dict>
    <key>IOPlatformSerialNumber</key>
    <string>KX2L66YHJR</string>
    <key>IOPlatformUUID</key>
    <string>8A770B45-5F72-5242-B992-E8BC22A1BE01</string>
    <key>model</key>
    <data>
    TWFjMTYsNwA=
    </data>
  </dict>
</array>
</plist>`);

  assert.deepEqual(parsed, [
    {
      IOPlatformSerialNumber: "KX2L66YHJR",
      IOPlatformUUID: "8A770B45-5F72-5242-B992-E8BC22A1BE01",
      model: "TWFjMTYsNwA=",
    },
  ]);
});

test("parsePlistDict accepts self-closing empty arrays and dictionaries", () => {
  const parsed = parsePlistDict(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Containers</key>
  <array/>
  <key>Metadata</key>
  <dict/>
</dict>
</plist>`);

  assert.deepEqual(parsed, {
    Containers: [],
    Metadata: {},
  });
});
