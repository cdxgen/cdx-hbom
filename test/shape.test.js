import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDependencyGraph,
  createHardwareComponent,
} from "../src/common/shape.js";

test("createHardwareComponent records the hardware class as a property", () => {
  const component = createHardwareComponent("cable", { name: "USB-C cable" });
  assert.equal(component.type, "device");
  assert.deepEqual(component.properties, [
    { name: "cdx:hbom:hardwareClass", value: "cable" },
  ]);
});

test("buildDependencyGraph merges edges that share a ref", () => {
  const graph = buildDependencyGraph([
    { ref: "port-1", dependsOn: ["cable-1"] },
    { ref: "port-1", dependsOn: ["charger-1"] },
  ]);
  const port = graph.find((entry) => entry.ref === "port-1");
  assert.deepEqual(port.dependsOn.sort(), ["cable-1", "charger-1"]);
});

test("buildDependencyGraph drops references to unknown components", () => {
  const graph = buildDependencyGraph(
    [{ ref: "port-1", dependsOn: ["cable-1", "ghost"] }],
    ["port-1", "cable-1"],
  );
  assert.deepEqual(graph, [{ ref: "port-1", dependsOn: ["cable-1"] }]);
});

test("buildDependencyGraph ignores edges for unknown refs and self-references", () => {
  const graph = buildDependencyGraph(
    [
      { ref: "ghost", dependsOn: ["cable-1"] },
      { ref: "port-1", dependsOn: ["port-1", "cable-1"] },
    ],
    ["port-1", "cable-1"],
  );
  assert.deepEqual(graph, [{ ref: "port-1", dependsOn: ["cable-1"] }]);
});
