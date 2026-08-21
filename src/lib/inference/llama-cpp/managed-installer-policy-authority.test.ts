// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { PolicyAuthorityRefusalError } from "../../adapters/openshell/policy-authority";
import { createDockerRuntimeProviderBundle } from "../../onboard/runtime-provider/docker";
import { dockerLlamaCppBindingSha256 } from "../../onboard/runtime-provider/docker-llama-cpp-operation";
import type {
  HostLocalInferenceOperation,
  HostLocalInferenceReceipt,
  HostLocalLlamaCppLifecycle,
} from "../../onboard/runtime-provider/host-local-inference";
import { isLlamaCppServingRecipe } from "../serving/adapter-registry";
import { loadManagedInferenceCatalog } from "../serving/catalog-loader";
import type { ResolvedLlamaCppInferenceSelection } from "../serving/types";
import { installManagedLlamaCpp, resumeManagedLlamaCppRuntime } from "./managed-installer";
import { engineHarness } from "./managed-installer.test-support";
import {
  loadManagedLlamaCppApiKey,
  managedLlamaCppStatePaths,
  reserveManagedLlamaCppOwner,
} from "./managed-state";

const temporaryHomes: string[] = [];

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function temporaryHome(): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-llama-")));
  temporaryHomes.push(home);
  return home;
}

function selection(): ResolvedLlamaCppInferenceSelection {
  const catalog = loadManagedInferenceCatalog();
  const recipe = catalog.recipes.find(
    ({ metadata }) => metadata.id === "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1",
  );
  const preset = catalog.presets.find(
    ({ metadata }) => metadata.id === "llama-cpp.dgx-spark-gb10.single.nemotron-3-nano-30b-a3b",
  );
  expect(recipe && isLlamaCppServingRecipe(recipe)).toBe(true);
  expect(preset).toBeDefined();
  return {
    outcome: "selected",
    selection: "explicit",
    catalogDigest: catalog.catalogDigest,
    presetDigest: catalog.sources.find(
      ({ kind, id }) => kind === "ServingPreset" && id === preset!.metadata.id,
    )!.digest,
    recipeDigest: catalog.sources.find(
      ({ kind, id }) => kind === "ServingRecipe" && id === recipe!.metadata.id,
    )!.digest,
    preset: preset!,
    recipe: recipe as ResolvedLlamaCppInferenceSelection["recipe"],
  };
}

function verifiedArtifact(selected: ResolvedLlamaCppInferenceSelection, home: string) {
  const hostPath = path.join(home, "model.gguf");
  fs.writeFileSync(hostPath, "fixture", { mode: 0o600 });
  const identity = fs.lstatSync(hostPath, { bigint: true });
  return {
    digest: selected.recipe.spec.model.files[0]!.digest,
    filesystemIdentity: {
      ctimeNs: identity.ctimeNs,
      dev: identity.dev,
      ino: identity.ino,
      mtimeNs: identity.mtimeNs,
      size: identity.size,
    },
    hostPath,
    sizeBytes: selected.recipe.spec.model.files[0]!.sizeBytes,
  };
}

function runtimeProvider(
  engine: HostLocalInferenceOperation["engine"],
  lifecycle: HostLocalLlamaCppLifecycle,
) {
  const bundle = createDockerRuntimeProviderBundle();
  return {
    ...bundle,
    hostLocalInference: {
      providerId: "docker",
      supported: true as const,
      services: ["llama-cpp" as const],
      createOperation: () => ({
        providerId: "docker",
        engine,
        bindingSha256: dockerLlamaCppBindingSha256(engine),
        assertAuthority: vi.fn(),
        spawn: vi.fn(() => ({}) as never),
        createLlamaCppLifecycle: () => lifecycle,
      }),
    },
  };
}

function lifecycle() {
  const receipt = { schemaVersion: 1 } as HostLocalInferenceReceipt;
  return {
    recoverUnfinished: vi.fn(() => ({ recovered: [], failures: [] })),
    resume: vi.fn(() => receipt),
    runtime: {} as HostLocalLlamaCppLifecycle["runtime"],
    start: vi.fn(() => receipt),
  } satisfies HostLocalLlamaCppLifecycle;
}

describe("managed llama.cpp policy authority", () => {
  it("propagates a typed refusal after acquisition without credential or lifecycle mutation (#9833)", async () => {
    const selected = selection();
    const home = temporaryHome();
    const harness = engineHarness();
    harness.images.add(selected.recipe.spec.runtime.image);
    harness.images.add(selected.recipe.spec.readiness.probeImage);
    const managedLifecycle = lifecycle();

    await expect(
      installManagedLlamaCpp(selected, {
        sandboxName: "spark-agent",
        homeDir: home,
        runtimeProvider: runtimeProvider(harness.engine, managedLifecycle),
        verifyGguf: vi.fn(async () => verifiedArtifact(selected, home)),
        checkPort: vi.fn(async () => ({ ok: true })),
        log: vi.fn(),
        revalidatePolicyRequirements: () => {
          throw new PolicyAuthorityRefusalError(
            "External policy authority must supply the managed llama.cpp entry.",
          );
        },
      }),
    ).rejects.toBeInstanceOf(PolicyAuthorityRefusalError);

    const paths = managedLlamaCppStatePaths(home);
    expect(fs.existsSync(paths.ownerPath)).toBe(true);
    expect(loadManagedLlamaCppApiKey(paths)).toBeNull();
    expect(managedLifecycle.recoverUnfinished).not.toHaveBeenCalled();
    expect(managedLifecycle.start).not.toHaveBeenCalled();
    expect(managedLifecycle.resume).not.toHaveBeenCalled();
  });

  it("rechecks after resume verification before lifecycle recovery or credentials (#9833)", async () => {
    const selected = selection();
    const home = temporaryHome();
    const paths = managedLlamaCppStatePaths(home);
    reserveManagedLlamaCppOwner(paths, {
      schemaVersion: 1,
      sandboxName: "spark-agent",
      catalogDigest: selected.catalogDigest,
      presetDigest: selected.presetDigest,
      recipeDigest: selected.recipeDigest,
      recipeId: selected.recipe.metadata.id,
    });
    const harness = engineHarness();
    harness.images.add(selected.recipe.spec.runtime.image);
    harness.images.add(selected.recipe.spec.readiness.probeImage);
    const managedLifecycle = lifecycle();

    await expect(
      resumeManagedLlamaCppRuntime("spark-agent", {
        homeDir: home,
        runtimeProvider: runtimeProvider(harness.engine, managedLifecycle),
        verifyGguf: vi.fn(async () => verifiedArtifact(selected, home)),
        checkPort: vi.fn(async () => ({ ok: true })),
        revalidatePolicyRequirements: () => {
          throw new PolicyAuthorityRefusalError(
            "External policy authority must supply the managed llama.cpp entry.",
          );
        },
      }),
    ).rejects.toBeInstanceOf(PolicyAuthorityRefusalError);

    expect(loadManagedLlamaCppApiKey(paths)).toBeNull();
    expect(managedLifecycle.recoverUnfinished).not.toHaveBeenCalled();
    expect(managedLifecycle.start).not.toHaveBeenCalled();
    expect(managedLifecycle.resume).not.toHaveBeenCalled();
  });
});
