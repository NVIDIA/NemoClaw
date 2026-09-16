// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Consumed shapes of private OpenClaw bundles, which ship no declarations.
// The native fixtures verify these boundaries against the pinned image.
interface FixtureTool {
  name: string;
  execute(id: string, args: Record<string, unknown>): Promise<unknown>;
}

declare module "*/agent-tools-CNTtT1Sj.mjs" {
  export function createOpenClawCodingTools(options: {
    config: unknown;
    agentId: string;
    sessionKey: string;
    workspaceDir: string;
    cwd: string;
    includeToolSearchControls?: boolean;
    toolSearchCatalogRef?: unknown;
  }): FixtureTool[];
}

declare module "*/local-model-lean-Ct7p3GNL.mjs" {
  export function v(): unknown;
  export function a(options: { config: unknown; tools: FixtureTool[]; catalogRef: unknown }): {
    tools: FixtureTool[];
  };
}

declare module "*/runtime-3_-fmbqF.mjs" {
  export function u<T>(options: {
    config: T;
    env: NodeJS.ProcessEnv;
    includeAuthStoreRefs: boolean;
  }): Promise<{ config: T }>;
}

declare module "*/brave-web-search-provider-CY6mh6hm.js" {
  export function t(): {
    createTool(options: { config: unknown; searchConfig: unknown }): {
      execute(args: { query: string; count: number }): Promise<unknown>;
    };
  };
}

declare module "*/cli/run-main.js" {
  export function runCli(argv: string[]): Promise<void>;
}
