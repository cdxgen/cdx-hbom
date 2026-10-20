import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWindowsScriptInvariants,
  buildCimScript,
  resolveWindowsPowerShellPath,
  WINDOWS_POWERSHELL_BASE_ARGS,
} from "../../src/windows/common/powershell.js";
import {
  WINDOWS_COMMANDS,
  WINDOWS_MANIFESTS,
  WINDOWS_PLATFORM_MANIFEST,
  WINDOWS_SELFTEST_COMMAND,
  WINDOWS_SELFTEST_MANIFEST,
} from "../../src/windows/common/commands.js";

test("resolveWindowsPowerShellPath builds the System32 path without PATH lookups", () => {
  assert.equal(
    resolveWindowsPowerShellPath({ SystemRoot: "C:\\Windows" }),
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.equal(
    resolveWindowsPowerShellPath({ SystemRoot: "D:\\Win dir" }),
    "D:\\Win dir\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
});

test("resolveWindowsPowerShellPath falls back to C:\\Windows for unsafe SystemRoot values", () => {
  for (const systemRoot of [
    undefined,
    "",
    "C:",
    "relative\\path",
    'C:\\Evil"Quote',
    "C:/Forward/Slash",
    "C:\\Question?",
    "C:\\Star*",
    "C:\\Pipe|",
  ]) {
    assert.equal(
      resolveWindowsPowerShellPath({ SystemRoot: systemRoot }),
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      `SystemRoot ${JSON.stringify(systemRoot)} must fall back`,
    );
  }
});

test("base args never include -ExecutionPolicy or -EncodedCommand", () => {
  assert.deepEqual(WINDOWS_POWERSHELL_BASE_ARGS, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);
});

test("registry scripts satisfy the invariants at module load", () => {
  for (const spec of [WINDOWS_COMMANDS[0], WINDOWS_SELFTEST_COMMAND]) {
    const script = spec.args.at(-1);
    assertWindowsScriptInvariants(script);
    assert.match(script, /\$ErrorActionPreference='Stop'/u);
    assert.match(script, /\$ProgressPreference='SilentlyContinue'/u);
    assert.match(script, /schema='cdx-hbom\/windows-envelope@1'/u);
    assert.match(script, /ConvertTo-Json -InputObject \$o -Depth 6 -Compress$/u);
  }
});

test("buildCimScript is deterministic for the same manifest", () => {
  assert.equal(
    buildCimScript(WINDOWS_PLATFORM_MANIFEST),
    buildCimScript(WINDOWS_PLATFORM_MANIFEST),
  );
  assert.equal(WINDOWS_COMMANDS[0].args.at(-1).length, WINDOWS_COMMANDS[0].args.at(-1).length);
  // Keep the emitted scripts comfortably inside the 8,000 character budget.
  assert.ok(WINDOWS_COMMANDS[0].args.at(-1).length <= 8000);
  assert.ok(WINDOWS_SELFTEST_COMMAND.args.at(-1).length <= 8000);
});

test("assertWindowsScriptInvariants rejects one-line, depth and size violations", () => {
  assert.throws(
    () => assertWindowsScriptInvariants('Write-Output "hi"'),
    /double quotes/u,
  );
  assert.throws(
    () => assertWindowsScriptInvariants("Write-Output a\nWrite-Output b"),
    /single line/u,
  );
  assert.throws(
    () => assertWindowsScriptInvariants("Write-Output `a"),
    /single line/u,
  );
  assert.throws(
    () => assertWindowsScriptInvariants("a".repeat(8001)),
    /exceeding 8000/u,
  );
  assert.throws(
    () => assertWindowsScriptInvariants("ConvertTo-Json -InputObject $o"),
    /-Depth 6/u,
  );
});

test("buildCimScript rejects unsafe manifest values", () => {
  const base = {
    commandId: "x",
    entries: [
      { key: "k", kind: "cim", namespace: "root/cimv2", className: "Win32_BIOS", properties: ["Manufacturer"] },
    ],
  };
  for (const unsafe of ['"', "`", "$", ";", "\n", "\0"]) {
    assert.throws(
      () =>
        buildCimScript({
          ...base,
          entries: [
            { ...base.entries[0], className: `Win32_BIOS${unsafe}` },
          ],
        }),
      /forbidden character/u,
      `className with ${JSON.stringify(unsafe)} must be rejected`,
    );
  }
  assert.throws(
    () => buildCimScript({ ...base, entries: [] }),
    /at least one entry/u,
  );
});

test("buildCimScript emits the documented envelope fields and call shape", () => {
  const script = buildCimScript(WINDOWS_SELFTEST_MANIFEST);
  assert.match(script, /commandId='windows-cim-selftest'/u);
  assert.match(
    script,
    /elevated=\$null;results=\[ordered\]@\{\}/u,
  );
  assert.match(
    script,
    /try\{\$o\.elevated=\[Security\.Principal\.WindowsPrincipal\]::new/u,
  );
  // One Q call per cim entry, one R call per registry entry, ordered after the
  // helper declarations.
  assert.equal((script.match(/;Q '/gu) ?? []).length, 7);
  assert.equal((script.match(/;R '/gu) ?? []).length, 1);
  assert.match(script, /;Q 'biosAgain' 'root\/cimv2' 'Win32_BIOS'/u);
  assert.match(
    script,
    /;R 'missingRegistry' 'HKLM:\\SOFTWARE\\cdx-hbom-selftest-absent' @\('X'\)/u,
  );
});

test("buildCimScript renders where filters and projection unions", () => {
  const script = buildCimScript({
    commandId: "where-probe",
    entries: [
      {
        key: "adapters",
        kind: "cim",
        namespace: "root/cimv2",
        className: "Win32_NetworkAdapter",
        properties: ["Name", "MACAddress"],
        where: { property: "PhysicalAdapter", in: [true] },
      },
      {
        key: "states",
        kind: "cim",
        namespace: "root/cimv2",
        className: "Win32_Thing",
        properties: ["Name"],
        where: { property: "State", in: ["Online", "Idle"] },
      },
    ],
  });
  assert.match(
    script,
    /@\('Name','MACAddress'\) \{\$_\.PhysicalAdapter -eq \$true\} 'PhysicalAdapter'/u,
  );
  assert.match(
    script,
    /@\('Name'\) \{\$_\.State -eq 'Online' -or \$_.State -eq 'Idle'\} 'State'/u,
  );
});

test("buildCimScript escapes single quotes in manifest values", () => {
  const script = buildCimScript({
    commandId: "quote-probe",
    entries: [
      {
        key: "odd'name",
        kind: "registry",
        path: "HKLM:\\SOFTWARE\\odd'name",
        names: ["Value'name"],
      },
    ],
  });
  assert.match(script, /;R 'odd''name' 'HKLM:\\SOFTWARE\\odd''name' @\('Value''name'\)/u);
});

test("privacy guard: manifests never select PII properties", () => {
  const banned = [
    // https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-computersystem
    { className: "Win32_ComputerSystem", property: "Name" },
    { className: "Win32_ComputerSystem", property: "DNSHostName" },
    { className: "Win32_ComputerSystem", property: "Domain" },
    { className: "Win32_ComputerSystem", property: "Workgroup" },
    { className: "Win32_ComputerSystem", property: "UserName" },
    { className: "Win32_ComputerSystem", property: "PrimaryOwnerName" },
    { className: "Win32_ComputerSystem", property: "PrimaryOwnerContact" },
    { className: "Win32_ComputerSystem", property: "Roles" },
    // https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-operatingsystem
    { className: "Win32_OperatingSystem", property: "CSName" },
    { className: "Win32_OperatingSystem", property: "RegisteredUser" },
    { className: "Win32_OperatingSystem", property: "Organization" },
    { className: "Win32_OperatingSystem", property: "SerialNumber" },
    // Present on nearly every CIM class; never selected.
    { className: undefined, property: "SystemName" },
    // https://learn.microsoft.com/en-us/windows/win32/devguard/win32-deviceguard
    { className: "Win32_DeviceGuard", property: "InstanceIdentifier" },
    // https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-battery
    // (DeviceID often embeds the battery serial number).
    { className: "Win32_Battery", property: "DeviceID" },
  ];

  assert.ok(WINDOWS_MANIFESTS.includes(WINDOWS_PLATFORM_MANIFEST));
  assert.ok(WINDOWS_MANIFESTS.includes(WINDOWS_SELFTEST_MANIFEST));
  // Every registry command has a manifest in the scanned list (plus the
  // selftest), so a new command cannot bypass the guard.
  assert.equal(WINDOWS_MANIFESTS.length, WINDOWS_COMMANDS.length + 1);
  for (const spec of WINDOWS_COMMANDS) {
    assert.ok(
      WINDOWS_MANIFESTS.some((manifest) => manifest.commandId === spec.id),
      `${spec.id} is missing from WINDOWS_MANIFESTS`,
    );
  }
  for (const manifest of WINDOWS_MANIFESTS) {
    for (const entry of manifest.entries) {
      for (const property of entry.properties ?? []) {
        for (const rule of banned) {
          const classNameMatches =
            rule.className === undefined || rule.className === entry.className;
          if (
            classNameMatches &&
            property.toLowerCase() === rule.property.toLowerCase()
          ) {
            assert.fail(
              `${manifest.commandId} selects PII property ${entry.className}.${property}`,
            );
          }
        }
      }
    }
  }
});
