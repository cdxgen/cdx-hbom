import process from "node:process";

/**
 * Absolute path of the Windows PowerShell 5.1 executable, resolved without a
 * PATH lookup so a hijacked PATH cannot redirect collector commands.
 *
 * @type {string}
 */
export const WINDOWS_POWERSHELL_RELATIVE_PATH =
  "System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * Arguments shared by every Windows PowerShell invocation. `-Command` needs no
 * `-ExecutionPolicy` (about_Execution_Policies), and `-NoProfile` keeps the
 * script independent of machine and user profiles.
 *
 * @type {ReadonlyArray<string>}
 */
export const WINDOWS_POWERSHELL_BASE_ARGS = Object.freeze([
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
]);

// CreateProcess command lines are limited to 32,767 characters, but the CIM
// scripts stay far below this self-imposed budget so traces and allowlist
// audits remain reviewable.
const MAX_SCRIPT_LENGTH = 8000;

// Characters that would break out of the single-quoted PowerShell literals the
// builder emits, or break the one-line invariant.
const UNSAFE_MANIFEST_VALUE = /["`$;\r\n\0]/u;

// A drive-absolute SystemRoot such as `C:\Windows`. Everything after the drive
// colon must be a legal path segment; control characters and path wildcards
// are rejected so a hostile environment cannot smuggle quotes into the path.
const SYSTEM_ROOT_PATTERN = /^[A-Za-z]:\\[^\0-\x1f"*?<>|/:]+$/u;

const FALLBACK_SYSTEM_ROOT = "C:\\Windows";

/**
 * Resolve the absolute path of `powershell.exe` from an environment.
 *
 * The resolver is pure: tests pass a custom environment. `SystemRoot` is
 * validated and falls back to `C:\Windows`, matching the documented location
 * of Windows PowerShell on every supported release.
 *
 * @param {{ SystemRoot?: string }} [env=process.env] Environment to read.
 * @returns {string} Absolute powershell.exe path.
 */
export function resolveWindowsPowerShellPath(env = process.env) {
  return resolveWindowsSystemPath(WINDOWS_POWERSHELL_RELATIVE_PATH, env);
}

/**
 * Resolve an absolute path under the validated `SystemRoot`.
 *
 * @param {string} relativePath Path below `SystemRoot`, such as `System32\reg.exe`.
 * @param {{ SystemRoot?: string }} [env=process.env] Environment to read.
 * @returns {string} Absolute path.
 */
export function resolveWindowsSystemPath(relativePath, env = process.env) {
  const candidate = String(env?.SystemRoot ?? "");
  const root = SYSTEM_ROOT_PATTERN.test(candidate)
    ? candidate.replace(/[\\]+$/u, "")
    : FALLBACK_SYSTEM_ROOT;
  return `${root}\\${relativePath}`;
}

/**
 * Assert the invariants every generated CIM script must hold.
 *
 * - exactly one line, with no `"`, backtick, `\r` or `\n` (libuv quoting plus
 *   the powershell.exe command-line parser make double quotes fragile);
 * - at most {@link MAX_SCRIPT_LENGTH} characters;
 * - an explicit `-Depth` on the `ConvertTo-Json` call, because exceeding the
 *   depth silently serializes hashtables as type-name strings.
 *
 * @param {string} script Generated PowerShell script.
 * @returns {void} Nothing; throws on the first violated invariant.
 */
export function assertWindowsScriptInvariants(script) {
  const text = String(script ?? "");

  if (text.includes('"')) {
    throw new Error("Windows CIM script must not contain double quotes");
  }
  if (/[\r\n`]/u.test(text)) {
    throw new Error("Windows CIM script must be a single line");
  }
  if (text.length > MAX_SCRIPT_LENGTH) {
    throw new Error(
      `Windows CIM script is ${text.length} characters, exceeding ${MAX_SCRIPT_LENGTH}`,
    );
  }
  if (!text.includes("ConvertTo-Json -InputObject $o -Depth 6 -Compress")) {
    throw new Error("Windows CIM script must serialize with -Depth 6");
  }
}

/**
 * @typedef {object} CimManifestEntry
 * @property {string} key Result key inside the envelope's `results` table.
 * @property {"cim"} kind Entry kind.
 * @property {string} namespace CIM namespace such as `root/cimv2`.
 * @property {string} className CIM class such as `Win32_BIOS`.
 * @property {string[]} properties Property names projected at the CIM layer.
 * @property {{ property: string, in: Array<string | number | boolean> }} [where] Optional instance filter.
 */

/**
 * @typedef {object} RegistryManifestEntry
 * @property {string} key Result key inside the envelope's `results` table.
 * @property {"registry"} kind Entry kind.
 * @property {string} path Registry path such as `HKLM:\SOFTWARE\...`.
 * @property {string[]} names Value names to keep.
 */

/**
 * @typedef {object} PnpPropertiesManifestEntry
 * @property {string} key Result key inside the envelope's `results` table.
 * @property {"pnp-properties"} kind Entry kind.
 * @property {string[]} keys DEVPKEY names, each fetched in one bulk call.
 */

/**
 * @typedef {object} RegistryChildrenManifestEntry
 * @property {string} key Result key inside the envelope's `results` table.
 * @property {"registry-children"} kind Entry kind.
 * @property {string} path Registry key whose subkeys are enumerated.
 * @property {string[]} names Value names read from each subkey.
 */

/**
 * @typedef {object} CmdletScalarManifestEntry
 * @property {string} key Result key inside the envelope's `results` table.
 * @property {"cmdlet-scalar"} kind Entry kind.
 * @property {string} cmdlet Allowlisted cmdlet name, run with no arguments.
 */

/**
 * Cmdlets a `cmdlet-scalar` entry may run. Each one is a documented
 * read-only query whose scalar result the envelope stores as `value`.
 * Confirm-SecureBootUEFI:
 * https://learn.microsoft.com/en-us/powershell/module/secureboot/confirm-securebootuefi
 *
 * @type {ReadonlyArray<string>}
 */
export const WINDOWS_SCALAR_CMDLETS = Object.freeze(["Confirm-SecureBootUEFI"]);

/**
 * @typedef {object} CimManifest
 * @property {string} commandId Command identifier recorded in the envelope.
 * @property {ReadonlyArray<CimManifestEntry | RegistryManifestEntry | PnpPropertiesManifestEntry | RegistryChildrenManifestEntry | CmdletScalarManifestEntry>} entries Ordered entries.
 */

/**
 * Build the single-line PowerShell script for a CIM manifest.
 *
 * The script writes one JSON envelope (`cdx-hbom/windows-envelope@1`) through
 * `ConvertTo-Json -InputObject $o -Depth 6 -Compress`. Small helper functions
 * (`E` records an error, `Q` queries a CIM class, `R` reads registry values)
 * are declared once, then one call per entry keeps the script readable and its
 * length proportional to the manifest. Every literal is single-quoted.
 *
 * Constrained Language Mode notes: the encoding and elevation probes are the
 * only constructs that touch .NET types directly, and both sit inside their
 * own `try/catch` so a CLM host degrades to `outputEncoding='default'` and
 * `elevated=null` instead of failing the batch.
 *
 * @param {CimManifest} manifest Manifest with `commandId` and entries.
 * @returns {string} One-line PowerShell script.
 * @throws {Error} When a manifest value contains characters the builder cannot
 *   embed safely, or when the manifest is malformed.
 */
export function buildCimScript(manifest) {
  const commandId = requireManifestString(manifest?.commandId, "commandId");
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];

  if (entries.length === 0) {
    throw new Error("Windows CIM manifest needs at least one entry");
  }

  const parts = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "$enc='default'",
    "try{[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$enc='utf-8'}catch{$enc='default'}",
    `$o=[ordered]@{schema='cdx-hbom/windows-envelope@1';commandId='${escapePowerShellSingleQuoted(commandId)}';psVersion=[string]$PSVersionTable.PSVersion;languageMode=[string]$ExecutionContext.SessionState.LanguageMode;outputEncoding=$enc;elevated=$null;results=[ordered]@{}}`,
    "try{$o.elevated=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}catch{}",
    "$denied=@{}",
    // `r` is a default alias for Invoke-History, and aliases outrank functions
    // in PowerShell command resolution, so the helper names must be freed
    // before their `function` declarations take effect.
    "Remove-Item Alias:e,Alias:q,Alias:r -ErrorAction SilentlyContinue",
    "function E($k,$e){$o.results[$k]=@{ok=$false;error=@{nativeErrorCode=[string]$e.Exception.NativeErrorCode;statusCode=$e.Exception.StatusCode;category=[string]$e.CategoryInfo.Category;fqid=[string]$e.FullyQualifiedErrorId;message=[string]$e.Exception.Message}}}",
    "function Q($k,$ns,$cn,$p,$f,$wp){try{if($denied.ContainsKey($ns)){$o.results[$k]=@{ok=$false;error=$denied[$ns];shortCircuited=$true};return};$c=(Get-CimClass -Namespace $ns -ClassName $cn -ErrorAction Stop).CimClassProperties;$req=@($p);if($wp){$req=@($p+$wp|Select-Object -Unique)};$s=@($req|Where-Object{$c.Name -contains $_});$sel=@($s|Where-Object{$p -contains $_});if(-not $sel.Count){$o.results[$k]=@{ok=$false;error=@{nativeErrorCode='NoProperties';statusCode=0;category='MetadataError';fqid='NoProperties';message='No requested properties exist on the class'}};return};$g=Get-CimInstance -Namespace $ns -ClassName $cn -Property $s -ErrorAction Stop;if($f){$g=$g|Where-Object $f};$o.results[$k]=@{ok=$true;items=@($g|Select-Object -Property $sel)}}catch{E $k $_;if([string]$_.Exception.NativeErrorCode -eq 'AccessDenied'){$denied[$ns]=@{nativeErrorCode=[string]$_.Exception.NativeErrorCode;statusCode=$_.Exception.StatusCode;category=[string]$_.CategoryInfo.Category;fqid=[string]$_.FullyQualifiedErrorId;message=[string]$_.Exception.Message}}}}",
    "function R($k,$path,$n){try{$v=Get-ItemProperty -Path $path -ErrorAction Stop;$r=[ordered]@{};foreach($x in $n){if($v.PSObject.Properties.Name -contains $x){$r[$x]=$v.$x}};$o.results[$k]=@{ok=$true;kind='registry';values=$r}}catch{E $k $_;$o.results[$k].kind='registry'}}",
  ];

  // Kind-specific helpers are declared only when a manifest uses the kind, so
  // the scripts (and therefore the argsSha256) of earlier commands never
  // change when a new kind is added.
  const kinds = new Set(entries.map((entry) => entry?.kind));
  if (kinds.has("pnp-properties")) {
    parts.push(
      "Remove-Item Alias:p -ErrorAction SilentlyContinue",
      // Get-PnpDevice reads root/cimv2 Win32_PnPEntity, so a denial recorded
      // for that namespace short-circuits the whole entry.
      //
      // Properties are read one device at a time, piping each device object
      // into Get-PnpDeviceProperty with every key. Measured on win11-vm
      // (26200.9457, 74 devices, fresh processes, tmp/probe-pnp2..13):
      // - passing the instance IDs as an `-InstanceId` array (one call per
      //   key, or all keys at once) returns the right row count but
      //   duplicates some devices' rows and omits others', 7-24 bad rows per
      //   run, nondeterministically;
      // - piping the whole device array into one call is correct but takes
      //   3.5-4.2 s;
      // - piping one device per call is correct and takes about 1.6 s.
      //
      // One rejected key fails every call that carries it (VM-FINDINGS §6),
      // so the key set is probed once against the first device; rejected
      // keys are recorded in keyErrors and the loop runs with the rest.
      // Device-specific failures are counted in errorCount.
      "function P($k,$keys){try{if($denied.ContainsKey('root/cimv2')){$o.results[$k]=@{ok=$false;error=$denied['root/cimv2'];shortCircuited=$true;kind='pnp-properties'};return};$devs=@(Get-PnpDevice -PresentOnly -ErrorAction Stop);$ke=[ordered]@{};$valid=@($keys);$mode='per-device';if($devs.Count -gt 0){try{$null=@($devs[0]|Get-PnpDeviceProperty -KeyName $keys -ErrorAction Stop)}catch{$mode='per-device-retry';$valid=@();foreach($kn in $keys){try{$null=@($devs[0]|Get-PnpDeviceProperty -KeyName $kn -ErrorAction Stop);$valid+=$kn}catch{$ke[$kn]=@{nativeErrorCode=[string]$_.Exception.NativeErrorCode;statusCode=$_.Exception.StatusCode;category=[string]$_.CategoryInfo.Category;fqid=[string]$_.FullyQualifiedErrorId;message=[string]$_.Exception.Message}}}}};$rows=@();$pe=@();if($valid.Count -gt 0){foreach($d in $devs){$rows+=@($d|Get-PnpDeviceProperty -KeyName $valid -ErrorAction SilentlyContinue -ErrorVariable +pe)}};$o.results[$k]=@{ok=$true;kind='pnp-properties';mode=$mode;deviceCount=$devs.Count;errorCount=$pe.Count;items=@($rows|Select-Object -Property InstanceId,KeyName,Type,Data);keyErrors=$ke}}catch{E $k $_;$o.results[$k].kind='pnp-properties'}}",
    );
  }
  if (kinds.has("registry-children")) {
    parts.push(
      "Remove-Item Alias:c -ErrorAction SilentlyContinue",
      // One row per subkey, named by the subkey, carrying the requested
      // values that exist; a missing parent key is reported through E as
      // ItemNotFound, which the parser classifies as not-present.
      "function C($k,$path,$n){try{$items=@();foreach($key in @(Get-ChildItem -Path $path -ErrorAction Stop)){$v=Get-ItemProperty -Path $key.PSPath -ErrorAction Stop;$r=[ordered]@{Name=$key.PSChildName};foreach($x in $n){if($v.PSObject.Properties.Name -contains $x){$r[$x]=$v.$x}};$items+=,$r};$o.results[$k]=@{ok=$true;kind='registry-children';items=$items}}catch{E $k $_;$o.results[$k].kind='registry-children'}}",
    );
  }

  for (const entry of entries) {
    parts.push(buildEntryCall(entry));
  }

  parts.push("ConvertTo-Json -InputObject $o -Depth 6 -Compress");

  const script = parts.join(";");
  assertWindowsScriptInvariants(script);
  return script;
}

/**
 * Build the script statement for one manifest entry.
 *
 * @param {CimManifestEntry | RegistryManifestEntry} entry Manifest entry.
 * @returns {string} PowerShell call statement.
 */
function buildEntryCall(entry) {
  const key = requireManifestString(entry?.key, "entry key");

  if (entry?.kind === "registry") {
    const path = requireManifestString(entry.path, `${key} registry path`);
    const names = requireManifestStringArray(entry.names, `${key} registry names`);
    return `R '${escapePowerShellSingleQuoted(key)}' '${escapePowerShellSingleQuoted(path)}' @(${names
      .map((name) => `'${escapePowerShellSingleQuoted(name)}'`)
      .join(",")})`;
  }

  if (entry?.kind === "registry-children") {
    const path = requireManifestString(entry.path, `${key} registry path`);
    const names = requireManifestStringArray(entry.names, `${key} registry names`);
    return `C '${escapePowerShellSingleQuoted(key)}' '${escapePowerShellSingleQuoted(path)}' @(${names
      .map((name) => `'${escapePowerShellSingleQuoted(name)}'`)
      .join(",")})`;
  }

  if (entry?.kind === "cmdlet-scalar") {
    const cmdlet = requireManifestString(entry.cmdlet, `${key} cmdlet`);
    // The cmdlet name is interpolated as a command, so only names from the
    // allowlist may appear, and never with arguments.
    if (!WINDOWS_SCALAR_CMDLETS.includes(cmdlet)) {
      throw new Error(
        `Windows CIM manifest ${key} cmdlet '${cmdlet}' is not an allowlisted scalar cmdlet`,
      );
    }
    const safeKey = escapePowerShellSingleQuoted(key);
    return `try{$o.results['${safeKey}']=@{ok=$true;kind='cmdlet-scalar';value=(${cmdlet} -ErrorAction Stop)}}catch{E '${safeKey}' $_;$o.results['${safeKey}'].kind='cmdlet-scalar'}`;
  }

  if (entry?.kind === "pnp-properties") {
    const keys = requireManifestStringArray(entry.keys, `${key} pnp keys`);
    // DEVPKEY names are plain identifiers; anything else would be a typo that
    // Get-PnpDeviceProperty rejects at runtime for every key in the call.
    for (const name of keys) {
      if (!/^DEVPKEY_[A-Za-z0-9_]+$/u.test(name)) {
        throw new Error(
          `Windows CIM manifest ${key} pnp key '${name}' must be a DEVPKEY_ identifier`,
        );
      }
    }
    return `P '${escapePowerShellSingleQuoted(key)}' @(${keys
      .map((name) => `'${name}'`)
      .join(",")})`;
  }

  if (entry?.kind !== "cim") {
    throw new Error(`Windows CIM manifest entry '${key}' has unknown kind`);
  }

  const namespace = requireManifestString(
    entry.namespace,
    `${key} namespace`,
  );
  const className = requireManifestString(
    entry.className,
    `${key} className`,
  );
  const properties = requireManifestStringArray(
    entry.properties,
    `${key} properties`,
  );

  let filter = "$null";
  let whereProperty = "$null";
  if (entry.where !== undefined) {
    const property = requireManifestString(
      entry.where?.property,
      `${key} where property`,
    );
    // The filter interpolates the property name outside quotes, so it must be
    // a plain CIM identifier (WMI property grammar: identifier chars only).
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(property)) {
      throw new Error(
        `Windows CIM manifest ${key} where property must be a plain identifier`,
      );
    }
    const values = Array.isArray(entry.where?.in) ? entry.where.in : [];
    if (values.length === 0) {
      throw new Error(`Windows CIM manifest entry '${key}' has an empty where`);
    }
    const comparisons = values
      .map((value) => `$_.${property} -eq ${formatPowerShellLiteral(value)}`)
      .join(" -or ");
    filter = `{${comparisons}}`;
    whereProperty = `'${escapePowerShellSingleQuoted(property)}'`;
  }

  const propertyList = properties
    .map((name) => `'${escapePowerShellSingleQuoted(name)}'`)
    .join(",");

  return `Q '${escapePowerShellSingleQuoted(key)}' '${escapePowerShellSingleQuoted(
    namespace,
  )}' '${escapePowerShellSingleQuoted(className)}' @(${propertyList}) ${filter} ${whereProperty}`;
}

/**
 * Format a manifest value as a PowerShell literal.
 *
 * @param {string | number | boolean} value Filter value.
 * @returns {string} PowerShell literal.
 */
function formatPowerShellLiteral(value) {
  if (value === true) {
    return "$true";
  }
  if (value === false) {
    return "$false";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    return `'${escapePowerShellSingleQuoted(assertSafeManifestValue(value))}'`;
  }
  throw new Error(
    `Unsupported Windows CIM where value: ${typeof value}`,
  );
}

/**
 * Escape a value for a single-quoted PowerShell string.
 *
 * @param {string} value Raw value, already validated.
 * @returns {string} Escaped value.
 */
function escapePowerShellSingleQuoted(value) {
  return assertSafeManifestValue(value).replaceAll("'", "''");
}

/**
 * Reject characters the one-line, single-quoted script cannot carry.
 *
 * @param {string} value Candidate value.
 * @returns {string} The unchanged value.
 */
function assertSafeManifestValue(value) {
  if (UNSAFE_MANIFEST_VALUE.test(value)) {
    throw new Error(
      "Windows CIM manifest value contains a forbidden character (double quote, backtick, dollar, semicolon or newline)",
    );
  }
  return value;
}

/**
 * Require a non-empty safe manifest string.
 *
 * @param {unknown} value Candidate value.
 * @param {string} label Field label for error messages.
 * @returns {string} Validated value.
 */
function requireManifestString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Windows CIM manifest ${label} must be a non-empty string`);
  }
  return assertSafeManifestValue(value);
}

/**
 * Require a non-empty array of safe manifest strings.
 *
 * @param {unknown} value Candidate value.
 * @param {string} label Field label for error messages.
 * @returns {string[]} Validated values.
 */
function requireManifestStringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(
      `Windows CIM manifest ${label} must be a non-empty array of non-empty strings`,
    );
  }
  return value.map((item) => assertSafeManifestValue(item));
}
