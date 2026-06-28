// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Present in the OpenShell sandbox supervisor once native Streamable HTTP MCP
 * policy support is available. OpenShell current main has no structured
 * capability-attestation API, so NemoClaw uses this existing implementation
 * string only to reject stale sandbox runtimes before applying an MCP policy.
 */
export const OPENSHELL_MCP_POLICY_CAPABILITY_MARKER = "allow_all_known_mcp_methods";
