import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  cimArray,
  cimBool,
  cimDate,
  cimNumber,
  cimString,
  cimUint16String,
  classifyWindowsResultError,
  parseWindowsEnvelope,
  summarizeWindowsAccess,
  toWindowsResultDiagnostic,
  WINDOWS_NETWORK_LOGON_HINT,
} from "../../src/windows/common/cim.js";

/**
 * Read one captured fixture as text.
 *
 * @param {string} relativePath Path under test/fixtures/windows.
 * @returns {string} Fixture text.
 */
function readFixture(relativePath) {
  return readFileSync(
    new URL(`../fixtures/windows/${relativePath}`, import.meta.url),
    "utf8",
  );
}

test("parseWindowsEnvelope reads the captured elevated platform envelope", () => {
  const envelope = parseWindowsEnvelope(
    readFixture("arm64/vm-parallels-elevated/windows-cim-platform.stdout"),
  );

  assert.equal(envelope.meta.commandId, "windows-cim-platform");
  assert.equal(envelope.meta.psVersion, "5.1.26100.9457");
  assert.equal(envelope.meta.languageMode, "FullLanguage");
  assert.equal(envelope.meta.outputEncoding, "utf-8");
  assert.equal(envelope.meta.elevated, true);
  assert.deepEqual(envelope.warnings, []);
  for (const key of [
    "computerSystem",
    "computerSystemProduct",
    "bios",
    "baseBoard",
    "systemEnclosure",
    "processor",
    "physicalMemory",
    "physicalMemoryArray",
    "operatingSystem",
    "msSystemInformation",
  ]) {
    assert.ok(envelope.results[key], `result ${key} exists`);
    assert.equal(envelope.results[key].ok, true, `result ${key} is ok`);
    assert.ok(Array.isArray(envelope.results[key].items));
    assert.ok(envelope.results[key].items.length > 0, `result ${key} has items`);
  }
});

test("parseWindowsEnvelope normalizes items to arrays", () => {
  const envelope = parseWindowsEnvelope(
    '{"schema":"cdx-hbom/windows-envelope@1","results":{"one":{"ok":true,"items":{"A":1}},"two":{"ok":true,"items":null}}}',
  );
  assert.deepEqual(envelope.results.one.items, [{ A: 1 }]);
  assert.deepEqual(envelope.results.two.items, []);
});

test("parseWindowsEnvelope rejects foreign schemas and garbage", () => {
  assert.throws(
    () => parseWindowsEnvelope('{"schema":"other@1","results":{}}'),
    /Unexpected Windows envelope schema/u,
  );
  assert.throws(() => parseWindowsEnvelope("not json"), SyntaxError);
});

test("parseWindowsEnvelope flags projection and depth bugs as warnings", () => {
  const base = JSON.parse(
    readFixture("arm64/vm-parallels-elevated/windows-cim-platform.stdout"),
  );
  // Derived inside the test from the captured fixture (never a new fixture
  // file): inject the two bug shapes ConvertTo-Json produces when projection
  // or depth is wrong.
  base.results.bios.items[0].BIOSVersion = "System.Collections.Hashtable";
  base.results.computerSystem.items[0].Embedded = {
    CimClass: { Name: "Win32_BIOS" },
    CimInstanceProperties: [],
  };

  const envelope = parseWindowsEnvelope(JSON.stringify(base));
  assert.equal(envelope.warnings.length, 3);
  assert.match(envelope.warnings[0], /results\.bios\.items\[0\]\.BIOSVersion/u);
  assert.match(envelope.warnings[0], /System\.Collections\.Hashtable/u);
  assert.match(envelope.warnings[1], /results\.computerSystem\.items\[0\]\.Embedded/u);
  assert.match(envelope.warnings[1], /CimClass/u);
  assert.match(envelope.warnings[2], /CimInstanceProperties/u);
});

