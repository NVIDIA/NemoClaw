// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  getManagedInferenceLifecycleDescriptor,
  getManagedInferenceMaterializerDescriptor,
  getManagedInferencePreparationDescriptor,
  getManagedInferenceRecipeRegistrationError,
  getManagedInferenceTopologyQualificationDescriptor,
  HOST_LOCAL_VLLM_LIFECYCLE_REF,
  HOST_LOCAL_VLLM_MATERIALIZER_REF,
  listManagedInferenceLifecycleDescriptors,
  listManagedInferenceMaterializerDescriptors,
  listManagedInferencePreparationDescriptors,
  listManagedInferenceTopologyQualificationDescriptors,
  MANAGED_CLUSTER_VLLM_LIFECYCLE_REF,
  MANAGED_CLUSTER_VLLM_MATERIALIZER_REF,
  NO_PREPARATION_REF,
  SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
} from "./adapter-registry.js";
import { loadManagedInferenceCatalog } from "./catalog-loader.js";
import { fixtureManagedClusterSelection } from "./managed-cluster-fixture.test-support.js";
import {
  MANAGED_CLUSTER_TOPOLOGY_ID,
  MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION,
} from "./managed-cluster-topology.js";
import type { ManagedInferenceServingRecipe } from "./types.js";

const LIGHTNING_RECIPE_ID = "vllm.nemotron-3.5-lightning-30b-a3b-nvfp4.spark-single.v1";

function shippedRecipe(): ManagedInferenceServingRecipe {
  const recipe = loadManagedInferenceCatalog().recipes.find(
    ({ spec }) => spec.execution.materializerRef === MANAGED_CLUSTER_VLLM_MATERIALIZER_REF,
  );
  expect(recipe).toBeDefined();
  return structuredClone(recipe as ManagedInferenceServingRecipe);
}

function shippedLightningRecipe(): ManagedInferenceServingRecipe {
  const recipe = loadManagedInferenceCatalog().recipes.find(
    ({ metadata }) => metadata.id === LIGHTNING_RECIPE_ID,
  );
  expect(recipe).toBeDefined();
  return structuredClone(recipe as ManagedInferenceServingRecipe);
}

