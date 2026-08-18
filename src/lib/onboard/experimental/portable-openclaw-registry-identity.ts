// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { RuntimeProviderSelectionError } from "../runtime-provider/access";
import {
  classifyPortableLifecycleReceipt,
  type PortableLifecycleReceiptClassification,
} from "./portable-runtime-receipt-readiness";

export type PortableLifecycleReceiptClassifier = (
  sandboxName: string,
  deps?: { readonly env?: NodeJS.ProcessEnv },
) => PortableLifecycleReceiptClassification;

/** Require the durable identity that authorizes an explicit Portable OpenClaw registry agent. */
export function requirePortableOpenClawRegistryIdentity(
  sandboxName: string,
  lifecycleGeneration: string | undefined,
  env: NodeJS.ProcessEnv,
  classifyReceipt: PortableLifecycleReceiptClassifier = classifyPortableLifecycleReceipt,
): "openclaw" {
  const receipt = classifyReceipt(sandboxName, { env });
  if (
    receipt.kind !== "current" ||
    !lifecycleGeneration ||
    lifecycleGeneration !== receipt.registryGeneration
  ) {
    throw new RuntimeProviderSelectionError(
      "Portable OpenClaw registration requires a current lifecycle receipt that matches the registry generation.",
    );
  }
  return "openclaw";
}
