import { runCommand } from "../../common/command.js";

/**
 * Read one or more `system_profiler` data types as JSON.
 *
 * @param {string[]} dataTypes Requested `system_profiler` sections.
 * @param {{ timeoutMs?: number }} [options={}] Execution options.
 * @returns {Promise<Record<string, unknown>>} Parsed JSON output.
 */
export async function readSystemProfiler(dataTypes, options = {}) {
  const stdout = await runCommand(
    {
      id: "system-profiler-json",
      category: "platform",
      command: "/usr/sbin/system_profiler",
      args: [...dataTypes, "-json"],
      parser: "json",
      purpose: "Collect structured Darwin hardware inventory.",
      phase: "collector-v1",
    },
    options,
  );

  return JSON.parse(stdout);
}
