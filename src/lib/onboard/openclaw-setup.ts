// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export interface OpenclawSetupDeps {
  step(n: number, total: number, msg: string): void;
  agentProductName(): string;
  getProviderSelectionConfig(provider: string, model: string): unknown | null;
  buildSandboxConfigSyncScript(config: any): string;
  writeSandboxConfigSyncFile(script: string): string;
  run(argv: string[], options: Record<string, unknown>): unknown;
  openshellArgv(args: string[]): string[];
  cleanupTempDir(file: string, prefix: string): void;
}

export function createOpenclawSetup(deps: OpenclawSetupDeps) {
  return async function setupOpenclaw(
    sandboxName: string,
    model: string,
    provider: string,
  ): Promise<void> {
    deps.step(7, 8, `Setting up ${deps.agentProductName()} inside sandbox`);

    const selectionConfig = deps.getProviderSelectionConfig(provider, model);
    if (selectionConfig) {
      const sandboxConfig = {
        ...(selectionConfig as Record<string, unknown>),
        onboardedAt: new Date().toISOString(),
      };
      const script = deps.buildSandboxConfigSyncScript(sandboxConfig);
      const scriptFile = deps.writeSandboxConfigSyncFile(script);
      try {
        const scriptContent = fs.readFileSync(scriptFile, "utf-8");
        deps.run(deps.openshellArgv(["sandbox", "connect", sandboxName]), {
          stdio: ["pipe", "ignore", "inherit"],
          input: scriptContent,
        });
      } finally {
        deps.cleanupTempDir(scriptFile, "nemoclaw-sync");
      }
    }

    console.log(`  ✓ ${deps.agentProductName()} gateway launched inside sandbox`);
  };
}
