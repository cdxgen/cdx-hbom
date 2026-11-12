import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectHardware,
  createHbomDocument,
  HBOM_PARTY_REF,
  HBOM_TOOL_REF,
  identifierIsAssertable,
  isRedactedIdentifier,
  mapCdx20HardwareComponent,
  RAW_IDENTIFIER_POLICY,
  REDACTED_IDENTIFIER_POLICY,
  toCdx20HardwareComponent,
} from "../index.js";
import { redactIdentifier } from "../src/common/shape.js";
import {
  buildDarwinArm64Hbom,
  parseSysctlValues,
} from "../src/darwin/arm64/index.js";
import {
  buildLinuxHbom,
  parseDmidecodeText,
  parseHostnamectlJson,
  parseIpLinkJson,
  parseLscpuJson,
  parseLshwJson,
  parseLspciVmmnn,
  parseLsusbText,
} from "../src/linux/common/index.js";

// cdx-hbom has no dependencies. The schema check borrows ajv, ajv-formats
// and the 2.0 schema files from a directory laid out like a cdxgen checkout
// (node_modules/ajv, node_modules/ajv-formats, data/*.schema.json). The CI
// workflow builds one and sets CDX_HBOM_CDXGEN_ROOT; locally it defaults to a
// cdxgen checkout next to this repository (../cdxgen). Without it the schema
// check is skipped with a note, except under CI, where it fails. The
// structural checks below always run.
const CDXGEN_ROOT =
  process.env.CDX_HBOM_CDXGEN_ROOT ||
  fileURLToPath(new URL("../../cdxgen", import.meta.url));
const REQUIRE_SCHEMA_VALIDATOR = Boolean(process.env.CI);

const TARGETS = [
  ["darwin", "arm64"],
  ["linux", "amd64"],
  ["linux", "arm64"],
  ["win32", "x64"],
  ["win32", "arm64"],
];

/**
 * Override `process.platform` and `process.arch` for a callback.
 *
 * @param {string} platform Fake platform value.
 * @param {string} architecture Fake architecture value.
 * @param {() => unknown} callback Callback.
 * @returns {Promise<unknown>} Callback result, awaited before restoring.
 */
async function withTargetPlatform(platform, architecture, callback) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: platform,
  });
  Object.defineProperty(process, "arch", {
    ...archDescriptor,
    value: architecture,
  });
  try {
    return await callback();
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    Object.defineProperty(process, "arch", archDescriptor);
  }
}

function readFixture(relativePath) {
  return readFileSync(
    new URL(`./fixtures/${relativePath}`, import.meta.url),
    "utf8",
  );
}

const REAL_MAC = "9c:6b:00:12:34:56";
const REAL_SERIAL = "SN0123456789";

/**
 * Build a Linux HBOM from the captured mini-dev-2 amd64 fixtures. The
 * captures were scrubbed by hand (`redacted-serial`, `redacted-asset`,
 * `redacted:mac`); one interface gets a real-looking MAC and DMI a real
 * serial so the identifier path has something to assert.
 *
 * @param {boolean} includeSensitiveIdentifiers Collector option.
 * @returns {object} CycloneDX 1.7 document.
 */
function buildLinuxFixtureHbom(includeSensitiveIdentifiers) {
  const ipLink = parseIpLinkJson(readFixture("linux/amd64/ip-link.json"));
  const eno1 = ipLink.find((entry) => entry.ifname === "eno1");
  eno1.address = REAL_MAC;
  return buildLinuxHbom({
    architecture: "amd64",
    collectedAt: "2026-05-12T00:00:00.000Z",
    includeSensitiveIdentifiers,
    sources: {
      osRelease: { NAME: "Ubuntu", VERSION_ID: "24.04" },
      cpuInfo: [
        {
          processor: "0",
          vendor_id: "AuthenticAMD",
          "model name": "AMD Ryzen 7 8845HS",
        },
      ],
      memInfo: { MemTotal: { value: 32000000, unit: "kB" } },
      dmiInfo: {
        sys_vendor: "GMKtec",
        product_name: "NucBox K8 Plus",
        product_serial: REAL_SERIAL,
      },
      hostnamectl: parseHostnamectlJson(
        readFixture("linux/amd64/hostnamectl.json"),
      ),
      lscpu: parseLscpuJson(readFixture("linux/amd64/lscpu.json")),
      pciDevices: parseLspciVmmnn(readFixture("linux/amd64/lspci.vmmnn")),
      usbDevices: parseLsusbText(readFixture("linux/amd64/lsusb.txt")),
      ipLink,
      lshw: parseLshwJson(readFixture("linux/amd64/lshw.json")),
      dmidecode: parseDmidecodeText(readFixture("linux/amd64/dmidecode.txt")),
    },
  });
}

