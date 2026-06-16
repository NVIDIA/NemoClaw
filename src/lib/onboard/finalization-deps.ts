// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Lazy-require runtime dependencies for the onboarding finalization handler.
// Kept in a focused module under src/lib/onboard/ so the top-level onboard
// entrypoint stays lean (codebase-growth-guardrails). The lazy `require` calls
// avoid an import cycle: connect.ts and process-recovery.ts both pull in
// onboard helpers, so they must not be statically imported here.
export const finalizationHandlerDeps = {
  checkAndRecoverSandboxProcesses(name: string, options: { quiet: boolean }): void {
    const processRecovery: typeof import("../actions/sandbox/process-recovery") =
      require("../actions/sandbox/process-recovery");
    processRecovery.checkAndRecoverSandboxProcesses(name, options);
  },
  // Best-effort device-approval sweep that clears pending allowlisted
  // CLI/webchat scope upgrades so onboard hands off without a stuck pairing
  // request (#4504). Never throws.
  autoPairScopeApproval(name: string): void {
    const connect: typeof import("../actions/sandbox/connect") =
      require("../actions/sandbox/connect");
    connect.runConnectAutoPairApprovalPass(name);
  },
  // Provoke the operator.write scope upgrade with a throwaway in-sandbox agent
  // run so the request is PENDING when the approval pass above clears it,
  // letting the user's first real run connect without an embedded fallback
  // (#4504-v2). Best-effort; never throws.
  warmupScopeUpgrade(name: string): void {
    const warmup: typeof import("../actions/sandbox/auto-pair-warmup") =
      require("../actions/sandbox/auto-pair-warmup");
    warmup.runSandboxScopeWarmupRun(name);
  },
};
