// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import {
  compileManagedInferenceCatalogSources,
  type ManagedInferenceCatalogSource,
  writeManagedInferenceCatalog,
} from "../scripts/managed-inference/compile-catalog.mts";
import type {
  ManagedInferenceReadinessSource,
  ManagedInferenceServingPreset,
  ManagedInferenceServingRecipe,
  ResolvedManagedInferenceSelection,
} from "../src/lib/inference/serving/catalog-types.js";
import {
  FIXTURE_DUAL_SPARK_PRESET_ID,
  fixtureDualSparkSelection,
} from "../src/lib/inference/serving/dual-spark-fixture.test-support.js";
import { materializeDualSparkVllmPlan } from "../src/lib/inference/serving/dual-spark-materialize.js";
import type { DualSparkTopologyOutput } from "../src/lib/inference/serving/dual-spark-topology.js";
import { resolveManagedInferenceServing } from "../src/lib/inference/serving/resolver.js";
import type { SystemReadinessReport } from "../src/lib/readiness/types.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DIRECTORIES = ["managed-inference/presets", "managed-inference/recipes"] as const;
const FIXTURE_DUAL_SPARK_RECIPE_ID = fixtureDualSparkSelection().recipe.metadata.id;

function catalogSources(): ManagedInferenceCatalogSource[] {
  return SOURCE_DIRECTORIES.flatMap((directory) =>
    fs
      .readdirSync(path.join(REPOSITORY_ROOT, directory), {
        withFileTypes: true,
      })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map((entry) => {
        const sourcePath = `${directory}/${entry.name}`;
        return {
          path: sourcePath,
          contents: fs.readFileSync(path.join(REPOSITORY_ROOT, sourcePath), "utf8"),
        };
      }),
  );
}

function replaceDefinition<TDefinition>(
  sources: readonly ManagedInferenceCatalogSource[],
  kind: "ServingPreset" | "ServingRecipe",
  replace: (definition: TDefinition) => TDefinition,
): ManagedInferenceCatalogSource[] {
  const fixtureId =
    kind === "ServingPreset" ? FIXTURE_DUAL_SPARK_PRESET_ID : FIXTURE_DUAL_SPARK_RECIPE_ID;
  const replacementIndex = sources.findIndex((source) => {
    const definition = parse(source.contents) as {
      readonly kind?: unknown;
      readonly metadata?: { readonly id?: unknown };
    };
    return definition.kind === kind && definition.metadata?.id === fixtureId;
  });
  expect(replacementIndex).toBeGreaterThanOrEqual(0);
  return sources.map((source, index) =>
    index === replacementIndex
      ? {
          ...source,
          contents: stringify(replace(parse(source.contents) as TDefinition)),
        }
      : source,
  );
}

function syntheticProfileSources(
  sources: readonly ManagedInferenceCatalogSource[],
): ManagedInferenceCatalogSource[] {
  const compiled = compileManagedInferenceCatalogSources(sources).catalog;
  const sourcePreset = compiled.presets.find(
    ({ definition }) => definition.metadata.id === FIXTURE_DUAL_SPARK_PRESET_ID,
  )?.definition;
  expect(sourcePreset).toBeDefined();
  const presetTemplate = sourcePreset as ManagedInferenceServingPreset;
  const sourceRecipe = compiled.recipes.find(
    ({ definition }) => definition.metadata.id === presetTemplate.spec.plan.recipeRef,
  )?.definition;
  expect(sourceRecipe).toBeDefined();
  const recipeTemplate = sourceRecipe as ManagedInferenceServingRecipe;

  const recipe: ManagedInferenceServingRecipe = {
    ...recipeTemplate,
    metadata: {
      id: "vllm.synthetic-model.generic-topology.v1",
      displayName: "Synthetic model on a registered topology",
    },
    spec: {
      ...recipeTemplate.spec,
      model: {
        ...recipeTemplate.spec.model,
        id: "example/Synthetic-Model",
        revision: "1111111111111111111111111111111111111111",
        servedName: "synthetic-model",
        downloadSizeBytes: 12_345_678_901,
        preparation: { ref: "none/v1" },
      },
      runtime: {
        ...recipeTemplate.spec.runtime,
        image: `registry.example.test/vllm@sha256:${"2".repeat(64)}`,
        imageDownloadSizeBytes: 2_345_678_901,
        sharedMemoryBytes: 34_359_738_368,
        modelCache: {
          ...recipeTemplate.spec.runtime.modelCache,
          target: "/models/synthetic-cache",
        },
        temporaryFilesystems: recipeTemplate.spec.runtime.temporaryFilesystems.map((filesystem) =>
          filesystem.target === recipeTemplate.spec.runtime.modelCache.target
            ? { ...filesystem, target: "/models/synthetic-cache", sizeBytes: 8_589_934_592 }
            : filesystem,
        ),
        environment: {
          ...recipeTemplate.spec.runtime.environment,
          FLASHINFER_WORKSPACE_BASE: "/models/synthetic-cache/flashinfer",
          VLLM_CACHE_ROOT: "/models/synthetic-cache/vllm-cache",
          SYNTHETIC_PROFILE: "enabled",
        },
      },
      serve: {
        ...recipeTemplate.spec.serve,
        executable: "/opt/vllm/bin/vllm",
        arguments: recipeTemplate.spec.serve.arguments.map((argument) =>
          argument.name === "--port"
            ? { ...argument, value: 8_101 }
            : argument.name === "--max-model-len"
              ? { ...argument, value: 131_072 }
              : argument,
        ),
      },
      readiness: {
        ...recipeTemplate.spec.readiness,
        timeoutSeconds: 900,
        expectedModel: "synthetic-model",
      },
    },
  };
  const preset: ManagedInferenceServingPreset = {
    ...presetTemplate,
    metadata: {
      id: "vllm.synthetic-model.generic-topology",
      displayName: "Synthetic model on a registered topology",
    },
    spec: {
      ...presetTemplate.spec,
      priority: presetTemplate.spec.priority + 1,
      plan: { ...presetTemplate.spec.plan, recipeRef: recipe.metadata.id },
    },
  };
  return [
    ...sources,
    {
      path: "managed-inference/recipes/vllm.synthetic-model.generic-topology.v1.yaml",
      contents: stringify(recipe),
    },
    {
      path: "managed-inference/presets/vllm.synthetic-model.generic-topology.yaml",
      contents: stringify(preset),
    },
  ];
}

