// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
import { getCredential } from "../../credentials/store";
import * as nim from "../../inference/nim";
import {
  type WebSearchProvider,
  webSearchEnvFor,
  webSearchLabelFor,
  webSearchProviderForConfig,
} from "../../inference/web-search";
import { shouldManageDashboardForAgent } from "../../onboard/dashboard-runtime";
import { isLinuxDockerDriverGatewayEnabled } from "../../onboard/docker-driver-platform";
import { enforceDockerGpuPatchPreserveNetwork } from "../../onboard/docker-gpu-local-inference";
import { initialDockerGpuRoute, resolveDockerGpuRoutePlan } from "../../onboard/docker-gpu-route";
import { isDockerDesktopWslRuntime } from "../../onboard/docker-gpu-sandbox-create";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import {
  matchesGatewayCredentialOnlyProviderBinding,
  readGatewayProviderMetadata,
} from "../../onboard/gateway-provider-metadata";
import { resolveSandboxGpuConfig } from "../../onboard/sandbox-gpu-mode";
import { agentSupportsWebSearchProvider } from "../../onboard/web-search-support";
import { redact } from "../../security/redact";
import {
  preflightRebuildCredentials,
  type RebuildBail,
  type RebuildLog,
} from "./rebuild-credential-preflight";
import type { PreparedRebuildImage } from "./rebuild-custom-image-preflight";
import * as rebuildImagePreflight from "./rebuild-custom-image-preflight";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { rebuildOnboardDependencies } from "./rebuild-onboard-dependencies";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";
import { disposePreparedBuildContext } from "./rebuild-prepared-image-context";
import type { RebuildResumeConfig } from "./rebuild-resume-config";
import type { RebuildTargetConfig } from "./rebuild-target-config";

/**
 * Whether recreate can reuse the web-search credential already registered with
 * the sandbox's OpenShell gateway provider. `saveCredential` stages web-search
 * keys to the process env only — the gateway provider is the durable system of
 * record — so a fresh `rebuild` process can hold no host credential for a
 * sandbox whose web search works (#7097). Recreate reuses that gateway binding
 * for the OpenClaw agent (messaging-prep `requiresExactOpenClawProviderBinding`),
 * so the preflight accepts the same binding instead of demanding a host key
 * the recreate will never read. Agents that never reuse the binding, and any
 * run with a host key staged, keep the validation path.
 */
function canReuseGatewayWebSearchCredential(
  target: RebuildTargetConfig,
  sb: RebuildSandboxEntry,
  provider: WebSearchProvider,
  log: RebuildLog,
): boolean {
  if (target.agentDefinition) return false;
  const credentialEnv = webSearchEnvFor(provider);
  if (getCredential(credentialEnv)) return false;
  const providerName = `${sb.name}-${provider}-search`;
  const matches = matchesGatewayCredentialOnlyProviderBinding(
    readGatewayProviderMetadata(providerName, runOpenshell, resolveSandboxGatewayName(sb)),
    { name: providerName, type: provider, credentialKey: credentialEnv },
  );
  if (matches) {
    log(
      `Web search preflight: reusing the ${provider} credential registered with gateway provider '${providerName}'; no host ${credentialEnv} is required`,
    );
  }
  return matches;
}

async function preflightRebuildWebSearchCredential(
  target: RebuildTargetConfig,
  sb: RebuildSandboxEntry,
  log: RebuildLog,
  bail: RebuildBail,
): Promise<boolean> {
  const config = target.durableConfig.webSearchConfig;
  if (!config) return true;
  const provider = webSearchProviderForConfig(config);
  const label = webSearchLabelFor(provider);
  if (canReuseGatewayWebSearchCredential(target, sb, provider, log)) return true;
  try {
    const credential = await rebuildOnboardDependencies.ensureValidatedWebSearchCredential(
      config,
      true,
    );
    if (typeof credential !== "string" || !credential.trim()) {
      throw new Error(`${label} credential validation did not return a usable key.`);
    }
    return true;
  } catch (err) {
    printRebuildPreflightFailure(
      `${label} credential is invalid.`,
      err instanceof Error ? err.message : String(err),
      `${label} credential preflight failed`,
      bail,
    );
    return false;
  }
}

export type RebuildTargetRuntimePreflightResult =
  | {
      ok: true;
      preparedImage: PreparedRebuildImage | null;
      requiresGatewayProviderReconfigure: boolean;
    }
  | { ok: false };

