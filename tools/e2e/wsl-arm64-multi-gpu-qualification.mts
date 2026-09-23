// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { detectGpuWithRuntimeProviderProofForProvider } from "../../src/lib/onboard/fatal-runtime-preflight.ts";
import { resolveSandboxGpuConfig } from "../../src/lib/onboard/sandbox-gpu-mode.ts";

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function nonemptyRows(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .filter(Boolean);
}

requireCondition(
  process.env.NEMOCLAW_WSL_ARM64_MULTI_GPU_QUALIFICATION === "1",
  "NEMOCLAW_WSL_ARM64_MULTI_GPU_QUALIFICATION=1 is required",
);
requireCondition(os.arch() === "arm64", `WSL ARM64 qualification requires arm64; got ${os.arch()}`);
requireCondition(
  process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP,
  "WSL environment evidence is missing",
);
requireCondition(fs.statSync("/dev/dxg").isCharacterDevice(), "/dev/dxg is not a character device");

const smiOutput = execFileSync(
  "nvidia-smi",
  ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
  { encoding: "utf8", timeout: 30_000 },
);
const hostRows = nonemptyRows(smiOutput);
requireCondition(hostRows.length >= 2, `expected at least two NVIDIA GPUs; got ${hostRows.length}`);

const gpu = detectGpuWithRuntimeProviderProofForProvider("docker");
requireCondition(gpu, "provider-owned GPU detection returned no GPU");
requireCondition(gpu.type === "nvidia", `expected NVIDIA GPU detection; got ${gpu.type}`);
requireCondition(
  gpu.count === hostRows.length,
  `provider proof detected ${gpu.count} GPUs but nvidia-smi reported ${hostRows.length}`,
);
requireCondition(gpu.gpus?.length === hostRows.length, "per-device GPU rows were not preserved");
requireCondition(
  gpu.containerGpuProof?.providerId === "docker" && gpu.containerGpuProof.passed,
  "Docker provider-owned CUDA proof did not pass",
);
requireCondition(gpu.totalMemoryMB > 0, "aggregate GPU capacity is missing");
requireCondition((gpu.availableMemoryMB ?? 0) > 0, "available GPU capacity is missing");

const sandboxGpu = resolveSandboxGpuConfig(gpu, { env: {} });
requireCondition(sandboxGpu.errors.length === 0, sandboxGpu.errors.join("; "));
requireCondition(sandboxGpu.sandboxGpuEnabled, "onboarding disabled sandbox GPU access");

const summary = {
  architecture: os.arch(),
  availableMemoryMB: gpu.availableMemoryMB,
  containerGpuProof: gpu.containerGpuProof,
  detectedGpuCount: gpu.count,
  sandboxGpuEnabled: sandboxGpu.sandboxGpuEnabled,
  totalMemoryMB: gpu.totalMemoryMB,
};
const artifactDirectory = process.env.E2E_ARTIFACT_DIR;
requireCondition(artifactDirectory, "E2E_ARTIFACT_DIR is required");
fs.mkdirSync(artifactDirectory, { recursive: true });
fs.writeFileSync(
  path.join(artifactDirectory, "qualification-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
process.stdout.write(`${JSON.stringify(summary)}\n`);
