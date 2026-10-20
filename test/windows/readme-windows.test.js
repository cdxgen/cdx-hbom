import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WINDOWS_MANIFESTS } from "../../src/windows/common/commands.js";

const README = fileURLToPath(new URL("../../README.md", import.meta.url));
const START = "<!-- windows-sources:start -->";
const END = "<!-- windows-sources:end -->";

/**
 * Render the README's Windows source list from the manifests, so the README
 * can never list a class the registry does not query or miss one it does.
 *
 * @returns {string} Markdown bullet list.
 */
function renderWindowsSources() {
  const lines = [];
  for (const manifest of WINDOWS_MANIFESTS) {
    if (manifest.commandId === "windows-cim-selftest") {
      continue;
    }
    const byNamespace = new Map();
    const other = [];
    for (const entry of manifest.entries) {
      if (entry.kind === "cim") {
        if (!byNamespace.has(entry.namespace)) {
          byNamespace.set(entry.namespace, []);
        }
        byNamespace.get(entry.namespace).push(`\`${entry.className}\``);
      } else if (entry.kind === "registry") {
        other.push(`registry \`${entry.path}\` (${entry.names.map((name) => `\`${name}\``).join(", ")})`);
      } else if (entry.kind === "registry-children") {
        other.push(`registry subkeys of \`${entry.path}\` (${entry.names.map((name) => `\`${name}\``).join(", ")})`);
      } else if (entry.kind === "pnp-properties") {
        other.push(`\`Get-PnpDevice -PresentOnly\` and \`Get-PnpDeviceProperty\` (${entry.keys.map((key) => `\`${key}\``).join(", ")})`);
      } else if (entry.kind === "cmdlet-scalar") {
        other.push(`cmdlet \`${entry.cmdlet}\``);
      }
    }
    const cim = [...byNamespace.entries()].map(([namespace, classes]) => `\`${namespace}\`: ${classes.join(", ")}`);
    lines.push(`- \`${manifest.commandId}\`: ${[...cim, ...other].join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}

test("the README Windows source list matches the command registry", () => {
  const readme = readFileSync(README, "utf8").replaceAll("\r\n", "\n");
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  assert.ok(start !== -1 && end > start, "README carries the windows-sources markers");
  const committed = readme.slice(start + START.length, end).replace(/^\n/u, "");
  assert.equal(
    committed,
    renderWindowsSources(),
    "README Windows source list drifted from the registry; replace the block between the markers with the expected text",
  );
});

test("the README lists the Windows targets and the Windows troubleshooting page", () => {
  const readme = readFileSync(README, "utf8").replaceAll("\r\n", "\n");
  assert.match(readme, /- `win32\/amd64`/u);
  assert.match(readme, /- `win32\/arm64`/u);
  assert.match(readme, /\(windows-troubleshooting\.md\)/u);
  assert.match(readme, /## Permissions/u);
});
