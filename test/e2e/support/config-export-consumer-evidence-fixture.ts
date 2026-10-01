// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const EXPECTED_NATIVE_SETTINGS = {
  model: { contextWindow: 131_072, maxTokens: 8192, reasoning: false },
  reasoningEffort: "default",
  execution: { timeoutSeconds: 600, heartbeatEvery: "2m" },
  dashboard: { enabled: true, port: 18_789, bind: "loopback" },
  toolDisclosure: "progressive",
} as const;

export const PINNED_CONSUMER_EVIDENCE = {
  revision: "88c6600c06b0937907290362eef86912052c4ad0" as const,
  compiledSandboxes: 1,
  contextWindows: [131_072],
  openclawNativeSettings: { sandbox: EXPECTED_NATIVE_SETTINGS },
  openclawNativeSettingsVerified: 1,
  hermesNativeSettingsVerified: 0,
};
