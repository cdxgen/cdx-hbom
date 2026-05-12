import {
  buildLinuxHbom,
  collectLinuxHardware,
  getLinuxCommandPlan,
} from "../common/index.js";

/**
 * Return the Linux arm64 command plan.
 *
 * @returns {ReadonlyArray<object>} Command descriptors.
 */
export function getLinuxArm64CommandPlan() {
  return getLinuxCommandPlan();
}

/**
 * Build a Linux arm64 BOM from pre-collected sources.
 *
 * @param {object} options Build options.
 * @returns {object} CycloneDX BOM.
 */
export function buildLinuxArm64Hbom(options) {
  return buildLinuxHbom({
    ...options,
    architecture: "arm64",
  });
}

/**
 * Collect Linux arm64 hardware inventory.
 *
 * @param {object} [options={}] Collector options.
 * @returns {Promise<object>} CycloneDX BOM.
 */
export async function collectLinuxArm64Hardware(options = {}) {
  return collectLinuxHardware({
    ...options,
    architecture: "arm64",
  });
}
