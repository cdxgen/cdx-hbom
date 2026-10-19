import {
  buildWindowsHbom,
  collectWindowsHardware,
  getWindowsCommandPlan,
} from "../common/index.js";

/**
 * Return the Windows amd64 command plan.
 *
 * @returns {ReadonlyArray<object>} Command descriptors.
 */
export function getWindowsAmd64CommandPlan() {
  return getWindowsCommandPlan();
}

/**
 * Build a Windows amd64 BOM from pre-collected sources.
 *
 * @param {object} options Build options.
 * @returns {object} CycloneDX BOM.
 */
export function buildWindowsAmd64Hbom(options) {
  return buildWindowsHbom({
    ...options,
    architecture: "amd64",
  });
}

/**
 * Collect Windows amd64 hardware inventory.
 *
 * @param {object} [options={}] Collector options.
 * @returns {Promise<object>} CycloneDX BOM.
 */
export async function collectWindowsAmd64Hardware(options = {}) {
  return collectWindowsHardware({
    ...options,
    architecture: "amd64",
  });
}