export async function preflightRebuildTargetRuntime(
  target: RebuildTargetConfig,
  sb: RebuildSandboxEntry,
  recreateOptions: RebuildRecreateOnboardOpts,
  log: RebuildLog,
  bail: RebuildBail,
  options: {
    allowMissingGatewayProviderWithHostCredential?: boolean;
    skipImagePreflight?: boolean;
  } = {},
): Promise<RebuildTargetRuntimePreflightResult> {
  const webSearchConfig = target.durableConfig.webSearchConfig;
  const webSearchProvider = webSearchConfig ? webSearchProviderForConfig(webSearchConfig) : null;
  if (
    webSearchProvider &&
    !agentSupportsWebSearchProvider(
      target.agentDefinition,
      webSearchProvider,
      target.fromDockerfile,
    )
  ) {
    const label = webSearchLabelFor(webSearchProvider);
    printRebuildPreflightFailure(
      `the recorded agent/image does not support ${label}.`,
      "Recreate with a supported image before enabling recorded web-search state.",
      `Recorded ${label} is unsupported by the rebuild image`,
      bail,
    );
    return { ok: false };
  }
  if (webSearchProvider) {
    const credentialEnv = webSearchEnvFor(webSearchProvider);
    const collidingBridge = Object.values(sb.mcp?.bridges ?? {}).find((entry) =>
      entry.env.includes(credentialEnv),
    );
    if (collidingBridge) {
      printRebuildPreflightFailure(
        `the recorded ${webSearchLabelFor(webSearchProvider)} credential is also owned by MCP server '${collidingBridge.server}'.`,
        `Use a distinct credential name; ${credentialEnv} cannot be shared across managed providers.`,
        "Web Search and MCP credential ownership conflict",
        bail,
      );
      return { ok: false };
    }
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
    return { ok: false };
  }
  try {
    const dockerDriverGateway = isLinuxDockerDriverGatewayEnabled();
    const selectedRoute = initialDockerGpuRoute(
      resolveDockerGpuRoutePlan(sandboxGpuConfig, {
        dockerDriverGateway,
        dockerDesktopWsl: isDockerDesktopWslRuntime(),
      }),
    );
    await enforceDockerGpuPatchPreserveNetwork(target.resumeConfig.provider, sandboxGpuConfig, {
      dockerDriverGateway,
      selectedRoute,
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
    return { ok: false };
  }

  let preparedImage: PreparedRebuildImage | null = null;
  let requiresGatewayProviderReconfigure = false;
  if (!options.skipImagePreflight) {
    const customImage = await rebuildImagePreflight.preflightRebuildImage({
      agent: target.agentDefinition,
      fromDockerfile: target.fromDockerfile,
      model: target.resumeConfig.model,
      provider: target.resumeConfig.provider,
      preferredInferenceApi: target.resumeConfig.preferredInferenceApi,
      compatibleEndpointReasoning: target.resumeConfig.compatibleEndpointReasoning,
      webSearchConfig: target.durableConfig.webSearchConfig,
      toolDisclosure: target.durableConfig.toolDisclosure,
      hermesToolGateways: target.hermesToolGateways,
      sandboxGpuConfig,
      preResolvedBaseImageMetadata: recreateOptions.preResolvedBaseImageMetadata ?? null,
      gatewayPort: recreateOptions.targetGatewayPort,
      chatUiUrl: managesDashboard
        ? `http://127.0.0.1:${String(recreateOptions.controlUiPort)}`
        : "",
    });
    if (!customImage.ok) {
      printRebuildPreflightFailure(
        "the replacement sandbox image did not build.",
        redact(customImage.detail),
        "Replacement sandbox image preflight failed",
        bail,
      );
      return { ok: false };
    }
    preparedImage = customImage.prepared;
  }
  try {
    if (!(await preflightRebuildWebSearchCredential(target, sb, log, bail))) {
      return { ok: false };
    }

    // Credential preflight must use the same trusted selection. Legacy registry
    // rows may recover provider/model from their own matching onboard session;
    // checking the raw row first would miss that remote credential requirement.
    if (
      !preflightRebuildCredentials(
        {
          ...sb,
          provider: target.resumeConfig.provider,
          model: target.resumeConfig.model,
          credentialEnv: target.credentialEnv,
          hermesAuthMethod: target.durableConfig.hermesAuthMethod,
        },
        log,
        bail,
        {
          allowMissingGatewayProviderWithHostCredential:
            options.allowMissingGatewayProviderWithHostCredential,
          onGatewayProviderReconfigureRequired: () => {
            requiresGatewayProviderReconfigure = true;
          },
        },
      )
    ) {
      return { ok: false };
    }
    const result: RebuildTargetRuntimePreflightResult = {
      ok: true,
      preparedImage,
      requiresGatewayProviderReconfigure,
    };
    preparedImage = null;
    return result;
  } finally {
    if (preparedImage) disposePreparedBuildContext(preparedImage);
  }
}

export async function preflightAuthoritativeOnboardRuntime(
  sandboxName: string,
  resumeConfig: RebuildResumeConfig,
  recreateOptions: RebuildRecreateOnboardOpts,
  bail: RebuildBail,
  options: { deferInferenceRouteUntilOnboard?: true } = {},
): Promise<boolean> {
  try {
    await rebuildOnboardDependencies.preflightAuthoritativeRebuildTarget({
      ...recreateOptions,
      ...options,
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
