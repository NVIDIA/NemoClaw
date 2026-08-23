// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import type { HostLocalInferenceServingRecipe } from "./types.js";

const MATERIALIZER_OWNED_ARGUMENTS = new Set([
  "--host",
  "--port",
  "--revision",
  "--served-model-name",
  "--max-model-len",
  "--tensor-parallel-size",
  "--pipeline-parallel-size",
  "--data-parallel-size",
]);

export function hostLocalVllmModelArguments(recipe: HostLocalInferenceServingRecipe): string[] {
  return recipe.spec.serve.arguments.flatMap(({ name, value }) => {
    if (MATERIALIZER_OWNED_ARGUMENTS.has(name)) return [];
    if (name === "--gpu-memory-utilization") {
      return [name, String(hostLocalVllmGpuMemoryUtilization(recipe))];
    }
    return value === undefined ? [name] : [name, String(value)];
  });
}

export function hostLocalVllmGpuMemoryUtilization(
  recipe: HostLocalInferenceServingRecipe,
): number {
  const matches = recipe.spec.serve.arguments.filter(
    (argument) => argument.name === "--gpu-memory-utilization",
  );
  if (matches.length > 1) {
    throw new Error(
      `Managed vLLM recipe ${recipe.metadata.id} has duplicate --gpu-memory-utilization arguments.`,
    );
  }
  const value = matches.length === 1 ? matches[0]!.value : undefined;
  const utilization =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^(?:0|1)(?:\.[0-9]+)?$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(utilization) || utilization <= 0 || utilization > 1) {
    throw new Error(
      `Managed vLLM recipe ${recipe.metadata.id} has no valid --gpu-memory-utilization.`,
    );
  }
  return utilization;
}

export function hostLocalVllmDockerRunArguments(recipe: HostLocalInferenceServingRecipe): string[] {
  const { devices, gpuRequest, ipcMode, sharedMemoryBytes, temporaryFilesystems, ulimits } =
    recipe.spec.runtime;
  const memlock = ulimits.memlock === "unlimited" ? -1 : ulimits.memlock;
  return [
    "--gpus",
    gpuRequest,
    "--ipc",
    ipcMode,
    "--mount",
    `type=bind,source=${path.join(os.homedir(), ".cache", "huggingface", "hub")},target=${recipe.spec.runtime.modelCache.target}/hub,readonly`,
    "--shm-size",
    `${String(sharedMemoryBytes)}b`,
    "--ulimit",
    `memlock=${String(memlock)}`,
    "--ulimit",
    `stack=${String(ulimits.stackBytes)}`,
    ...devices.flatMap((device) => ["--device", device]),
    ...temporaryFilesystems.flatMap(({ target, sizeBytes, mode, options }) => [
      "--tmpfs",
      `${target}:${[...options, `size=${String(sizeBytes)}`, `mode=${mode}`].join(",")}`,
    ]),
  ];
}
