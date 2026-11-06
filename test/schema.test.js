import assert from "node:assert/strict";
import test from "node:test";

import {
  collectHardware,
  createHbomDocument,
  HBOM_BOM_FORMAT,
  HBOM_SCHEMA_URL,
  HBOM_SPEC_VERSION,
} from "../index.js";

test("createHbomDocument wraps data in the versioned HBOM envelope", () => {
  const document = createHbomDocument({
    metadata: {
      timestamp: "2026-05-12T00:00:00.000Z",
      component: {
        type: "device",
        name: "MacBook Pro",
      },
      tools: [{ name: "cdx-hbom" }],
      properties: [],
    },
    components: [],
    evidence: {
      target: {
        platform: "darwin",
        architecture: "arm64",
      },
      commands: [],
    },
    properties: [],
  });

  assert.equal(document.$schema, HBOM_SCHEMA_URL);
  assert.equal(document.bomFormat, HBOM_BOM_FORMAT);
  assert.equal(document.specVersion, HBOM_SPEC_VERSION);
  assert.equal(document.version, 1);
  assert.match(document.serialNumber, /^urn:uuid:/u);
  assert.equal("evidence" in document, false);
});

test("schema constants target the official CycloneDX 1.7 schema", () => {
  assert.equal(
    HBOM_SCHEMA_URL,
    "http://cyclonedx.org/schema/bom-1.7.schema.json",
  );
  assert.equal(HBOM_BOM_FORMAT, "CycloneDX");
  assert.equal(HBOM_SPEC_VERSION, "1.7");
});

test("createHbomDocument envelopes a CycloneDX 2.0 document", () => {
  const document = createHbomDocument({
    specVersion: "2.0",
    metadata: {
      component: {
        "bom-ref": "device:host",
        type: "device",
        name: "host",
      },
    },
    components: [
      { "bom-ref": "device:cpu", type: "device", name: "cpu" },
    ],
    dependencies: [{ ref: "device:host", dependsOn: ["device:cpu"] }],
    properties: [],
  });
  assert.equal(document.specFormat, "CycloneDX");
  assert.equal(document.specVersion, "2.0");
  assert.equal(document.bomFormat, undefined);
  assert.equal(document.components, undefined);
  assert.ok(Array.isArray(document.inventories));
  assert.equal(document.inventories[0].subject.refId, "device:host");
  assert.equal(document.inventories[0].components[0].refId, "device:cpu");
  assert.equal(document.dependencies[0].ref, "device:host");
  assert.equal(document.dependencies[0].dependsOn[0], "device:cpu");
});

test("the 1.7 envelope keeps the 1.x root shape", () => {
  const document = createHbomDocument({
    metadata: {
      component: { "bom-ref": "device:host", type: "device", name: "host" },
    },
    components: [{ "bom-ref": "device:cpu", type: "device", name: "cpu" }],
    properties: [],
  });
  assert.equal(document.bomFormat, "CycloneDX");
  assert.equal(document.specVersion, "1.7");
  assert.ok(Array.isArray(document.components));
  assert.equal(document.inventories, undefined);
});

test("collectHardware returns the same components at 1.7 and 2.0", async () => {
  const options = { dryRun: true };
  const [bom17, bom20] = await Promise.all([
    collectHardware({ ...options }),
    collectHardware({ ...options, specVersion: "2.0" }),
  ]);
  const names17 = bom17.components.map((component) => component.name).sort();
  const entries20 = (bom20.inventories[0].components || []).map(
    (component) => component.name,
  ).sort();
  assert.deepEqual(entries20, names17);
  const edges17 = new Set(
    (bom17.dependencies || []).flatMap((edge) =>
      (edge.dependsOn || []).map((target) => `${edge.ref}->${target}`),
    ),
  );
  const edges20 = new Set(
    (bom20.dependencies || []).flatMap((edge) =>
      (edge.dependsOn || []).map((target) => `${edge.ref}->${target}`),
    ),
  );
  assert.deepEqual(edges20, edges17);
  const tool17 = bom17.metadata.tools.components[0];
  const tool20 = bom20.metadata.tools.components[0];
  assert.equal(tool17["bom-ref"], "pkg:npm/@cdxgen/cdx-hbom");
  assert.equal(tool20["bom-ref"], "pkg:npm/@cdxgen/cdx-hbom");
  assert.ok(tool17.version);
  assert.equal(tool20.version, tool17.version);
});
