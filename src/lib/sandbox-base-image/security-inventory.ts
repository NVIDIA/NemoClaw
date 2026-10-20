// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture } from "../adapters/docker";

import {
  OPENCLAW_SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY,
  SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY,
  PINNED_HERMES_BASE_SECURITY_PACKAGE_INVENTORY,
  securityInventoryProbe,
  SECURITY_INVENTORY_PROBE_OK,
} from "./security-package-specs";

export {
  OPENCLAW_SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY,
  SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY,
} from "./security-package-specs";

/**
 * Reject a published or cached base that predates the immutable security
 * package inventory consumed by completed-image verification.
 */
function sandboxBaseImageHasPackageInventory(
  imageRef: string,
  packageInventory: readonly string[],
): boolean {
  const output = dockerCapture(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--entrypoint",
      "/bin/sh",
      imageRef,
      "-c",
      securityInventoryProbe(packageInventory),
    ],
    { ignoreError: true, timeout: 20_000 },
  );
  return output.trim() === SECURITY_INVENTORY_PROBE_OK;
}

export function sandboxBaseImageHasSecurityInventory(imageRef: string): boolean {
  return sandboxBaseImageHasPackageInventory(imageRef, SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY);
}

/** Accept the reviewed older inventory only with pinned-base provenance. */
export function hermesSandboxBaseImageHasSecurityInventory(
  imageRef: string,
  allowPinnedInventory = false,
): boolean {
  return (
    sandboxBaseImageHasSecurityInventory(imageRef) ||
    (allowPinnedInventory &&
      sandboxBaseImageHasPackageInventory(imageRef, PINNED_HERMES_BASE_SECURITY_PACKAGE_INVENTORY))
  );
}

export function openClawSandboxBaseImageHasSecurityInventory(imageRef: string): boolean {
  return sandboxBaseImageHasPackageInventory(
    imageRef,
    OPENCLAW_SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY,
  );
}
