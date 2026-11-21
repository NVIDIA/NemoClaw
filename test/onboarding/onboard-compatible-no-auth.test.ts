// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const ENDPOINT = "http://localhost:11434/v1";

type Scenario = {
  label: string;
  /** Prompt answers for an interactive run; omit for a non-interactive run. */
  answers?: string[];
  authMode?: string;
  apiKey?: string;
  providerKey?: string;
  /** Credential env of a registered same-gateway peer; omit for no peer. */
  peerCredentialEnv?: string;
};

const repoModule = (...parts: string[]) =>
  JSON.stringify(path.join(REPO_ROOT, "src", "lib", ...parts));

// One child-process driver runs every scenario through the real setupNim and,
// when a peer is registered, the real shared-route containment guard.
const DRIVER = String.raw`
const credentials = require(${repoModule("credentials", "store.ts")});
const runner = require(${repoModule("runner.ts")});
const compatibility = require(${repoModule("inference", "gateway-route-compatibility.ts")});
const { guardProviderInferenceRouteSelection } = require(
  ${repoModule("onboard", "machine", "handlers", "provider-inference-route-containment.ts")},
);
let answers = [];
const prompts = [];
credentials.prompt = async (message) => {
  prompts.push(message);
  return answers.length > 0 ? answers.shift() : "exit";
};
runner.runCapture = () => "";
const { setupNim } = require(${repoModule("onboard.ts")});

function peer(credentialEnv) {
  return {
    name: "test-a",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    createdAt: "2026-10-26T00:00:00.000Z",
    provider: "compatible-endpoint",
    model: "test-model",
    endpointUrl: "${ENDPOINT}",
    preferredInferenceApi: "openai-completions",
    credentialEnv,
  };
}

function setEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function run(scenario) {
  const interactive = Array.isArray(scenario.answers);
  answers = interactive ? [...scenario.answers] : [];
  prompts.length = 0;
  Object.assign(process.env, {
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_ENDPOINT_URL: "${ENDPOINT}",
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_PREFERRED_API: "chat-completions",
  });
  setEnv("NEMOCLAW_NON_INTERACTIVE", interactive ? undefined : "1");
  setEnv("NEMOCLAW_COMPATIBLE_AUTH_MODE", scenario.authMode);
  setEnv("COMPATIBLE_API_KEY", scenario.apiKey);
  setEnv("NEMOCLAW_PROVIDER_KEY", scenario.providerKey);
  const errors = [];
  let guard = null;
  if (scenario.peerCredentialEnv) {
    const sandboxes = [peer(scenario.peerCredentialEnv)];
    const deps = {
      checkGatewayRouteCompatibility: (request) =>
        compatibility.checkGatewayRouteCompatibility({ ...request, sandboxes }),
      preflightGatewayRouteDiscovery: (request) =>
        compatibility.preflightGatewayRouteDiscovery({ ...request, sandboxes }),
      error: (message) => errors.push(message),
      exitProcess: (code) => {
        throw Object.assign(new Error("exit"), { code });
      },
    };
    guard = (route) =>
      guardProviderInferenceRouteSelection(deps, "nemoclaw", "test-b", false, route);
  }
  const originalExit = process.exit;
  process.exit = (code) => { throw Object.assign(new Error("exit"), { code }); };
  const outcome = { label: scenario.label };
  try {
    const result = guard
      ? await setupNim(null, "test-b", null, true, null, "nemoclaw", guard)
      : await setupNim(null);
    outcome.credentialEnv = result.credentialEnv;
  } catch (error) {
    outcome.exitCode = error.code;
    outcome.credentialConflict = errors.some((message) => message.includes("credential identity"));
  } finally {
    process.exit = originalExit;
  }
  outcome.stagedApiKey = Boolean(process.env.COMPATIBLE_API_KEY);
  outcome.askedApiKey = prompts.some((message) => message.includes("API key"));
  return outcome;
}

(async () => {
  const originalLog = console.log;
  console.log = () => {};
  console.error = () => {};
  const results = [];
  for (const scenario of JSON.parse(process.env.NO_AUTH_SCENARIOS)) results.push(await run(scenario));
  console.log = originalLog;
  originalLog(JSON.stringify(results));
})().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
`;

const FAKE_CURL = `#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then outfile="$2"; shift 2; else shift; fi
done
body='{"choices":[{"message":{"tool_calls":[{"type":"function","function":{"name":"emit_ok","arguments":"{\\"ok\\":true}"}}]}}]}'
if [ -n "$outfile" ]; then printf '%s' "$body" > "$outfile"; fi
printf '200'
`;

