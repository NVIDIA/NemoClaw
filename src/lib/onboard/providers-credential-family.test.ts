// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

type RunResult = { status: number; stdout?: string; stderr?: string };
type RunOptions = { env?: Record<string, string> };
type RunOpenshell = (command: string[], options?: RunOptions) => RunResult;

type TokenDef = {
  name: string;
  envKey: string;
  token: string | null;
  providerType: string;
  additionalCredentials: Array<{ envKey: string; token: string | null }>;
};

const { upsertMessagingProviders } = require("./providers") as {
  upsertMessagingProviders: (
    tokenDefs: TokenDef[],
    runOpenshell: RunOpenshell,
    options?: { bestEffort?: boolean; requireExactBindings?: boolean },
  ) => string[];
};

const PROFILE_EXPORT = JSON.stringify({
  id: "nemoclaw-mcp-v1",
  credentials: [],
  endpoints: [],
  binaries: [],
  inference_capable: false,
});

const PROVIDER_NAME = "alpha-telegram-bridge";
const CANONICAL_KEY = "TELEGRAM_BOT_TOKEN";
const AGENT_A_KEY = "TELEGRAM_BOT_TOKEN_AGENT_A";
const AGENT_B_KEY = "TELEGRAM_BOT_TOKEN_AGENT_B";
const MISSING_KEY = "TELEGRAM_BOT_TOKEN_AGENT_MISSING";

function tokenDef(
  token: string | null,
  additionalCredentials: TokenDef["additionalCredentials"],
): TokenDef {
  return {
    name: PROVIDER_NAME,
    envKey: CANONICAL_KEY,
    token,
    providerType: "nemoclaw-mcp-v1",
    additionalCredentials,
  };
}

function providerMetadata(keys: string): RunResult {
  return {
    status: 0,
    stdout: [
      `Name: ${PROVIDER_NAME}`,
      "Type: nemoclaw-mcp-v1",
      `Credential keys: ${keys}`,
      "Config keys: <none>",
      "",
    ].join("\n"),
    stderr: "",
  };
}

function profileResult(): RunResult {
  return { status: 0, stdout: PROFILE_EXPORT, stderr: "" };
}

function missingProvider(): RunResult {
  return { status: 1, stdout: "", stderr: `provider '${PROVIDER_NAME}' not found` };
}

it("creates one messaging provider with its namespaced credentials (#10153)", () => {
  const commands: string[] = [];
  let credentialKeys: string[] | null = null;
  const runOpenshell: RunOpenshell = (command) => {
    commands.push(command.join(" "));
    switch (command[1]) {
      case "profile":
        return profileResult();
      case "get":
        return credentialKeys ? providerMetadata(credentialKeys.join(", ")) : missingProvider();
      case "create":
        credentialKeys = [CANONICAL_KEY, AGENT_A_KEY];
        return { status: 0 };
      default:
        return { status: 0 };
    }
  };

  expect(
    upsertMessagingProviders(
      [
        tokenDef("telegram-test-token", [
          { envKey: AGENT_A_KEY, token: "telegram-agent-a-test-token" },
          { envKey: MISSING_KEY, token: null },
        ]),
      ],
      runOpenshell,
    ),
  ).toEqual([PROVIDER_NAME]);
  expect(commands).toContain(
    `provider create --name ${PROVIDER_NAME} --type nemoclaw-mcp-v1 --credential ${CANONICAL_KEY} --credential ${AGENT_A_KEY}`,
  );
  expect(commands.every((command) => !command.includes(MISSING_KEY))).toBe(true);
});

it("rejects an update that omits a submitted namespaced credential (#10153)", () => {
  const runOpenshell: RunOpenshell = (command) =>
    command[1] === "profile" ? profileResult() : providerMetadata(CANONICAL_KEY);

  expect(() =>
    upsertMessagingProviders(
      [
        tokenDef("telegram-test-token", [
          { envKey: AGENT_A_KEY, token: "telegram-agent-a-test-token" },
        ]),
      ],
      runOpenshell,
      { bestEffort: true },
    ),
  ).toThrow(/did not confirm messaging provider/u);
});

