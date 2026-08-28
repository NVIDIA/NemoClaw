// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import type { RebuildRecreateJournal } from "../../src/lib/actions/sandbox/rebuild-recreate-journal";

export function stubRecreateJournal(): RebuildRecreateJournal {
  return {
    id: "journal-1",
    acceptedTarget: false,
    sourceConfirmedAbsent: false,
    gatewayAuthority: {
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    },
    targetGeneration: "generation-1",
    targetIntentFingerprint: "intent-1",
    markDeleting: vi.fn(),
    observeSourceForDelete: vi.fn(() => "source" as const),
    confirmDeleted: vi.fn(),
    completeAcceptedTarget: vi.fn(),
  };
}
