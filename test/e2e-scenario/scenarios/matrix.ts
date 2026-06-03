// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScenarioEnvironment } from "./types.ts";

export function ubuntuRepoDocker(onboarding: string): ScenarioEnvironment {
  return { platform: "ubuntu-local", install: "repo-current", runtime: "docker-running", onboarding };
}

export function gpuRepoDockerCdi(onboarding: string): ScenarioEnvironment {
  return { platform: "gpu-runner", install: "repo-current", runtime: "gpu-docker-cdi", onboarding };
}

export function macosRepoDocker(onboarding: string): ScenarioEnvironment {
  return { platform: "macos-local", install: "repo-current", runtime: "macos-docker-optional", onboarding };
}

export function wslRepoDocker(onboarding: string): ScenarioEnvironment {
  return { platform: "wsl-local", install: "repo-current", runtime: "docker-running", onboarding };
}

export function brevLaunchableRemote(onboarding: string): ScenarioEnvironment {
  return { platform: "brev-launchable", install: "launchable", runtime: "docker-running", onboarding };
}

export function ubuntuRepoNoDocker(onboarding: string): ScenarioEnvironment {
  return { platform: "ubuntu-local", install: "repo-current", runtime: "docker-missing", onboarding };
}
