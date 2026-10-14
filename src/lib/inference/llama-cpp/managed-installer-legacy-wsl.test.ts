// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostLocalInferenceOperation } from "../../onboard/runtime-provider/host-local-inference";
import { createDockerRuntimeProviderBundle } from "../../onboard/runtime-provider/docker";
import { dockerLlamaCppBindingSha256 } from "../../onboard/runtime-provider/docker-llama-cpp-operation";
import { loadManagedInferenceCatalog } from "../serving/catalog-loader";
import {
  assertManagedLlamaCppResumeSupported,
  resolveManagedLlamaCppOwnerSelection,
  resumeManagedLlamaCppRuntime,
} from "./managed-installer";
import { engineHarness } from "./managed-installer.test-support";
import { managedLlamaCppStatePaths, reserveManagedLlamaCppOwner } from "./managed-state";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryHome(): string {
  const home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-llama-cpp-wsl-")),
  );
  temporaryDirectories.push(home);
  return home;
}

function managedRuntimeProvider(engine: HostLocalInferenceOperation["engine"]) {
  const bundle = createDockerRuntimeProviderBundle();
  return {
    ...bundle,
    hostLocalInference: {
      providerId: "docker" as const,
      supported: true as const,
      services: ["llama-cpp" as const],
      createOperation: vi.fn(() => ({
        providerId: "docker" as const,
        engine,
        bindingSha256: dockerLlamaCppBindingSha256(engine),
        assertAuthority: vi.fn(),
        spawn: vi.fn(() => ({}) as never),
        createLlamaCppLifecycle: vi.fn(() => {
          throw new Error("Unexpected managed llama.cpp lifecycle construction");
        }),
      })),
    },
  };
}

describe("former WSL managed llama.cpp recipe", () => {
  it("rehydrates the former WSL recipe without substituting the new image (#12285)", () => {
    const catalog = loadManagedInferenceCatalog();
    const preset = catalog.presets.find(
      ({ metadata }) => metadata.id === "llama-cpp.n1x-wsl-arm64.single.qwen3-6-35b-a3b",
    );
    expect(preset).toBeDefined();
    const owner = {
      schemaVersion: 1 as const,
      sandboxName: "existing-wsl",
      catalogDigest: `sha256:${"0".repeat(64)}`,
      presetDigest: catalog.sources.find(
        ({ kind, id }) => kind === "ServingPreset" && id === preset!.metadata.id,
      )!.digest,
      recipeDigest: "sha256:b1032bb63f7f0772ddc96576219269fe42a086814eca561d1b28d69394dc72e1",
      recipeId: "llama-cpp.qwen3-6-35b-a3b.n1x-wsl.v1",
    };
    const selected = resolveManagedLlamaCppOwnerSelection(owner);
    expect(selected.catalogDigest).toBe(owner.catalogDigest);
    expect(selected.recipeDigest).toBe(owner.recipeDigest);
    expect(selected.recipe.spec.runtime.image).toBe(
      "ghcr.io/nvidia/nemoclaw/llama-cpp-server@sha256:9d0cddd7bcaf98d3b75a7fc8c7ce3af3a9973b5f23a8092e7e93a9afc473a675",
    );
    expect(() => assertManagedLlamaCppResumeSupported(selected)).toThrow(
      "The former WSL managed llama.cpp image cannot resume",
    );
    expect(() =>
      resolveManagedLlamaCppOwnerSelection({
        ...owner,
        recipeDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("Managed llama.cpp recipe authority changed");
  });
  it("rejects former WSL image resume before Docker effects (#12285)", async () => {
    const homeDir = temporaryHome();
    const catalog = loadManagedInferenceCatalog();
    const preset = catalog.presets.find(
      ({ metadata }) => metadata.id === "llama-cpp.n1x-wsl-arm64.single.qwen3-6-35b-a3b",
    )!;
    reserveManagedLlamaCppOwner(managedLlamaCppStatePaths(homeDir), {
      schemaVersion: 1,
      sandboxName: "existing-wsl",
      catalogDigest: `sha256:${"0".repeat(64)}`,
      presetDigest: catalog.sources.find(
        ({ kind, id }) => kind === "ServingPreset" && id === preset.metadata.id,
      )!.digest,
      recipeDigest: "sha256:b1032bb63f7f0772ddc96576219269fe42a086814eca561d1b28d69394dc72e1",
      recipeId: "llama-cpp.qwen3-6-35b-a3b.n1x-wsl.v1",
    });
    const harness = engineHarness();
    await expect(
      resumeManagedLlamaCppRuntime("existing-wsl", {
        homeDir,
        runtimeProvider: managedRuntimeProvider(harness.engine),
      }),
    ).rejects.toThrow("The former WSL managed llama.cpp image cannot resume");
    expect(harness.capture).not.toHaveBeenCalled();
  });
});
