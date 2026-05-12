import { safeSpawnSync } from "./safe.js";

/**
 * @typedef {object} CommandSpec
 * @property {string} id Stable command identifier.
 * @property {string} category Inventory category.
 * @property {string} command Executable path or name.
 * @property {string[]} args Command arguments.
 * @property {string} parser Parser identifier.
 * @property {string} purpose Human-readable rationale.
 * @property {string} phase Rollout phase such as `collector-v1` or `planned-enrichment`.
 * @property {string[]} [sensitiveFields] Field names that should be redacted by default.
 */

/**
 * Execute a command and return trimmed stdout.
 *
 * @param {CommandSpec} spec Command descriptor.
 * @param {{ timeoutMs?: number }} [options={}] Execution options.
 * @returns {Promise<string>} Trimmed stdout.
 */
export async function runCommand(spec, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const result = safeSpawnSync(spec.command, spec.args, {
    allowedCommands: options.allowedCommands,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${spec.id} failed with exit code ${result.status ?? "unknown"}: ${String(result.stderr ?? "").trim()}`,
    );
  }

  return String(result.stdout ?? "").trim();
}
