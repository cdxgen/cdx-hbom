import {
  buildWindowsHbom,
  collectWindowsHardware,
  getWindowsCommandPlan,
} from "../common/index.js";

/**
 * Return the Windows arm64 command plan.
 *
 * @returns {ReadonlyArray<object>} Command descriptors.
 */
export function getWindowsArm64CommandPlan() {
  return getWindowsCommandPlan();
}

/**
 * Build a Windows arm64 BOM from pre-collected sources.
 *
 * @param {object} options Build options.
 * @returns {object} CycloneDX BOM.
 */
export function buildWindowsArm64Hbom(options) {
  return buildWindowsHbom({
    ...options,
    architecture: "arm64",
  });
}

/**
 * Collect Windows arm64 hardware inventory.
 *
 * @param {object} [options={}] Collector options.
 * @returns {Promise<object>} CycloneDX BOM.
 */
export async function collectWindowsArm64Hardware(options = {}) {
  return collectWindowsHardware({
    ...options,
    architecture: "arm64",
  });
}
