// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "../channels";
import { MessagingWorkflowPlanner } from "../compiler/workflow-planner";
import { createBuiltInMessagingHookRegistry } from "../hooks";
import type { MessagingAgentId, SandboxMessagingPlan } from "../manifest";

export const TEST_TELEGRAM_TOKEN = "123456:test-telegram-token";

export interface CompileTelegramPlanOptions {
  readonly envOverrides: Readonly<Record<string, string | undefined>>;
  readonly sandboxName?: string;
  readonly agent?: MessagingAgentId;
  readonly isInteractive?: boolean;
}

export async function compileTelegramPlanForTests(
  options: CompileTelegramPlanOptions,
): Promise<SandboxMessagingPlan> {
  const { envOverrides, sandboxName = "alpha", agent = "openclaw", isInteractive = true } = options;
  const planner = new MessagingWorkflowPlanner(
    createBuiltInChannelManifestRegistry(),
    createBuiltInMessagingHookRegistry({
      common: {
        env: { TELEGRAM_BOT_TOKEN: TEST_TELEGRAM_TOKEN, ...envOverrides },
        getCredential: (key) => (key === "TELEGRAM_BOT_TOKEN" ? TEST_TELEGRAM_TOKEN : null),
        saveCredential: () => {},
        prompt: async () => "unused",
        log: () => {},
      },
      telegram: {
        fetch: async () => ({
          ok: true,
          status: 200,
          async json() {
            return { ok: true };
          },
          async text() {
            return "";
          },
        }),
      },
    }),
    createBuiltInRenderTemplateResolver(),
  );
  return withTelegramEnvOverrides(envOverrides, () =>
    planner.buildPlan({
      sandboxName,
      agent,
      workflow: "onboard",
      isInteractive,
      configuredChannels: ["telegram"],
    }),
  );
}

export async function withTelegramEnvOverrides<T>(
  values: Readonly<Record<string, string | undefined>>,
  run: () => Promise<T>,
): Promise<T> {
  const merged = { TELEGRAM_BOT_TOKEN: TEST_TELEGRAM_TOKEN, ...values };
  const previous = Object.fromEntries(Object.keys(merged).map((key) => [key, process.env[key]]));
  applyEnvForTests(merged);
  try {
    return await run();
  } finally {
    applyEnvForTests(previous);
  }
}

// Per-key set/restore via `vi.stubEnv` keeps the helper's environment edits
// scoped to the tests that call it. `vi.unstubAllEnvs()` (the canonical
// counterpart) would clear stubs registered by concurrent unrelated tests in
// the same worker, so the explicit per-key restore in `withTelegramEnvOverrides`
// guards isolation rather than a coarser revert.
export function applyEnvForTests(values: Readonly<Record<string, string | undefined>>): void {
  for (const [key, value] of Object.entries(values)) {
    vi.stubEnv(key, value as string);
  }
}
