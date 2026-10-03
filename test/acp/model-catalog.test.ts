import assert from "node:assert/strict";
import test from "node:test";
import { fallbackModelOptions, nativeModelOptions, optionIds } from "../../src/acp/model-catalog.ts";

test("native ACP model selectors preserve IDs, labels, descriptions, and current value", () => {
  const models = nativeModelOptions([
    { type: "select", id: "effort", category: "mode", currentValue: "high", options: [{ value: "high", name: "High" }] },
    {
      type: "select", id: "amp-mode", category: "model", currentValue: "medium", name: "Amp Mode",
      description: "Select the Amp agent mode.",
      options: [
        { value: "low", name: "Low", description: "Cheap" },
        { group: "plugin", name: "Plugin modes", options: [{ value: "deep", name: "Deep", description: "Plugin" }] },
      ],
    },
  ]);
  assert.deepEqual(models, {
    configId: "amp-mode",
    current: "medium",
    options: [
      { id: "low", name: "Low", description: "Cheap" },
      { id: "deep", name: "Deep", description: "Plugin" },
    ],
  });
  assert.deepEqual(optionIds(models!.options), ["low", "deep"]);
});

test("fallback catalogs cover the three built-in slashless ACP agents", () => {
  for (const agent of ["claude", "codex", "amp"]) {
    const options = fallbackModelOptions(agent);
    assert.ok(options.length > 0, agent);
    assert.equal(new Set(options.map((option) => option.id)).size, options.length);
  }
  assert.equal(fallbackModelOptions("unknown").length, 0);
});
