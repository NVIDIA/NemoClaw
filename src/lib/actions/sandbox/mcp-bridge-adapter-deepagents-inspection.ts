// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import type { McpAttachedCredentialRevision } from "./mcp-bridge-provider-readiness";
import {
  type AdapterRegistrationInspection,
  inspectAdapterRegistrationCommand,
} from "./mcp-bridge-adapter-inspection";
import { buildDeepAgentsMcpStatusCommand } from "./mcp-bridge-adapter-status";

export function inspectDeepAgentsAdapterRegistration(
  sandboxName: string,
  entry: McpBridgeEntry,
  credentialRevision?: McpAttachedCredentialRevision,
): AdapterRegistrationInspection {
  return inspectAdapterRegistrationCommand(
    sandboxName,
    entry,
    buildDeepAgentsMcpStatusCommand(entry, credentialRevision),
  );
}