it("rejects a later mismatched provider before submitting any family credentials (#10153)", () => {
  const canonicalSecret = "brave-canonical-test-secret";
  const extensionSecret = "brave-extension-test-secret";
  const commands: Array<{ command: string; env: Record<string, string> }> = [];
  const runOpenshell: RunOpenshell = (command, options = {}) => {
    commands.push({ command: command.join(" "), env: options.env ?? {} });
    switch (command[1]) {
      case "get":
        return command[2] === PROVIDER_NAME
          ? missingProvider()
          : {
              status: 0,
              stdout: [
                "Name: alpha-brave-search",
                "Type: openai",
                "Credential keys: BRAVE_API_KEY",
                "Config keys: <none>",
                "",
              ].join("\n"),
            };
      default:
        return { status: 0 };
    }
  };

  expect(() =>
    upsertMessagingProviders(
      [
        tokenDef("telegram-test-token", []),
        {
          name: "alpha-brave-search",
          envKey: "BRAVE_API_KEY",
          token: canonicalSecret,
          providerType: "brave",
          additionalCredentials: [{ envKey: "BRAVE_API_KEY_AGENT_A", token: extensionSecret }],
        },
      ],
      runOpenshell,
      { bestEffort: true },
    ),
  ).toThrow(/does not match the required 'brave' credential binding/u);
  expect(commands.some(({ command }) => /provider (?:create|update)/u.test(command))).toBe(false);
  expect(
    commands.some(({ env }) =>
      Object.values(env).some((value) => [canonicalSecret, extensionSecret].includes(value)),
    ),
  ).toBe(false);
});

it("reports a changed provider when post-mutation verification fails (#10153)", () => {
  let created = false;
  const runOpenshell: RunOpenshell = (command) => {
    switch (command[1]) {
      case "profile":
        return profileResult();
      case "get":
        return created ? providerMetadata(CANONICAL_KEY) : missingProvider();
      case "create":
        created = true;
        return { status: 0 };
      default:
        return { status: 0 };
    }
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit(${String(code)})`);
  });

  try {
    expect(() =>
      upsertMessagingProviders(
        [
          tokenDef("telegram-test-token", [
            { envKey: AGENT_A_KEY, token: "telegram-agent-a-test-token" },
          ]),
        ],
        runOpenshell,
      ),
    ).toThrow(/exit\(1\)/u);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /did not confirm messaging provider.*changed gateway state.*alpha-telegram-bridge.*inspect those providers before retrying/isu,
      ),
    );
  } finally {
    exit.mockRestore();
    error.mockRestore();
  }
});

it("does not create a credential family without its canonical credential (#10153)", () => {
  const commands: string[] = [];
  const runOpenshell: RunOpenshell = (command) => {
    commands.push(command.join(" "));
    return command[1] === "profile" ? profileResult() : missingProvider();
  };

  expect(() =>
    upsertMessagingProviders(
      [tokenDef(null, [{ envKey: AGENT_A_KEY, token: "telegram-agent-a-test-token" }])],
      runOpenshell,
      { bestEffort: true },
    ),
  ).toThrow(/without its canonical credential/u);
  expect(commands.some((command) => command.includes("provider create"))).toBe(false);
});

it("rejects a resumed provider missing a submitted namespaced credential (#10153)", () => {
  const commands: string[] = [];
  const runOpenshell: RunOpenshell = (command) => {
    commands.push(command.join(" "));
    return command[1] === "get"
      ? providerMetadata(`${CANONICAL_KEY}, ${AGENT_A_KEY}`)
      : profileResult();
  };

  expect(() =>
    upsertMessagingProviders(
      [
        tokenDef("telegram-test-token", [
          { envKey: AGENT_A_KEY, token: "telegram-agent-a-test-token" },
          { envKey: AGENT_B_KEY, token: "telegram-agent-b-test-token" },
        ]),
      ],
      runOpenshell,
      { bestEffort: true, requireExactBindings: true },
    ),
  ).toThrow(/does not match the required/u);
  expect(commands.some((command) => /provider (create|update)/u.test(command))).toBe(false);
});

it("retains an existing namespaced credential not submitted by an update (#10153)", () => {
  const commands: string[] = [];
  const retainedKey = `${CANONICAL_KEY}_AGENT_C`;
  const runOpenshell: RunOpenshell = (command) => {
    commands.push(command.join(" "));
    return command[1] === "get"
      ? providerMetadata(`${CANONICAL_KEY}, ${AGENT_A_KEY}, ${AGENT_B_KEY}, ${retainedKey}`)
      : profileResult();
  };

  expect(
    upsertMessagingProviders(
      [
        tokenDef("telegram-test-token", [
          { envKey: AGENT_A_KEY, token: "telegram-agent-a-test-token" },
          { envKey: AGENT_B_KEY, token: "telegram-agent-b-test-token" },
        ]),
      ],
      runOpenshell,
      { bestEffort: true, requireExactBindings: true },
    ),
  ).toEqual([PROVIDER_NAME]);
  expect(commands).toContain(
    `provider update ${PROVIDER_NAME} --credential ${CANONICAL_KEY} --credential ${AGENT_A_KEY} --credential ${AGENT_B_KEY}`,
  );
  expect(commands.every((command) => !command.includes(`--credential ${retainedKey}`))).toBe(true);
});