function to20(bom, includeSensitiveIdentifiers) {
  return createHbomDocument({
    ...bom,
    specVersion: "2.0",
    includeSensitiveIdentifiers,
  });
}

function inventoryComponents(document) {
  return [
    document.inventories[0].subject,
    ...(document.inventories[0].components || []),
  ];
}

function propertyValue(component, name) {
  return (component.properties || []).find((entry) => entry.name === name)
    ?.value;
}

/**
 * Collect every object key path named `key` in a JSON value.
 *
 * @param {unknown} value JSON value.
 * @param {string} key Key to find.
 * @param {string} [path] Current path.
 * @returns {string[]} Paths where the key occurs.
 */
function findKey(value, key, path = "") {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findKey(entry, key, `${path}/${index}`),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([name, member]) => [
      ...(name === key ? [`${path}/${name}`] : []),
      ...findKey(member, key, `${path}/${name}`),
    ]);
  }
  return [];
}

/**
 * Structural checks a 2.0 document must pass whether or not a schema
 * validator is available.
 *
 * @param {object} document CycloneDX 2.0 document.
 */
function assertStructurallyValid20(document) {
  assert.equal(document.specFormat, "CycloneDX");
  assert.equal(document.specVersion, "2.0");
  assert.equal(document.bomFormat, undefined);
  assert.deepEqual(findKey(document, "bom-ref"), [], "no bom-ref anywhere");
  assert.deepEqual(
    findKey(document, "manufacturer").filter(
      (path) => !path.startsWith("/metadata/manufacturer"),
    ),
    [],
    "manufacturer is a 1.x component member",
  );
  const refIds = findKey(document, "refId").map((path) =>
    path
      .split("/")
      .slice(1, -1)
      .reduce((node, segment) => node[segment], document),
  ).map((node) => node.refId);
  assert.equal(new Set(refIds).size, refIds.length, "refIds are unique");
  const known = new Set(refIds);
  for (const edge of document.dependencies || []) {
    assert.ok(known.has(edge.ref), `dependency ref ${edge.ref} resolves`);
    for (const target of edge.dependsOn || []) {
      assert.ok(known.has(target), `dependsOn ${target} resolves`);
    }
  }
  const parties = new Set(
    (document.definitions?.parties || []).map((party) => party.refId),
  );
  const tools = new Set(
    (document.metadata?.tools?.components || []).map((tool) => tool.refId),
  );
  for (const component of inventoryComponents(document)) {
    for (const identifier of component.identifiers || []) {
      assert.ok(
        parties.has(identifier.party),
        `identifier party ${identifier.party} is declared`,
      );
      assert.ok(
        !tools.has(identifier.party),
        "an identifier never names a tool as its party",
      );
      assert.ok(identifier.identities.length > 0);
    }
    for (const code of component.classification?.codes || []) {
      assert.equal(typeof code.standard, "string");
      assert.equal(typeof code.value, "string");
    }
    assert.equal(component.deviceType, undefined);
    assert.equal(component.quantity, undefined);
    assert.equal(component.boardLocation, undefined);
  }
  for (const party of document.definitions?.parties || []) {
    if (party.system?.ref) {
      assert.ok(known.has(party.system.ref), "party system ref resolves");
      assert.ok(
        tools.has(party.system.ref),
        `party system ref ${party.system.ref} is a tool entry refId`,
      );
    }
  }
}

let schemaValidatorPromise;

/**
 * Compile the bundled CycloneDX 2.0 schema with ajv borrowed from a cdxgen
 * checkout, the same way lib/validator/bomValidator.js does.
 *
 * @returns {Promise<Function | undefined>} Validator or undefined.
 */
