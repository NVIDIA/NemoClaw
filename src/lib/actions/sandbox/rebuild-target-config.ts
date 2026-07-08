// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../agent/defs";
import { webSearchProviderForConfig } from "../../inference/web-search";
import type { DcodeAutoApprovalMode } from "../../onboard/dcode-auto-approval";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import type { ToolDisclosure } from "../../tool-disclosure";
import type { RebuildBail } from "./rebuild-credential-preflight";
import { isDcodeRebuildAgent } from "./rebuild-dcode-orchestrator";
import {
  type RebuildDurableConfig,
  resolveRebuildDockerfile,
  resolveRebuildDurableConfig,
} from "./rebuild-durable-config";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";
import { prepareRebuildResumeConfig, type RebuildResumeConfig } from "./rebuild-resume-config";

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
  if (durableConfig.toolDisclosureError) {
    printRebuildPreflightFailure(
      "recorded tool-disclosure state is invalid.",
      durableConfig.toolDisclosureError,
      "Recorded tool-disclosure state is invalid",
      bail,
    );
    return false;
  }
  if (durableConfig.dcodeAutoApprovalModeError) {
    printRebuildPreflightFailure(
      "recorded DCode auto-approval state is invalid.",
      durableConfig.dcodeAutoApprovalModeError,
      "Recorded DCode auto-approval state is invalid",
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
  requestedToolDisclosure?: ToolDisclosure,
  allowLegacyManagedImageRecovery = false,
  requestedDcodeAutoApprovalMode?: DcodeAutoApprovalMode,
): RebuildTargetConfig | null {
  const resumeConfig = prepareRebuildResumeConfig(sandboxName, sb, rebuildAgent, log, bail);
  if (!resumeConfig) return null;
  const sessionSnapshot = onboardSession.loadSession();
  const sessionMatchesSandbox = sessionSnapshot?.sandboxName === sandboxName;
  const durableConfig = resolveRebuildDurableConfig(
    sandboxName,
    sb,
    sessionSnapshot,
    {
      provider: resumeConfig.provider,
      model: resumeConfig.model,
    },
    requestedToolDisclosure,
    allowLegacyManagedImageRecovery,
    requestedDcodeAutoApprovalMode,
  );
  if (!validateRebuildDurableConfig(durableConfig, resumeConfig, bail)) return null;
  if (isDcodeRebuildAgent(rebuildAgent) && durableConfig.fromDockerfile) {
    printRebuildPreflightFailure(
      "the managed DCode registry entry conflicts with a recorded custom Dockerfile.",
      "Managed DCode rebuilds must use the verified managed image path.",
      "Managed DCode rebuild cannot use a recorded custom Dockerfile",
      bail,
    );
    return null;
  }

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
  const hermesToolGateways =
    rebuildAgent === "hermes" &&
    durableConfig.webSearchConfig &&
    webSearchProviderForConfig(durableConfig.webSearchConfig) === "tavily"
      ? hermesGateways.gateways.filter((gateway) => gateway !== "nous-web")
      : hermesGateways.gateways;
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
    hermesToolGateways,
    hasHermesToolGateways: hermesGateways.recorded,
    credentialEnv,
    fromDockerfile: dockerfile.path,
    agentDefinition: rebuildAgent && rebuildAgent !== "openclaw" ? loadAgent(rebuildAgent) : null,
  };
}
