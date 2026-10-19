// Target routing normalizers shared by the package entry point and the
// per-platform collectors.

/**
 * Normalize a platform string for target routing.
 *
 * `windows` is accepted as an alias of the Node.js `win32` platform value.
 *
 * @param {string | undefined} platform Platform value.
 * @returns {string} Normalized platform.
 */
export function normalizeTargetPlatform(platform) {
  const normalized = String(platform ?? "").toLowerCase();
  return normalized === "windows" ? "win32" : normalized;
}

/**
 * Normalize architecture aliases used by Node.js, uname, and user input.
 *
 * Examples:
 *
 * - `x64` -> `amd64`
 * - `x86_64` -> `amd64`
 * - `aarch64` -> `arm64`
 *
 * @param {string | undefined} architecture Architecture value.
 * @returns {string} Normalized architecture.
 */
export function normalizeTargetArchitecture(architecture) {
  const normalized = String(architecture ?? "").toLowerCase();

  if (["x64", "x86_64", "x86-64"].includes(normalized)) {
    return "amd64";
  }
  if (["aarch64", "armv8", "arm64e"].includes(normalized)) {
    return "arm64";
  }

  return normalized;
}
