import { WINDOWS_COMMANDS } from "./commands.js";
import { resolveWindowsPowerShellPath } from "./powershell.js";

export {
  WINDOWS_COMMANDS,
  WINDOWS_PLATFORM_MANIFEST,
  WINDOWS_SELFTEST_COMMAND,
  WINDOWS_SELFTEST_MANIFEST,
} from "./commands.js";
export {
  assertWindowsScriptInvariants,
  buildCimScript,
  resolveWindowsPowerShellPath,
  WINDOWS_POWERSHELL_BASE_ARGS,
  WINDOWS_POWERSHELL_RELATIVE_PATH,
} from "./powershell.js";

/**
 * Return a copy of the Windows command plan.
 *
 * The executable path is re-resolved from the current environment so callers
 * (and their tests) see the powershell.exe path that would actually run, while
 * the frozen registry stays immutable.
 *
 * @returns {ReadonlyArray<object>} Command descriptors.
 */
export function getWindowsCommandPlan() {
  return WINDOWS_COMMANDS.map((spec) => ({
    ...spec,
    command: resolveWindowsPowerShellPath(),
    args: [...spec.args],
    sensitiveFields: spec.sensitiveFields
      ? [...spec.sensitiveFields]
      : undefined,
  }));
}
