// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

type RunResult = { status: number; stdout?: string; stderr?: string };
type RunOpenshell = (command: string[]) => RunResult;

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

it.each([
  ["a missing", `${CANONICAL_KEY}, ${AGENT_A_KEY}`],
  ["an unplanned", `${CANONICAL_KEY}, ${AGENT_A_KEY}, ${AGENT_B_KEY}, ${CANONICAL_KEY}_AGENT_C`],
])("rejects a resumed provider with %s namespaced credential (#10153)", (_case, observed) => {
  const commands: string[] = [];
  const runOpenshell: RunOpenshell = (command) => {
    commands.push(command.join(" "));
    return command[1] === "get" ? providerMetadata(observed) : profileResult();
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
