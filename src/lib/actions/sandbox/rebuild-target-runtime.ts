// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as nim from "../../inference/nim";
import { shouldManageDashboardForAgent } from "../../onboard/dashboard-runtime";
import { isLinuxDockerDriverGatewayEnabled } from "../../onboard/docker-driver-platform";
import { enforceDockerGpuPatchPreserveNetwork } from "../../onboard/docker-gpu-local-inference";
import { resolveSandboxGpuConfig } from "../../onboard/sandbox-gpu-mode";
import { agentSupportsWebSearch } from "../../onboard/web-search-support";
import { redact } from "../../security/redact";
import {
  preflightRebuildCredentials,
  type RebuildBail,
  type RebuildLog,
} from "./rebuild-credential-preflight";
import * as rebuildImagePreflight from "./rebuild-custom-image-preflight";
import type { RebuildDurableConfig } from "./rebuild-durable-config";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";
import type { RebuildResumeConfig } from "./rebuild-resume-config";
import type { RebuildTargetConfig } from "./rebuild-target-config";

const onboardModule = require("../../onboard") as {
  ensureValidatedBraveSearchCredential: (nonInteractive?: boolean) => Promise<unknown>;
  preflightAuthoritativeRebuildTarget: (
    options: RebuildRecreateOnboardOpts & {
      model: string;
      provider: string;
      sandboxName: string;
    },
  ) => Promise<void>;
};

async function preflightRebuildBraveSearchCredential(
  durableConfig: RebuildDurableConfig,
  bail: RebuildBail,
): Promise<boolean> {
  if (!durableConfig.webSearchConfig) return true;
  try {
    const credential = await onboardModule.ensureValidatedBraveSearchCredential(true);
    if (typeof credential !== "string" || !credential.trim()) {
      throw new Error("Brave Search credential validation did not return a usable key.");
    }
    return true;
  } catch (err) {
    printRebuildPreflightFailure(
      "Brave Web Search credential is invalid.",
      err instanceof Error ? err.message : String(err),
      "Brave Web Search credential preflight failed",
      bail,
    );
    return false;
  }
}

export async function preflightRebuildTargetRuntime(
  target: RebuildTargetConfig,
  sb: RebuildSandboxEntry,
  recreateOptions: RebuildRecreateOnboardOpts,
  log: RebuildLog,
  bail: RebuildBail,
): Promise<boolean> {
  if (
    target.durableConfig.webSearchConfig &&
    !agentSupportsWebSearch(target.agentDefinition, target.fromDockerfile)
  ) {
    printRebuildPreflightFailure(
      "the recorded agent/image does not support Brave Web Search.",
      "Recreate with a supported image before enabling recorded web-search state.",
      "Recorded Brave Web Search is unsupported by the rebuild image",
      bail,
    );
    return false;
  }

  const managesDashboard = shouldManageDashboardForAgent(target.agentDefinition);
  const gpuEnv = { ...process.env };
  delete gpuEnv.NEMOCLAW_SANDBOX_GPU;
  delete gpuEnv.NEMOCLAW_SANDBOX_GPU_DEVICE;
  const sandboxGpuConfig = resolveSandboxGpuConfig(nim.detectGpu(), {
    flag: recreateOptions.sandboxGpu,
    device: recreateOptions.sandboxGpuDevice,
    env: gpuEnv,
  });
  if (sandboxGpuConfig.errors.length > 0) {
    printRebuildPreflightFailure(
      "the recorded sandbox GPU state cannot be recreated.",
      sandboxGpuConfig.errors.join(" "),
      "Recorded sandbox GPU state is invalid",
      bail,
    );
    return false;
  }
  try {
    await enforceDockerGpuPatchPreserveNetwork(target.resumeConfig.provider, sandboxGpuConfig, {
      dockerDriverGateway: isLinuxDockerDriverGatewayEnabled(),
      gatewayPort: recreateOptions.targetGatewayPort,
      log,
    });
  } catch (err) {
    printRebuildPreflightFailure(
      "the recorded GPU network path is not reachable.",
      err instanceof Error ? err.message : String(err),
      "Sandbox GPU network preflight failed",
      bail,
    );
    return false;
  }

  const customImage = await rebuildImagePreflight.preflightRebuildImage({
    agent: target.agentDefinition,
    fromDockerfile: target.fromDockerfile,
    model: target.resumeConfig.model,
    provider: target.resumeConfig.provider,
    preferredInferenceApi: target.resumeConfig.preferredInferenceApi,
    compatibleEndpointReasoning: target.resumeConfig.compatibleEndpointReasoning,
    webSearchConfig: target.durableConfig.webSearchConfig,
    hermesToolGateways: target.hermesToolGateways,
    sandboxGpuConfig,
    gatewayPort: recreateOptions.targetGatewayPort,
    chatUiUrl: managesDashboard ? `http://127.0.0.1:${String(recreateOptions.controlUiPort)}` : "",
  });
  if (!customImage.ok) {
    printRebuildPreflightFailure(
      "the replacement sandbox image did not build.",
      redact(customImage.detail),
      "Replacement sandbox image preflight failed",
      bail,
    );
    return false;
  }
  if (!(await preflightRebuildBraveSearchCredential(target.durableConfig, bail))) return false;

  // Credential preflight must use the same trusted selection. Legacy registry
  // rows may recover provider/model from their own matching onboard session;
  // checking the raw row first would miss that remote credential requirement.
  return preflightRebuildCredentials(
    {
      ...sb,
      provider: target.resumeConfig.provider,
      model: target.resumeConfig.model,
      credentialEnv: target.credentialEnv,
      hermesAuthMethod: target.durableConfig.hermesAuthMethod,
    },
    log,
    bail,
  );
}

export async function preflightAuthoritativeOnboardRuntime(
  sandboxName: string,
  resumeConfig: RebuildResumeConfig,
  recreateOptions: RebuildRecreateOnboardOpts,
  bail: RebuildBail,
): Promise<boolean> {
  try {
    await onboardModule.preflightAuthoritativeRebuildTarget({
      ...recreateOptions,
      model: resumeConfig.model,
      provider: resumeConfig.provider,
      sandboxName,
    });
    return true;
  } catch (err) {
    printRebuildPreflightFailure(
      "the replacement onboarding host/runtime checks did not pass.",
      err instanceof Error ? err.message : String(err),
      "Replacement onboarding preflight failed",
      bail,
    );
    return false;
  }
}
