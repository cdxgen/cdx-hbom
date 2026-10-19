import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseDeviceInstanceId,
  parseHardwareIds,
  redactInstanceId,
} from "../../src/windows/common/pnp.js";
import { parseWindowsEnvelope } from "../../src/windows/common/cim.js";

// Example device instance ID from:
// https://learn.microsoft.com/en-us/windows-hardware/drivers/install/device-instance-ids
const PCI_DOC_INSTANCE = "PCI\\VEN_1000&DEV_0001&SUBSYS_00000000&REV_02\\1&08";

// Example hardware/compatible IDs from:
// https://learn.microsoft.com/en-us/windows-hardware/drivers/install/identifiers-for-pci-devices
const PCI_DOC_HARDWARE_IDS = [
  "PCI\\VEN_1414&DEV_00E0&SUBSYS_00000000&REV_04",
  "PCI\\VEN_1414&DEV_00E0&SUBSYS_00000000",
  "PCI\\VEN_1414&DEV_00E0&REV_04",
  "PCI\\VEN_1414&DEV_00E0",
];

// Example Bluetooth IDs from:
// https://learn.microsoft.com/en-us/windows-hardware/drivers/bluetooth/installing-a-bluetooth-device
const BTH_DOC_SERVICE_ID = "BTHENUM\\{00001124-0000-1000-8000-00805F9B34FB}";
const BTH_DOC_VID_PID_ID =
  "BTHENUM\\{00001124-0000-1000-8000-00805F9B34FB}_VID&12345678_PID&abcd";

// Example firmware resource ID from:
// https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/authoring-an-update-driver-package
// (UEFI\RES_{RESOURCE_GUID}, post-update form UEFI\RES_{RESOURCE_GUID}&REV_XXX)
const UEFI_DOC_RESOURCE_ID = "UEFI\\RES_{6bd4efb9-23cc-4b4a-ac37-016517413e9a}";

// Formats documented at:
// https://learn.microsoft.com/en-us/windows-hardware/drivers/install/standard-usb-identifiers
// USB\VID_v(4)&PID_d(4)[&REV_r(4)] and USB\VID_v(4)&PID_d(4)&MI_z(2).
const USB_TEMPLATE_IDS = [
  "USB\\VID_1D6B&PID_0002&REV_0600",
  "USB\\VID_1D6B&PID_0003&MI_01",
];

test("parseDeviceInstanceId splits documented PCI instance IDs", () => {
  const parsed = parseDeviceInstanceId(PCI_DOC_INSTANCE);
  assert.equal(parsed.enumerator, "PCI");
  assert.equal(parsed.deviceId, "VEN_1000&DEV_0001&SUBSYS_00000000&REV_02");
  assert.equal(parsed.instance, "1&08");
  assert.deepEqual(parsed.ids, {
    vendorId: "1000",
    deviceId: "0001",
    subsystemId: "0000",
    subsystemVendorId: "0000",
    revision: "02",
  });
});

test("parseDeviceInstanceId keeps PCI subsystem ID before subsystem vendor ID", () => {
  // SUBSYS_04001AB8 on the VM's SATA controller: 0400 is the subsystem ID,
  // 1AB8 the subsystem vendor (identifiers-for-pci-devices).
  const parsed = parseDeviceInstanceId(
    "PCI\\VEN_8086&DEV_265C&SUBSYS_04001AB8&REV_02\\3&3259BAD1&0&10",
  );
  assert.equal(parsed.ids.subsystemId, "0400");
  assert.equal(parsed.ids.subsystemVendorId, "1ab8");
  assert.equal(parsed.ids.vendorId, "8086");
  assert.equal(parsed.ids.deviceId, "265c");
  assert.equal(parsed.ids.revision, "02");
  assert.equal(parsed.instance, "3&3259BAD1&0&10");
});

