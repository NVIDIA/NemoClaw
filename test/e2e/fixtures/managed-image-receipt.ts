// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { DEFAULT_GATEWAY_PORT } from "../../../src/lib/core/ports.ts";
import { readManagedWorkloadAuthority } from "../../../src/lib/onboard/workload/authority.ts";
import { readConfigFile } from "../../../src/lib/state/config-io.ts";
import { parseSandboxRegistryEntries } from "../../../src/lib/state/registry-normalization.ts";
import { cloneSandboxWorkloadReceipt } from "../../../src/lib/state/registry/workload.ts";
import { nemoclawStateRoot } from "../../../src/lib/state/state-root.ts";

const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const FALLBACK_DIAGNOSTIC = "Managed image unavailable; using the trusted Dockerfile recipe.";

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
  readonly commandOutput?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly expectedAgent?: string;
  readonly sandboxName: string;
}): StockManagedImageReceiptEvidence {
  const environment = options.environment ?? process.env;
  const revision = environment.E2E_MANAGED_IMAGE_REVISION?.trim() ?? "";
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error("stock onboarding requires one exact managed-image cohort revision");
  }
  if (options.commandOutput?.includes(FALLBACK_DIAGNOSTIC)) {
    throw new Error("stock onboarding emitted a legacy Dockerfile fallback diagnostic");
  }

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
  if (!environment.E2E_MANAGED_IMAGE_REVISION?.trim()) return false;
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
  return !args
    .slice(onboardArgumentIndex + 1)
    .some((argument) => argument === "--from" || argument.startsWith("--from="));
}
