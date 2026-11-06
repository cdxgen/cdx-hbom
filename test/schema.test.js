import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectHardware,
  createHbomDocument,
  getHbomToolVersion,
  HBOM_BOM_FORMAT,
  HBOM_SCHEMA_URL,
  HBOM_SPEC_VERSION,
  HBOM_TOOL_REF,
} from "../index.js";
import { readHbomToolVersion } from "../src/common/schema.js";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

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
  // The 1.7 tool entry is what main emits; only 2.0 adds version and refId
  // (cdxgen/cdx-hbom#25 review item 12).
  assert.deepEqual(bom17.metadata.tools.components, [
    { type: "application", name: "cdx-hbom" },
  ]);
  assert.deepEqual(bom20.metadata.tools.components, [
    {
      type: "application",
      name: "cdx-hbom",
      version: packageVersion,
      refId: HBOM_TOOL_REF,
    },
  ]);
});

test("readHbomToolVersion returns undefined for a missing or unusable package.json", () => {
  const directory = mkdtempSync(join(tmpdir(), "cdx-hbom-version-"));
  try {
    const write = (name, text) => {
      const path = join(directory, name);
      writeFileSync(path, text);
      return path;
    };
    assert.equal(readHbomToolVersion(join(directory, "missing.json")), undefined);
    assert.equal(readHbomToolVersion(write("bad.json", "{ not json")), undefined);
    assert.equal(readHbomToolVersion(write("none.json", "{}")), undefined);
    assert.equal(
      readHbomToolVersion(write("number.json", '{"version":1}')),
      undefined,
    );
    assert.equal(
      readHbomToolVersion(write("ok.json", '{"version":"1.2.3"}')),
      "1.2.3",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema.js imports without package.json and leaves the tool version out", async () => {
  // Copy the two modules into a directory with no package.json two levels up,
  // the layout a bundle that does not ship package.json would have.
  const root = mkdtempSync(join(tmpdir(), "cdx-hbom-bundle-"));
  try {
    const moduleDir = join(root, "a", "b");
    mkdirSync(moduleDir, { recursive: true });
    for (const name of ["schema.js", "cdx20.js"]) {
      copyFileSync(
        fileURLToPath(new URL(`../src/common/${name}`, import.meta.url)),
        join(moduleDir, name),
      );
    }
    assert.equal(existsSync(join(root, "package.json")), false);
    const bundled = await import(
      pathToFileURL(join(moduleDir, "schema.js")).href
    );
    assert.equal(bundled.getHbomToolVersion(), undefined);
    const document = bundled.createHbomDocument({
      specVersion: "2.0",
      metadata: {
        tools: { components: [{ type: "application", name: "cdx-hbom" }] },
        component: { type: "device", name: "host" },
      },
    });
    assert.deepEqual(document.metadata.tools.components, [
      { type: "application", name: "cdx-hbom", refId: HBOM_TOOL_REF },
    ]);
    assert.equal(getHbomToolVersion(), packageVersion);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
