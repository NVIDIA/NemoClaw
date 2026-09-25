// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Target revision that owns the recorded omission behavior. */
export const V1ALPHA1_RUNTIME_DEFAULTS_REVISION =
  "88c6600c06b0937907290362eef86912052c4ad0" as const;

/**
 * Effective v1 runtime values when the exporter omits a supported agent setting.
 * Keep these values separate from the v0 managed-startup profile defaults.
 */
export const V1ALPHA1_RUNTIME_DEFAULTS = {
  openclaw: {
    tuning: {
      contextWindow: 32_768,
      maxTokens: 4096,
      reasoning: false,
      reasoningEffort: "default",
    },
    execution: {
      timeoutSeconds: 600,
      heartbeatEvery: null,
    },
    interfaces: {
      dashboard: {
        enabled: false,
        port: 18_789,
        bind: "127.0.0.1",
      },
    },
    tools: {
      disclosure: "progressive",
    },
  },
  hermes: {
    interfaces: {
      api: { port: 8642 },
      dashboard: {
        enabled: true,
        port: 18_789,
        internalPort: 19_119,
        tuiEnabled: true,
      },
    },
  },
} as const;