test("parseWindowsEnvelope strips a UTF-8 BOM", () => {
  const text = readFixture(
    "arm64/vm-parallels-elevated/windows-cim-platform.stdout",
  );
  const envelope = parseWindowsEnvelope(`\uFEFF${text}`);
  assert.equal(envelope.meta.commandId, "windows-cim-platform");
});

test("normalizers handle captured value shapes", () => {
  // Whitespace-only serials on Parallels hardware collapse to undefined.
  assert.equal(cimString(" "), undefined);
  assert.equal(cimString("PRLS   - 2"), "PRLS   - 2");
  assert.equal(cimString(null), undefined);

  assert.equal(cimNumber("17179869184"), 17179869184);
  assert.equal(cimNumber(""), undefined);
  assert.equal(cimNumber("not-a-number"), undefined);
  assert.equal(cimNumber(12), 12);

  assert.equal(cimBool(true), true);
  assert.equal(cimBool("false"), false);
  assert.equal(cimBool(1), undefined);

  assert.deepEqual(cimArray(undefined), []);
  assert.deepEqual(cimArray("a"), ["a"]);
  assert.deepEqual(cimArray(["a"]), ["a"]);

  // WmiMonitorID.ManufacturerName captured on the VM: [80,82,76,0,...] is
  // "PRL" and decoding stops at the first zero.
  assert.equal(cimUint16String([80, 82, 76, 0, 0, 0]), "PRL");
  assert.equal(cimUint16String([87, 68, 67]), "WDC");
  assert.equal(cimUint16String([]), undefined);
  assert.equal(cimUint16String("PRL"), undefined);
});

test("cimDate accepts every captured date serialization", () => {
  // Windows PowerShell 5.1 epoch-ms form (JSON.parse turns \/ into /).
  assert.equal(cimDate("/Date(1708337472000)/"), "2024-02-19");
  // ISO 8601 with explicit timezone.
  assert.equal(cimDate("2026-08-11T15:56:20Z"), "2026-08-11");
  // ISO 8601 without timezone is read as UTC.
  assert.equal(cimDate("2026-08-11T23:30:00"), "2026-08-11");
  // Plain date, as MSFT_NetAdapter DriverDate reports it.
  assert.equal(cimDate("2025-11-25"), "2025-11-25");
  // MS_SystemInformation.BIOSReleaseDate captured on the VM.
  assert.equal(cimDate("Tue, 11 Aug 2026 15:56:20"), "2026-08-11");
  assert.equal(cimDate("Wed, 21 Jan 2026 01:02:03"), "2026-01-21");
  assert.equal(cimDate("not a date"), undefined);
  assert.equal(cimDate(null), undefined);
  assert.equal(cimDate(""), undefined);
});

test("classification matches the captured selftest error objects", () => {
  const selftest = parseWindowsEnvelope(
    readFixture("arm64/vm-parallels-elevated/windows-cim-selftest.stdout"),
  );

  const byError = (key) => classifyWindowsResultError(selftest.results[key].error);
  // Captured on win11-vm (elevated): Get-CimClass reports the absent class as
  // NotFound/6, the absent namespace as InvalidNamespace/3, and
  // MSAcpi_ThermalZoneTemperature as NotSupported/7. The missing registry key
  // reports PathNotFound with category ObjectNotFound.
  assert.equal(byError("missingClass"), "not-present");
  assert.equal(selftest.results.missingClass.error.statusCode, 6);
  assert.equal(selftest.results.missingClass.error.nativeErrorCode, "NotFound");
  assert.equal(byError("missingNamespace"), "not-present");
  assert.equal(selftest.results.missingNamespace.error.nativeErrorCode, "InvalidNamespace");
  assert.equal(byError("notSupported"), "partial-support");
  assert.equal(selftest.results.notSupported.error.nativeErrorCode, "NotSupported");
  assert.equal(byError("missingRegistry"), "not-present");
  assert.ok(selftest.results.missingRegistry.ok === false);

  // Shapes captured under the standard-user tokens and in VM-FINDINGS §4.
  assert.equal(
    classifyWindowsResultError({
      nativeErrorCode: "AccessDenied",
      statusCode: 2,
      category: "PermissionDenied",
      fqid: "HRESULT 0x80041003,Microsoft.Management.Infrastructure.CimCmdlets.GetCimInstanceCommand",
      message: "localized",
    }),
    "permission-denied",
  );
  assert.equal(
    classifyWindowsResultError({ nativeErrorCode: "InvalidClass", statusCode: 5 }),
    "not-present",
  );
  assert.equal(
    classifyWindowsResultError({ nativeErrorCode: "NoProperties", statusCode: 0 }),
    "not-present",
  );
  assert.equal(
    classifyWindowsResultError({ nativeErrorCode: "", statusCode: undefined }),
    "command-error",
  );
});

