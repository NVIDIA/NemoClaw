// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpSourceEntry } from "./mcp-bridge-contracts";
import type { McpAttachedCredentialRevision } from "./mcp-bridge-provider-readiness";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import {
  type AdapterRegistrationInspection,
  inspectAdapterRegistrationCommand,
} from "./mcp-bridge-adapter-inspection";
import { buildDeepAgentsMcpStatusCommand } from "./mcp-bridge-adapter-status";

export async function inspectDeepAgentsAdapterRegistration(
  sandboxName: string,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  credentialRevision?: McpAttachedCredentialRevision,
): Promise<AdapterRegistrationInspection> {
  return await inspectAdapterRegistrationCommand(
    sandboxName,
    entry,
    buildDeepAgentsMcpStatusCommand(entry, credentialRevision),
    runtimeSelection,
  );
}
