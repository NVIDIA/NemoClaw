// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const TOKEN_ROTATION_ORDER_ENV = "NEMOCLAW_TOKEN_ROTATION_ORDER";

export type TokenRotationOrder = "telegram-first" | "discord-first";
export type SequentialTokenRotationProvider = "telegram" | "discord";

export interface TokenRotationTokenSet {
  readonly telegram: string;
  readonly discord: string;
  readonly slackBot: string;
  readonly slackApp: string;
}

export interface SequentialTokenRotationStep {
  readonly provider: SequentialTokenRotationProvider;
  readonly displayName: "Telegram" | "Discord";
  readonly artifactSlug: "telegram" | "discord";
  readonly phaseNumber: number;
  readonly reusePhaseNumber: number;
  readonly providerSuffixes: readonly ["telegram-bridge"] | readonly ["discord-bridge"];
  readonly tokens: TokenRotationTokenSet;
}

const ORDERED_PROVIDERS = Object.freeze({
  "telegram-first": Object.freeze(["telegram", "discord"] as const),
  "discord-first": Object.freeze(["discord", "telegram"] as const),
}) satisfies Readonly<Record<TokenRotationOrder, readonly SequentialTokenRotationProvider[]>>;

export const TOKEN_ROTATION_PROVIDER_SUFFIXES = Object.freeze([
  "telegram-bridge",
  "discord-bridge",
  "slack-bridge",
  "slack-app",
] as const);

export function parseTokenRotationOrder(value: string | undefined): TokenRotationOrder {
  const selector = value?.trim();
  // Keep the hosted target on the reversed order while #8690 is under
  // diagnosis; historical artifacts already cover Telegram-first.
  if (!selector) return "discord-first";
  if (selector === "telegram-first" || selector === "discord-first") return selector;
  throw new Error(`${TOKEN_ROTATION_ORDER_ENV} must be 'telegram-first' or 'discord-first'.`);
}

function rotateProviderToken(
  current: TokenRotationTokenSet,
  replacement: TokenRotationTokenSet,
  provider: SequentialTokenRotationProvider,
): TokenRotationTokenSet {
  return Object.freeze(
    provider === "telegram"
      ? { ...current, telegram: replacement.telegram }
      : { ...current, discord: replacement.discord },
  );
}

export function buildSequentialTokenRotationSteps(
  order: TokenRotationOrder,
  initial: TokenRotationTokenSet,
  replacement: TokenRotationTokenSet,
): readonly SequentialTokenRotationStep[] {
  let current: TokenRotationTokenSet = Object.freeze({ ...initial });
  return Object.freeze(
    ORDERED_PROVIDERS[order].map((provider, index) => {
      current = rotateProviderToken(current, replacement, provider);
      const phaseNumber = 2 + index * 2;
      return Object.freeze(
        provider === "telegram"
          ? {
              provider,
              displayName: "Telegram" as const,
              artifactSlug: "telegram" as const,
              phaseNumber,
              reusePhaseNumber: phaseNumber + 1,
              providerSuffixes: Object.freeze(["telegram-bridge"] as const),
              tokens: current,
            }
          : {
              provider,
              displayName: "Discord" as const,
              artifactSlug: "discord" as const,
              phaseNumber,
              reusePhaseNumber: phaseNumber + 1,
              providerSuffixes: Object.freeze(["discord-bridge"] as const),
              tokens: current,
            },
      );
    }),
  );
}

export function tokenRotationPhaseNames(
  steps: readonly SequentialTokenRotationStep[],
): readonly string[] {
  return Object.freeze(
    steps.flatMap((step) => [
      `rotate only the ${step.displayName} provider`,
      `reuse the sandbox after the unchanged ${step.displayName} token`,
    ]),
  );
}
