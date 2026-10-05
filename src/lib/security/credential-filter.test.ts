// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  makeEmptyClaimsJwtFixture,
  makeJwtFixture,
} from "../../../test/helpers/security-token-fixtures";

import {
  isCredentialField,
  isConfigValue,
  isSafeCredentialPlaceholder,
  isSensitiveFile,
  npmConfigContainsCredentialDirective,
  sanitizeEnvFileContent,
  stripCredentials,
  textContainsCredential,
  textContainsHighConfidenceCredential,
  valueLooksLikeSecret,
} from "./credential-filter.js";
import { HERMES_PROXY_REWRITE_SENTINEL } from "../hermes-managed-route.js";

function expectCredentialFieldClassification(fields: readonly string[], expected: boolean): void {
  for (const field of fields) {
    expect(isCredentialField(field), field).toBe(expected);
  }
}

function expectStrippedCredentialFields(
  result: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    expect(result[field], field).toBe("[STRIPPED_BY_MIGRATION]");
  }
}

describe("isCredentialField", () => {
  it("matches explicit field names", () => {
    expect(isCredentialField("apiKey")).toBe(true);
    expect(isCredentialField("api_key")).toBe(true);
    expect(isCredentialField("token")).toBe(true);
    expect(isCredentialField("secret")).toBe(true);
    expect(isCredentialField("password")).toBe(true);
    expect(isCredentialField("resolvedKey")).toBe(true);
  });

  it("matches pattern-based names", () => {
    expect(isCredentialField("accessToken")).toBe(true);
    expect(isCredentialField("access_token")).toBe(true);
    expect(isCredentialField("personal_access_token")).toBe(true);
    expect(isCredentialField("refreshToken")).toBe(true);
    expect(isCredentialField("refresh-token")).toBe(true);
    expect(isCredentialField("clientSecret")).toBe(true);
    expect(isCredentialField("client_secret")).toBe(true);
    expect(isCredentialField("bearerToken")).toBe(true);
    expect(isCredentialField("auth_token")).toBe(true);
    expect(isCredentialField("oauth_token")).toBe(true);
    expect(isCredentialField("apikey")).toBe(true);
    expect(isCredentialField("Token")).toBe(true);
    expect(isCredentialField("privateKey")).toBe(true);
    expect(isCredentialField("signingKey")).toBe(true);
    expect(isCredentialField("sessionToken")).toBe(true);
    expect(isCredentialField("sessionKey")).toBe(true);
    expect(isCredentialField("authKey")).toBe(true);
    // OpenClaw channel token fields (#5027).
    expect(isCredentialField("botToken")).toBe(true);
    expect(isCredentialField("bot_token")).toBe(true);
    expect(isCredentialField("appToken")).toBe(true);
    expect(isCredentialField("app_token")).toBe(true);
  });

  it("strips opaque values under common OAuth and channel field spellings", () => {
    expect(
      stripCredentials({
        access_token: "opaque-access-value",
        refresh_token: "opaque-refresh-value",
        client_secret: "opaque-client-value",
        auth_token: "opaque-auth-value",
        bot_token: "opaque-bot-value",
        apikey: "opaque-api-value",
      }),
    ).toEqual({
      access_token: "[STRIPPED_BY_MIGRATION]",
      refresh_token: "[STRIPPED_BY_MIGRATION]",
      client_secret: "[STRIPPED_BY_MIGRATION]",
      auth_token: "[STRIPPED_BY_MIGRATION]",
      bot_token: "[STRIPPED_BY_MIGRATION]",
      apikey: "[STRIPPED_BY_MIGRATION]",
    });
  });

  it("matches terminal pass aliases without treating pass substrings as credentials", () => {
    expectCredentialFieldClassification(
      [
        "pass",
        "passwd",
        "customPass",
        "customPasswd",
        "DBPass",
        "db_pass",
        "db_passwd",
        "db-pass",
        "db-passwd",
      ],
      true,
    );
    expectCredentialFieldClassification(
      ["COMPASS", "BYPASS", "passengerCount", "passed", "passRate", "passCount", "passThrough"],
      false,
    );
  });

  it("matches env-variable-style secret names (#5027)", () => {
    expect(isCredentialField("GITHUB_TOKEN")).toBe(true);
    expect(isCredentialField("BRAVE_API_KEY")).toBe(true);
    expect(isCredentialField("OPENAI_API_KEY")).toBe(true);
    expect(isCredentialField("API_SERVER_KEY")).toBe(true);
    expect(isCredentialField("NEMOCLAW_PROVIDER_KEY")).toBe(true);
    expect(isCredentialField("DB_PASSWORD")).toBe(true);
    expect(isCredentialField("DB_PASSWD")).toBe(true);
    expect(isCredentialField("DB_PASS")).toBe(true);
    expect(isCredentialField("SLACK_APP_TOKEN")).toBe(true);
    // Bare uppercase secret words must also be scrubbed.
    expect(isCredentialField("TOKEN")).toBe(true);
    expect(isCredentialField("PASSWORD")).toBe(true);
    expect(isCredentialField("PASSWD")).toBe(true);
    expect(isCredentialField("PASS")).toBe(true);
    expect(isCredentialField("SECRET")).toBe(true);
    expect(isCredentialField("CREDENTIALS")).toBe(true);
  });

  it("matches well-known HTTP auth header names (#5027)", () => {
    expect(isCredentialField("Authorization")).toBe(true);
    expect(isCredentialField("authorization")).toBe(true);
    expect(isCredentialField("Proxy-Authorization")).toBe(true);
    expect(isCredentialField("X-API-Key")).toBe(true);
    expect(isCredentialField("X-API-Token")).toBe(true);
    expect(isCredentialField("x-auth-token")).toBe(true);
    expect(isCredentialField("Private-Token")).toBe(true);
    expect(isCredentialField("X-Custom-Auth")).toBe(true);
    expect(isCredentialField("Cookie")).toBe(true);
  });

  it("does not match safe field names", () => {
    expect(isCredentialField("name")).toBe(false);
    expect(isCredentialField("model")).toBe(false);
    expect(isCredentialField("provider")).toBe(false);
    expect(isCredentialField("endpoint")).toBe(false);
    expect(isCredentialField("version")).toBe(false);
    // Benign env/setting names must not be scrubbed.
    expect(isCredentialField("NODE_ENV")).toBe(false);
    expect(isCredentialField("LOG_LEVEL")).toBe(false);
    expect(isCredentialField("PATH")).toBe(false);
    expect(isCredentialField("tokenizer")).toBe(false);
    expect(isCredentialField("maxTokens")).toBe(false);
    expect(isCredentialField("displayName")).toBe(false);
    expect(isCredentialField("sortKey")).toBe(false);
    expect(isCredentialField("sessionId")).toBe(false);
    expect(isCredentialField("accessLevel")).toBe(false);
    expect(isCredentialField("X-Request-Id")).toBe(false);
    expect(isCredentialField("author")).toBe(false);
  });

  it("does not strip public keys (verification material, not secrets)", () => {
    expect(isCredentialField("publicKey")).toBe(false);
    expect(isCredentialField("PUBLIC_KEY")).toBe(false);
    expect(isCredentialField("public-key")).toBe(false);
    expect(isCredentialField("public.key")).toBe(false);
    expect(isCredentialField("X-Public-Key")).toBe(false);
    expect(isCredentialField("GITHUB_PUBLIC_KEY")).toBe(false);
    // But private keys and other secret fields still match.
    expect(isCredentialField("privateKey")).toBe(true);
    expect(isCredentialField("PRIVATE_KEY")).toBe(true);
    expect(isCredentialField("apiKey")).toBe(true);
  });
});

