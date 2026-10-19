import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  WINDOWS_COMMANDS,
  WINDOWS_SELFTEST_COMMAND,
} from "../../src/windows/common/commands.js";

const FIXTURES_ROOT = fileURLToPath(
  new URL("../fixtures/windows", import.meta.url),
);

const SPECS_BY_ID = new Map(
  [...WINDOWS_COMMANDS, WINDOWS_SELFTEST_COMMAND].map((spec) => [spec.id, spec]),
);

/**
 * List committed fixture directories.
 *
 * @returns {string[]} Labels present under test/fixtures/windows.
 */
function fixtureLabels() {
  if (!existsSync(FIXTURES_ROOT)) {
    return [];
  }
  return readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((arch) =>
      readdirSync(join(FIXTURES_ROOT, arch.name), {
        withFileTypes: true,
      })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${arch.name}/${entry.name}`),
    );
}

test("Windows fixtures exist for all three capture tokens", () => {
  const labels = fixtureLabels();
  for (const expected of [
    "arm64/vm-parallels-elevated",
    "arm64/vm-parallels-std-local",
    "arm64/vm-parallels-std-network",
  ]) {
    assert.ok(
      labels.includes(expected),
      `missing fixture directory ${expected}; capture it with scripts/windows/capture-fixtures.mjs`,
    );
  }
});

test("fixture manifests match the current registry args (freshness)", () => {
  for (const label of fixtureLabels()) {
    const manifestPath = join(FIXTURES_ROOT, label, "manifest.json");
    assert.ok(existsSync(manifestPath), `${label} has a manifest.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    assert.ok(manifest.label, `${label} manifest carries the label`);
    assert.equal(
      manifest.provenance ?? "captured",
      "captured",
      `${label} is live-captured, not derived`,
    );

    for (const command of manifest.commands) {
      const spec = SPECS_BY_ID.get(command.id);
      assert.ok(
        spec,
        `${label} references unknown command ${command.id}; re-capture after registry changes`,
      );
      const expected = createHash("sha256")
        .update(JSON.stringify(spec.args))
        .digest("hex");
      assert.equal(
        command.argsSha256,
        expected,
        `${label}/${command.id}: args changed since capture; re-run scripts/windows/capture-fixtures.mjs and scripts/windows/redact-fixtures.mjs`,
      );
    }
  }
});

test("committed fixtures carry only redacted sensitive values", () => {
  const serialPattern = /REDACTED-SERIAL-\d+/u;
  const guidReplacement =
    /\{?00000000-0000-4000-8000-0000000000\d{2}\}?/iu;
  const rawGuid =
    /\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?/u;

  for (const label of fixtureLabels()) {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURES_ROOT, label, "manifest.json"), "utf8"),
    );
    assert.equal(
      existsSync(join(FIXTURES_ROOT, label, "literals.txt")),
      false,
      `${label} must not commit literals.txt`,
    );

    for (const command of manifest.commands) {
      const spec = SPECS_BY_ID.get(command.id);
      const text = readFileSync(
        join(FIXTURES_ROOT, label, `${command.id}.stdout`),
        "utf8",
      );
      const envelope = JSON.parse(text);

      for (const field of spec?.sensitiveFields ?? []) {
        const separator = field.indexOf(".");
        const result =
          envelope.results?.[field.slice(0, separator)] ?? {};
        const name = field.slice(separator + 1);
        const items = result.items ?? [];
        for (const item of items) {
          const value = item?.[name];
          for (const entry of Array.isArray(value) ? value : [value]) {
            if (typeof entry !== "string" || entry.trim().length === 0) {
              continue;
            }
            assert.ok(
              serialPattern.test(entry) ||
                guidReplacement.test(entry) ||
                /^redacted(:|$)/u.test(entry),
              `${label}/${command.id}: ${field} still carries a raw value (${entry.slice(0, 12)}...)`,
            );
            // A raw GUID in a sensitive field means redaction missed it.
            if (/uuid|guid/iu.test(field)) {
              assert.notMatch(
                entry.replace(guidReplacement, ""),
                rawGuid,
                `${label}/${command.id}: ${field} carries an unredacted GUID`,
              );
            }
          }
        }
      }

      // Every PnP instance segment in committed fixtures is redacted.
      for (const item of envelope.results?.pnpIds?.items ?? []) {
        const id = String(item?.PNPDeviceID ?? "");
        const instance = id.split("\\").at(-1);
        assert.match(
          instance,
          /^redacted/u,
          `${label}/${command.id}: raw PnP instance segment in ${id}`,
        );
      }
    }
  }
});
