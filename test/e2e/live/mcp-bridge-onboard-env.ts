// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import {
  MANAGED_IMAGE_PLATFORMS,
  MANAGED_IMAGE_REPOSITORIES,
  parseManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ManagedImagePlatform,
  type ShippedManagedImageAgent,
} from "../../../src/lib/onboard/managed-image/contract.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";

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
  const selectedReceipt = environment.E2E_MANAGED_IMAGE_COHORT_RECEIPT?.trim();
  const exactCandidateCatalog = environment.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG?.trim();
  if (!selectedRevision && !exactCandidateCatalog) return;

  const expectedRevision = selectedRevision ?? environment.NEMOCLAW_E2E_EXPECTED_SHA?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/u.test(expectedRevision)) {
    throw new Error("managed-image MCP qualification requires an exact cohort revision");
  }

  const workloadPlatform = options.workload?.platform;
  if (
    typeof workloadPlatform !== "string" ||
    !(MANAGED_IMAGE_PLATFORMS as readonly string[]).includes(workloadPlatform)
  ) {
    throw new Error("managed-image MCP qualification requires an exact workload platform");
  }
  const expectedPlatform = workloadPlatform as ManagedImagePlatform;

  let expectedReference: string;
  let expectedCohort: string;
  if (selectedRevision) {
    if (!selectedReceipt || Buffer.byteLength(selectedReceipt, "utf8") > 8 * 1024) {
      throw new Error("managed-image MCP qualification requires the selected cohort receipt");
    }
    let receipt: Record<string, unknown>;
    try {
      const parsed = JSON.parse(selectedReceipt) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      receipt = parsed as Record<string, unknown>;
    } catch {
      throw new Error("managed-image MCP qualification cohort receipt is invalid");
    }
    const runId = receipt.runId;
    const runAttempt = receipt.runAttempt;
    const images = receipt.images;
    const cohort = receipt.cohort;
    if (
      JSON.stringify(Object.keys(receipt).sort()) !==
        JSON.stringify(["cohort", "images", "kind", "revision", "runAttempt", "runId"]) ||
      receipt.kind !== "nemoclaw-managed-image-cohort-receipt-v1" ||
      receipt.revision !== expectedRevision ||
      !Number.isSafeInteger(runId) ||
      Number(runId) < 1 ||
      !Number.isSafeInteger(runAttempt) ||
      Number(runAttempt) < 1 ||
      cohort !== `ghrun-${String(runId)}-${String(runAttempt)}` ||
      !images ||
      typeof images !== "object" ||
      Array.isArray(images) ||
      JSON.stringify(Object.keys(images).sort()) !==
        JSON.stringify([...SHIPPED_MANAGED_IMAGE_AGENTS].sort())
    ) {
      throw new Error("managed-image MCP qualification cohort receipt is invalid");
    }
    const agentImages = (images as Record<string, unknown>)[options.expectedAgent];
    if (
      !agentImages ||
      typeof agentImages !== "object" ||
      Array.isArray(agentImages) ||
      JSON.stringify(Object.keys(agentImages).sort()) !==
        JSON.stringify([...MANAGED_IMAGE_PLATFORMS].sort())
    ) {
      throw new Error("managed-image MCP qualification cohort receipt is invalid");
    }
    expectedReference = (agentImages as Record<string, unknown>)[expectedPlatform] as string;
    expectedCohort = cohort;
  } else {
    let catalog: Record<string, unknown>;
    try {
      const parsed = JSON.parse(fs.readFileSync(exactCandidateCatalog!, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      catalog = parsed as Record<string, unknown>;
    } catch {
      throw new Error("managed-image MCP qualification catalog is invalid");
    }
    const contract = parseManagedImageContractV1(
      catalog[options.expectedAgent],
      options.expectedAgent,
      expectedPlatform,
    );
    if (contract.source.revision !== expectedRevision) {
      throw new Error("managed-image MCP qualification catalog revision is invalid");
    }
    expectedReference = contract.reference;
    expectedCohort = contract.source.cohort;
  }

  if (
    typeof expectedReference !== "string" ||
    !expectedReference.startsWith(`${MANAGED_IMAGE_REPOSITORIES[options.expectedAgent]}@sha256:`) ||
    options.workload?.kind !== "managed-image" ||
    options.workload.sourceRevision !== expectedRevision ||
    options.workload.sourceCohort !== expectedCohort ||
    options.workload.reference !== expectedReference
  ) {
    throw new Error(
      "MCP qualification must use the exact agent image from the selected cohort receipt",
    );
  }
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
