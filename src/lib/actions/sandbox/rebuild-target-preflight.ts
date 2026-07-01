// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../agent/defs";
import { RD as _RD, R } from "../../cli/terminal-style";
import * as nim from "../../inference/nim";
import { hydrateMessagingChannelConfig } from "../../messaging-channel-config";
import { shouldManageDashboardForAgent } from "../../onboard/dashboard-runtime";
import { isLinuxDockerDriverGatewayEnabled } from "../../onboard/docker-driver-platform";
import { enforceDockerGpuPatchPreserveNetwork } from "../../onboard/docker-gpu-local-inference";
import { getStoredMessagingChannelConfig } from "../../onboard/messaging-config";
import { resolveSandboxGpuConfig } from "../../onboard/sandbox-gpu-mode";
import { agentSupportsWebSearch } from "../../onboard/web-search-support";
import { redact } from "../../security/redact";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import {
  preflightRebuildCredentials,
  type RebuildBail,
  type RebuildLog,
} from "./rebuild-credential-preflight";
import * as rebuildImagePreflight from "./rebuild-custom-image-preflight";
import {
  REBUILD_HERMES_DASHBOARD_ENV_KEYS,
  type RebuildDurableConfig,
  resolveRebuildDockerfile,
  resolveRebuildDurableConfig,
  resolveRebuildHermesDashboardEnv,
} from "./rebuild-durable-config";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import {
  buildRebuildRecreateOnboardOpts,
  type RebuildRecreateOnboardOpts,
} from "./rebuild-gpu-opt-out";
import { prepareRebuildResumeConfig, type RebuildResumeConfig } from "./rebuild-resume-config";

const onboardModule = require("../../onboard") as {
  ensureValidatedBraveSearchCredential: (nonInteractive?: boolean) => Promise<unknown>;
  preflightAuthoritativeRebuildTarget: (options: {
    authoritativeResumeConfig: true;
    model: string;
    provider: string;
    sandboxName: string;
    targetGatewayName: string;
    targetGatewayPort: number;
    controlUiPort: number | null;
    sandboxGpu: "enable" | "disable" | null;
    sandboxGpuDevice: string | null;
    noGpu?: true;
  }) => Promise<void>;
};
const hermesProviderAuth = require("../../hermes-provider-auth") as {
  HERMES_PROVIDER_NAME: string;
  HERMES_INFERENCE_CREDENTIAL_ENV: string;
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV: string;
};

export type RebuildTargetConfig = {
  resumeConfig: RebuildResumeConfig;
  sessionSnapshot: Session | null;
  sessionMatchesSandbox: boolean;
  durableConfig: RebuildDurableConfig;
  hermesToolGateways: string[];
  hasHermesToolGateways: boolean;
  credentialEnv: string | null;
  fromDockerfile: string | null;
  agentDefinition: ReturnType<typeof loadAgent> | null;
};

export function printRebuildPreflightFailure(
  summary: string,
  detail: string,
  bailMessage: string,
  bail: RebuildBail,
): void {
  console.error("");
  console.error(`  ${_RD}Rebuild preflight failed:${R} ${summary}`);
  console.error(`  ${detail}`);
  console.error("  Sandbox is untouched — no data was lost.");
  bail(bailMessage);
}

function stringListOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item: unknown): item is string => typeof item === "string");
}

function resolveRebuildHermesToolGateways(
  rebuildAgent: string | null,
  sb: RebuildSandboxEntry,
  session: Session | null,
  sessionMatchesSandbox: boolean,
): { gateways: string[]; recorded: boolean } {
  if (rebuildAgent !== "hermes") return { gateways: [], recorded: false };
  const registryGateways = stringListOrNull(sb.hermesToolGateways);
  const sessionGateways = sessionMatchesSandbox
    ? stringListOrNull(session?.hermesToolGateways)
    : null;
  return {
    gateways: registryGateways ?? sessionGateways ?? [],
    recorded: registryGateways !== null || sessionGateways !== null,
  };
}

function validateRebuildDurableConfig(
  durableConfig: RebuildDurableConfig,
  resumeConfig: RebuildResumeConfig,
  bail: RebuildBail,
): boolean {
  if (durableConfig.webSearchError) {
    printRebuildPreflightFailure(
      "recorded web-search state is invalid.",
      durableConfig.webSearchError,
      "Recorded web-search state is invalid",
      bail,
    );
    return false;
  }
  if (durableConfig.fromDockerfileError) {
    printRebuildPreflightFailure(
      "recorded custom Dockerfile is invalid.",
      durableConfig.fromDockerfileError,
      "Recorded custom Dockerfile is invalid",
      bail,
    );
    return false;
  }
  if (
    durableConfig.hermesAuthMethodError ||
    (resumeConfig.provider === hermesProviderAuth.HERMES_PROVIDER_NAME &&
      durableConfig.hermesAuthMethod === null)
  ) {
    printRebuildPreflightFailure(
      "Hermes auth state is incomplete.",
      durableConfig.hermesAuthMethodError ??
        "cannot determine the recorded Hermes Provider authentication method",
      "Cannot determine recorded Hermes Provider authentication method",
      bail,
    );
    return false;
  }
  return true;
}