function loadSchemaValidator() {
  schemaValidatorPromise ??= (async () => {
    const ajvPath = join(CDXGEN_ROOT, "node_modules", "ajv", "dist", "2020.js");
    const formatsPath = join(
      CDXGEN_ROOT,
      "node_modules",
      "ajv-formats",
      "dist",
      "index.js",
    );
    const schemaPath = join(
      CDXGEN_ROOT,
      "data",
      "cyclonedx-2.0-bundled.schema.json",
    );
    if (![ajvPath, formatsPath, schemaPath].every((path) => existsSync(path))) {
      return undefined;
    }
    try {
      const Ajv2020 = (await import(pathToFileURL(ajvPath).href)).default;
      const addFormats = (await import(pathToFileURL(formatsPath).href))
        .default;
      const readSchema = (name) =>
        JSON.parse(readFileSync(join(CDXGEN_ROOT, "data", name), "utf8"));
      const ajv = new Ajv2020({ strict: false, logger: false, allErrors: true });
      addFormats(ajv);
      ajv.addFormat("idn-email", true);
      for (const [name, id] of [
        [
          "cyclonedx-2.0-cryptography-defs.schema.json",
          "https://cyclonedx.org/schema/cryptography-defs.schema.json",
        ],
        [
          "behavior-taxonomy.schema.json",
          "https://cyclonedx.org/schema/behavior-taxonomy.schema.json",
        ],
        [
          "jsf-0.82.schema.json",
          "https://cyclonedx.org/schema/jsf-0.82.schema.json",
        ],
        ["spdx.schema.json", "https://cyclonedx.org/schema/spdx.schema.json"],
      ]) {
        const schema = { ...readSchema(name) };
        delete schema.$schema;
        schema.$id = id;
        ajv.addSchema(schema);
      }
      return ajv.compile(readSchema("cyclonedx-2.0-bundled.schema.json"));
    } catch (error) {
      console.log(`# 2.0 schema validator unavailable: ${error.message}`);
      return undefined;
    }
  })();
  return schemaValidatorPromise;
}

/**
 * Load the schema validator, failing under CI when it is missing.
 *
 * @returns {Promise<Function | undefined>} Validator, or undefined outside CI
 *   when ajv or the schema is missing.
 */
async function requireSchemaValidator() {
  const validate = await loadSchemaValidator();
  if (!validate && REQUIRE_SCHEMA_VALIDATOR) {
    assert.fail(
      `CI is set but ajv, ajv-formats or the 2.0 schema was not found under ${CDXGEN_ROOT}; set CDX_HBOM_CDXGEN_ROOT`,
    );
  }
  return validate;
}

async function assertSchemaValid20(t, document, label) {
  const validate = await requireSchemaValidator();
  if (!validate) {
    const note = `ajv or the 2.0 schema not found under ${CDXGEN_ROOT}; schema validation skipped`;
    console.log(`# ${note}`);
    t.diagnostic(note);
    return;
  }
  const valid = validate(document);
  assert.ok(
    valid,
    `${label}: ${JSON.stringify(validate.errors?.slice(0, 5), null, 2)}`,
  );
}

test("the borrowed 2.0 schema validator rejects the shapes the review found", async (t) => {
  const validate = await requireSchemaValidator();
  if (!validate) {
    t.skip(`ajv or the 2.0 schema not found under ${CDXGEN_ROOT}`);
    return;
  }
  const base = to20(buildLinuxFixtureHbom(false), false);
  assert.equal(validate(base), true);
  const stringCodes = structuredClone(base);
  stringCodes.inventories[0].components.find(
    (component) => component.classification?.codes,
  ).classification.codes = ["0200"];
  assert.equal(validate(stringCodes), false, "string classification codes");
  const toolBomRef = structuredClone(base);
  toolBomRef.metadata.tools.components[0]["bom-ref"] = HBOM_TOOL_REF;
  assert.equal(validate(toolBomRef), false, "bom-ref on the tool entry");
  const subjectManufacturer = structuredClone(base);
  subjectManufacturer.inventories[0].subject.manufacturer = { name: "Acme" };
  assert.equal(validate(subjectManufacturer), false, "1.x manufacturer");
});

