// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { endpointlessProviderProfilePath } from "../adapters/openshell/provider-profile";
import {
  type EndpointlessProviderProfileRunner,
  registerCheckedInProviderProfile,
} from "../adapters/openshell/provider-profile-registration";

export const MESSAGING_CREDENTIAL_PROVIDER_TYPE = "nemoclaw-mcp-v1"; // gitleaks:allow

export function messagingCredentialProviderProfilePath(root: string): string {
  return endpointlessProviderProfilePath(root, MESSAGING_CREDENTIAL_PROVIDER_TYPE);
}

/** Register and verify the endpointless profile used by static messaging credentials. */
export function ensureMessagingCredentialProviderProfile(input: {
  readonly root: string;
  readonly runOpenshell: EndpointlessProviderProfileRunner;
}): void {
  const result = registerCheckedInProviderProfile({
    profilePath: messagingCredentialProviderProfilePath(input.root),
    runOpenshell: input.runOpenshell,
  });
  if (result.ok) return;
  if (result.operation === "import") {
    throw new Error("Could not import the OpenShell messaging credential profile.");
  }
  if (!(result.error.kind === "command" && result.error.reason === "profile_incompatible")) {
    throw new Error(
      `OpenShell provider profile '${MESSAGING_CREDENTIAL_PROVIDER_TYPE}' could not be exported for validation.`,
    );
  }
  throw new Error(
    `OpenShell provider profile '${MESSAGING_CREDENTIAL_PROVIDER_TYPE}' already exists but does not match NemoClaw's endpointless messaging credential contract.`,
  );
}
