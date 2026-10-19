// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHeadlessCheckHelper } from "../../helpers/langchain-deepagents-code-headless.ts";

const repo = process.cwd();
const checks = [
  ["03-deepagents-code-nemotron-ultra-profile.sh", "fail"],
  ["04-deepagents-code-fresh-reonboard.sh", "fail"],
  ["07-deepagents-code-headless-inference.sh", "ok"],
] as const;

describe.each(checks)("%s hosted endpoint", (file, firstFunction) => {
  const script = readFileSync(
    path.join(repo, "test/e2e/e2e-cloud-experimental/checks", file),
    "utf8",
  );
  // Execute initialization only; the remaining script owns live sandbox operations.
  const initialization = script.slice(0, script.indexOf(`\n${firstFunction}() {`));
  function run(endpoint?: string) {
    return spawnSync("/bin/bash", ["-c", `${initialization}\nprintf '%s' "$HOSTED_ENDPOINT"`], {
      encoding: "utf8",
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        REPO: repo,
        ...(endpoint === undefined ? {} : { NEMOCLAW_ENDPOINT_URL: endpoint }),
      },
    });
  }

  it.each([
    [undefined, "https://inference-api.nvidia.com/v1"],
    ["https://custom.example/v1", "https://custom.example/v1"],
    ["https://custom.example/v1///", "https://custom.example/v1"],
    ["https://CUSTOM.example:443/v1/chat/completions/", "https://custom.example/v1"],
    [" https://custom.example/v1/models ", "https://custom.example/v1"],
  ])("uses the onboarding endpoint for input %s", (input, expected) => {
    const result = run(input);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  it.each([
    "https://user:secret@custom.example/v1",
    "https://custom.example/v1?key=secret",
    "https://custom.example/v1#secret",
    "https://custom.example/v1\n",
    "not-a-url",
  ])("rejects unsafe endpoint %s before running checks", (input) => {
    const result = run(input);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(input);
  });
});

it.each([
  "https://custom.example.test/v1/",
  "https://CUSTOM.example.test:443/v1/chat/completions/",
])("accepts canonical config for %s and rejects different routes or keys", (endpoint) => {
  const config = (baseUrl: string, key = "COMPATIBLE_API_KEY") =>
    `[models.providers.openai]\nbase_url = "${baseUrl}"\napi_key_env = "${key}"\n`;
  expect(
    runHeadlessCheckHelper("inference-route-contract", {
      CONFIG: config("https://custom.example.test/v1"),
      NEMOCLAW_ENDPOINT_URL: endpoint,
    }),
  ).toBe("native-compatible\n");
  expect(() =>
    runHeadlessCheckHelper("inference-route-contract", {
      CONFIG: config("https://other.example.test/v1"),
      NEMOCLAW_ENDPOINT_URL: endpoint,
    }),
  ).toThrow();
  expect(() =>
    runHeadlessCheckHelper("inference-route-contract", {
      CONFIG: config("https://custom.example.test/v1", "DEEPAGENTS_CODE_OPENAI_API_KEY"),
      NEMOCLAW_ENDPOINT_URL: endpoint,
    }),
  ).toThrow();
});