describe("valueLooksLikeSecret", () => {
  it("matches recognizable secret formats", () => {
    expect(valueLooksLikeSecret("ghp_0123456789abcdef")).toBe(true);
    expect(valueLooksLikeSecret("sk-proj-0123456789abcdefghij")).toBe(true);
    expect(valueLooksLikeSecret("xoxb-123456789-abcdefghij")).toBe(true);
    expect(valueLooksLikeSecret(makeJwtFixture())).toBe(true);
    expect(valueLooksLikeSecret(makeEmptyClaimsJwtFixture())).toBe(true);
    expect(valueLooksLikeSecret("Bearer abcdef0123456789")).toBe(true);
  });

  it("does not match benign values", () => {
    expect(valueLooksLikeSecret("npx")).toBe(false);
    expect(valueLooksLikeSecret("https://integrate.api.nvidia.com/v1")).toBe(false);
    expect(valueLooksLikeSecret("moonshotai/kimi-k2")).toBe(false);
    expect(valueLooksLikeSecret("production")).toBe(false);
  });
});

describe("textContainsHighConfidenceCredential", () => {
  it("does not flag generated placeholder matcher source as a Slack credential", () => {
    expect(
      textContainsHighConfidenceCredential(
        String.raw`const bot = /^xoxb-OPENSHELL-RESOLVE-ENV-[A-Za-z0-9_]+$/u; const app = /^xapp-OPENSHELL-RESOLVE-ENV-[A-Za-z0-9_]+$/u;`,
      ),
    ).toBe(false);
  });

  it.each([
    "xoxb-OPENSHELL-RESOLVE-ENV-SLACK-BOT-TOKEN",
    "xapp-OPENSHELL-RESOLVE-ENV-SLACK-APP-TOKEN",
  ])("flags malformed Slack placeholder-shaped credentials: %s", (value) => {
    expect(textContainsHighConfidenceCredential(value)).toBe(true);
  });

  it("does not flag the reserved Hermes proxy rewrite sentinel as a credential", () => {
    expect(textContainsHighConfidenceCredential(HERMES_PROXY_REWRITE_SENTINEL)).toBe(false);
    expect(textContainsHighConfidenceCredential(`${HERMES_PROXY_REWRITE_SENTINEL}-secret`)).toBe(
      true,
    );
  });

  it("allows only the canonical public JWT documentation vector", () => {
    const publicJwt = [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join(".");

    expect(textContainsHighConfidenceCredential(publicJwt)).toBe(false);
    expect(textContainsHighConfidenceCredential(makeJwtFixture())).toBe(true);
  });

  it.each([["AKIA", "IOSFODNN7EXAMPLE"].join(""), ["AKIA", "I44QH8DHBEXAMPLE"].join("")])(
    "allows only the public AWS documentation access key %s",
    (publicAwsAccessKey) => {
      expect(textContainsHighConfidenceCredential(publicAwsAccessKey)).toBe(false);
      expect(textContainsHighConfidenceCredential(`${publicAwsAccessKey.slice(0, -1)}1`)).toBe(
        true,
      );
      expect(textContainsHighConfidenceCredential(`${publicAwsAccessKey}1`)).toBe(true);
    },
  );

  it("allows only whatsapp-rust-bridge's public WASM byte sequence", () => {
    const publishedBytes = ["AKIA", "1JDQYCQC", "ANIA9GDQ"].join("");

    expect(textContainsHighConfidenceCredential(publishedBytes)).toBe(false);
    expect(textContainsHighConfidenceCredential(`${publishedBytes.slice(0, -1)}1`)).toBe(true);
  });

  it("allows only MSAL's synthetic private-key documentation block", () => {
    const begin = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const end = ["-----END", "PRIVATE KEY-----"].join(" ");
    const documentedShape = `${begin} ... ${end}`;
    const actualBlock = `${begin}\nnot-public-key-material\n${end}`;

    expect(textContainsHighConfidenceCredential(documentedShape)).toBe(false);
    expect(textContainsHighConfidenceCredential(actualBlock)).toBe(true);
  });

  it("allows only botocore's synthetic DSA private-key documentation block", () => {
    const begin = ["-----BEGIN", "DSA PRIVATE KEY-----"].join(" ");
    const end = ["-----END", "DSA PRIVATE KEY-----"].join(" ");

    expect(
      textContainsHighConfidenceCredential(`${begin}<a very long private key string>${end}`),
    ).toBe(false);
    expect(textContainsHighConfidenceCredential(`${begin}\nprivate-key-material\n${end}`)).toBe(
      true,
    );
  });

  it("continues to flag real Slack credentials", () => {
    expect(textContainsHighConfidenceCredential("xoxb-123456789-abcdefghij")).toBe(true);
    expect(textContainsHighConfidenceCredential("xapp-1-A1234567890-abcdef123456")).toBe(true);
  });

  it("preserves visibly synthetic token examples in upstream documentation", () => {
    expect(textContainsHighConfidenceCredential(["ghp_", "x".repeat(20)].join(""))).toBe(false);
    expect(textContainsHighConfidenceCredential(["sk-", "x".repeat(20)].join(""))).toBe(false);
    expect(textContainsHighConfidenceCredential(["ghp_", "0123456789abcdef"].join(""))).toBe(true);
  });

  it("does not treat sk- inside an ordinary hyphenated word as a token prefix", () => {
    expect(textContainsHighConfidenceCredential("task-concurrency-diagnosis")).toBe(false);
    expect(textContainsHighConfidenceCredential(["sk-", "0123456789abcdefghij"].join(""))).toBe(
      true,
    );
  });
});

describe("textContainsCredential", () => {
  it.each([
    "request failed: Authorization: Bearer opaqueCredentialPayloadZ1234567890",
    "password=abc",
    "sessionToken=opaqueCredentialPayloadZ1234567890",
    '  "client_secret": "opaqueCredentialPayloadZ1234567890"',
    '{"nested":{"sessionToken":"opaqueCredentialPayloadZ1234567890"}}',
    "//registry.example/:_authToken=opaqueCredentialPayloadZ1234567890",
  ])("flags opaque credential context in arbitrary text: %s", (value) => {
    expect(textContainsCredential(value)).toBe(true);
  });

  it.each([
    "exports.valueLooksLikeSecret = valueLooksLikeSecret;",
    "Authorization: Bearer openshell:resolve:env:REMOTE_MCP_TOKEN",
    ["Authorization: Bearer", "private-qa"].join(" "),
    "sessionToken=[STRIPPED_BY_MIGRATION]",
  ])("preserves non-secret source or placeholder text: %s", (value) => {
    expect(textContainsCredential(value)).toBe(false);
  });

  it("does not exempt values that merely extend the Microsoft Teams QA marker", () => {
    expect(textContainsCredential("Authorization: Bearer private-qa-live")).toBe(true);
  });

  it("allows only @pinojs/redact's complete public wildcard fixture", () => {
    const publishedFixture = [
      "// Tests for Issue #2319: @pinojs/redact fails to redact patterns with 3+ consecutive wildcards",
      "password: 'secret-2-levels'",
      "password: 'secret-3-levels'",
      "password: 'secret-4-levels'",
      "password: 'secret-5-levels'",
      "password: 'secret-6-levels'",
      "password: 'secret-value'",
      "token: 'token1'",
      "token: 'token2'",
      "token: 'token3'",
      "password: 'secret'",
      "username: 'admin'",
      "password: 'secret1'",
      "password: 'secret2'",
      "authorization: 'Bearer secret-token'",
      "authorization: 'Bearer another-token'",
    ].join("\n");

    expect(textContainsCredential(publishedFixture)).toBe(false);
    expect(
      textContainsCredential(publishedFixture.replace("another-token", "another-token-x")),
    ).toBe(true);
    expect(textContainsCredential(publishedFixture.replace("Issue #2319", "Issue #2320"))).toBe(
      true,
    );
  });
});

describe("npmConfigContainsCredentialDirective", () => {
  it.each(["_auth", "_authToken", "username", "password", "_password"])(
    "rejects the npm credential directive %s",
    (directive) => {
      expect(
        npmConfigContainsCredentialDirective(
          `//registry.example/:${directive}=opaqueCredentialPayloadZ1234567890`,
        ),
      ).toBe(true);
    },
  );

  it("allows non-credential npm registry configuration", () => {
    expect(
      npmConfigContainsCredentialDirective(
        ["registry=https://registry.npmjs.org/", "always-auth=false"].join("\n"),
      ),
    ).toBe(false);
  });
});

describe("isSafeCredentialPlaceholder", () => {
  it("recognizes OpenShell resolve placeholders and the unused sentinel", () => {
    expect(isSafeCredentialPlaceholder("openshell:resolve:env:DISCORD_BOT_TOKEN")).toBe(true);
    expect(isSafeCredentialPlaceholder("openshell:resolve:env:BRAVE_API_KEY")).toBe(true);
    expect(isSafeCredentialPlaceholder("xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN")).toBe(true);
    expect(isSafeCredentialPlaceholder("xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN")).toBe(true);
    expect(isSafeCredentialPlaceholder("unused")).toBe(true);
    expect(isSafeCredentialPlaceholder("nemoclaw-managed-inference")).toBe(true);
    expect(isSafeCredentialPlaceholder(HERMES_PROXY_REWRITE_SENTINEL)).toBe(true);
    expect(isSafeCredentialPlaceholder("[STRIPPED_BY_MIGRATION]")).toBe(true);
    expect(isSafeCredentialPlaceholder("Bearer openshell:resolve:env:REMOTE_MCP_TOKEN")).toBe(true);
    // `Bearer <safe-literal>` proxy-auth sentinels are preserved too.
    expect(isSafeCredentialPlaceholder("Bearer unused")).toBe(true);
    expect(isSafeCredentialPlaceholder("Bearer [STRIPPED_BY_MIGRATION]")).toBe(true);
  });

  it("rejects raw secrets and malformed references", () => {
    expect(isSafeCredentialPlaceholder("sk-1234567890")).toBe(false);
    expect(isSafeCredentialPlaceholder("xoxb-987654321-realtoken")).toBe(false);
    expect(isSafeCredentialPlaceholder("openshell:resolve:env:")).toBe(false);
    expect(isSafeCredentialPlaceholder("openshell:resolve:env:BAD NAME")).toBe(false);
    expect(isSafeCredentialPlaceholder(42)).toBe(false);
    expect(isSafeCredentialPlaceholder(null)).toBe(false);
  });
});

describe("isConfigValue", () => {
  it("accepts plain JSON-like configuration values", () => {
    expect(isConfigValue(null)).toBe(true);
    expect(isConfigValue("hello")).toBe(true);
    expect(isConfigValue(42)).toBe(true);
    expect(isConfigValue({ nested: [true, "value", { count: 1 }] })).toBe(true);
  });

  it("rejects non-JSON objects nested inside config values", () => {
    expect(isConfigValue({ when: new Date() })).toBe(false);
    expect(isConfigValue([new Map()])).toBe(false);
  });
});

describe("stripCredentials", () => {
  it("strips top-level credential fields", () => {
    const input = { model: "gpt-4", apiKey: "sk-123", name: "test" };
    const result = stripCredentials(input);
    expect(result.model).toBe("gpt-4");
    expect(result.apiKey).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.name).toBe("test");
  });

  it("strips nested credential fields", () => {
    const input = { providers: { openai: { apiKey: "sk-123", model: "gpt-4" } } };
    const result = stripCredentials(input);
    expect(result.providers.openai.apiKey).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.providers.openai.model).toBe("gpt-4");
  });

  it("strips credentials in arrays", () => {
    const input = { items: [{ token: "abc" }, { name: "safe" }] };
    const result = stripCredentials(input);
    expect(result.items[0].token).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.items[1].name).toBe("safe");
  });

  it("handles null and primitives", () => {
    expect(stripCredentials(null)).toBeNull();
    expect(stripCredentials(undefined)).toBeUndefined();
    expect(stripCredentials("hello")).toBe("hello");
    expect(stripCredentials(42)).toBe(42);
  });

  it("preserves null and undefined under credential field names", () => {
    const result = stripCredentials({ apiKey: null, token: undefined, model: "keep" });
    expect(result.apiKey).toBeNull();
    expect(result.token).toBeUndefined();
    expect(result.model).toBe("keep");
  });

  it("preserves OpenShell resolve placeholders under credential fields (#5027)", () => {
    const input = {
      models: { providers: { nvidia: { apiKey: "unused", baseUrl: "https://x/v1" } } },
      channels: {
        discord: { accounts: { default: { token: "openshell:resolve:env:DISCORD_BOT_TOKEN" } } },
        slack: {
          accounts: { default: { botToken: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN" } },
        },
      },
    };
    const result = stripCredentials(input);
    expect(result.models.providers.nvidia.apiKey).toBe("unused");
    expect(result.models.providers.nvidia.baseUrl).toBe("https://x/v1");
    expect(result.channels.discord.accounts.default.token).toBe(
      "openshell:resolve:env:DISCORD_BOT_TOKEN",
    );
    expect(result.channels.slack.accounts.default.botToken).toBe(
      "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
    );
  });

  it("still strips raw secrets even under preserved-style sibling fields", () => {
    const input = {
      good: { apiKey: "openshell:resolve:env:GOOD_KEY" },
      bad: { apiKey: "sk-actual-secret" },
    };
    const result = stripCredentials(input);
    expect(result.good.apiKey).toBe("openshell:resolve:env:GOOD_KEY");
    expect(result.bad.apiKey).toBe("[STRIPPED_BY_MIGRATION]");
  });
});

