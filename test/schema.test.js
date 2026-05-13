import assert from "node:assert/strict";
import test from "node:test";

import {
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
