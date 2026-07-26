// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MCP_BRIDGE_TEST_CREDENTIALS = {
  host: "fake-host-mcp-secret-value",
  rotatedHost: "fake-rotated-mcp-secret-value",
  rebindHost: "fake-rebind-mcp-secret-value",
  compatibleEndpoint: "fake-compatible-mcp-bridge-key",
  // Prefix shared by the exact-main generation-window fixture. The live test
  // appends a bounded generation number, while the artifact scanner searches
  // for this prefix so any member of the sequence is still detected.
  generationWindow: "fake-generation-window-secret-",
} as const;