describe("managed inference adapter registries", () => {
  it("registers one versioned descriptor for each shipped managed cluster mechanic", () => {
    expect(listManagedInferenceTopologyQualificationDescriptors()).toMatchObject([
      {
        id: MANAGED_CLUSTER_TOPOLOGY_ID,
        schemaVersion: MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION,
        bindingOutput: "topology",
      },
    ]);
    expect(listManagedInferenceMaterializerDescriptors()).toMatchObject([
      { ref: MANAGED_CLUSTER_VLLM_MATERIALIZER_REF, backend: "vllm" },
      { ref: HOST_LOCAL_VLLM_MATERIALIZER_REF, backend: "vllm" },
    ]);
    expect(listManagedInferenceLifecycleDescriptors()).toMatchObject([
      { ref: MANAGED_CLUSTER_VLLM_LIFECYCLE_REF, backend: "vllm" },
      { ref: HOST_LOCAL_VLLM_LIFECYCLE_REF, backend: "vllm" },
    ]);
    expect(listManagedInferencePreparationDescriptors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: NO_PREPARATION_REF, backend: "vllm" }),
        expect.objectContaining({
          ref: SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
          backend: "vllm",
        }),
      ]),
    );
  });

  it("looks up mechanics only by their stable registry references", () => {
    expect(
      getManagedInferenceTopologyQualificationDescriptor(
        MANAGED_CLUSTER_TOPOLOGY_ID,
        MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION,
      ),
    ).toBeDefined();
    expect(
      getManagedInferenceTopologyQualificationDescriptor("unknown.topology", 1),
    ).toBeUndefined();
    expect(
      getManagedInferenceMaterializerDescriptor(MANAGED_CLUSTER_VLLM_MATERIALIZER_REF),
    ).toBeDefined();
    expect(
      getManagedInferenceMaterializerDescriptor(HOST_LOCAL_VLLM_MATERIALIZER_REF),
    ).toBeDefined();
    expect(getManagedInferenceMaterializerDescriptor("unknown.materializer/v1")).toBeUndefined();
    expect(
      getManagedInferenceLifecycleDescriptor(MANAGED_CLUSTER_VLLM_LIFECYCLE_REF),
    ).toBeDefined();
    expect(getManagedInferenceLifecycleDescriptor(HOST_LOCAL_VLLM_LIFECYCLE_REF)).toBeDefined();
    expect(getManagedInferenceLifecycleDescriptor("unknown.lifecycle/v1")).toBeUndefined();
    expect(
      getManagedInferencePreparationDescriptor(
        SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
      ),
    ).toBeDefined();
    expect(getManagedInferencePreparationDescriptor(NO_PREPARATION_REF)).toBeDefined();
    expect(getManagedInferencePreparationDescriptor("unknown.preparation/v1")).toBeUndefined();
  });

  it("validates the current recipe by adapter shape without pinning its profile or model identity", () => {
    const recipe = shippedRecipe();
    const changedIdentity = {
      ...recipe,
      metadata: { ...recipe.metadata, id: "vllm.synthetic.second-recipe" },
      spec: {
        ...recipe.spec,
        model: {
          ...recipe.spec.model,
          id: "example/AnotherModel",
          revision: "b".repeat(40),
          servedName: "another-model",
        },
        runtime: {
          ...recipe.spec.runtime,
          image: `registry.example/vllm@sha256:${"c".repeat(64)}`,
        },
        readiness: { ...recipe.spec.readiness, expectedModel: "another-model" },
      },
    } as ManagedInferenceServingRecipe;

    expect(getManagedInferenceRecipeRegistrationError(recipe)).toBeUndefined();
    expect(getManagedInferenceRecipeRegistrationError(changedIdentity)).toBeUndefined();
  });

  it("rejects an unregistered or incompatible recipe mechanic", () => {
    const recipe = shippedRecipe();
    const unregistered = {
      ...recipe,
      spec: {
        ...recipe.spec,
        execution: { ...recipe.spec.execution, materializerRef: "vllm.unknown/v1" },
      },
    } as ManagedInferenceServingRecipe;
    const wrongShape = {
      ...recipe,
      spec: {
        ...recipe.spec,
        execution: { ...recipe.spec.execution, nodeCount: 3 },
      },
    } as ManagedInferenceServingRecipe;

    expect(getManagedInferenceRecipeRegistrationError(unregistered)).toMatch(
      /unknown materializer/u,
    );
    expect(getManagedInferenceRecipeRegistrationError(wrongShape)).toMatch(/TP times PP/u);
  });

  it("accepts shell-quoted JSON values for host-local vLLM arguments", () => {
    const structuredArgument = shippedLightningRecipe();
    const unsafeArgument = {
      ...structuredArgument,
      spec: {
        ...structuredArgument.spec,
        serve: {
          ...structuredArgument.spec.serve,
          arguments: structuredArgument.spec.serve.arguments.map((argument) =>
            argument.name === "--speculative-config"
              ? { ...argument, value: '{"method":"mtp"};touch/tmp/unsafe' }
              : argument,
          ),
        },
      },
    } as ManagedInferenceServingRecipe;

    expect(getManagedInferenceRecipeRegistrationError(structuredArgument)).toBeUndefined();
    expect(getManagedInferenceRecipeRegistrationError(unsafeArgument)).toMatch(
      /bounded safe text/u,
    );
  });

  it("rejects structured host-local vLLM environment values", () => {
    const recipe = shippedLightningRecipe();
    const structuredEnvironment = {
      ...recipe,
      spec: {
        ...recipe.spec,
        runtime: {
          ...recipe.spec.runtime,
          environment: {
            ...recipe.spec.runtime.environment,
            VLLM_TEST_CONFIG: '{"enabled":true}',
          },
        },
      },
    } as ManagedInferenceServingRecipe;

    expect(getManagedInferenceRecipeRegistrationError(structuredEnvironment)).toMatch(
      /bounded safe text/u,
    );
  });

  it("rejects schema-valid values that the registered adapter cannot execute", () => {
    const recipe = shippedRecipe();
    const unsupportedCache = {
      ...recipe,
      spec: {
        ...recipe.spec,
        runtime: {
          ...recipe.spec.runtime,
          modelCache: { ...recipe.spec.runtime.modelCache, source: "synthetic-cache" },
        },
      },
    } as ManagedInferenceServingRecipe;
    const rendezvousCollision = {
      ...recipe,
      spec: {
        ...recipe.spec,
        serve: {
          ...recipe.spec.serve,
          arguments: recipe.spec.serve.arguments.map((argument) =>
            argument.name === "--port" ? { ...argument, value: 25_000 } : argument,
          ),
        },
      },
    } as ManagedInferenceServingRecipe;
    const mutableLaunchImage = {
      ...recipe,
      spec: {
        ...recipe.spec,
        model: { ...recipe.spec.model, installFastSafetensors: true },
      },
    } as ManagedInferenceServingRecipe;
    const redundantPath = {
      ...recipe,
      spec: {
        ...recipe.spec,
        runtime: {
          ...recipe.spec.runtime,
          modelCache: { ...recipe.spec.runtime.modelCache, target: "/models//cache" },
        },
      },
    } as ManagedInferenceServingRecipe;
    const shadowedCache = {
      ...recipe,
      spec: {
        ...recipe.spec,
        runtime: {
          ...recipe.spec.runtime,
          temporaryFilesystems: [
            ...recipe.spec.runtime.temporaryFilesystems,
            {
              target: "/cache",
              sizeBytes: 1_073_741_824,
              mode: "0700",
              options: ["rw", "nosuid", "nodev"],
            },
          ],
        },
      },
    } as ManagedInferenceServingRecipe;

    expect(getManagedInferenceRecipeRegistrationError(unsupportedCache)).toMatch(
      /Hugging Face cache source/u,
    );
    expect(getManagedInferenceRecipeRegistrationError(rendezvousCollision)).toMatch(
      /rendezvous port/u,
    );
    expect(getManagedInferenceRecipeRegistrationError(mutableLaunchImage)).toMatch(
      /cannot install fastsafetensors/u,
    );
    expect(getManagedInferenceRecipeRegistrationError(redundantPath)).toMatch(
      /normalized absolute/u,
    );
    expect(getManagedInferenceRecipeRegistrationError(shadowedCache)).toMatch(
      /cannot shadow the model cache/u,
    );
  });

  it("dispatches topology artifact validation through the registered descriptor", () => {
    const artifact = fixtureManagedClusterSelection().topologyQualification;
    const descriptor = getManagedInferenceTopologyQualificationDescriptor(
      artifact.id,
      artifact.schemaVersion,
    );
    expect(descriptor).toBeDefined();
    expect(descriptor!.validateArtifact(artifact, artifact.subjectNodeIds)).toBeUndefined();

    const changed = structuredClone(artifact);
    (changed as { outputDigest: string }).outputDigest = `sha256:${"f".repeat(64)}`;
    expect(descriptor!.validateArtifact(changed, artifact.subjectNodeIds)).toMatch(/digest/u);
  });

  it("keeps preparation inputs bounded without coupling them to a model ID", () => {
    const recipe = shippedRecipe();
    const preparation = (recipe.spec.model as unknown as { preparation: { ref: string } })
      .preparation;
    const descriptor = getManagedInferencePreparationDescriptor(preparation.ref);
    const differentModel = {
      ...recipe,
      spec: {
        ...recipe.spec,
        model: { ...recipe.spec.model, id: "example/AnotherModel" },
      },
    } as ManagedInferenceServingRecipe;
    const unsafePath = {
      ...recipe,
      spec: {
        ...recipe.spec,
        model: {
          ...recipe.spec.model,
          preparation: {
            ...(recipe.spec.model as unknown as { preparation: object }).preparation,
            snapshotCopy: {
              ...(
                recipe.spec.model as unknown as {
                  preparation: { snapshotCopy: object };
                }
              ).preparation.snapshotCopy,
              sourcePath: "../encoding.py",
            },
          },
        },
      },
    } as ManagedInferenceServingRecipe;

    expect(descriptor?.validateRecipe(differentModel)).toBeUndefined();
    expect(descriptor?.validateRecipe(unsafePath)).toMatch(/copy paths/u);
  });

  it("accepts only the exact no-op preparation shape", () => {
    const recipe = shippedRecipe();
    const descriptor = getManagedInferencePreparationDescriptor(NO_PREPARATION_REF);
    const noPreparation = {
      ...recipe,
      spec: {
        ...recipe.spec,
        model: { ...recipe.spec.model, preparation: { ref: NO_PREPARATION_REF } },
      },
    } as ManagedInferenceServingRecipe;
    const extraInput = {
      ...noPreparation,
      spec: {
        ...noPreparation.spec,
        model: {
          ...noPreparation.spec.model,
          preparation: { ref: NO_PREPARATION_REF, command: "true" },
        },
      },
    } as ManagedInferenceServingRecipe;

    expect(descriptor?.validateRecipe(noPreparation)).toBeUndefined();
    expect(descriptor?.validateRecipe(extraInput)).toMatch(/empty preparation/u);
  });
});
