// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MCP_BRIDGE_PHASES = {
  openclaw: [
    "start compatible inference and MCP endpoints",
    "onboard OpenClaw and prove base policy",
    "configure bridge and enforce endpoint boundaries",
    "exercise lifecycle and confirm OpenClaw bridge removal",
  ],
  hermes: [
    "start Hermes inference and MCP endpoints",
    "onboard the Hermes MCP sandbox",
    "configure and inspect the Hermes MCP bridge",
    "exercise lifecycle and confirm Hermes bridge removal",
  ],
  deepagents: [
    "start Deep Agents inference and MCP endpoints",
    "onboard the Deep Agents MCP sandbox",
    "configure and inspect the Deep Agents MCP bridge",
    "exercise lifecycle and confirm Deep Agents bridge removal",
  ],
} as const;
