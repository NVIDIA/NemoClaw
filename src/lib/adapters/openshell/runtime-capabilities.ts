// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Present in OpenShell artifacts that include native Streamable HTTP MCP policy
 * support. NemoClaw uses this implementation marker only as an installed-artifact
 * compatibility gate during onboarding. The running supervisor is validated by
 * applying the actual generated MCP policy through `openshell policy set --wait`.
 */
export const OPENSHELL_MCP_POLICY_CAPABILITY_MARKER = "allow_all_known_mcp_methods";
