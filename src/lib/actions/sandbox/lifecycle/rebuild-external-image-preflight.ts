// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { prepareExternalImageWorkloadSource } from "../../../onboard/workload/external-image";
import type { RuntimeProviderBundle } from "../../../onboard/runtime-provider/contract";
import type { SandboxWorkloadRuntimeCapabilities } from "../../../onboard/workload/source";
import type { SandboxWorkloadReceipt } from "../../../state/registry/types";
import { cloneSandboxWorkloadReceipt } from "../../../state/registry/workload";
import type { ToolDisclosure } from "../../../tool-disclosure";

export class RebuildExternalImagePreflightError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`External image rebuild preflight failed: ${message}`, options);
    this.name = "RebuildExternalImagePreflightError";
  }
}

/**
 * Revalidate the exact publisher-owned image before destructive rebuild work.
 * This path never resolves a release catalog or substitutes another image.
 */
export function preflightExternalImageRebuild(input: {
  readonly agentName: string | null;
  readonly expectedToolDisclosure: ToolDisclosure;
  readonly receipt: SandboxWorkloadReceipt | undefined;
  readonly runtime: SandboxWorkloadRuntimeCapabilities;
  readonly provider: RuntimeProviderBundle;
}): void {
  const receipt = cloneSandboxWorkloadReceipt(input.receipt);
  if (receipt?.kind !== "external-image") {
    throw new RebuildExternalImagePreflightError(
      "the durable external-image receipt is missing or invalid",
    );
  }
  if (input.agentName !== "openclaw" && input.agentName !== "hermes") {
    throw new RebuildExternalImagePreflightError(
      "the recorded agent is not supported for user-supplied images",
    );
  }
  if (!input.provider.workload.acceptsReceipt(receipt)) {
    throw new RebuildExternalImagePreflightError(
      `provider '${input.provider.identity.id}' rejected the durable external-image receipt`,
    );
  }
  const containerEngine = input.provider.containerEngine;
  if (
    containerEngine.supported !== true ||
    !containerEngine.identities.some(
      (identity) => identity.operation === "external-image-preparation",
    )
  ) {
    throw new RebuildExternalImagePreflightError(
      `provider '${input.provider.identity.id}' cannot inspect user-supplied images`,
    );
  }

  let prepared;
  try {
    prepared = prepareExternalImageWorkloadSource(
      {
        reference: receipt.reference,
        agentName: input.agentName,
        runtime: input.runtime,
      },
      { capture: containerEngine.capture },
    );
  } catch (error) {
    throw new RebuildExternalImagePreflightError(
      error instanceof Error ? error.message : "the recorded image could not be inspected",
      { cause: error },
    );
  }
  const preparedIdentity = {
    reference: prepared.reference,
    platform: prepared.platform,
    runtimeImageContentId: prepared.runtimeImageContentId,
  };
  const recordedIdentity = {
    reference: receipt.reference,
    platform: receipt.platform,
    runtimeImageContentId: receipt.runtimeImageContentId,
  };
  if (!isDeepStrictEqual(preparedIdentity, recordedIdentity)) {
    throw new RebuildExternalImagePreflightError(
      "the inspected image identity does not match the durable external-image receipt",
    );
  }
  if (prepared.toolDisclosure !== input.expectedToolDisclosure) {
    throw new RebuildExternalImagePreflightError(
      "the requested tool-disclosure mode does not match the recorded image",
    );
  }
}