test("isRedactedIdentifier treats every redaction marker as redacted", () => {
  for (const value of [
    undefined,
    null,
    "",
    "  ",
    "redacted",
    "REDACTED",
    "redacted:3456",
    "withheld",
    "withheld:policy",
    "redacted-serial",
    "redacted:mac",
    redactIdentifier("ab12"),
    redactIdentifier("SN-123456"),
  ]) {
    assert.equal(isRedactedIdentifier(value), true, String(value));
  }
  assert.equal(redactIdentifier("ab12"), "redacted");
  for (const value of ["SN-123456", "00:11:22:33:44:55", "C02XYZ"]) {
    assert.equal(isRedactedIdentifier(value), false, value);
  }
});

test("isRedactedIdentifier ignores case and surrounding whitespace", () => {
  const markers = {
    empty: "",
    "whitespace only": " \t\n",
    redacted: "redacted",
    "redacted, mixed case": "ReDaCtEd",
    "redacted with padding": "  redacted  ",
    "redacted:<anything>": "redacted:anything at all",
    "redacted:<anything>, upper case": "REDACTED:XYZ",
    "redacted:<anything>, padded": "\tredacted:3456\n",
    "redacted-*": "redacted-asset",
    "redacted-*, mixed case": "Redacted-ABC",
    "redacted-*, padded": " redacted-mac ",
    withheld: "withheld",
    "withheld, padded": " withheld ",
    "withheld, upper case": "WITHHELD",
    "withheld, tab padded": "\tWithheld\n",
  };
  for (const [label, value] of Object.entries(markers)) {
    assert.equal(isRedactedIdentifier(value), true, label);
  }
  for (const value of [" SN-123456 ", "Mac16,7", "NotRedacted", "X-withheld"]) {
    assert.equal(isRedactedIdentifier(value), false, value);
  }
});

test("identifierIsAssertable asserts model numbers without the sensitive gate", () => {
  const name = "cdx:hbom:modelNumber";
  const component = (value, policy) => ({
    properties: [
      ...(policy ? [{ name: "cdx:hbom:identifierPolicy", value: policy }] : []),
      { name, value },
    ],
  });
  assert.equal(identifierIsAssertable(component("MX2E3LL/A"), name), true);
  assert.equal(
    identifierIsAssertable(
      component("MX2E3LL/A", REDACTED_IDENTIFIER_POLICY),
      name,
      { identifierPolicy: REDACTED_IDENTIFIER_POLICY },
    ),
    true,
    "the redacted-by-default policy does not hold back a model number",
  );
  for (const value of ["", "redacted", "Redacted-ABC", " withheld ", "redacted:3456"]) {
    assert.equal(
      identifierIsAssertable(component(value), name, {
        includeSensitiveIdentifiers: true,
      }),
      false,
      `marker ${JSON.stringify(value)}`,
    );
  }
  assert.equal(identifierIsAssertable({ properties: [] }, name), false);
  // The per-unit identifiers keep the gate.
  for (const property of [
    "cdx:hbom:serialNumber",
    "cdx:hbom:assetTag",
    "cdx:hbom:macAddress",
    "cdx:hbom:imei",
  ]) {
    const unit = { properties: [{ name: property, value: "AB-123456" }] };
    assert.equal(identifierIsAssertable(unit, property), false, property);
    assert.equal(
      identifierIsAssertable(unit, property, { includeSensitiveIdentifiers: true }),
      true,
      property,
    );
  }
});

test("a redacted collection still asserts the model number, and only that", async (t) => {
  const host = {
    "bom-ref": "device:host",
    type: "device",
    name: "host",
    properties: [
      { name: "cdx:hbom:serialNumber", value: "redacted:6789" },
      { name: "cdx:hbom:macAddress", value: "00:11:22:33:44:55" },
      { name: "cdx:hbom:modelNumber", value: "MX2E3LL/A" },
      { name: "cdx:hbom:identifierPolicy", value: REDACTED_IDENTIFIER_POLICY },
    ],
  };
  const document = createHbomDocument({
    specVersion: "2.0",
    metadata: {
      tools: { components: [{ type: "application", name: "cdx-hbom" }] },
      component: host,
    },
    properties: [
      { name: "cdx:hbom:identifierPolicy", value: REDACTED_IDENTIFIER_POLICY },
    ],
  });
  assert.deepEqual(document.inventories[0].subject.identifiers, [
    {
      party: HBOM_PARTY_REF,
      identities: [{ scheme: "model-number", value: "MX2E3LL/A" }],
    },
  ]);
  assertStructurallyValid20(document);
  await assertSchemaValid20(t, document, "model number only");
  const markerOnly = structuredClone(host);
  markerOnly.properties[2].value = "Withheld";
  const closed = createHbomDocument({
    specVersion: "2.0",
    metadata: { component: markerOnly },
  });
  assert.equal(closed.inventories[0].subject.identifiers, undefined);
  assert.equal(closed.definitions, undefined);
});

