// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  appendExtraPlaceholderKeysEnvArg,
  canonicalPlaceholderKeys,
  EXTRA_PLACEHOLDER_KEYS_ENV,
  EXTRA_PLACEHOLDER_KEYS_MAX,
  parseExtraPlaceholderKeys,
  registerExtraPlaceholderProviders,
} from "./extra-placeholder-keys";

const CANONICAL_ENVKEYS_FIXTURE = new Set([
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "WECHAT_BOT_TOKEN",
  "BRAVE_API_KEY",
  "TAVILY_API_KEY",
]);

describe("parseExtraPlaceholderKeys", () => {
  it("returns empty result for unset, blank, or whitespace-only input", () => {
    expect(parseExtraPlaceholderKeys(undefined)).toEqual({ keys: [], warnings: [] });
    expect(parseExtraPlaceholderKeys(null)).toEqual({ keys: [], warnings: [] });
    expect(parseExtraPlaceholderKeys("")).toEqual({ keys: [], warnings: [] });
    expect(parseExtraPlaceholderKeys("   \t  ")).toEqual({ keys: [], warnings: [] });
  });

  it("accepts whitespace- and comma-separated upper-snake tokens that extend canonical channel envKeys", () => {
    const result = parseExtraPlaceholderKeys(
      "TELEGRAM_BOT_TOKEN_AGENT_A TELEGRAM_BOT_TOKEN_AGENT_B,DISCORD_BOT_TOKEN_AGENT_C\tBRAVE_API_KEY_AGENT_D",
      CANONICAL_ENVKEYS_FIXTURE,
    );
    expect(result.keys).toEqual([
      "TELEGRAM_BOT_TOKEN_AGENT_A",
      "TELEGRAM_BOT_TOKEN_AGENT_B",
      "DISCORD_BOT_TOKEN_AGENT_C",
      "BRAVE_API_KEY_AGENT_D",
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects tokens that do not match the upper-snake pattern with a single warning each", () => {
    const result = parseExtraPlaceholderKeys(
      "telegram_bot_token 9NUM_START Path$Bad TELEGRAM_BOT_TOKEN_OK",
      CANONICAL_ENVKEYS_FIXTURE,
    );
    expect(result.keys).toEqual(["TELEGRAM_BOT_TOKEN_OK"]);
    expect(result.warnings).toContain(
      `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "telegram_bot_token" — must match /^[A-Z][A-Z0-9_]{0,127}$/`,
    );
    expect(result.warnings).toContain(
      `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "9NUM_START" — must match /^[A-Z][A-Z0-9_]{0,127}$/`,
    );
    expect(result.warnings).toContain(
      `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "Path$Bad" — must match /^[A-Z][A-Z0-9_]{0,127}$/`,
    );
  });

  it("rejects tokens that exactly equal a canonical credential name", () => {
    const result = parseExtraPlaceholderKeys(
      "TELEGRAM_BOT_TOKEN TELEGRAM_BOT_TOKEN_AGENT_A BRAVE_API_KEY",
      CANONICAL_ENVKEYS_FIXTURE,
    );
    expect(result.keys).toEqual(["TELEGRAM_BOT_TOKEN_AGENT_A"]);
  });

  it("refuses arbitrary host secret environment-variable names", () => {
    const result = parseExtraPlaceholderKeys(
      [
        "GITHUB_TOKEN",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_ACCESS_KEY_ID",
        "NPM_TOKEN",
        "KUBECONFIG",
        EXTRA_PLACEHOLDER_KEYS_ENV,
        "TELEGRAM_BOT_TOKEN_AGENT_A",
      ].join(" "),
      CANONICAL_ENVKEYS_FIXTURE,
    );
    expect(result.keys).toEqual(["TELEGRAM_BOT_TOKEN_AGENT_A"]);
  });

  it("dedupes repeated tokens without emitting a warning", () => {
    const result = parseExtraPlaceholderKeys(
      "TELEGRAM_BOT_TOKEN_A TELEGRAM_BOT_TOKEN_A SLACK_BOT_TOKEN_B TELEGRAM_BOT_TOKEN_A",
      CANONICAL_ENVKEYS_FIXTURE,
    );
    expect(result.keys).toEqual(["TELEGRAM_BOT_TOKEN_A", "SLACK_BOT_TOKEN_B"]);
    expect(result.warnings).toEqual([]);
  });

  it("caps the parsed list at EXTRA_PLACEHOLDER_KEYS_MAX entries and warns about the remainder", () => {
    const tokens = Array.from(
      { length: EXTRA_PLACEHOLDER_KEYS_MAX + 5 },
      (_, i) => `TELEGRAM_BOT_TOKEN_${i}`,
    );
    const result = parseExtraPlaceholderKeys(tokens.join(" "), CANONICAL_ENVKEYS_FIXTURE);
    expect(result.keys).toHaveLength(EXTRA_PLACEHOLDER_KEYS_MAX);
    expect(result.warnings).toContain(
      `${EXTRA_PLACEHOLDER_KEYS_ENV}: capped at ${EXTRA_PLACEHOLDER_KEYS_MAX} entries; remaining tokens ignored`,
    );
  });
});

describe("canonicalPlaceholderKeys", () => {
  it.each([
    "TELEGRAM_BOT_TOKEN",
    "DISCORD_BOT_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "WECHAT_BOT_TOKEN",
    "BRAVE_API_KEY",
    "TAVILY_API_KEY",
  ])("returns the canonical channel envKeys plus web-search API keys [case %#]", (expected) => {
    const canonical = canonicalPlaceholderKeys();

    expect(canonical.has(expected)).toBe(true);
  });

  it("does not leak the control env or arbitrary host secret env names", () => {
    const canonical = canonicalPlaceholderKeys();
    expect(canonical.has(EXTRA_PLACEHOLDER_KEYS_ENV)).toBe(false);
    expect(canonical.has("GITHUB_TOKEN")).toBe(false);
    expect(canonical.has("AWS_SECRET_ACCESS_KEY")).toBe(false);
  });
});

describe("registerExtraPlaceholderProviders", () => {
  function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
      previous[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("adds validated credentials to their canonical providers (#10153)", () => {
    withEnv(
      {
        [EXTRA_PLACEHOLDER_KEYS_ENV]: "TELEGRAM_BOT_TOKEN_AGENT_A SLACK_BOT_TOKEN_AGENT_B",
        TELEGRAM_BOT_TOKEN_AGENT_A: "telegram-token-A",
        SLACK_BOT_TOKEN_AGENT_B: "slack-token-B",
      },
      () => {
        const messagingTokenDefs = [
          {
            name: "my-sandbox-telegram-bridge",
            envKey: "TELEGRAM_BOT_TOKEN",
            token: "telegram-token",
            providerType: "nemoclaw-mcp-v1",
          },
          {
            name: "my-sandbox-slack-bridge",
            envKey: "SLACK_BOT_TOKEN",
            token: "slack-token",
            providerType: "nemoclaw-mcp-v1",
          },
        ];
        const warnings: string[] = [];
        const extraKeys = registerExtraPlaceholderProviders(messagingTokenDefs, (m) =>
          warnings.push(m),
        );
        expect(extraKeys).toEqual(["TELEGRAM_BOT_TOKEN_AGENT_A", "SLACK_BOT_TOKEN_AGENT_B"]);
        expect(warnings).toEqual([]);
        expect(messagingTokenDefs).toEqual([
          {
            name: "my-sandbox-telegram-bridge",
            envKey: "TELEGRAM_BOT_TOKEN",
            token: "telegram-token",
            providerType: "nemoclaw-mcp-v1",
            additionalCredentials: [
              { envKey: "TELEGRAM_BOT_TOKEN_AGENT_A", token: "telegram-token-A" },
            ],
          },
          {
            name: "my-sandbox-slack-bridge",
            envKey: "SLACK_BOT_TOKEN",
            token: "slack-token",
            providerType: "nemoclaw-mcp-v1",
            additionalCredentials: [
              { envKey: "SLACK_BOT_TOKEN_AGENT_B", token: "slack-token-B" },
            ],
          },
        ]);
      },
    );
  });

  it("records a missing extension without submitting a credential value", () => {
    withEnv(
      {
        [EXTRA_PLACEHOLDER_KEYS_ENV]: "TELEGRAM_BOT_TOKEN_AGENT_MISSING",
        TELEGRAM_BOT_TOKEN_AGENT_MISSING: undefined,
      },
      () => {
        const messagingTokenDefs = [
          {
            name: "my-sandbox-telegram-bridge",
            envKey: "TELEGRAM_BOT_TOKEN",
            token: "telegram-token",
            providerType: "nemoclaw-mcp-v1",
          },
        ];
        const extraKeys = registerExtraPlaceholderProviders(messagingTokenDefs);
        expect(extraKeys).toEqual(["TELEGRAM_BOT_TOKEN_AGENT_MISSING"]);
        expect(messagingTokenDefs).toEqual([
          {
            name: "my-sandbox-telegram-bridge",
            envKey: "TELEGRAM_BOT_TOKEN",
            token: "telegram-token",
            providerType: "nemoclaw-mcp-v1",
            additionalCredentials: [
              { envKey: "TELEGRAM_BOT_TOKEN_AGENT_MISSING", token: null },
            ],
          },
        ]);
      },
    );
  });

  it("logs the parser warning when the operator supplies a non-extending host secret name", () => {
    withEnv(
      {
        [EXTRA_PLACEHOLDER_KEYS_ENV]: "GITHUB_TOKEN TELEGRAM_BOT_TOKEN_AGENT_A",
        GITHUB_TOKEN: "would-leak-if-registered",
        TELEGRAM_BOT_TOKEN_AGENT_A: "telegram-token-A",
      },
      () => {
        const messagingTokenDefs = [
          {
            name: "my-sandbox-telegram-bridge",
            envKey: "TELEGRAM_BOT_TOKEN",
            token: "telegram-token",
            providerType: "nemoclaw-mcp-v1",
          },
        ];
        const warnings: string[] = [];
        const extraKeys = registerExtraPlaceholderProviders(messagingTokenDefs, (m) =>
          warnings.push(m),
        );
        expect(extraKeys).toEqual(["TELEGRAM_BOT_TOKEN_AGENT_A"]);
        expect(messagingTokenDefs).toEqual([
          {
            name: "my-sandbox-telegram-bridge",
            envKey: "TELEGRAM_BOT_TOKEN",
            token: "telegram-token",
            providerType: "nemoclaw-mcp-v1",
            additionalCredentials: [
              { envKey: "TELEGRAM_BOT_TOKEN_AGENT_A", token: "telegram-token-A" },
            ],
          },
        ]);
        // The host secret never makes it onto a provider row, so the token
        // value cannot leak into the sandbox gateway.
        expect(JSON.stringify(messagingTokenDefs)).not.toContain("would-leak-if-registered");
        expect(warnings.some((w) => w.includes('"GITHUB_TOKEN"'))).toBe(true);
      },
    );
  });

});

describe("appendExtraPlaceholderKeysEnvArg", () => {
  function formatEnvAssignment(key: string, value: string): string {
    return `${key}=${value}`;
  }

  it("appends one comma-joined env arg containing only the key names, never their token values", () => {
    const envArgs: string[] = [];
    appendExtraPlaceholderKeysEnvArg(
      envArgs,
      ["TELEGRAM_BOT_TOKEN_AGENT_A", "SLACK_BOT_TOKEN_AGENT_B"],
      formatEnvAssignment,
    );
    expect(envArgs).toEqual([
      `${EXTRA_PLACEHOLDER_KEYS_ENV}=TELEGRAM_BOT_TOKEN_AGENT_A,SLACK_BOT_TOKEN_AGENT_B`,
    ]);
    // The emitted env arg holds only the key list, not the resolved token
    // value. Operators who set the credential see openshell:resolve:env:<KEY>
    // inside the sandbox; the secret itself never travels through env-arg
    // propagation.
    expect(envArgs.every((arg) => !arg.includes("token"))).toBe(true);
  });

  it("survives the OpenShell split_whitespace command round trip", () => {
    const envArgs: string[] = [];
    appendExtraPlaceholderKeysEnvArg(
      envArgs,
      ["TELEGRAM_BOT_TOKEN_AGENT_A", "SLACK_BOT_TOKEN_AGENT_B"],
      formatEnvAssignment,
    );

    const commandTokens = ["env", ...envArgs, "nemoclaw-start"].join(" ").split(/\s+/u);
    const assignment = commandTokens.find((token) =>
      token.startsWith(`${EXTRA_PLACEHOLDER_KEYS_ENV}=`),
    );
    expect(assignment).toBe(
      `${EXTRA_PLACEHOLDER_KEYS_ENV}=TELEGRAM_BOT_TOKEN_AGENT_A,SLACK_BOT_TOKEN_AGENT_B`,
    );

    const rawValue = assignment?.slice(EXTRA_PLACEHOLDER_KEYS_ENV.length + 1);
    expect(parseExtraPlaceholderKeys(rawValue, CANONICAL_ENVKEYS_FIXTURE)).toEqual({
      keys: ["TELEGRAM_BOT_TOKEN_AGENT_A", "SLACK_BOT_TOKEN_AGENT_B"],
      warnings: [],
    });
  });

  it("emits no env arg when the extras list is empty", () => {
    const envArgs: string[] = [];
    appendExtraPlaceholderKeysEnvArg(envArgs, [], formatEnvAssignment);
    expect(envArgs).toEqual([]);
  });
});