describe("sanitizeEnvFileContent", () => {
  it("strips PASS/TOKEN secrets without over-matching KEYBOARD_LAYOUT", () => {
    const input = [
      "# comment",
      "NODE_ENV=production",
      "KEYBOARD_LAYOUT=us",
      "DB_PASS=super-secret",
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "API_KEY=openshell:resolve:env:API_KEY",
      "PASSPHRASE=raw-passphrase",
      "",
    ].join("\n");

    const result = sanitizeEnvFileContent(input);
    expect(result).toContain("NODE_ENV=production");
    expect(result).toContain("KEYBOARD_LAYOUT=us");
    expect(result).toContain("DB_PASS=[STRIPPED_BY_MIGRATION]");
    expect(result).toContain("GITHUB_TOKEN=[STRIPPED_BY_MIGRATION]");
    expect(result).toContain("API_KEY=openshell:resolve:env:API_KEY");
    expect(result).toContain("PASSPHRASE=[STRIPPED_BY_MIGRATION]");
    expect(result).toContain("# comment");
  });

  it("strips credential keys that use a leading export prefix", () => {
    const input = [
      "export DB_PASS=super-secret",
      "export NODE_ENV=production",
      "  export  GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "",
    ].join("\n");

    const result = sanitizeEnvFileContent(input);
    expect(result).toContain("export DB_PASS=[STRIPPED_BY_MIGRATION]");
    expect(result).toContain("export NODE_ENV=production");
    expect(result).toContain("export  GITHUB_TOKEN=[STRIPPED_BY_MIGRATION]");
    expect(result).not.toContain("super-secret");
    expect(result).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("strips secret-shaped values stored under benign keys", () => {
    const input = [
      "MODEL=keep-me",
      "CUSTOM=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "ENDPOINT=Bearer opaque-migration-secret",
      "SAFE=openshell:resolve:env:SAFE",
      "",
    ].join("\n");

    const result = sanitizeEnvFileContent(input);
    expect(result).toContain("MODEL=keep-me");
    expect(result).toContain("CUSTOM=[STRIPPED_BY_MIGRATION]");
    expect(result).toContain("ENDPOINT=[STRIPPED_BY_MIGRATION]");
    expect(result).toContain("SAFE=openshell:resolve:env:SAFE");
  });
});

describe("isSensitiveFile", () => {
  it("detects credential-bearing auth state basenames", () => {
    expect(isSensitiveFile("auth-profiles.json")).toBe(true);
    expect(isSensitiveFile("Auth-Profiles.json")).toBe(true);
    expect(isSensitiveFile("auth.json")).toBe(true);
    expect(isSensitiveFile("AUTH.JSON")).toBe(true);
    expect(isSensitiveFile("chatgpt-auth.json")).toBe(true);
    expect(isSensitiveFile("CHATGPT-AUTH.JSON")).toBe(true);
  });

  it("does not flag normal files", () => {
    expect(isSensitiveFile("openclaw.json")).toBe(false);
    expect(isSensitiveFile("config.yaml")).toBe(false);
    expect(isSensitiveFile("SOUL.md")).toBe(false);
  });
});

describe("stripCredentials secret patterns", () => {
  it("strips terminal pass aliases while preserving benign pass substrings", () => {
    const payload = "opaqueCredentialPayloadZ1234567890";
    const result = stripCredentials({
      customPass: payload,
      customPasswd: payload,
      DBPass: payload,
      db_pass: payload,
      db_passwd: payload,
      "db-pass": payload,
      COMPASS: "north",
      BYPASS: "allowed",
      passRate: 0.9,
      passCount: 4,
      passThrough: true,
    });

    expectStrippedCredentialFields(result, [
      "customPass",
      "customPasswd",
      "DBPass",
      "db_pass",
      "db_passwd",
      "db-pass",
    ]);
    expect(result).toMatchObject({
      COMPASS: "north",
      BYPASS: "allowed",
      passRate: 0.9,
      passCount: 4,
      passThrough: true,
    });
  });

  it("strips raw channel tokens and MCP env secrets from openclaw.json (#5027)", () => {
    const input = {
      channels: {
        slack: {
          accounts: { default: { botToken: "xoxb-123-realsecret", appToken: "xapp-1-realsecret" } },
        },
      },
      mcpServers: {
        github: {
          command: "npx",
          env: {
            GITHUB_TOKEN: "ghp_realsecret",
            TOKEN: "raw",
            PASSWORD: "pw",
            NODE_ENV: "production",
          },
        },
      },
    };
    const result = stripCredentials(input);
    expect(result.channels.slack.accounts.default.botToken).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.channels.slack.accounts.default.appToken).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.mcpServers.github.env.GITHUB_TOKEN).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.mcpServers.github.env.TOKEN).toBe("[STRIPPED_BY_MIGRATION]");
    expect(result.mcpServers.github.env.PASSWORD).toBe("[STRIPPED_BY_MIGRATION]");
    // Non-secret env vars and command survive.
    expect(result.mcpServers.github.env.NODE_ENV).toBe("production");
    expect(result.mcpServers.github.command).toBe("npx");
  });

  it("strips MCP HTTP auth headers by name and value backstop (#5027)", () => {
    const input = {
      mcpServers: {
        remote: {
          url: "https://mcp.example.com",
          headers: {
            Authorization: "Bearer ghp_0123456789abcdef",
            "X-API-Key": "sk-0123456789abcdefghij", // gitleaks:allow
            // Opaque value (no recognizable prefix) caught by header name.
            "X-API-Token": "plain-opaque-value-12345",
            // Opaque value under a custom -auth header, caught by header name.
            "X-Custom-Auth": "plain-opaque-value-67890",
            // Bearer resolve reference must survive (only a reference, no secret).
            "X-Auth-Token": "Bearer openshell:resolve:env:REMOTE_MCP_TOKEN",
            "X-Request-Id": "req-12345",
          },
        },
      },
    };
    const result = stripCredentials(input);
    const headers = result.mcpServers.remote.headers;
    expect(headers.Authorization).toBe("[STRIPPED_BY_MIGRATION]");
    expect(headers["X-API-Key"]).toBe("[STRIPPED_BY_MIGRATION]");
    expect(headers["X-API-Token"]).toBe("[STRIPPED_BY_MIGRATION]");
    expect(headers["X-Custom-Auth"]).toBe("[STRIPPED_BY_MIGRATION]");
    expect(headers["X-Auth-Token"]).toBe("Bearer openshell:resolve:env:REMOTE_MCP_TOKEN");
    expect(headers["X-Request-Id"]).toBe("req-12345");
    expect(result.mcpServers.remote.url).toBe("https://mcp.example.com");
  });

  it("scrubs secret strings and flag values inside array args (#5027)", () => {
    const input = {
      mcpServers: {
        cli: {
          command: "some-mcp",
          args: [
            "--api-key",
            "opaqueOpaqueSecret123", // opaque value after a credential flag
            "--verbose", // value-less flag must not be swallowed
            "--token=plainOpaque", // inline credential flag form
            "--name=server", // benign inline flag survives
            "ghp_0123456789abcdef", // shape-based catch
          ],
        },
      },
    };
    const result = stripCredentials(input);
    const args = result.mcpServers.cli.args;
    expect(args[0]).toBe("--api-key");
    expect(args[1]).toBe("[STRIPPED_BY_MIGRATION]");
    expect(args[2]).toBe("--verbose");
    expect(args[3]).toBe("--token=[STRIPPED_BY_MIGRATION]");
    expect(args[4]).toBe("--name=server");
    expect(args[5]).toBe("[STRIPPED_BY_MIGRATION]");
  });
});