test("the asserting party points at the tool entry's refId, or at nothing", async (t) => {
  const host = {
    "bom-ref": "device:host",
    type: "device",
    name: "host",
    properties: [{ name: "cdx:hbom:serialNumber", value: "SN-123456" }],
  };
  const build = (tools) =>
    createHbomDocument({
      specVersion: "2.0",
      includeSensitiveIdentifiers: true,
      metadata: { ...(tools ? { tools } : {}), component: host },
    });
  const partyOf = (document) => {
    assert.equal(document.definitions.parties.length, 1);
    return document.definitions.parties[0];
  };

  const standard = build({
    components: [{ type: "application", name: "cdx-hbom" }],
  });
  assert.equal(partyOf(standard).system.ref, HBOM_TOOL_REF);
  assertStructurallyValid20(standard);
  await assertSchemaValid20(t, standard, "standard tool entry");

  const customRef = build({
    components: [
      { type: "application", name: "cdx-hbom", refId: "tool-cdx-hbom" },
    ],
  });
  assert.equal(customRef.metadata.tools.components[0].refId, "tool-cdx-hbom");
  assert.equal(partyOf(customRef).system.ref, "tool-cdx-hbom");
  assertStructurallyValid20(customRef);
  await assertSchemaValid20(t, customRef, "custom tool refId");

  const customBomRef = build({
    components: [
      { type: "application", name: "cdx-hbom", "bom-ref": "tool-from-1x" },
    ],
  });
  assert.equal(partyOf(customBomRef).system.ref, "tool-from-1x");
  assertStructurallyValid20(customBomRef);

  for (const tools of [
    undefined,
    { components: [] },
    { components: [{ type: "application", name: "other-tool", refId: "other" }] },
  ]) {
    const document = build(tools);
    const party = partyOf(document);
    assert.equal(party.refId, HBOM_PARTY_REF);
    assert.deepEqual(party.system, { label: "cdx-hbom", kind: "automation" });
    assertStructurallyValid20(document);
    await assertSchemaValid20(t, document, `tools=${JSON.stringify(tools)}`);
  }
});


test("identifierIsAssertable requires the option, a raw policy and a raw value", () => {
  const component = (policy, value = "SN-123456") => ({
    properties: [
      ...(policy ? [{ name: "cdx:hbom:identifierPolicy", value: policy }] : []),
      { name: "cdx:hbom:serialNumber", value },
    ],
  });
  const name = "cdx:hbom:serialNumber";
  const on = { includeSensitiveIdentifiers: true };
  assert.equal(identifierIsAssertable(component(), name), false);
  assert.equal(identifierIsAssertable(component(RAW_IDENTIFIER_POLICY), name), false);
  assert.equal(identifierIsAssertable(component(), name, on), true);
  assert.equal(
    identifierIsAssertable(component(RAW_IDENTIFIER_POLICY), name, on),
    true,
  );
  assert.equal(
    identifierIsAssertable(component(REDACTED_IDENTIFIER_POLICY), name, on),
    false,
  );
  // "include" is not a value any collector writes.
  assert.equal(identifierIsAssertable(component("include"), name, on), false);
  assert.equal(
    identifierIsAssertable(component(), name, {
      ...on,
      identifierPolicy: REDACTED_IDENTIFIER_POLICY,
    }),
    false,
  );
  for (const value of ["redacted", "redacted:3456", "withheld"]) {
    assert.equal(
      identifierIsAssertable(component(RAW_IDENTIFIER_POLICY, value), name, on),
      false,
      value,
    );
  }
});

