// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpSourceEntry } from "../mcp-bridge-contracts";
import { normalizeMcpServerUrl } from "../mcp-bridge-validation";

/** Validate a persisted URL with the exact private-host trust recorded at registration. */
export function normalizeRecordedMcpServerUrl(
  entry: Pick<McpSourceEntry, "trustedPrivateHost" | "url">,
): string {
  return normalizeMcpServerUrl(entry.url, {
    trustedPrivateHosts: entry.trustedPrivateHost ? [entry.trustedPrivateHost] : undefined,
  });
}
