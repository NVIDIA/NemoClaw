// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { DEFAULT_GATEWAY_PORT } from "../../../src/lib/core/ports.ts";
import {
  isShippedManagedImageAgent,
  MANAGED_IMAGE_PLATFORMS,
  MANAGED_IMAGE_REPOSITORIES,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ManagedImageContractV1,
  type ShippedManagedImageAgent,
} from "../../../src/lib/onboard/managed-image/contract.ts";
import { readManagedWorkloadAuthority } from "../../../src/lib/onboard/workload/authority.ts";
import {
  liveE2eManagedImageCatalog,
  readLiveE2eManagedImageCatalogContracts,
} from "../../../src/lib/onboard/workload/preparation.ts";
import { readConfigFile } from "../../../src/lib/state/config-io.ts";
import { parseSandboxRegistryEntries } from "../../../src/lib/state/registry-normalization.ts";
import { cloneSandboxWorkloadReceipt } from "../../../src/lib/state/registry/workload.ts";
import { nemoclawStateRoot } from "../../../src/lib/state/state-root.ts";

const REVISION_PATTERN = /^[0-9a-f]{40}$/u;

function readCandidateCatalog(
  environment: NodeJS.ProcessEnv,
): ReadonlyMap<ShippedManagedImageAgent, ManagedImageContractV1> {
  const selected = liveE2eManagedImageCatalog(environment);
  if (!selected) {
    throw new Error("stock onboarding requires a selected candidate managed-image catalog");
  }

  try {
    return readLiveE2eManagedImageCatalogContracts(selected);
  } catch {
    throw new Error("stock onboarding candidate managed-image catalog is invalid");
  }
}

function selectedManagedImageRevision(environment: NodeJS.ProcessEnv): string {
  const revision = environment.E2E_MANAGED_IMAGE_REVISION?.trim() ?? "";
  if (revision) {
    if (!REVISION_PATTERN.test(revision)) {
      throw new Error("stock onboarding requires one exact managed-image cohort revision");
    }
    return revision;
  }
  const catalog = liveE2eManagedImageCatalog(environment);
  if (!catalog) {
    throw new Error("stock onboarding requires one exact managed-image cohort revision");
  }
  return catalog.revision;
}

export function assertManagedImageReceiptMatchesSelectedCohort(options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly expectedAgent: ShippedManagedImageAgent;
  readonly workload?: Record<string, unknown>;
}): void {
  const revision = options.environment.E2E_MANAGED_IMAGE_REVISION?.trim() ?? "";
  const rawReceipt = options.environment.E2E_MANAGED_IMAGE_COHORT_RECEIPT?.trim() ?? "";
  if (!revision) {
    if (rawReceipt) {
      throw new Error(
        "stock onboarding requires the complete selected managed-image cohort receipt",
      );
    }
    const platform = options.workload?.platform;
    if (
      typeof platform !== "string" ||
      !(MANAGED_IMAGE_PLATFORMS as readonly string[]).includes(platform)
    ) {
      throw new Error("stock onboarding candidate managed-image catalog is invalid");
    }
    const contract = readCandidateCatalog(options.environment).get(options.expectedAgent);
    if (
      !contract ||
      contract.platform !== platform ||
      options.workload?.kind !== "managed-image" ||
      options.workload.reference !== contract.reference ||
      options.workload.release !== contract.source.release ||
      options.workload.sourceRevision !== contract.source.revision ||
      options.workload.sourceCohort !== contract.source.cohort
    ) {
      throw new Error("stock onboarding must use the exact agent image from the selected cohort");
    }
    return;
  }
  if (!REVISION_PATTERN.test(revision) || !rawReceipt || Buffer.byteLength(rawReceipt) > 8 * 1024) {
    throw new Error("stock onboarding requires the complete selected managed-image cohort receipt");
  }
  let receipt: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawReceipt) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    receipt = parsed as Record<string, unknown>;
  } catch {
    throw new Error("stock onboarding selected managed-image cohort receipt is invalid");
  }
  const runId = receipt.runId;
  const runAttempt = receipt.runAttempt;
  const images = receipt.images;
  const cohort = receipt.cohort;
  if (
    JSON.stringify(Object.keys(receipt).sort()) !==
      JSON.stringify(["cohort", "images", "kind", "revision", "runAttempt", "runId"]) ||
    receipt.kind !== "nemoclaw-managed-image-cohort-receipt-v1" ||
    receipt.revision !== revision ||
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
    throw new Error("stock onboarding selected managed-image cohort receipt is invalid");
  }

  const platform = options.workload?.platform;
  const agentImages = (images as Record<string, unknown>)[options.expectedAgent];
  if (
    typeof platform !== "string" ||
    !(MANAGED_IMAGE_PLATFORMS as readonly string[]).includes(platform) ||
    !agentImages ||
    typeof agentImages !== "object" ||
    Array.isArray(agentImages) ||
    JSON.stringify(Object.keys(agentImages).sort()) !==
      JSON.stringify([...MANAGED_IMAGE_PLATFORMS].sort())
  ) {
    throw new Error("stock onboarding selected managed-image cohort receipt is invalid");
  }
  const expectedReference = (agentImages as Record<string, unknown>)[platform];
  if (
    typeof expectedReference !== "string" ||
    !expectedReference.startsWith(`${MANAGED_IMAGE_REPOSITORIES[options.expectedAgent]}@sha256:`) ||
    options.workload?.kind !== "managed-image" ||
    options.workload.reference !== expectedReference ||
    options.workload.sourceRevision !== revision ||
    options.workload.sourceCohort !== cohort
  ) {
    throw new Error("stock onboarding must use the exact agent image from the selected cohort");
  }
}