function matchingReadinessSources(
  preset: ManagedInferenceServingPreset,
): ManagedInferenceReadinessSource[] {
  const requirements = preset.spec.requirements.all.flatMap((requirement) =>
    "readiness" in requirement ? [requirement.readiness] : [],
  );
  const report: SystemReadinessReport = {
    schemaVersion: "1.1.0",
    mutated: false,
    provenance: {
      nemoclawVersion: "0.1.0",
      sourceRevision: "a".repeat(40),
      observedAt: "2026-08-03T12:00:00.000Z",
    },
    observations: requirements.flatMap((requirement) =>
      requirement.kind === "observation"
        ? [
            {
              id: requirement.id,
              state: requirement.state as SystemReadinessReport["observations"][number]["state"],
            },
          ]
        : [],
    ),
    capabilities: requirements.flatMap((requirement) =>
      requirement.kind === "capability"
        ? [
            {
              id: requirement.id,
              state: requirement.state as SystemReadinessReport["capabilities"][number]["state"],
            },
          ]
        : [],
    ),
    qualifications: requirements.flatMap((requirement) =>
      requirement.kind === "qualification"
        ? [
            {
              id: requirement.id,
              status:
                requirement.status as SystemReadinessReport["qualifications"][number]["status"],
            },
          ]
        : [],
    ),
    findings: [],
    evidence: [],
    status: "supported",
    exitCode: 0,
  };
  return ["spark-head", "spark-worker"].map((nodeId) => ({
    nodeId,
    report: structuredClone(report),
  }));
}