export function prepareRebuildTargetConfig(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  rebuildAgent: string | null,
  log: (message: string) => void,
  bail: RebuildBail,
): RebuildTargetConfig | null {
  const resumeConfig = prepareRebuildResumeConfig(sandboxName, sb, rebuildAgent, log, bail);
  if (!resumeConfig) return null;
  const sessionSnapshot = onboardSession.loadSession();
  const sessionMatchesSandbox = sessionSnapshot?.sandboxName === sandboxName;
  const durableConfig = resolveRebuildDurableConfig(sandboxName, sb, sessionSnapshot, {
    provider: resumeConfig.provider,
    model: resumeConfig.model,
  });
  if (!validateRebuildDurableConfig(durableConfig, resumeConfig, bail)) return null;

  const dockerfile = resolveRebuildDockerfile(durableConfig.fromDockerfile);
  if (!dockerfile.ok) {
    printRebuildPreflightFailure(
      "recorded custom Dockerfile is unavailable.",
      `${dockerfile.path}: ${dockerfile.reason}`,
      "Recorded custom Dockerfile is unavailable",
      bail,
    );
    return null;
  }

  const hermesGateways = resolveRebuildHermesToolGateways(
    rebuildAgent,
    sb,
    sessionSnapshot,
    sessionMatchesSandbox,
  );
  const credentialEnv =
    resumeConfig.provider === hermesProviderAuth.HERMES_PROVIDER_NAME
      ? durableConfig.hermesAuthMethod === "api_key"
        ? hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV
        : hermesProviderAuth.HERMES_INFERENCE_CREDENTIAL_ENV
      : resumeConfig.credentialEnv;

  return {
    resumeConfig,
    sessionSnapshot,
    sessionMatchesSandbox,
    durableConfig,
    hermesToolGateways: hermesGateways.gateways,
    hasHermesToolGateways: hermesGateways.recorded,
    credentialEnv,
    fromDockerfile: dockerfile.path,
    agentDefinition: rebuildAgent && rebuildAgent !== "openclaw" ? loadAgent(rebuildAgent) : null,
  };
}

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
  log: (message: string) => void,
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

export function prepareRebuildRecreateOptions(
  sb: RebuildSandboxEntry,
  rebuildAgent: string | null,
  storedFromDockerfile: string | null,
  autoYes: boolean,
  bail: RebuildBail,
): RebuildRecreateOnboardOpts | null {
  try {
    return buildRebuildRecreateOnboardOpts({
      sb,
      rebuildAgent,
      storedFromDockerfile,
      autoYes,
      usageNoticeAccepted: true,
    });
  } catch (err) {
    printRebuildPreflightFailure(
      "the recorded recreate target is invalid.",
      err instanceof Error ? err.message : String(err),
      "Recorded recreate target is invalid",
      bail,
    );
    return null;
  }
}

export function stageRebuildHermesDashboardConfig(
  rebuildAgent: string | null,
  sb: RebuildSandboxEntry,
  controlUiPort: number | null,
  bail: RebuildBail,
): boolean {
  const resolved = resolveRebuildHermesDashboardEnv(rebuildAgent, sb, controlUiPort);
  if (!resolved.ok) {
    printRebuildPreflightFailure(
      "the recorded Hermes dashboard state is invalid.",
      resolved.reason,
      "Recorded Hermes dashboard state is invalid",
      bail,
    );
    return false;
  }
  for (const key of REBUILD_HERMES_DASHBOARD_ENV_KEYS) {
    const value = resolved.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return true;
}

export function hydrateMessagingConfigForRebuild(
  sandboxName: string,
  log: (msg: string) => void,
): void {
  const rebuildSession = onboardSession.loadSession();
  const hydratedMessagingConfig = hydrateMessagingChannelConfig(
    getStoredMessagingChannelConfig(sandboxName, rebuildSession),
  );
  if (hydratedMessagingConfig) {
    log(`Stashed messaging config for rebuild: ${Object.keys(hydratedMessagingConfig).join(",")}`);
  }
}
