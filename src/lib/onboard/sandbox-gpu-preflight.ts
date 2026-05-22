// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { findReadableNvidiaCdiSpecFiles, getDockerCdiSpecDirs } from "./docker-cdi";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

export function sandboxGpuRemediationLines(): string[] {
  return [
    "Install/configure NVIDIA Container Toolkit CDI, then restart Docker:",
    "  sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml",
    "  sudo systemctl restart docker",
    "Or force CPU sandbox behavior with NEMOCLAW_SANDBOX_GPU=0.",
  ];
}

export function exitOnSandboxGpuConfigErrors(config: SandboxGpuConfig): void {
  if (config.errors.length > 0) {
    console.error("");
    for (const error of config.errors) console.error(`  ✗ ${error}`);
    process.exit(1);
  }
}

export function validateSandboxGpuPreflight(config: SandboxGpuConfig): void {
  exitOnSandboxGpuConfigErrors(config);
  if (!config.sandboxGpuEnabled) return;
  if (process.platform !== "linux") return;

  const cdiSpecDirs = getDockerCdiSpecDirs();
  const cdiSpecFiles = findReadableNvidiaCdiSpecFiles(cdiSpecDirs);
  if (cdiSpecFiles.length === 0) {
    console.error("");
    console.error("  ✗ Docker CDI GPU support was not detected.");
    for (const line of sandboxGpuRemediationLines()) console.error(`    ${line}`);
    process.exit(1);
  }
  console.log(`  ✓ Docker CDI GPU support detected (${cdiSpecFiles.join(", ")})`);
}
