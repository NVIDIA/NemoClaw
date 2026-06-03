// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerInfoFormat } from "../adapters/docker";
import { findReadableNvidiaCdiSpecFiles, getDockerCdiSpecDirs } from "./docker-cdi";
import type { SandboxGpuConfig, SandboxGpuFlag } from "./sandbox-gpu-mode";
import {
  detectWslDockerDesktopStatus,
  type WslDockerDesktopDetectionDeps,
  type WslDockerDesktopStatus,
  wslDockerDesktopGpuCompatibilityRemediationLines,
} from "./wsl-docker-desktop-gpu";

const SANDBOX_GPU_PREFLIGHT_TIMEOUT_MS = 30_000;

export type SandboxGpuPreflightDeps = WslDockerDesktopDetectionDeps & {
  getDockerCdiSpecDirs?: () => string[];
  findReadableNvidiaCdiSpecFiles?: (dirs: string[]) => string[];
};

export interface SandboxGpuFlagOptions {
  sandboxGpu?: SandboxGpuFlag;
  gpu?: boolean;
  noGpu?: boolean;
}

export function resolveSandboxGpuFlagFromOptions(opts: SandboxGpuFlagOptions): SandboxGpuFlag {
  const requestedGpuPassthrough = opts.gpu === true;
  const optedOutGpuPassthrough = opts.noGpu === true;
  const sandboxGpuFlag = opts.sandboxGpu ?? null;
  if (requestedGpuPassthrough && optedOutGpuPassthrough) {
    console.error("  --gpu and --no-gpu cannot both be set.");
    process.exit(1);
  }
  if (
    (requestedGpuPassthrough && sandboxGpuFlag === "disable") ||
    (optedOutGpuPassthrough && sandboxGpuFlag === "enable")
  ) {
    console.error("  --gpu/--no-gpu conflict with the sandbox GPU flags.");
    process.exit(1);
  }
  if (sandboxGpuFlag) return sandboxGpuFlag;
  if (requestedGpuPassthrough) return "enable";
  if (optedOutGpuPassthrough) return "disable";
  return null;
}

