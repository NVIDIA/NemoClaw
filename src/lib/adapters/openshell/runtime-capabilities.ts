// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compiled into the OpenShell sandbox supervisor that requires verified TLS,
 * binds HTTP Host to the approved origin, and rejects MCP query drift before
 * credential replacement.
 */
export const OPENSHELL_MCP_TRANSPORT_CAPABILITY_MARKER =
  "authenticated-mcp-policy-bound-credential-rewrite-v1";

/**
 * Attested by the gateway and embedded in the sandbox supervisor when exact,
 * policy-authorized lifecycle commands use the internal control relay without
 * a host listener or workload-accessible privileged principal.
 */
export const OPENSHELL_LIFECYCLE_EXEC_CAPABILITY_MARKER = "policy-authorized-lifecycle-exec-v1";

export const OPENSHELL_HERMES_MCP_LIFECYCLE_OPERATION = "nemoclaw.hermes-mcp-config-transaction-v1";

export const OPENSHELL_REQUIRED_MCP_GATEWAY_CAPABILITIES = [
  OPENSHELL_MCP_TRANSPORT_CAPABILITY_MARKER,
  OPENSHELL_LIFECYCLE_EXEC_CAPABILITY_MARKER,
  OPENSHELL_HERMES_MCP_LIFECYCLE_OPERATION,
] as const;
