#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactForLog } from "./security/redact.js";
import { sdkOpenShellGatewayHealthObserver } from "../../nemoclaw/dist/shared/openshell-gateway-health-sdk.js";
import type { OpenShellGatewayHealthObserver } from "../../nemoclaw/dist/shared/openshell-observation-boundary.cjs";

import type { createBlueprintNativeInference } from "./inference/native-provider/blueprint";

/** Observe existing native authority without creating, repairing, or attaching providers. */
export async function observeBlueprintNativeInference(
  requested: Readonly<{
    gatewayName: string;
    sandboxName: string;
    provider: string;
    model: string;
    api: string;
    endpointUrl?: string;
    requiresCredential?: boolean;
  }>,
): Promise<string> {
  const { findSandboxAcrossGatewayRoots } = await import("./state/registry/cross-port");
  const { verifyBlueprintNativeInferenceSelection } =
    await import("./actions/sandbox/inference-route-health");
  const { createRegisteredSandboxIdentityRevalidation } =
    await import("./onboard/sandbox-recreate-transaction");
  const { observeSandboxOnGateway } = await import("./onboard/sandbox-recreate-probe");
  const { findBlueprintNativeReceipt, observeBlueprintCreatedInference } =
    await import("./inference/native-provider/blueprint");
  const readBlueprintSandboxRegistration = (sandboxName: string) =>
    findSandboxAcrossGatewayRoots(sandboxName)?.entry ?? null;
  const entry = readBlueprintSandboxRegistration(requested.sandboxName);
  if (!entry) {
    const receipt = findBlueprintNativeReceipt(requested);
    if (receipt) return observeBlueprintCreatedInference(requested, receipt);
  }
  const revalidate = createRegisteredSandboxIdentityRevalidation(entry, {
    readRegistration: readBlueprintSandboxRegistration,
    observe: (sandboxName, gatewayName) =>
      observeSandboxOnGateway({ sandboxName, gatewayName }, undefined, undefined, 15_000),
  });
  if (!entry || !revalidate)
    throw new Error("Runtime identity apply requires recorded sandbox lifecycle authority.");
  revalidate("inspect native inference for runtime identity apply");
  // Each registered native family verifies its declared credential against live provider metadata.
  const identity = await verifyBlueprintNativeInferenceSelection(entry, requested);
  revalidate("complete native inference inspection for runtime identity apply");
  const current = readBlueprintSandboxRegistration(requested.sandboxName);
  if (!current || identity !== (await verifyBlueprintNativeInferenceSelection(current, requested)))
    throw new Error("Native inference selection changed during runtime identity inspection.");
  revalidate("complete native inference selection verification");
  return identity;
}

export async function prepareBlueprintNativeInference(
  requested: Parameters<typeof observeBlueprintNativeInference>[0] &
    Readonly<{ timeoutSeconds: number }>,
): Promise<void> {
  const { reconcileBlueprintNativeTimeout } = await import("./inference/native-provider/blueprint");
  await reconcileBlueprintNativeTimeout(requested, () =>
    observeBlueprintNativeInference(requested),
  );
}

const RUNNER_MODULE = "../nemoclaw/blueprint/runner.js";
const MAX_DIAGNOSTIC_CHARACTERS = 1_024;
const UNSAFE_DIAGNOSTIC_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+/gu;

function reportFailure(error: unknown): void {
  let detail = "Blueprint Runner failed.";
  try {
    detail = error instanceof Error ? error.message : String(error);
  } catch {
    // Keep the fixed fallback when an arbitrary thrown value cannot be rendered.
  }
  const redacted = redactForLog(detail);
  const sanitized =
    typeof redacted === "string" ? redacted.replace(UNSAFE_DIAGNOSTIC_CHARACTERS, " ").trim() : "";
  const message = (sanitized || "Blueprint Runner failed.").slice(0, MAX_DIAGNOSTIC_CHARACTERS);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}

async function run(): Promise<void> {
  const runner = (await import(RUNNER_MODULE)) as Readonly<{
    main(
      argv: string[],
      options: Readonly<{
        gatewayHealthObserver: OpenShellGatewayHealthObserver;
        nativeInferenceObserver: typeof observeBlueprintNativeInference;
        nativeInferenceCreator: typeof createBlueprintNativeInference;
        nativeInferencePreparer: typeof prepareBlueprintNativeInference;
      }>,
    ): Promise<void>;
  }>;
  await runner.main(process.argv.slice(2), {
    gatewayHealthObserver: sdkOpenShellGatewayHealthObserver,
    nativeInferenceObserver: observeBlueprintNativeInference,
    nativeInferenceCreator: async (input) => {
      const { createBlueprintNativeInference } =
        await import("./inference/native-provider/blueprint");
      return createBlueprintNativeInference(input);
    },
    nativeInferencePreparer: prepareBlueprintNativeInference,
  });
}

if (require.main === module) void run().catch(reportFailure);