export function sandboxGpuRemediationLines(
  options: { wslDockerDesktop?: boolean; wslDockerDesktopStatus?: WslDockerDesktopStatus } = {},
): string[] {
  const status =
    options.wslDockerDesktopStatus ??
    (options.wslDockerDesktop ? "docker-desktop" : "not-docker-desktop");
  const wslRemediationLines = wslDockerDesktopGpuCompatibilityRemediationLines(status);
  if (wslRemediationLines) return wslRemediationLines;
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

export function formatSandboxGpuPassthroughNote(options: {
  hostGpuPlatform?: string | null;
  resumeHasResolvedGpuIntent?: boolean;
  recordedGpuPassthroughBeforePreflight?: boolean;
  requestedGpuPassthrough?: boolean;
  sandboxGpuMode?: string | null;
}): string {
  if (options.hostGpuPlatform === "jetson") {
    return "  NVIDIA Jetson/Tegra GPU detected; enabling sandbox GPU through Docker NVIDIA runtime. Use --no-gpu to opt out.";
  }
  if (options.resumeHasResolvedGpuIntent && options.recordedGpuPassthroughBeforePreflight) {
    return "  [resume] Continuing GPU passthrough from the saved onboarding session.";
  }
  if (options.requestedGpuPassthrough || options.sandboxGpuMode === "1") {
    return "  GPU passthrough requested; passing --gpu to OpenShell gateway and sandbox creation.";
  }
  return "  NVIDIA GPU detected; enabling OpenShell GPU passthrough. Use --no-gpu to opt out.";
}

export function parseDockerRuntimeNames(value: string | null | undefined): string[] {
  const raw = String(value || "").trim();
  if (!raw || raw === "<no value>") return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => String(entry || "").trim()).filter(Boolean);
    }
    if (parsed && typeof parsed === "object") {
      return Object.keys(parsed)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  } catch {
    // Fall through to the plain-text parser below.
  }
  return raw
    .split(/[\s,{}":]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function dockerNvidiaRuntimeAvailable(deps: SandboxGpuPreflightDeps = {}): boolean {
  const dockerInfo = deps.dockerInfoFormat ?? dockerInfoFormat;
  try {
    const runtimeOutput = dockerInfo("{{json .Runtimes}}", {
      ignoreError: true,
      timeout: SANDBOX_GPU_PREFLIGHT_TIMEOUT_MS,
    });
    return parseDockerRuntimeNames(runtimeOutput).includes("nvidia");
  } catch {
    return false;
  }
}

function validateJetsonSandboxGpuPreflight(deps: SandboxGpuPreflightDeps): void {
  if (!dockerNvidiaRuntimeAvailable(deps)) {
    console.error("");
    console.error("  ✗ Docker NVIDIA runtime was not detected for Jetson/Tegra sandbox GPU.");
    console.error("    Jetson sandbox GPU uses NVIDIA Container Runtime semantics, not CDI.");
    console.error("    Install/configure NVIDIA Container Toolkit for Docker, then restart Docker:");
    console.error("      sudo nvidia-ctk runtime configure --runtime=docker");
    console.error("      sudo systemctl restart docker");
    console.error("    Or force CPU sandbox behavior with NEMOCLAW_SANDBOX_GPU=0.");
    process.exit(1);
  }
  console.log("  ✓ Docker NVIDIA runtime detected for Jetson/Tegra sandbox GPU");
}

export interface DirectSandboxGpuVerifierDeps extends WslDockerDesktopDetectionDeps {
  runOpenshell(
    args: string[],
    opts?: Record<string, unknown>,
  ): { status?: number | null; stdout?: unknown; stderr?: unknown };
  buildDirectSandboxGpuProofCommands?: (sandboxName: string) => Array<{
    args: string[];
    label: string;
    optional?: boolean;
  }>;
  compactText(value: string): string;
  redact(value: unknown): string;
}

export function createDirectSandboxGpuVerifier(deps: DirectSandboxGpuVerifierDeps) {
  return function verifyDirectSandboxGpu(sandboxName: string): void {
    console.log("  Verifying direct sandbox GPU access...");
    const buildProofCommands =
      deps.buildDirectSandboxGpuProofCommands ??
      require("./initial-policy").buildDirectSandboxGpuProofCommands;
    for (const proof of buildProofCommands(sandboxName)) {
      const result = deps.runOpenshell(proof.args, {
        ignoreError: true,
        suppressOutput: true,
        timeout: 30_000,
      });
      if (result.status === 0) {
        console.log(`  ✓ GPU proof passed: ${proof.label}`);
        continue;
      }
      if (proof.optional === true) return;
      const diagnostic = deps.compactText(deps.redact(`${result.stderr || ""} ${result.stdout || ""}`));
      console.error(`  ✗ GPU proof failed: ${proof.label}`);
      if (diagnostic) console.error(`    ${diagnostic.slice(0, 300)}`);
      for (const line of sandboxGpuRemediationLines({
        wslDockerDesktopStatus: detectWslDockerDesktopStatus(deps),
      })) {
        console.error(`    ${line}`);
      }
      const statusText = String(result.status || 1);
      const diagnosticSuffix = diagnostic ? `: ${diagnostic.slice(0, 300)}` : "";
      throw new Error(`GPU proof failed: ${proof.label} (status ${statusText})${diagnosticSuffix}`);
    }
  };
}

export function validateSandboxGpuPreflight(
  config: SandboxGpuConfig,
  deps: SandboxGpuPreflightDeps = {},
): void {
  exitOnSandboxGpuConfigErrors(config);
  if (!config.sandboxGpuEnabled) return;
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return;

  if (config.hostGpuPlatform === "jetson") {
    validateJetsonSandboxGpuPreflight(deps);
    return;
  }

  const wslDockerDesktopStatus = detectWslDockerDesktopStatus(deps);
  if (wslDockerDesktopStatus === "docker-desktop") {
    console.log(
      "  Docker Desktop WSL detected; using Docker --gpus compatibility path instead of CDI spec validation.",
    );
    return;
  }

  const cdiSpecDirs = (deps.getDockerCdiSpecDirs ?? getDockerCdiSpecDirs)();
  const cdiSpecFiles = (deps.findReadableNvidiaCdiSpecFiles ?? findReadableNvidiaCdiSpecFiles)(
    cdiSpecDirs,
  );
  if (cdiSpecFiles.length === 0) {
    console.error("");
    console.error("  ✗ Docker CDI GPU support was not detected.");
    for (const line of sandboxGpuRemediationLines({
      wslDockerDesktopStatus,
    })) {
      console.error(`    ${line}`);
    }
    process.exit(1);
  }
  console.log(`  ✓ Docker CDI GPU support detected (${cdiSpecFiles.join(", ")})`);
}
