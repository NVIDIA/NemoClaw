// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import { reconcileRegisteredExtraProviders } from "./extra-provider-reconciliation";

export type ProbeResult = {
  status: number | null;
  error?: Error;
  output?: unknown;
  stdout?: unknown;
  stderr?: unknown;
};

export const LIMIT = 64 * 1024;

export const ok = (): ProbeResult => ({ status: 0, stdout: "" });

export const missing = (name: string): ProbeResult => ({
  status: 1,
  stderr: `Error: provider '${name}' not found`,
});

export function reconcile(
  recorded: string[],
  responses: Record<string, ProbeResult | (() => ProbeResult)> = {},
  extra: Partial<Parameters<typeof reconcileRegisteredExtraProviders>[1]> = {},
): string[] {
  return reconcileRegisteredExtraProviders("nemoclaw", {
    listExtraProviders: () => [...recorded],
    removeExtraProvider: () => true,
    runOpenshell: vi.fn((args: string[]): ProbeResult => {
      const response = responses[args.at(-1) ?? ""];
      return typeof response === "function" ? response() : (response ?? ok());
    }),
    warn: () => undefined,
    ...extra,
  });
}
