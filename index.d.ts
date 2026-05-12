export interface TargetSelector {
  platform?: string;
  architecture?: string;
}

export interface CommandDescriptor {
  id: string;
  category: string;
  command: string;
  args: string[];
  parser?: string;
  purpose?: string;
  phase?: string;
  sensitiveFields?: string[];
}

export interface HbomProperty {
  name: string;
  value: string;
}

export interface HbomManufacturer {
  name: string;
}

export interface HbomComponent {
  type: string;
  name: string;
  version?: string;
  description?: string;
  manufacturer?: HbomManufacturer;
  properties?: HbomProperty[];
  [key: string]: unknown;
}

export interface HbomDocument {
  bomFormat: string;
  specVersion: string;
  serialNumber?: string;
  version?: number;
  metadata?: Record<string, unknown>;
  components?: HbomComponent[];
  properties?: HbomProperty[];
  [key: string]: unknown;
}

export interface CollectorOptions extends TargetSelector {
  includeSensitiveIdentifiers?: boolean;
  includeCommandEnrichment?: boolean;
  includePrivilegedEnrichment?: boolean;
  includePlistEnrichment?: boolean;
  timeoutMs?: number;
  allowPartial?: boolean;
}

export interface BuildOptions extends TargetSelector {
  sources: Record<string, unknown>;
  includeSensitiveIdentifiers?: boolean;
  collectedAt?: string;
}

export const SUPPORTED_TARGETS: ReadonlyArray<{
  platform: string;
  architecture: string;
}>;

export const commandsExecuted: Set<string>;

export const HBOM_BOM_FORMAT: string;
export const HBOM_SCHEMA_URL: string;
export const HBOM_SPEC_VERSION: string;

export function getCommandPlan(options?: TargetSelector): ReadonlyArray<CommandDescriptor>;
export function collectHardware(options?: CollectorOptions): Promise<HbomDocument>;
export function buildHardwareFromSources(options: BuildOptions): HbomDocument;

export function parsePlist(xml: string): unknown;
export function parsePlistDict(xml: string): Record<string, unknown>;
export function parsePlistArray(xml: string): unknown[];

export function createHbomDocument(input: Record<string, unknown>): HbomDocument;

export function safeExistsSync(filePath: string): boolean;
export function safeMkdirSync(
  filePath: string,
  options?: { recursive?: boolean; mode?: number; suppressErrors?: boolean },
): string | undefined;
export function safeReadFileSync(
  filePath: string,
  options?: { encoding?: BufferEncoding | null; suppressErrors?: boolean },
): string | Buffer | undefined;
export function safeReaddirSync(
  directoryPath: string,
  options?: { suppressErrors?: boolean },
): string[];
export function safeSpawnSync(
  command: string,
  args?: string[],
  options?: Record<string, unknown>,
): {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
  [key: string]: unknown;
};