test("mapCdx20HardwareComponent appends identifiers and reports the party", () => {
  const nic = {
    "bom-ref": "device:nic",
    type: "device",
    name: "nic",
    manufacturer: { name: "Acme" },
    identifiers: [
      {
        party: "party-cdxgen",
        identities: [{ scheme: "purl", value: "pkg:generic/acme/nic@1" }],
      },
    ],
    properties: [
      { name: "cdx:hbom:serialNumber", value: "SN-123456" },
      { name: "cdx:hbom:macAddress", value: "00:11:22:33:44:55" },
      { name: "cdx:hbom:assetTag", value: "redacted" },
      { name: "cdx:hbom:hardwareClass", value: "network-adapter" },
      { name: "cdx:hbom:pciClassCode", value: "0200" },
      { name: "cdx:hbom:deviceType", value: "bga" },
      { name: "cdx:hbom:quantity", value: "4" },
      { name: "cdx:hbom:deviceLocator", value: "DIMM3" },
    ],
  };
  const snapshot = structuredClone(nic);
  const { component, partyRefIds } = mapCdx20HardwareComponent(nic, {
    partyRefId: "party-hbom",
    includeSensitiveIdentifiers: true,
  });
  assert.deepEqual(nic, snapshot, "the input is not mutated");
  assert.deepEqual(partyRefIds, ["party-hbom"]);
  assert.equal(component.refId, "device:nic");
  assert.equal(component["bom-ref"], undefined);
  assert.deepEqual(component.properties, nic.properties);
  assert.deepEqual(component.identifiers, [
    nic.identifiers[0],
    {
      party: "party-hbom",
      identities: [
        { scheme: "serial-number", value: "SN-123456" },
        { scheme: "mac-address", value: "00:11:22:33:44:55" },
      ],
    },
  ]);
  assert.deepEqual(component.classification, {
    category: "network-adapter",
    codes: [{ standard: "PCI-SIG class code", value: "0200" }],
  });
  assert.deepEqual(component.parties, [
    { roles: [{ role: "manufacturer" }], organization: { name: "Acme" } },
  ]);
  assert.equal(component.manufacturer, undefined);
  assert.equal(component.deviceType, undefined);
  assert.equal(component.quantity, undefined);
  assert.equal(component.boardLocation, undefined);

  const usb = toCdx20HardwareComponent({
    type: "device",
    name: "hub",
    properties: [{ name: "cdx:hbom:usbClass", value: "09" }],
  });
  assert.deepEqual(usb.classification, {
    codes: [{ standard: "USB-IF class code", value: "09" }],
  });
});

test("mapCdx20HardwareComponent emits no identifiers by default or without a party", () => {
  const nic = {
    type: "device",
    name: "nic",
    identifiers: [
      {
        party: "party-cdxgen",
        identities: [{ scheme: "purl", value: "pkg:generic/acme/nic@1" }],
      },
    ],
    properties: [{ name: "cdx:hbom:serialNumber", value: "SN-123456" }],
  };
  const byDefault = mapCdx20HardwareComponent(nic, { partyRefId: "party-hbom" });
  assert.deepEqual(byDefault.partyRefIds, []);
  assert.deepEqual(byDefault.component.identifiers, nic.identifiers);
  const noParty = mapCdx20HardwareComponent(nic, {
    includeSensitiveIdentifiers: true,
  });
  assert.deepEqual(noParty.partyRefIds, []);
  assert.deepEqual(noParty.component.identifiers, nic.identifiers);
  // A bare string is read as the party refId; the option is still required.
  assert.deepEqual(toCdx20HardwareComponent(nic, "party-hbom").identifiers, nic.identifiers);
  // classification is only allowed on device and material components.
  const firmware = toCdx20HardwareComponent({
    type: "firmware",
    name: "bios",
    properties: [{ name: "cdx:hbom:hardwareClass", value: "firmware" }],
  });
  assert.equal(firmware.classification, undefined);
});

test("Linux fixtures: redacted collection yields no 2.0 identifiers", async (t) => {
  const bom17 = buildLinuxFixtureHbom(false);
  assert.equal(
    propertyValue(bom17.metadata.component, "cdx:hbom:identifierPolicy"),
    REDACTED_IDENTIFIER_POLICY,
  );
  // Asking the 2.0 mapping for identifiers cannot undo the collector's
  // redaction.
  for (const include of [false, true]) {
    const document = to20(bom17, include);
    for (const component of inventoryComponents(document)) {
      assert.equal(component.identifiers, undefined, component.name);
    }
    assert.equal(document.definitions, undefined);
    assertStructurallyValid20(document);
    await assertSchemaValid20(t, document, `linux redacted include=${include}`);
  }
});

