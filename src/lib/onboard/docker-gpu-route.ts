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

/** Resolve the internal Docker-driver GPU strategy without exposing a new user contract. */
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

  if (dockerDesktopWsl) {
    if (control === "0") {
      const log = options.log ?? ((message: string) => console.warn(message));
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
  if (control === "0") return "native-only";
  if (control === "" || control === "auto") return "native-with-fallback";

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