export interface StockManagedImageReceiptEvidence {
  readonly agent: string;
  readonly reference: string;
  readonly sourceCohort: string;
  readonly sourceRevision: string;
}

function gatewayPort(environment: NodeJS.ProcessEnv): number {
  const raw = environment.NEMOCLAW_GATEWAY_PORT?.trim();
  if (!raw) return DEFAULT_GATEWAY_PORT;
  if (!/^[1-9][0-9]{0,4}$/u.test(raw)) {
    throw new Error("stock managed-image receipt assertion requires a valid gateway port");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("stock managed-image receipt assertion requires a valid gateway port");
  }
  return port;
}

/** Assert the durable receipt before an E2E test begins post-onboarding probes. */
export function assertStockManagedImageReceipt(options: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly expectedAgent?: string;
  readonly sandboxName: string;
}): StockManagedImageReceiptEvidence | null {
  const environment = options.environment ?? process.env;
  const revision = selectedManagedImageRevision(environment);
  const home = environment.HOME?.trim() || os.homedir();
  const registryPath = path.join(
    nemoclawStateRoot(home, gatewayPort(environment)),
    "sandboxes.json",
  );
  const registry = readConfigFile<unknown>(registryPath, { sandboxes: {} });
  const sandboxes =
    registry && typeof registry === "object" && !Array.isArray(registry)
      ? (registry as { sandboxes?: unknown }).sandboxes
      : undefined;
  const entry = parseSandboxRegistryEntries(sandboxes).find(
    ([name]) => name === options.sandboxName,
  )?.[1];
  if (!entry) {
    throw new Error(`stock sandbox '${options.sandboxName}' is missing from the durable registry`);
  }
  const authority = readManagedWorkloadAuthority(entry);
  if (!authority) {
    const receipt = cloneSandboxWorkloadReceipt(entry.workload);
    throw new Error(
      `stock sandbox '${options.sandboxName}' must record a managed-image receipt, got '${receipt?.kind ?? "missing"}'`,
    );
  }
  if (authority.receipt.sourceRevision !== revision) {
    throw new Error(
      `stock sandbox '${options.sandboxName}' managed-image revision does not match the selected cohort`,
    );
  }
  if (options.expectedAgent && authority.agent !== options.expectedAgent) {
    throw new Error(`stock sandbox '${options.sandboxName}' managed-image agent does not match`);
  }
  if (isShippedManagedImageAgent(authority.agent)) {
    assertManagedImageReceiptMatchesSelectedCohort({
      environment,
      expectedAgent: authority.agent,
      workload: authority.receipt as unknown as Record<string, unknown>,
    });
  }
  return {
    agent: authority.agent,
    reference: authority.receipt.reference,
    sourceCohort: authority.receipt.sourceCohort,
    sourceRevision: authority.receipt.sourceRevision,
  };
}

export function shouldAssertStockManagedImageReceipt(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): boolean {
  const selectedRevision = environment.E2E_MANAGED_IMAGE_REVISION?.trim();
  const selectedCatalog = selectedRevision ? null : liveE2eManagedImageCatalog(environment);
  if (!selectedRevision && !selectedCatalog) return false;
  const selectedAgent = environment.NEMOCLAW_AGENT?.trim();
  if (selectedAgent && !isShippedManagedImageAgent(selectedAgent)) return false;
  if (environment.NEMOCLAW_FROM_DOCKERFILE?.trim()) return false;
  const executable = path.basename(command);
  let onboardArgumentIndex = -1;
  if (executable === "nemoclaw" || executable === "nemoclaw.js") {
    onboardArgumentIndex = args[0] === "onboard" ? 0 : -1;
  }
  if (executable === "node" || executable === "nodejs") {
    onboardArgumentIndex =
      path.basename(args[0] ?? "") === "nemoclaw.js" && args[1] === "onboard" ? 1 : -1;
  }
  if (onboardArgumentIndex < 0) return false;
  const onboardArguments = args.slice(onboardArgumentIndex + 1);
  if (onboardArguments.some((argument) => argument === "--help" || argument === "-h")) {
    return false;
  }
  return !onboardArguments.some(
    (argument) => argument === "--from" || argument.startsWith("--from="),
  );
}
