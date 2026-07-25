// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../../src/lib/agent/defs";
import { ensureAgentBaseImage } from "../../../src/lib/agent/onboard";
import { DASHBOARD_PORT } from "../../../src/lib/core/ports";
import { resolveCreateSandboxDashboardPort } from "../../../src/lib/onboard/dashboard-port";
import { LOCAL_INFERENCE_TIMEOUT_SECS } from "../../../src/lib/onboard/env";
import { assertExitZero } from "../fixtures/clients/command.ts";
import { type HostCliClient, resultText } from "../fixtures/clients/index.ts";
import type { ShellProbeRunOptions } from "../fixtures/shell-probe.ts";
import { requireRebuildHermesPreparedCurrentBaseIdentity } from "./rebuild-hermes-base-identity.ts";

const GATEWAY_SETUP_TIMEOUT_MS = 10 * 60_000;
const OPENSHELL_TIMEOUT_MS = 2 * 60_000;
const LONG_COMMAND_CAPTURE_LIMIT_BYTES = 4 * 1024 * 1024;

export type RebuildHermesInferenceProviderAction = "create" | "update";

interface RebuildHermesCurrentFixtureDeps {
  ensureBaseImage: typeof ensureAgentBaseImage;
  resolveDashboardPort: typeof resolveCreateSandboxDashboardPort;
}

export function buildRebuildHermesCompatibleProviderArgs(
  action: RebuildHermesInferenceProviderAction,
  endpointUrl: string,
): string[] {
  const credentialAndEndpoint = [
    "--credential",
    "COMPATIBLE_API_KEY",
    "--config",
    `OPENAI_BASE_URL=${endpointUrl}`,
  ];
  return action === "update"
    ? ["provider", "update", "-g", "nemoclaw", "compatible-endpoint", ...credentialAndEndpoint]
    : [
        "provider",
        "create",
        "-g",
        "nemoclaw",
        "--name",
        "compatible-endpoint",
        "--type",
        "openai",
        ...credentialAndEndpoint,
      ];
}

export function buildRebuildHermesInferenceRouteArgs(model: string): string[] {
  return [
    "inference",
    "set",
    "-g",
    "nemoclaw",
    "--no-verify",
    "--provider",
    "compatible-endpoint",
    "--model",
    model,
    "--timeout",
    String(LOCAL_INFERENCE_TIMEOUT_SECS),
  ];
}

export async function prepareRebuildHermesCurrentFixture(input: {
  host: Pick<HostCliClient, "command">;
  sandboxName: string;
  endpointUrl: string;
  model: string;
  env: NodeJS.ProcessEnv;
  redactionValues: string[];
  onOutput?: ShellProbeRunOptions["onOutput"];
  deps?: Partial<RebuildHermesCurrentFixtureDeps>;
}): Promise<{
  basePreparation: Pick<ReturnType<typeof ensureAgentBaseImage>, "imageTag" | "built">;
  baseResolution: ReturnType<typeof requireRebuildHermesPreparedCurrentBaseIdentity>;
  dashboardPortSelection: ReturnType<typeof resolveCreateSandboxDashboardPort> & {
    ownerSandbox: string;
  };
  inferenceProviderAction: RebuildHermesInferenceProviderAction;
}> {
  const agent = loadAgent("hermes");
  const ensureBaseImage = input.deps?.ensureBaseImage ?? ensureAgentBaseImage;
  const resolveDashboardPort =
    input.deps?.resolveDashboardPort ?? resolveCreateSandboxDashboardPort;
  const basePreparation = ensureBaseImage(agent);
  const baseResolution = requireRebuildHermesPreparedCurrentBaseIdentity(basePreparation);
  const commandOptions = {
    env: input.env,
    redactionValues: input.redactionValues,
  };

  const gatewayStart = await input.host.command(
    "openshell",
    ["gateway", "start", "--name", "nemoclaw"],
    {
      ...commandOptions,
      artifactName: "phase-1-start-nemoclaw-gateway",
      timeoutMs: GATEWAY_SETUP_TIMEOUT_MS,
      captureLimitBytes: LONG_COMMAND_CAPTURE_LIMIT_BYTES,
      onOutput: input.onOutput,
    },
  );
  assertExitZero(gatewayStart, "start reusable 'nemoclaw' OpenShell gateway");

  const gatewayProbe = await input.host.command(
    "openshell",
    ["gateway", "info", "-g", "nemoclaw"],
    {
      ...commandOptions,
      artifactName: "phase-1-gateway-probe",
      timeoutMs: 30_000,
    },
  );
  assertExitZero(gatewayProbe, "direct preparation must leave a reusable 'nemoclaw' gateway");

  const existingProvider = await input.host.command(
    "openshell",
    ["provider", "get", "-g", "nemoclaw", "compatible-endpoint"],
    {
      ...commandOptions,
      artifactName: "phase-1-compatible-provider-get",
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  const inferenceProviderAction: RebuildHermesInferenceProviderAction =
    existingProvider.exitCode === 0 ? "update" : "create";
  const configureProvider = await input.host.command(
    "openshell",
    buildRebuildHermesCompatibleProviderArgs(inferenceProviderAction, input.endpointUrl),
    {
      ...commandOptions,
      artifactName: `phase-1-compatible-provider-${inferenceProviderAction}`,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  assertExitZero(
    configureProvider,
    `OpenShell compatible inference provider ${inferenceProviderAction}`,
  );

  const configureRoute = await input.host.command(
    "openshell",
    buildRebuildHermesInferenceRouteArgs(input.model),
    {
      ...commandOptions,
      artifactName: "phase-1-compatible-inference-route",
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  assertExitZero(configureRoute, "configure compatible inference route");

  const forwardList = await input.host.command("openshell", ["forward", "list"], {
    ...commandOptions,
    artifactName: "phase-1-forward-list-for-dashboard-port",
    timeoutMs: 30_000,
  });
  assertExitZero(forwardList, "inspect OpenShell forwards before dashboard port selection");

  const dashboardPortSelection = resolveDashboardPort({
    sandboxName: input.sandboxName,
    controlUiPort: null,
    chatUiUrlEnv: input.env.CHAT_UI_URL,
    persistedPort: null,
    agentForwardPort: agent.forwardPort,
    defaultPort: DASHBOARD_PORT,
    forwardListOutput: resultText(forwardList),
  });
  if (
    !Number.isInteger(dashboardPortSelection.effectivePort) ||
    dashboardPortSelection.effectivePort <= 0 ||
    dashboardPortSelection.effectivePort > 65535
  ) {
    throw new Error("production dashboard allocator did not select a valid test-owned port");
  }

  return {
    basePreparation: {
      imageTag: basePreparation.imageTag,
      built: basePreparation.built,
    },
    baseResolution,
    dashboardPortSelection: {
      ownerSandbox: input.sandboxName,
      ...dashboardPortSelection,
    },
    inferenceProviderAction,
  };
}
