// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { redactBridgeFailureForDisplay } from "./mcp-bridge-output";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import type { McpCredentialRevisionObservation } from "./mcp-bridge-provider-readiness";
import { statusMcpBridge } from "./mcp-bridge-status";

const AUTHORIZATION_DETAIL_MAX_LENGTH = 240;

function authorizationDetailForDisplay(
  detail: string,
  entry: McpBridgeEntry,
  fallback: string,
): string {
  return (
    redactBridgeFailureForDisplay(detail, entry).trim().slice(0, AUTHORIZATION_DETAIL_MAX_LENGTH) ||
    fallback
  );
}

/**
 * A stable OpenShell handle identifies the credential slot, not the current
 * credential bytes. When an update retains that handle, require differential
 * endpoint evidence before any caller can commit the managed adapter.
 */
export async function assertUnchangedStableMcpCredentialAuthorized(
  sandboxName: string,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  previousRevision: McpCredentialRevisionObservation | undefined,
  credentialRevision: McpCredentialRevisionObservation,
): Promise<void> {
  if (previousRevision !== credentialRevision || !credentialRevision.startsWith("s")) return;

  let detail = "post-update wire-level credential verification did not return a result";
  try {
    const [status] = await statusMcpBridge(sandboxName, entry.server, {
      allowCredentialProbeWithAdapterMismatch: true,
      allowIncompleteAddCredentialProbe: true,
      probeCredentialResolution: true,
      runtimeSelection,
    });
    const probe = status?.provider.credentialResolution;
    if (probe?.ok === true) return;
    if (probe?.detail) detail = authorizationDetailForDisplay(probe.detail, entry, detail);
  } catch (error) {
    detail = authorizationDetailForDisplay(
      error instanceof Error ? error.message : String(error),
      entry,
      "post-update credential status inspection failed",
    );
  }
  throw new McpBridgeError(
    `MCP server '${entry.server}' did not authorize its unchanged stable credential handle after provider update: ${detail}.`,
  );
}
