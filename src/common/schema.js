import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { toCdx20HardwareComponent } from "./cdx20.js";

export const HBOM_BOM_FORMAT = "CycloneDX";
export const HBOM_SPEC_VERSION = "1.7";
export const HBOM_SCHEMA_URL =
  "http://cyclonedx.org/schema/bom-1.7.schema.json";
export const HBOM_SPEC_VERSION_20 = "2.0";
export const HBOM_SCHEMA_URL_20 =
  "https://cyclonedx.org/schema/2.0/cyclonedx-2.0.schema.json";
export const HBOM_TOOL_REF = "pkg:npm/@cdxgen/cdx-hbom";
const packageJson = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
    "utf8",
  ),
);
export const HBOM_TOOL_VERSION = packageJson.version;

/**
 * The 2.0 draft moves the subject component into inventories[0].subject and
 * the components beside it, renames bom-ref to refId and replaces bomFormat
 * with specFormat (see cdxgen/cdxgen#4589; pinned draft commit
 * ea8c3605829d1da13339a0790b6da73548e42a6b). Dependencies keep pointing at
 * the same ids, which are now refIds.
 *
 * @param {{ metadata: Record<string, unknown>, components?: unknown[],
 *   dependencies?: unknown[], serialNumber?: string, version?: number,
 *   properties?: Array<{ name: string, value: string }> }} input Document
 *   sections in the 1.x shape.
 * @returns {object} CycloneDX 2.0 document.
 */
function toCdx20(input) {
  const mapHardware = (component) =>
    component && typeof component === "object"
      ? toCdx20HardwareComponent(component, HBOM_TOOL_REF)
      : component;
  const metadata = { ...input.metadata };
  const subject = metadata.component;
  delete metadata.component;
  const renameRefIds = (value) => {
    if (Array.isArray(value)) {
      return value.map(renameRefIds);
    }
    if (value && typeof value === "object") {
      const renamed = {};
      for (const [key, member] of Object.entries(value)) {
        renamed[key === "bom-ref" ? "refId" : key] = renameRefIds(member);
      }
      return renamed;
    }
    return value;
  };
  const document = {
    $schema: HBOM_SCHEMA_URL_20,
    specFormat: HBOM_BOM_FORMAT,
    specVersion: HBOM_SPEC_VERSION_20,
    serialNumber: input.serialNumber ?? `urn:uuid:${randomUUID()}`,
    version: input.version ?? 1,
    metadata,
    inventories: [
      {
        ...(subject
          ? { subject: renameRefIds(subject) }
          : { subject: { type: "device", name: "host" } }),
        components: (input.components ?? []).map(mapHardware),
      },
    ],
    properties: input.properties ?? [],
  };
  if (input.dependencies?.length) {
    document.dependencies = renameRefIds(input.dependencies);
  }
  return document;
}

/**
 * Create a CycloneDX BOM envelope for hardware inventory.
 *
 * @param {{
 *   metadata: Record<string, unknown>,
 *   components?: unknown[],
 *   dependencies?: unknown[],
 *   serialNumber?: string,
 *   version?: number,
 *   properties?: Array<{ name: string, value: string }>,
 *   specVersion?: string
 * }} input Document sections.
 * @returns {object} CycloneDX 1.7 or 2.0 document.
 */
export function createHbomDocument(input) {
  if (input.specVersion === HBOM_SPEC_VERSION_20) {
    return toCdx20(input);
  }
  const document = {
    $schema: HBOM_SCHEMA_URL,
    bomFormat: HBOM_BOM_FORMAT,
    specVersion: HBOM_SPEC_VERSION,
    serialNumber: input.serialNumber ?? `urn:uuid:${randomUUID()}`,
    version: input.version ?? 1,
    metadata: input.metadata,
    components: input.components ?? [],
    properties: input.properties ?? [],
  };

  if (input.dependencies?.length) {
    document.dependencies = input.dependencies;
  }

  return document;
}