test("Linux fixtures: raw collection asserts only real identifiers", async (t) => {
  const bom17 = buildLinuxFixtureHbom(true);
  assert.equal(
    propertyValue(bom17.metadata.component, "cdx:hbom:identifierPolicy"),
    RAW_IDENTIFIER_POLICY,
  );
  // Without the option the mapping stays closed.
  const closed = to20(bom17, false);
  assert.ok(inventoryComponents(closed).every((c) => !c.identifiers));
  assert.equal(closed.definitions, undefined);

  const document = to20(bom17, true);
  const identities = inventoryComponents(document).flatMap((component) =>
    (component.identifiers || []).flatMap((identifier) =>
      identifier.identities.map((identity) => ({
        party: identifier.party,
        ...identity,
      })),
    ),
  );
  assert.ok(
    identities.some(
      (entry) => entry.scheme === "serial-number" && entry.value === REAL_SERIAL,
    ),
  );
  assert.ok(
    identities.some(
      (entry) => entry.scheme === "mac-address" && entry.value === REAL_MAC,
    ),
  );
  for (const entry of identities) {
    assert.equal(entry.party, HBOM_PARTY_REF);
    assert.equal(isRedactedIdentifier(entry.value), false, entry.value);
  }
  assert.deepEqual(document.definitions.parties, [
    {
      refId: HBOM_PARTY_REF,
      roles: [{ role: "asserter" }],
      system: { label: "cdx-hbom", kind: "automation", ref: HBOM_TOOL_REF },
    },
  ]);
  const pciCodes = inventoryComponents(document).flatMap(
    (component) => component.classification?.codes || [],
  );
  assert.ok(pciCodes.some((code) => code.standard === "PCI-SIG class code"));
  assertStructurallyValid20(document);
  await assertSchemaValid20(t, document, "linux raw");
});

test("Darwin collector: the subject's serial becomes an identifier only on request", async (t) => {
  const build = (includeSensitiveIdentifiers) =>
    buildDarwinArm64Hbom({
      includeSensitiveIdentifiers,
      sources: {
        profiler: {
          SPHardwareDataType: [
            {
              machine_name: "MacBook Pro",
              machine_model: "Mac16,7",
              chip_type: "Apple M4 Pro",
              serial_number: "KX2L66YHJR",
            },
          ],
        },
        sysctl: { "machdep.cpu.brand_string": "Apple M4 Pro" },
      },
    });
  const raw = to20(build(true), true);
  assert.deepEqual(raw.inventories[0].subject.identifiers, [
    {
      party: HBOM_PARTY_REF,
      identities: [
        { scheme: "serial-number", value: "KX2L66YHJR" },
      ],
    },
  ]);
  assert.deepEqual(raw.inventories[0].subject.parties, [
    { roles: [{ role: "manufacturer" }], organization: { name: "Apple" } },
  ]);
  assertStructurallyValid20(raw);
  await assertSchemaValid20(t, raw, "darwin raw");
  const redacted = to20(build(false), true);
  assert.equal(redacted.inventories[0].subject.identifiers, undefined);
  assert.equal(redacted.definitions, undefined);
});

test("Darwin processor topology facts keep the 1.7 and 2.0 documents valid", async (t) => {
  const bom17 = buildDarwinArm64Hbom({
    collectedAt: "2026-05-12T00:00:00.000Z",
    sources: {
      profiler: {
        SPHardwareDataType: [
          {
            machine_name: "MacBook Pro",
            machine_model: "Mac16,7",
            chip_type: "Apple M4 Pro",
          },
        ],
      },
      sysctl: parseSysctlValues(
        readFixture("darwin/arm64/sysctl-baseline.txt"),
      ),
    },
  });
  const processor = bom17.components.find(
    (component) => propertyValue(component, "cdx:hbom:hardwareClass") === "processor",
  );
  assert.equal(propertyValue(processor, "cdx:hbom:performanceCoreCount"), "10");
  assert.equal(propertyValue(processor, "cdx:hbom:targetType"), "J616s");
  const document = to20(bom17, false);
  assertStructurallyValid20(document);
  await assertSchemaValid20(t, document, "darwin processor topology");
});

