// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShippedManagedImageAgent } from "../../../src/lib/onboard/managed-image/contract.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertManagedImageReceiptMatchesSelectedCohort } from "../fixtures/managed-image-receipt.ts";

const EXACT_MAIN_OVERLAY_KEYS = new Set([
  "PATH",
  "NEMOCLAW_OPENSHELL_BIN",
  "NEMOCLAW_OPENSHELL_GATEWAY_BIN",
  "NEMOCLAW_OPENSHELL_SANDBOX_BIN",
]);

const MCP_BRIDGE_QUALIFICATION_ENV_KEYS = [
  "E2E_MANAGED_IMAGE_REVISION",
  "E2E_MANAGED_IMAGE_COHORT_RECEIPT",
  "NEMOCLAW_E2E_EXPECTED_SHA",
  "NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG",
  "NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON",
  "NEMOCLAW_RUN_LIVE_E2E",
  "OPENSHELL_DOCKER_SUPERVISOR_IMAGE",
] as const;

const MCP_BRIDGE_ONBOARD_ARGS = [
  "onboard",
  "--non-interactive",
  "--yes",
  "--yes-i-accept-third-party-software",
] as const;

export function buildMcpBridgeOnboardArgs(environment: NodeJS.ProcessEnv = process.env): string[] {
  const catalogPath = environment.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG?.trim();
  return catalogPath
    ? [
        "onboard",
        "--temp-managed-runtime",
        "--temp-managed-runtime-catalog",
        catalogPath,
        ...MCP_BRIDGE_ONBOARD_ARGS.slice(1),
      ]
    : [...MCP_BRIDGE_ONBOARD_ARGS];
}

export function assertMcpBridgeManagedImageReceipt(options: {
  environment?: NodeJS.ProcessEnv;
  expectedAgent: ShippedManagedImageAgent;
  workload?: Record<string, unknown>;
}): void {
  const environment = options.environment ?? process.env;
  const selectedRevision = environment.E2E_MANAGED_IMAGE_REVISION?.trim();
  const exactCandidateCatalog =
    environment.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG?.trim() ||
    environment.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON?.trim();
  if (!selectedRevision && !exactCandidateCatalog) return;

  const expectedRevision = selectedRevision ?? environment.NEMOCLAW_E2E_EXPECTED_SHA?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/u.test(expectedRevision)) {
    throw new Error("managed-image MCP qualification requires an exact cohort revision");
  }
  assertManagedImageReceiptMatchesSelectedCohort({
    environment,
    expectedAgent: options.expectedAgent,
    workload: options.workload,
  });
}

export function buildMcpBridgeExactMainEnv(options: {
  baseEnv?: NodeJS.ProcessEnv;
  envOverlay?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const baseEnv = options.baseEnv ?? process.env;
  const envOverlay = options.envOverlay ?? {};
  for (const key of Object.keys(envOverlay)) {
    if (!EXACT_MAIN_OVERLAY_KEYS.has(key)) {
      throw new Error(`MCP exact-main command does not allow env overlay key '${key}'`);
    }
  }

  const qualificationEnv = Object.fromEntries(
    MCP_BRIDGE_QUALIFICATION_ENV_KEYS.flatMap((key) =>
      baseEnv[key] === undefined ? [] : [[key, baseEnv[key]]],
    ),
  );
  return {
    ...buildAvailabilityProbeEnv(baseEnv),
    ...qualificationEnv,
    ...envOverlay,
  };
}

export function buildMcpBridgeOnboardEnv(options: {
  agent: "openclaw" | "hermes" | "langchain-deepagents-code";
  baseEnv?: NodeJS.ProcessEnv;
  compatibleKey: string;
  compatibleModel: string;
  corporateCaBundle?: string;
  endpointUrl: string;
  envOverlay?: NodeJS.ProcessEnv;
  sandboxName: string;
}): NodeJS.ProcessEnv {
  return {
    ...buildMcpBridgeExactMainEnv(options),
    COMPATIBLE_API_KEY: options.compatibleKey,
    NVIDIA_INFERENCE_API_KEY: options.compatibleKey,
    ...(options.corporateCaBundle
      ? { NEMOCLAW_CORPORATE_CA_BUNDLE: options.corporateCaBundle }
      : {}),
    NEMOCLAW_AGENT: options.agent,
    NEMOCLAW_ENDPOINT_URL: options.endpointUrl,
    NEMOCLAW_MODEL: options.compatibleModel,
    NEMOCLAW_COMPAT_MODEL: options.compatibleModel,
    NEMOCLAW_PREFERRED_API: "openai-completions",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_SANDBOX_NAME: options.sandboxName,
    NEMOCLAW_RECREATE_SANDBOX: "1",
  };
}

export function requireMcpBridgeTlsCaCert(env: NodeJS.ProcessEnv = process.env): string {
  const corporateCaBundle = env.NEMOCLAW_MCP_TLS_CA_CERT;
  if (!corporateCaBundle) {
    throw new Error("NEMOCLAW_MCP_TLS_CA_CERT is required for routed-private MCP validation");
  }
  return corporateCaBundle;
}