test("summarizeWindowsAccess detects the network-logon denial pattern", () => {
  const platform = parseWindowsEnvelope(
    readFixture("arm64/vm-parallels-std-network/windows-cim-platform.stdout"),
  );
  assert.equal(platform.meta.elevated, false);
  assert.deepEqual(summarizeWindowsAccess(platform), { allWmiDenied: true });

  const elevated = parseWindowsEnvelope(
    readFixture("arm64/vm-parallels-elevated/windows-cim-platform.stdout"),
  );
  assert.deepEqual(summarizeWindowsAccess(elevated), { allWmiDenied: false });

  // The selftest carries a readable registry result under a network logon;
  // only WMI results count toward the summary.
  const selftestNetwork = parseWindowsEnvelope(
    readFixture("arm64/vm-parallels-std-network/windows-cim-selftest.stdout"),
  );
  const shortCircuited = selftestNetwork.results.biosAgain;
  assert.equal(shortCircuited.ok, false);
  assert.equal(shortCircuited.shortCircuited, true);
  assert.equal(
    shortCircuited.error.nativeErrorCode,
    "AccessDenied",
  );
  assert.deepEqual(summarizeWindowsAccess(selftestNetwork), {
    allWmiDenied: true,
  });
});

test("the captured std-local selftest denies only the TPM namespace", () => {
  const selftest = parseWindowsEnvelope(
    readFixture("arm64/vm-parallels-std-local/windows-cim-selftest.stdout"),
  );
  assert.equal(selftest.results.bios.ok, true);
  assert.equal(selftest.results.tpm.ok, false);
  assert.equal(
    classifyWindowsResultError(selftest.results.tpm.error),
    "permission-denied",
  );
  assert.equal(
    selftest.results.tpm.error.nativeErrorCode,
    "AccessDenied",
  );
  assert.equal(selftest.results.missingRegistry.ok, false);
  assert.deepEqual(summarizeWindowsAccess(selftest), { allWmiDenied: false });
});

test("toWindowsResultDiagnostic maps errors and stays quiet when absent", () => {
  const selftest = parseWindowsEnvelope(
    readFixture("arm64/vm-parallels-std-local/windows-cim-selftest.stdout"),
  );
  const diagnostic = toWindowsResultDiagnostic(
    "windows-cim-selftest",
    "tpm",
    selftest.results.tpm.error,
  );
  assert.equal(diagnostic.id, "windows-cim-selftest:tpm");
  assert.equal(diagnostic.issue, "permission-denied");
  assert.match(diagnostic.privilegeHint, /never requests elevation on Windows/u);

  // Absent hardware never reaches the diagnostic list, and dry-run blocks
  // never produce diagnostics.
  assert.equal(
    toWindowsResultDiagnostic("windows-cim-selftest", "missingClass", {
      nativeErrorCode: "NotFound",
      statusCode: 6,
    }),
    undefined,
  );
  assert.equal(
    toWindowsResultDiagnostic("windows-cim-selftest", "bios", {
      issue: "dry-run",
    }),
    undefined,
  );

  assert.equal(
    WINDOWS_NETWORK_LOGON_HINT,
    "WMI denied for a network logon (SSH/WinRM) without administrator rights; run cdx-hbom from a local session or elevated",
  );
});