test("parseDeviceInstanceId decodes USB and HID formats", () => {
  const usb = parseDeviceInstanceId(USB_TEMPLATE_IDS[1]);
  assert.equal(usb.enumerator, "USB");
  assert.deepEqual(usb.ids, {
    vendorId: "1d6b",
    productId: "0003",
    interfaceNumber: "01",
  });

  // VM-observed composite-device child: USB\VID_203A&PID_FFFB&MI_01\6&8A7A4EF&0&0001
  const usbChild = parseDeviceInstanceId(
    "USB\\VID_203A&PID_FFFB&MI_01\\6&8A7A4EF&0&0001",
  );
  assert.deepEqual(usbChild.ids, {
    vendorId: "203a",
    productId: "fffb",
    interfaceNumber: "01",
  });
  assert.equal(usbChild.instance, "6&8A7A4EF&0&0001");

  // HID\Vid_v(4)&Pid_d(4)&Rev_r(4)&MI_z(2)&Colb(2) shapes
  // (hidclass-hardware-ids-for-top-level-collections).
  const hid = parseDeviceInstanceId(
    "HID\\VID_046D&PID_C52B&REV_0112&MI_00&COL_01\\7&1a2b3c4d&0&0000",
  );
  assert.equal(hid.enumerator, "HID");
  assert.deepEqual(hid.ids, {
    vendorId: "046d",
    productId: "c52b",
    revision: "0112",
    interfaceNumber: "00",
    collection: "01",
  });
});

test("parseDeviceInstanceId decodes HD Audio, ACPI, UEFI and Bluetooth formats", () => {
  // VM-observed HDAUDIO device ID.
  const hdaudio = parseDeviceInstanceId(
    "HDAUDIO\\FUNC_01&VEN_1AB8&DEV_0001&SUBSYS_1AB80101&REV_1001\\8&2977f5f&0&0001",
  );
  assert.equal(hdaudio.enumerator, "HDAUDIO");
  assert.deepEqual(hdaudio.ids, {
    functionCode: "01",
    vendorId: "1ab8",
    deviceId: "0001",
    subsystemId: "1ab80101",
    revision: "1001",
  });

  const acpi = parseDeviceInstanceId("ACPI\\PRL4005\\0");
  assert.deepEqual(acpi, {
    enumerator: "ACPI",
    deviceId: "PRL4005",
    instance: "0",
    ids: {},
  });

  const uefi = parseDeviceInstanceId(`${UEFI_DOC_RESOURCE_ID}\\0`);
  assert.equal(uefi.enumerator, "UEFI");
  assert.equal(uefi.deviceId, "RES_{6bd4efb9-23cc-4b4a-ac37-016517413e9a}");
  assert.equal(uefi.instance, "0");
  assert.equal(uefi.ids.resourceGuid, "6bd4efb9-23cc-4b4a-ac37-016517413e9a");

  const bth = parseDeviceInstanceId(BTH_DOC_VID_PID_ID);
  assert.equal(bth.ids.serviceGuid, "00001124-0000-1000-8000-00805f9b34fb");
  assert.equal(bth.ids.vendorId, "12345678");
  assert.equal(bth.ids.productId, "abcd");

  const bthDevice = parseDeviceInstanceId(
    "BTHENUM\\DEV_04E52FEA9B1F\\7&ffffffff&0&BluetoothDevice_04E52FEA9B1F",
  );
  assert.equal(bthDevice.ids.deviceAddress, "04e52fea9b1f");
});

test("parseDeviceInstanceId keeps opaque enumerators opaque", () => {
  // VM-observed DISPLAY and SCSI IDs.
  for (const id of [
    "DISPLAY\\PRL5000\\3&21de92e8&0&UID0_0",
    "SCSI\\DISK&VEN_&PROD_HARDDISK_SSD\\3&4B87E29&0&000000",
    "SWD\\PRINTENUM\\PRINTQUEUES",
    "ROOT\\VOLMGR\\0000",
    "STORAGE\\VOLUME\\...",
  ]) {
    const parsed = parseDeviceInstanceId(id);
    assert.deepEqual(parsed.ids, {}, `${id} has no decoded tokens`);
    assert.ok(parsed.enumerator);
  }
});

