import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * Commands executed through the safe child-process wrapper.
 *
 * @type {Set<string>}
 */
export const commandsExecuted = new Set();

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Safely test whether a path exists.
 *
 * The function never throws for ordinary filesystem errors and is suitable for
 * discovery code that should degrade gracefully when probing the local host.
 *
 * @param {string} filePath Candidate path.
 * @returns {boolean} True when the path exists and is readable enough for `existsSync`.
 */
export function safeExistsSync(filePath) {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * Safely create a directory.
 *
 * `EEXIST` is treated as success. Other errors are re-thrown unless
 * `suppressErrors` is enabled.
 *
 * @param {string} filePath Directory path.
 * @param {{ recursive?: boolean, mode?: number, suppressErrors?: boolean }} [options={}] mkdir options.
 * @returns {string | undefined} The input path when created or already present.
 */
export function safeMkdirSync(filePath, options = {}) {
  try {
    mkdirSync(filePath, options);
    return filePath;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return filePath;
    }
    if (options.suppressErrors === true) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Safely read a text or binary file.
 *
 * Ordinary filesystem errors are suppressed unless `suppressErrors` is set to
 * `false`.
 *
 * @param {string} filePath File path.
 * @param {{ encoding?: BufferEncoding | null, suppressErrors?: boolean }} [options={}] Read options.
 * @returns {string | Buffer | undefined} File contents or undefined when suppressed.
 */
export function safeReadFileSync(filePath, options = {}) {
  try {
    if (options.encoding === null) {
      return readFileSync(filePath);
    }

    return readFileSync(filePath, options.encoding ?? "utf8");
  } catch (error) {
    if (options.suppressErrors === false) {
      throw error;
    }
    return undefined;
  }
}

/**
 * Safely list a directory.
 *
 * Ordinary filesystem errors are suppressed unless `suppressErrors` is set to
 * `false`.
 *
 * @param {string} directoryPath Directory path.
 * @param {{ suppressErrors?: boolean }} [options={}] Read options.
 * @returns {string[]} Directory entries or an empty array when suppressed.
 */
export function safeReaddirSync(directoryPath, options = {}) {
  try {
    return readdirSync(directoryPath);
  } catch (error) {
    if (options.suppressErrors === false) {
      throw error;
    }
    return [];
  }
}

/**
 * Safely execute a command synchronously.
 *
 * This is a deliberately small, dependency-free reimplementation of the ideas
 * behind `cdxgen`'s `safeSpawnSync`, adapted for `cdx-hbom`:
 *
 * - default timeout and maxBuffer
 * - opt-in command allowlist via `CDX_HBOM_ALLOWED_COMMANDS`
 * - executed-command tracking via `commandsExecuted`
 * - shell execution disabled by default
 * - Windows shell hijack guard when `shell: true`
 *
 * Unlike `cdxgen`, this helper intentionally avoids policy/audit side effects so
 * `cdx-hbom` stays small and standalone during early development.
 *
 * @param {string} command Executable path or name.
 * @param {string[]} [args=[]] Command arguments.
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   encoding?: BufferEncoding | "buffer",
 *   input?: string | Buffer,
 *   maxBuffer?: number,
 *   shell?: boolean,
 *   timeout?: number,
 *   windowsHide?: boolean,
 *   allowedCommands?: string[]
 * }} [options={}] Execution options.
 * @returns {{
 *   pid?: number,
 *   output?: Array<string | Buffer | null | undefined>,
 *   stdout?: string | Buffer,
 *   stderr?: string | Buffer,
 *   status: number | null,
 *   signal?: NodeJS.Signals | null,
 *   error?: Error
 * }} Spawn result object.
 */
export function safeSpawnSync(command, args = [], options = {}) {
  const allowedCommands = normalizeAllowedCommands(options.allowedCommands);
  const commandName = basename(command);

  if (allowedCommands && !allowedCommands.has(command) && !allowedCommands.has(commandName)) {
    return {
      status: 1,
      stdout: options.encoding === "buffer" ? Buffer.alloc(0) : "",
      stderr: options.encoding === "buffer" ? Buffer.from("Command blocked by allowlist") : "Command blocked by allowlist",
      error: new Error(`Command blocked by allowlist: ${command}`),
    };
  }

  if (options.shell === true && isWindowsShellHijackRisk(command, options.cwd)) {
    return {
      status: 1,
      stdout: options.encoding === "buffer" ? Buffer.alloc(0) : "",
      stderr: options.encoding === "buffer" ? Buffer.from("Blocked potential Windows shell hijack") : "Blocked potential Windows shell hijack",
      error: new Error("Blocked potential Windows shell hijack"),
    };
  }

  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    encoding: options.encoding ?? "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    shell: options.shell ?? false,
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    windowsHide: options.windowsHide ?? true,
  };

  commandsExecuted.add(command);
  return spawnSync(command, args, spawnOptions);
}

/**
 * Normalize the effective command allowlist.
 *
 * @param {string[] | undefined} allowedCommands Explicit allowlist.
 * @returns {Set<string> | null} Allowlist set or null when not configured.
 */
function normalizeAllowedCommands(allowedCommands) {
  if (Array.isArray(allowedCommands) && allowedCommands.length > 0) {
    return new Set(allowedCommands.map((entry) => entry.trim()).filter(Boolean));
  }

  const envValue =
    process.env.CDX_HBOM_ALLOWED_COMMANDS ?? process.env.CDXGEN_ALLOWED_COMMANDS;

  if (!envValue) {
    return null;
  }

  return new Set(
    envValue
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

/**
 * Detect the Windows current-working-directory shell hijack case.
 *
 * @param {string} command Executable name.
 * @param {string | undefined} cwd Working directory.
 * @returns {boolean} True when the executable could be shadowed by a local file.
 */
function isWindowsShellHijackRisk(command, cwd) {
  if (process.platform !== "win32" || !cwd || /[\\/]/u.test(command)) {
    return false;
  }

  const candidateBase = command.toLowerCase();
  const pathExt = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  const cwdPath = resolve(cwd);
  const candidates = [candidateBase, ...pathExt.map((extension) => `${candidateBase}${extension}`)];

  return candidates.some((candidate) => safeExistsSync(resolve(cwdPath, candidate)));
}
