// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type {
  McpProviderAttachment,
  McpProviderAttachmentInspection,
  McpProviderInspection,
} from "./mcp-bridge-provider-inspection";
export {
  assertMcpProviderRecoverable,
  assertNoAttachedProviderCredentialCollision,
  inspectMcpProvider,
  inspectMcpProviderAttachments,
  parseMcpProviderAttachmentNames,
  parseMcpProviderMetadata,
  preflightMcpEntryTargets,
  providerAttached,
  providerMatchesCredential,
  providerShapeDetail,
} from "./mcp-bridge-provider-inspection";
export type { ProviderDetachOutcome } from "./mcp-bridge-provider-mutation";
export {
  attachProvider,
  buildMcpBridgeProviderArgs,
  deleteProvider,
  detachMissingProviderReference,
  detachProvider,
  providerDetachChangedState,
  upsertMcpProvider,
} from "./mcp-bridge-provider-mutation";
export type { McpCredentialRevisionObservation } from "./mcp-bridge-provider-readiness";
export {
  buildMcpCredentialDetachedCommand,
  buildMcpCredentialRevisionObservationCommand,
  observeMcpCredentialRevision,
  waitForAttachedMcpCredential,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider-readiness";