test("parseHardwareIds picks the most specific match and USB class codes", () => {
  const usb = parseHardwareIds([
    "USB\\VID_203A&PID_FFFB&REV_0110",
    "USB\\VID_203A&PID_FFFB",
    "USB\\CLASS_03&SUBCLASS_01&PROT_01",
    "USB\\CLASS_03&SUBCLASS_01",
    "USB\\COMPOSITE",
  ]);
  assert.deepEqual(usb, {
    vendorId: "203a",
    productId: "fffb",
    revision: "0110",
    usbClass: "03",
    usbSubclass: "01",
    usbProtocol: "01",
  });

  const pci = parseHardwareIds([
    ...PCI_DOC_HARDWARE_IDS,
    "PCI\\VEN_1414&CC_0300",
  ]);
  assert.deepEqual(pci, {
    vendorId: "1414",
    productId: "00e0",
    revision: "04",
  });

  const uefi = parseHardwareIds([
    "UEFI\\RES_{6bd4efb9-23cc-4b4a-ac37-016517413e9a}&REV_2",
    "UEFI\\RES_{6bd4efb9-23cc-4b4a-ac37-016517413e9a}",
  ]);
  assert.equal(uefi.uefiRevision, "2");

  assert.deepEqual(parseHardwareIds(undefined), {});
  assert.deepEqual(parseHardwareIds([BTH_DOC_SERVICE_ID]), {});
});

test("redactInstanceId redacts the instance segment and Bluetooth MACs", () => {
  assert.equal(
    redactInstanceId("USB\\VID_203A&PID_FFFB\\KBD1.1"),
    "USB\\VID_203A&PID_FFFB\\redacted:D1.1",
  );
  assert.equal(
    redactInstanceId("ACPI\\PRL4005\\0"),
    "ACPI\\PRL4005\\redacted",
  );
  assert.equal(
    redactInstanceId(
      "BTHENUM\\DEV_04E52FEA9B1F\\7&ffffffff&0&BluetoothDevice_04E52FEA9B1F",
    ),
    // The whole instance segment is replaced; MAC-like tokens are
    // additionally redacted inside the device-ID segment.
    "BTHENUM\\DEV_redacted:9B1F\\redacted:9B1F",
  );
  assert.equal(
    redactInstanceId("BTHLE\\DEV_04E52FEA9B1F\\8&2ea2c7d6&0&3"),
    "BTHLE\\DEV_redacted:9B1F\\redacted:&0&3",
  );

  // Raw identifiers are kept when explicitly requested, and IDs without an
  // instance segment are unchanged.
  assert.equal(
    redactInstanceId("USB\\VID_203A&PID_FFFB\\KBD1.1", {
      includeSensitiveIdentifiers: true,
    }),
    "USB\\VID_203A&PID_FFFB\\KBD1.1",
  );
  assert.equal(redactInstanceId("USB\\COMPOSITE"), "USB\\COMPOSITE");
  // Redaction is idempotent, so already-redacted fixture values stay stable.
  assert.equal(
    redactInstanceId(
      "PCI\\VEN_8086&DEV_265C&SUBSYS_04001AB8&REV_02\\redacted:0&10",
    ),
    "PCI\\VEN_8086&DEV_265C&SUBSYS_04001AB8&REV_02\\redacted:0&10",
  );
});

test("captured selftest PnP IDs parse after fixture redaction", () => {
  const envelope = parseWindowsEnvelope(
    readFileSync(
      new URL(
        "../fixtures/windows/arm64/vm-parallels-elevated/windows-cim-selftest.stdout",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const items = envelope.results.pnpIds.items;
  assert.ok(items.length > 10, "the VM exposes dozens of PnP devices");

  const parsed = items.map((item) => parseDeviceInstanceId(item.PNPDeviceID));
  assert.ok(parsed.every((entry) => entry.enumerator && entry.deviceId));

  // The UEFI firmware resource device observed on the VM keeps its documented
  // hardware ID shape, including the REV_ version token.
  const uefiItem = items.find((item) =>
    String(item.PNPDeviceID ?? "").startsWith("UEFI\\"),
  );
  assert.ok(uefiItem, "VM has a UEFI firmware resource device");
  assert.equal(parseDeviceInstanceId(uefiItem.PNPDeviceID).enumerator, "UEFI");
  assert.match(
    uefiItem.HardwareID?.[0] ?? "",
    /^UEFI\\RES_\{[0-9a-f-]{36}\}&REV_\d+$/u,
  );
  assert.equal(parseHardwareIds(uefiItem.HardwareID).uefiRevision, "1");

  // Every instance segment in the committed fixture was redacted.
  assert.ok(
    parsed.every(
      (entry) => entry.instance === undefined || /redacted/u.test(entry.instance),
    ),
    "no raw instance segments may survive in fixtures",
  );
});