describe("managed inference catalog compiler", () => {
  it("produces an identical generated JSON document regardless of source enumeration order", () => {
    const sources = catalogSources();
    const compiled = compileManagedInferenceCatalogSources(sources);
    expect(compiled.document).toBe(
      compileManagedInferenceCatalogSources([...sources].reverse()).document,
    );
    expect(JSON.parse(compiled.document)).toEqual(compiled.catalog);
    expect(compiled.document.endsWith("\n")).toBe(true);
  });

  it("writes the JSON artifact and removes legacy generated TypeScript outputs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-catalog-compiler-"));
    const sources = catalogSources();
    const legacyPaths = [
      "src/lib/inference/serving/generated/catalog.ts",
      "dist/lib/inference/serving/generated/catalog.js",
      "dist/lib/inference/serving/generated/catalog.js.map",
      "dist/lib/inference/serving/generated/catalog.d.ts",
      "dist/lib/inference/serving/generated/catalog.d.ts.map",
    ];
    try {
      for (const source of sources) {
        const sourcePath = path.join(root, source.path);
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, source.contents, "utf8");
      }
      for (const legacyPath of legacyPaths) {
        const artifactPath = path.join(root, legacyPath);
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        fs.writeFileSync(artifactPath, "legacy generated artifact\n", "utf8");
      }

      const compiled = writeManagedInferenceCatalog(root);
      const documentPath = path.join(root, "src/lib/inference/serving/generated/catalog.json");
      expect(JSON.parse(fs.readFileSync(documentPath, "utf8"))).toEqual(compiled.catalog);
      expect(legacyPaths.every((legacyPath) => !fs.existsSync(path.join(root, legacyPath)))).toBe(
        true,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("compiles a synthetic second YAML-only profile without schema or TypeScript changes", () => {
    const sources = catalogSources();
    const base = compileManagedInferenceCatalogSources(sources).catalog;
    const compiled = compileManagedInferenceCatalogSources(syntheticProfileSources(sources));
    expect(compiled.catalog.presets).toHaveLength(base.presets.length + 1);
    expect(compiled.catalog.recipes).toHaveLength(base.recipes.length + 1);
    expect(compiled.catalog.presets.map(({ definition }) => definition.metadata.id)).toContain(
      "vllm.synthetic-model.generic-topology",
    );
    expect(compiled.catalog.recipes.map(({ definition }) => definition.metadata.id)).toContain(
      "vllm.synthetic-model.generic-topology.v1",
    );
    expect(compiled.document).toContain("vllm.synthetic-model.generic-topology");
    expect(compiled.document).toContain("vllm.synthetic-model.generic-topology.v1");
  });

  it("resolves and materializes the second YAML-only profile without profile-specific code", () => {
    const catalog = compileManagedInferenceCatalogSources(
      syntheticProfileSources(catalogSources()),
    ).catalog;
    const preset = catalog.presets.find(
      ({ definition }) => definition.metadata.id === "vllm.synthetic-model.generic-topology",
    )?.definition;
    expect(preset).toBeDefined();
    const topologyQualification = fixtureDualSparkSelection().topologyQualification;
    const resolution = resolveManagedInferenceServing(
      {
        readinessReports: matchingReadinessSources(preset as ManagedInferenceServingPreset),
        topologyQualifications: [topologyQualification],
        now: new Date("2026-08-03T12:00:10.000Z"),
      },
      catalog,
    );
    expect(resolution).toMatchObject({
      outcome: "selected",
      selection: "automatic",
      preset: { metadata: { id: "vllm.synthetic-model.generic-topology" } },
      recipe: { metadata: { id: "vllm.synthetic-model.generic-topology.v1" } },
    });
    const plan = materializeDualSparkVllmPlan(
      resolution as ResolvedManagedInferenceSelection<DualSparkTopologyOutput>,
      { catalog },
    );
    const revisionIndex = plan.roles.head.command.arguments.indexOf("--revision");

    expect(plan).toMatchObject({
      model: {
        id: "example/Synthetic-Model",
        revision: "1111111111111111111111111111111111111111",
        servedName: "synthetic-model",
      },
      apiPort: 8_101,
      readiness: { timeoutMs: 900_000, expectedModel: "synthetic-model" },
      roles: {
        head: {
          image: `registry.example.test/vllm@sha256:${"2".repeat(64)}`,
          runtime: {
            sharedMemoryBytes: 34_359_738_368,
            imageDownloadSizeBytes: 2_345_678_901,
            modelCache: { source: "huggingface-cache", target: "/models/synthetic-cache" },
          },
          preparation: {
            ref: "none/v1",
            modelDownloadSizeBytes: 12_345_678_901,
          },
          environment: {
            HF_HOME: "/models/synthetic-cache",
            SYNTHETIC_PROFILE: "enabled",
          },
          command: { executable: "/opt/vllm/bin/vllm" },
        },
      },
    });
    expect(revisionIndex).toBeGreaterThanOrEqual(0);
    expect(plan.roles.head.command.arguments[revisionIndex + 1]).toBe(
      "1111111111111111111111111111111111111111",
    );
    expect(plan.roles.head.command.arguments).toEqual(
      expect.arrayContaining(["--port", "8101", "--max-model-len", "131072"]),
    );
  });

  it("rejects duplicate definition IDs across YAML files", () => {
    const sources = catalogSources();
    const recipeSource = sources.find((source) => source.path.includes("/recipes/"));
    expect(recipeSource).toBeDefined();
    expect(() =>
      compileManagedInferenceCatalogSources([
        ...sources,
        {
          ...(recipeSource as ManagedInferenceCatalogSource),
          path: "managed-inference/recipes/duplicate.yaml",
        },
      ]),
    ).toThrow(/definition ID .* duplicated/u);
  });

  it("rejects an unknown recipe field", () => {
    const sources = replaceDefinition<ManagedInferenceServingRecipe>(
      catalogSources(),
      "ServingRecipe",
      (recipe) => ({
        ...recipe,
        spec: { ...recipe.spec, unsupportedField: true },
      }),
    );
    expect(() => compileManagedInferenceCatalogSources(sources)).toThrow(/additional properties/u);
  });

  it("rejects a mutable runtime image reference", () => {
    const sources = replaceDefinition<ManagedInferenceServingRecipe>(
      catalogSources(),
      "ServingRecipe",
      (recipe) => ({
        ...recipe,
        spec: {
          ...recipe.spec,
          runtime: {
            ...recipe.spec.runtime,
            image: "registry.example.test/runtime:latest",
          },
        },
      }),
    );
    expect(() => compileManagedInferenceCatalogSources(sources)).toThrow(/schema validation/u);
  });

  it("derives a new definition digest when YAML profile data changes", () => {
    const sources = catalogSources();
    const before = compileManagedInferenceCatalogSources(sources).catalog.recipes.find(
      ({ definition }) => definition.metadata.id === FIXTURE_DUAL_SPARK_RECIPE_ID,
    );
    const changed = replaceDefinition<ManagedInferenceServingRecipe>(
      sources,
      "ServingRecipe",
      (recipe) => ({
        ...recipe,
        spec: {
          ...recipe.spec,
          runtime: {
            ...recipe.spec.runtime,
            environment: {
              ...recipe.spec.runtime.environment,
              SYNTHETIC_SETTING: "enabled",
            },
          },
        },
      }),
    );
    const after = compileManagedInferenceCatalogSources(changed).catalog.recipes.find(
      ({ definition }) => definition.metadata.id === FIXTURE_DUAL_SPARK_RECIPE_ID,
    );
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after?.definitionDigest).not.toBe(before?.definitionDigest);
  });

  it.each([
    "--node-rank",
    "--headless",
    "--host",
    "--revision",
  ])("rejects materializer-owned serving argument %s", (argument) => {
    const sources = replaceDefinition<ManagedInferenceServingRecipe>(
      catalogSources(),
      "ServingRecipe",
      (recipe) => ({
        ...recipe,
        spec: {
          ...recipe.spec,
          serve: {
            ...recipe.spec.serve,
            arguments: [{ name: argument }, ...recipe.spec.serve.arguments],
          },
        },
      }),
    );
    expect(() => compileManagedInferenceCatalogSources(sources)).toThrow(
      new RegExp(`materializer-owned argument ${argument}`),
    );
  });

  it("rejects an unresolved preset recipe reference", () => {
    const sources = replaceDefinition<ManagedInferenceServingPreset>(
      catalogSources(),
      "ServingPreset",
      (preset) => ({
        ...preset,
        spec: {
          ...preset.spec,
          plan: { ...preset.spec.plan, recipeRef: "vllm.missing.recipe" },
        },
      }),
    );
    expect(() => compileManagedInferenceCatalogSources(sources)).toThrow(
      /references unknown recipe/u,
    );
  });

  it("rejects an unsupported selection fact even when it requests absence", () => {
    const sources = replaceDefinition<ManagedInferenceServingPreset>(
      catalogSources(),
      "ServingPreset",
      (preset) => ({
        ...preset,
        spec: {
          ...preset.spec,
          requirements: {
            all: [
              ...preset.spec.requirements.all,
              {
                fact: "cluster.unknown",
                state: "absent",
                operator: "equals",
                value: true,
              },
            ],
          },
        },
      }),
    );
    expect(() => compileManagedInferenceCatalogSources(sources)).toThrow(
      /unsupported selection fact/u,
    );
  });

  it("rejects a preset topology output not declared by the registered adapter", () => {
    const sources = replaceDefinition<ManagedInferenceServingPreset>(
      catalogSources(),
      "ServingPreset",
      (preset) => ({
        ...preset,
        spec: {
          ...preset.spec,
          plan: {
            ...preset.spec.plan,
            bindings: Object.fromEntries(
              Object.entries(preset.spec.plan.bindings).map(([name, binding]) => [
                name,
                {
                  valueFromTopologyQualification: {
                    ...binding.valueFromTopologyQualification,
                    output: "unsupported-output",
                  },
                },
              ]),
            ),
          },
        },
      }),
    );
    expect(() => compileManagedInferenceCatalogSources(sources)).toThrow(
      /binding .* does not match its recipe/u,
    );
  });

  it("rejects a recipe whose adapter reference is not registered", () => {
    const sources = replaceDefinition<ManagedInferenceServingRecipe>(
      catalogSources(),
      "ServingRecipe",
      (recipe) => ({
        ...recipe,
        spec: {
          ...recipe.spec,
          execution: {
            ...recipe.spec.execution,
            materializerRef: "vllm.missing-adapter/v1",
          },
        },
      }),
    );
    expect(() => compileManagedInferenceCatalogSources(sources)).toThrow(/unknown materializer/u);
  });
});
