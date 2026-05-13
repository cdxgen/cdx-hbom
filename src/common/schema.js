import { randomUUID } from "node:crypto";

export const HBOM_BOM_FORMAT = "CycloneDX";
export const HBOM_SPEC_VERSION = "1.7";
export const HBOM_SCHEMA_URL =
  "http://cyclonedx.org/schema/bom-1.7.schema.json";

/**
 * Create a CycloneDX 1.7 BOM envelope for hardware inventory.
 *
 * @param {{
 *   metadata: Record<string, unknown>,
 *   components?: unknown[],
 *   dependencies?: unknown[],
 *   serialNumber?: string,
 *   version?: number,
 *   properties?: Array<{ name: string, value: string }>
 * }} input Document sections.
 * @returns {{
 *   $schema: string,
 *   bomFormat: string,
 *   specVersion: string,
 *   serialNumber: string,
 *   version: number,
 *   metadata: Record<string, unknown>,
 *   components: unknown[],
 *   dependencies?: unknown[],
 *   properties: Array<{ name: string, value: string }>
 * }} CycloneDX 1.7 document.
 */
export function createHbomDocument(input) {
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
