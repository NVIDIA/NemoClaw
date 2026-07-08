// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface CredentialResolutionProbeReadiness {
  policyGatewayPresent: boolean | null;
  providerAttached: boolean | null;
  providerCredentialReady: boolean;
}

export function credentialResolutionReadinessSkipDetail(
  readiness: CredentialResolutionProbeReadiness,
): string | undefined {
  if (readiness.policyGatewayPresent === null) {
    return "probe skipped: the effective generated MCP policy could not be inspected";
  }
  if (!readiness.policyGatewayPresent) {
    return "probe skipped: the generated MCP policy does not match the effective gateway policy";
  }
  if (readiness.providerAttached === null) {
    return "probe skipped: provider attachment could not be inspected";
  }
  if (!readiness.providerAttached) {
    return "probe skipped: the credential provider is not attached to the sandbox";
  }
  if (!readiness.providerCredentialReady) {
    return "probe skipped: the OpenShell provider does not match the recorded credential binding";
  }
  return undefined;
}