test("2.0 dry-run output is valid for every target", async (t) => {
  for (const [platform, architecture] of TARGETS) {
    for (const includeSensitiveIdentifiers of [false, true]) {
      const document = await withTargetPlatform(platform, architecture, () =>
        collectHardware({
          dryRun: true,
          specVersion: "2.0",
          includeSensitiveIdentifiers,
        }),
      );
      const label = `${platform}/${architecture} sensitive=${includeSensitiveIdentifiers}`;
      assertStructurallyValid20(document);
      await assertSchemaValid20(t, document, label);
    }
  }
});

/**
 * Every refId a 2.0 document references (dependency refs, identifier
 * parties and party system refs) paired with where it was referenced.
 *
 * @param {object} document CycloneDX 2.0 document.
 * @returns {Array<[string, string]>} [reference, location] pairs.
 */
function referencedRefIds(document) {
  const references = [];
  for (const edge of document.dependencies || []) {
    references.push([edge.ref, "dependencies[].ref"]);
    for (const target of edge.dependsOn || []) {
      references.push([target, `dependsOn of ${edge.ref}`]);
    }
  }
  for (const component of inventoryComponents(document)) {
    for (const identifier of component.identifiers || []) {
      references.push([identifier.party, `identifier party on ${component.name}`]);
    }
  }
  for (const party of document.definitions?.parties || []) {
    if (party.system?.ref !== undefined) {
      references.push([party.system.ref, `system.ref of ${party.refId}`]);
    }
  }
  return references;
}

test("every referenced refId resolves in every target's 2.0 dry run", async () => {
  for (const [platform, architecture] of TARGETS) {
    for (const includeSensitiveIdentifiers of [false, true]) {
      const document = await withTargetPlatform(platform, architecture, () =>
        collectHardware({
          dryRun: true,
          specVersion: "2.0",
          includeSensitiveIdentifiers,
        }),
      );
      const declared = new Set(
        findKey(document, "refId").map((path) =>
          path
            .split("/")
            .slice(1)
            .reduce((node, segment) => node[segment], document),
        ),
      );
      const label = `${platform}/${architecture} sensitive=${includeSensitiveIdentifiers}`;
      for (const [reference, location] of referencedRefIds(document)) {
        assert.ok(declared.has(reference), `${label}: ${location} ${reference}`);
      }
      const toolRefIds = (document.metadata.tools?.components || []).map(
        (tool) => tool.refId,
      );
      for (const party of document.definitions?.parties || []) {
        if (party.system?.ref !== undefined) {
          assert.ok(toolRefIds.includes(party.system.ref), label);
        }
      }
    }
  }
});

test("1.7 dry-run tool entry is exactly main's for every target", async () => {
  for (const [platform, architecture] of TARGETS) {
    const bom = await withTargetPlatform(platform, architecture, () =>
      collectHardware({ dryRun: true }),
    );
    assert.deepEqual(
      bom.metadata.tools,
      { components: [{ type: "application", name: "cdx-hbom" }] },
      `${platform}/${architecture}`,
    );
    assert.equal(bom.specVersion, "1.7");
    assert.equal(bom.inventories, undefined);
  }
});

test("2.0 output keeps every cdx:hbom property of the 1.7 output", async () => {
  const pairs = [];
  for (const include of [false, true]) {
    const bom17 = buildLinuxFixtureHbom(include);
    pairs.push([`linux include=${include}`, bom17, to20(bom17, include)]);
  }
  for (const [platform, architecture] of TARGETS) {
    const [bom17, bom20] = await withTargetPlatform(platform, architecture, () =>
      Promise.all([
        collectHardware({ dryRun: true }),
        collectHardware({ dryRun: true, specVersion: "2.0" }),
      ]),
    );
    pairs.push([`${platform}/${architecture} dry-run`, bom17, bom20]);
  }
  for (const [label, bom17, bom20] of pairs) {
    const subject = bom20.inventories[0].subject;
    assert.deepEqual(
      subject.properties,
      bom17.metadata.component.properties,
      `${label}: subject`,
    );
    const components = bom20.inventories[0].components;
    assert.equal(components.length, bom17.components.length, label);
    bom17.components.forEach((component, index) => {
      assert.deepEqual(
        components[index].properties,
        component.properties,
        `${label}: ${component.name}`,
      );
      assert.equal(components[index].refId, component["bom-ref"]);
    });
    assert.deepEqual(bom20.properties, bom17.properties, `${label}: document`);
  }
});
