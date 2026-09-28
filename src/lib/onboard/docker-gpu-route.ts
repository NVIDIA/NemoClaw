// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type DockerGpuRoutePlan =
  | "none"
  | "native-only"
  | "compatibility-only"
  | "native-with-fallback";

export type SelectedDockerGpuRoute = "none" | "native" | "compatibility";

export type DockerGpuRouteConfig = {
  sandboxGpuEnabled: boolean;
  hostGpuPlatform?: string | null;
};

export type DockerGpuRouteOptions = {
  dockerDriverGateway: boolean;
  dockerDesktopWsl?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
};

const LEGACY_NONZERO_CONTROL_REMOVAL_VERSION = "v0.1.0";

/**
 * Legacy control boundary:
 * - invalidState: an undocumented nonzero value requests the old compatibility patch.
 * - sourceBoundary: operator and deployment automation set NEMOCLAW_DOCKER_GPU_PATCH.
 * - whyNotSourceFix: existing automation cannot be migrated atomically with this release.
 * - regressionTest: docker-gpu-route.test.ts covers legacy nonzero routing and its warning.
 * - removalCondition: remove legacy nonzero values in v0.1.0 as documented for operators.
 */
function warnForLegacyNonzeroControl(control: string, log: (message: string) => void): void {
  if (
    control === "" ||
    control === "0" ||
    control === "1" ||
    control === "auto" ||
    control === "fallback"
  )
    return;
  log(
    `  Warning: unrecognized NEMOCLAW_DOCKER_GPU_PATCH value '${control}'; preserving legacy compatibility-only behavior through v0.0.x. Other nonzero values will be removed in ${LEGACY_NONZERO_CONTROL_REMOVAL_VERSION}; use 0, 1, auto, or fallback.`,
  );
}

/**
 * SOURCE_OF_TRUTH_REVIEW (explicit ordinary-Linux GPU fallback; #6110):
 * invalidState: explicit fallback sees native rejection or trusted proof of no GPU attachment.
 * sourceBoundary: OpenShell `--gpu` plus structured Docker/NVIDIA evidence and proven cleanup.
 * whyNotSourceFix: supported stacks cannot upgrade atomically; WSL/Jetson still need compatibility.
 * regressionTest: sandbox-gpu-create-failure-classification.test.ts and
 * sandbox-gpu-fallback-orchestration.test.ts prove authorization, cleanup, and one retry.
 * removalCondition: native injection works on every supported host and compatibility is retired.
 *
 * Resolves the internal Docker-driver GPU strategy without exposing a new user contract.
 */
export function resolveDockerGpuRoutePlan(
  config: DockerGpuRouteConfig,
  options: DockerGpuRouteOptions,
): DockerGpuRoutePlan {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const dockerDesktopWsl = options.dockerDesktopWsl === true;
  if (!config.sandboxGpuEnabled) return "none";
  // The compatibility swap is specific to the Linux Docker driver. Other
  // OpenShell drivers keep their existing direct `--gpu` behavior.
  if (!options.dockerDriverGateway || (platform !== "linux" && !dockerDesktopWsl)) {
    return "native-only";
  }

  const control = String(env.NEMOCLAW_DOCKER_GPU_PATCH ?? "")
    .trim()
    .toLowerCase();
  const log = options.log ?? ((message: string) => console.warn(message));
  warnForLegacyNonzeroControl(control, log);

  if (dockerDesktopWsl) {
    if (control === "0") {
      log(
        "  NEMOCLAW_DOCKER_GPU_PATCH=0 ignored on Docker Desktop WSL: GPU passthrough on this runtime requires the compatibility path.",
      );
      log("  Skip GPU passthrough entirely with --no-gpu or NEMOCLAW_SANDBOX_GPU=0.");
    }
    return "compatibility-only";
  }

  if (config.hostGpuPlatform === "jetson") {
    return control === "0" ? "native-only" : "compatibility-only";
  }
  if (control === "fallback") return "native-with-fallback";
  if (control === "" || control === "auto" || control === "0") return "native-only";

  // Before native routing was introduced, every nonzero value enabled the
  // compatibility patch. Preserve that automation contract, including values
  // other than the documented "1".
  return "compatibility-only";
}

export function initialDockerGpuRoute(plan: DockerGpuRoutePlan): SelectedDockerGpuRoute {
  if (plan === "none") return "none";
  return plan === "compatibility-only" ? "compatibility" : "native";
}

export function supportsDockerGpuCompatibility(plan: DockerGpuRoutePlan): boolean {
  return plan === "compatibility-only" || plan === "native-with-fallback";
}

export function canFallbackToDockerGpuCompatibility(plan: DockerGpuRoutePlan): boolean {
  return plan === "native-with-fallback";
}

export function isDockerGpuCompatibilityRoute(route: SelectedDockerGpuRoute): boolean {
  return route === "compatibility";
}