function runScenarios(scenarios: Scenario[]): Array<Record<string, unknown>> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compatible-no-auth-"));
  try {
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "check.js");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "curl"), FAKE_CURL, { mode: 0o755 });
    fs.writeFileSync(scriptPath, DRIVER);
    const childEnv = { ...process.env };
    delete childEnv.COMPATIBLE_API_KEY;
    delete childEnv.NEMOCLAW_PROVIDER_KEY;
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...childEnv,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NO_AUTH_SCENARIOS: JSON.stringify(scenarios),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Interactive prompts: base URL (Enter keeps the default), API key, model.
const NO_AUTH_ANSWERS = ["", "", ""];
const API_KEY_ANSWERS = ["", "sk-typed-TEST-NOT-A-REAL-VALUE", ""];
const PROXY = "NEMOCLAW_OLLAMA_PROXY_TOKEN";
const API_KEY = "COMPATIBLE_API_KEY";

describe("OpenAI-compatible loopback no-auth onboarding", () => {
  it("requires explicit none in non-interactive mode (#7424)", () => {
    assert.deepEqual(
      runScenarios([
        { label: "none", authMode: "none" },
        { label: "unset" },
        { label: "invalid", authMode: "invalid" },
      ]),
      [
        { label: "none", credentialEnv: PROXY, stagedApiKey: false, askedApiKey: false },
        {
          label: "unset",
          exitCode: 1,
          credentialConflict: false,
          stagedApiKey: false,
          askedApiKey: false,
        },
        {
          label: "invalid",
          exitCode: 1,
          credentialConflict: false,
          stagedApiKey: false,
          askedApiKey: false,
        },
      ],
    );
  });

  it("matches a same-gateway no-auth sandbox with identical settings (#13733)", () => {
    assert.deepEqual(
      runScenarios([
        { label: "same no-auth settings", authMode: "none", peerCredentialEnv: PROXY },
        {
          label: "API key against a no-auth peer",
          apiKey: "test-key",
          peerCredentialEnv: PROXY,
        },
        { label: "no-auth against an API-key peer", authMode: "none", peerCredentialEnv: API_KEY },
      ]),
      [
        {
          label: "same no-auth settings",
          credentialEnv: PROXY,
          stagedApiKey: false,
          askedApiKey: false,
        },
        {
          label: "API key against a no-auth peer",
          exitCode: 1,
          credentialConflict: true,
          stagedApiKey: true,
          askedApiKey: false,
        },
        {
          label: "no-auth against an API-key peer",
          exitCode: 1,
          credentialConflict: true,
          stagedApiKey: false,
          askedApiKey: false,
        },
      ],
    );
  });

  it("keeps an explicit no-auth shared route from staging a fallback API key (#13733)", () => {
    assert.deepEqual(
      runScenarios([
        {
          label: "explicit no-auth with provider-key fallback",
          authMode: "none",
          providerKey: "sk-bridge-TEST-NOT-A-REAL-VALUE",
          peerCredentialEnv: PROXY,
        },
      ]),
      [
        {
          label: "explicit no-auth with provider-key fallback",
          credentialEnv: PROXY,
          stagedApiKey: false,
          askedApiKey: false,
        },
      ],
    );
  });

  it("checks the interactive credential choice before staging it (#13733)", () => {
    assert.deepEqual(
      runScenarios([
        {
          label: "no-auth with a no-auth peer",
          answers: NO_AUTH_ANSWERS,
          peerCredentialEnv: PROXY,
        },
        {
          label: "no-auth against an API-key peer",
          answers: NO_AUTH_ANSWERS,
          peerCredentialEnv: API_KEY,
        },
        {
          label: "API key with an API-key peer",
          answers: API_KEY_ANSWERS,
          peerCredentialEnv: API_KEY,
        },
        {
          label: "typed API key against a no-auth peer",
          answers: API_KEY_ANSWERS,
          peerCredentialEnv: PROXY,
        },
        {
          label: "NEMOCLAW_PROVIDER_KEY against a no-auth peer",
          answers: NO_AUTH_ANSWERS,
          providerKey: "sk-bridge-TEST-NOT-A-REAL-VALUE",
          peerCredentialEnv: PROXY,
        },
      ]),
      [
        {
          label: "no-auth with a no-auth peer",
          credentialEnv: PROXY,
          stagedApiKey: false,
          askedApiKey: true,
        },
        {
          label: "no-auth against an API-key peer",
          exitCode: 1,
          credentialConflict: true,
          stagedApiKey: false,
          askedApiKey: true,
        },
        {
          label: "API key with an API-key peer",
          credentialEnv: API_KEY,
          stagedApiKey: true,
          askedApiKey: true,
        },
        // The conflicting key is rejected before it is staged.
        {
          label: "typed API key against a no-auth peer",
          exitCode: 1,
          credentialConflict: true,
          stagedApiKey: false,
          askedApiKey: true,
        },
        {
          label: "NEMOCLAW_PROVIDER_KEY against a no-auth peer",
          exitCode: 1,
          credentialConflict: true,
          stagedApiKey: false,
          askedApiKey: false,
        },
      ],
    );
  });
});
