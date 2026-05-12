import {
  buildLinuxHbom,
  collectLinuxHardware,
  getLinuxCommandPlan,
} from "../common/index.js";

/**
 * Return the Linux amd64 command plan.
 *
 * @returns {ReadonlyArray<object>} Command descriptors.
 */
export function getLinuxAmd64CommandPlan() {
  return getLinuxCommandPlan();
}

/**
 * Build a Linux amd64 BOM from pre-collected sources.
 *
 * @param {object} options Build options.
 * @returns {object} CycloneDX BOM.
 */
export function buildLinuxAmd64Hbom(options) {
  return buildLinuxHbom({
    ...options,
    architecture: "amd64",
  });
}

/**
 * Collect Linux amd64 hardware inventory.
 *
 * @param {object} [options={}] Collector options.
 * @returns {Promise<object>} CycloneDX BOM.
 */
export async function collectLinuxAmd64Hardware(options = {}) {
  return collectLinuxHardware({
    ...options,
    architecture: "amd64",
  });
}
