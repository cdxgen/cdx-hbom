import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { mapCdx20HardwareComponent } from "./cdx20.js";

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

/** refId of the party cdx-hbom declares when it asserts identities at 2.0. */
export const HBOM_PARTY_REF = "party-cdx-hbom";

/**
 * Rename every 1.x `bom-ref` key to the 2.0 `refId`, recursively.
 *
 * @param {unknown} value Any JSON value.
 * @returns {unknown} A renamed copy.
 */
function renameRefIds(value) {
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
}

/**
 * Give the cdx-hbom tool entry its version and refId. Only the 2.0 output
 * carries them, so the 1.7 tool entry stays exactly what it was.
 *
 * @param {object} metadata 2.0 metadata (already renamed).
 * @returns {object} Metadata with the tool entry completed.
 */
function completeToolEntry(metadata) {
  const tools = metadata?.tools?.components;
  if (!Array.isArray(tools)) {
    return metadata;
  }
  return {
    ...metadata,
    tools: {
      ...metadata.tools,
      components: tools.map((tool) =>
        tool?.name === "cdx-hbom"
          ? {
              ...tool,
              version: tool.version ?? HBOM_TOOL_VERSION,
              refId: tool.refId ?? HBOM_TOOL_REF,
            }
          : tool,
      ),
    },
  };
}

/**
 * The 2.0 draft moves the subject component into inventories[0].subject and
 * the components beside it, renames bom-ref to refId and replaces bomFormat
 * with specFormat (see cdxgen/cdxgen#4589; pinned draft commit
 * ea8c3605829d1da13339a0790b6da73548e42a6b). Dependencies keep pointing at
 * the same ids, which are now refIds. The subject and every component go
 * through the hardware mapping in cdx20.js. When an identity is asserted,
 * cdx-hbom declares itself as the asserting party (`party-cdx-hbom`, an
 * automation system that points at the tool entry).
 *
 * @param {{ metadata: Record<string, unknown>, components?: unknown[],
 *   dependencies?: unknown[], serialNumber?: string, version?: number,
 *   properties?: Array<{ name: string, value: string }>,
 *   includeSensitiveIdentifiers?: boolean }} input Document sections in the
 *   1.x shape.
 * @returns {object} CycloneDX 2.0 document.
 */
function toCdx20(input) {
  const identifierPolicy = (input.properties ?? []).find(
    (property) => property?.name === "cdx:hbom:identifierPolicy",
  )?.value;
  const mappingOptions = {
    partyRefId: HBOM_PARTY_REF,
    includeSensitiveIdentifiers: input.includeSensitiveIdentifiers === true,
    identifierPolicy,
  };
  const referencedParties = new Set();
  const mapHardware = (component) => {
    if (!component || typeof component !== "object") {
      return component;
    }
    const { component: mapped, partyRefIds } = mapCdx20HardwareComponent(
      component,
      mappingOptions,
    );
    for (const refId of partyRefIds) {
      referencedParties.add(refId);
    }
    return renameRefIds(mapped);
  };
  const { component: subject, ...metadataRest } = input.metadata ?? {};
  const metadata = completeToolEntry(renameRefIds(metadataRest));
  const document = {
    $schema: HBOM_SCHEMA_URL_20,
    specFormat: HBOM_BOM_FORMAT,
    specVersion: HBOM_SPEC_VERSION_20,
    serialNumber: input.serialNumber ?? `urn:uuid:${randomUUID()}`,
    version: input.version ?? 1,
    metadata,
    inventories: [
      {
        subject: subject
          ? mapHardware(subject)
          : { type: "device", name: "host" },
        components: (input.components ?? []).map(mapHardware),
      },
    ],
    properties: input.properties ?? [],
  };
  if (input.dependencies?.length) {
    document.dependencies = renameRefIds(input.dependencies);
  }
  if (referencedParties.has(HBOM_PARTY_REF)) {
    document.definitions = {
      parties: [
        {
          refId: HBOM_PARTY_REF,
          roles: [{ role: "asserter" }],
          system: {
            label: "cdx-hbom",
            kind: "automation",
            ref: HBOM_TOOL_REF,
          },
        },
      ],
    };
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
 *   specVersion?: string,
 *   includeSensitiveIdentifiers?: boolean
 * }} input Document sections. includeSensitiveIdentifiers only affects the
 *   2.0 output: it allows unredacted identifiers to become 2.0 identifiers.
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
