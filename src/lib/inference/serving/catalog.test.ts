// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import catalogSchema from "../../../../managed-inference/schemas/catalog.schema.json" with {
  type: "json",
};
import presetSchema from "../../../../managed-inference/schemas/preset.schema.json" with {
  type: "json",
};
import recipeSchema from "../../../../managed-inference/schemas/recipe.schema.json" with {
  type: "json",
};
import {
  compileTrustedServingCatalog,
  parseCompiledServingCatalogJson,
  serializeCompiledServingCatalog,
} from "./catalog";
import type {
  ServingCatalogRegistries,
  ServingCatalogSchemas,
  ServingCatalogSource,
} from "./types";

const SOURCE_REVISION = "a".repeat(40);
const IMAGE_DIGEST = "b".repeat(64);
const MODEL_REVISION = "c".repeat(40);
const SCHEMAS: ServingCatalogSchemas = {
  catalog: catalogSchema,
  preset: presetSchema,
  recipe: recipeSchema,
};
const REGISTRIES: ServingCatalogRegistries = {
  materializers: new Set(["test.materializer/v1"]),
  lifecycles: new Set(["test.lifecycle/v1"]),
  readiness: new Map([
    ["test.runtime.present", "capability"],
    ["test.runtime.other", "capability"],
  ]),
};

function recipeSource(
  id = "test.recipe.v1",
  overrides: { image?: string; execution?: string } = {},
): ServingCatalogSource {
  return {
    path: `managed-inference/recipes/test/${id}.yaml`,
    contents: `
apiVersion: nemoclaw.nvidia.com/managed-inference/v1
kind: ServingRecipe
metadata:
  id: ${id}
spec:
  backend: test
  model:
    id: test/model
    revision: ${MODEL_REVISION}
    servedName: test-model
    files:
      - path: model.gguf
        digest: sha256:${"d".repeat(64)}
  runtime:
    image: ${overrides.image ?? `registry.example/test/server@sha256:${IMAGE_DIGEST}`}
    architecture: amd64
  execution:
${overrides.execution ?? "    materializerRef: test.materializer/v1\n    lifecycleRef: test.lifecycle/v1"}
  serve:
    arguments:
      - name: --port
        value: 8081
  readiness:
    timeoutSeconds: 30
    expectedModel: test-model
`,
  };
}

function presetSource(
  id = "test.preset.auto",
  options: { priority?: number; recipeRef?: string; readinessId?: string } = {},
): ServingCatalogSource {
  return {
    path: `managed-inference/presets/test/${id}.yaml`,
    contents: `
apiVersion: nemoclaw.nvidia.com/managed-inference/v1
kind: ServingPreset
metadata:
  id: ${id}
spec:
  selection: automatic
  priority: ${options.priority ?? 100}
  requirements:
    all:
      - readiness:
          scope: everyNode
          kind: capability
          id: ${options.readinessId ?? "test.runtime.present"}
          state: present
  plan:
    backend: test
    recipeRef: ${options.recipeRef ?? "test.recipe.v1"}
`,
  };
}

function compile(sources: readonly ServingCatalogSource[], registries = REGISTRIES) {
  return compileTrustedServingCatalog({
    sources,
    sourceRevision: SOURCE_REVISION,
    schemas: SCHEMAS,
    registries,
  });
}

function requireValidationFailure(run: () => void, expectedMessage: string): void {
  expect(run).toThrow(expectedMessage);
}

describe("managed inference serving catalog compiler", () => {
  it("compiles managed-inference YAML to deterministic canonical JSON (#8144)", () => {
    const recipe = recipeSource();
    const preset = presetSource();

    const first = compile([recipe, preset]);
    const second = compile([preset, recipe]);

    expect(serializeCompiledServingCatalog(first)).toBe(serializeCompiledServingCatalog(second));
    expect(first.readinessSchemaRef).toBe(
      "https://github.com/NVIDIA/NemoClaw/schemas/system-readiness.schema.json",
    );
    expect(first.recipes.map((definition) => definition.metadata.id)).toEqual(["test.recipe.v1"]);
    expect(first.presets.map((definition) => definition.metadata.id)).toEqual(["test.preset.auto"]);
    expect(first.sources.map((source) => source.path)).toEqual([
      "managed-inference/presets/test/test.preset.auto.yaml",
      "managed-inference/recipes/test/test.recipe.v1.yaml",
    ]);
  });

  it("rejects duplicate definition IDs and dangling recipe references (#8144)", () => {
    const duplicate = {
      ...recipeSource(),
      path: "managed-inference/recipes/test/duplicate.yaml",
    };
    expect(() => compile([recipeSource(), duplicate])).toThrow("ID test.recipe.v1 is duplicated");
    expect(() =>
      compile([
        recipeSource(),
        presetSource("test.preset.missing", {
          recipeRef: "test.recipe.missing",
        }),
      ]),
    ).toThrow("references unknown recipe test.recipe.missing");
  });

  it("rejects executable fields and mutable artifact references (#8144)", () => {
    expect(() =>
      compile([
        recipeSource("test.recipe.shell", {
          execution:
            "    materializerRef: test.materializer/v1\n    lifecycleRef: test.lifecycle/v1\n    command: sh -c server",
        }),
      ]),
    ).toThrow("does not satisfy the ServingRecipe schema");
    expect(() =>
      compile([
        recipeSource("test.recipe.mutable", {
          image: "registry.example/test/server:latest",
        }),
      ]),
    ).toThrow("does not satisfy the ServingRecipe schema");
  });

  it("rejects adapter and readiness IDs outside the injected registries (#8144)", () => {
    expect(() =>
      compile([recipeSource()], {
        ...REGISTRIES,
        materializers: new Set(),
      }),
    ).toThrow("references unknown materializer test.materializer/v1");
    expect(() =>
      compile([
        recipeSource(),
        presetSource("test.preset.unknown", {
          readinessId: "test.readiness.unknown",
        }),
      ]),
    ).toThrow("references unknown readiness entity test.readiness.unknown");
  });

  it("rejects duplicate automatic selectors at one priority (#8144)", () => {
    expect(() =>
      compile([
        recipeSource(),
        presetSource(),
        presetSource("test.preset.other", { priority: 100 }),
      ]),
    ).toThrow("have the same selector at priority 100 for backend test");
  });

  it("accepts disjoint automatic selectors at one priority (#8144)", () => {
    const catalog = compile([
      recipeSource(),
      presetSource(),
      presetSource("test.preset.other", {
        priority: 100,
        readinessId: "test.runtime.other",
      }),
    ]);

    expect(catalog.presets.map((preset) => preset.metadata.id)).toEqual([
      "test.preset.auto",
      "test.preset.other",
    ]);
  });

  it("accepts only compiled JSON whose digest matches its content (#8144)", () => {
    const serialized = serializeCompiledServingCatalog(compile([recipeSource(), presetSource()]));
    const parsed = parseCompiledServingCatalogJson(serialized, SCHEMAS);
    const tampered = serialized.replace("test/model", "test/other-model");
    requireValidationFailure(
      () => parseCompiledServingCatalogJson(tampered, SCHEMAS),
      "digest mismatch",
    );
    requireValidationFailure(
      () => parseCompiledServingCatalogJson("apiVersion: v1", SCHEMAS),
      "is not valid JSON",
    );

    expect(parsed.catalogDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
