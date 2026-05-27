// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseSecretsEnvContents,
  parseSecretsEnvLine,
  resetSecretsEnvStagingForTests,
  stageSecretsEnvFile,
} from "../../../dist/lib/credentials/secrets-env";

const TRACKED_KEYS = [
  "NVIDIA_API_KEY",
  "NVIDIA_INFERENCE_HUB_API_KEY",
  "OPENAI_API_KEY",
] as const;

function clearTrackedEnv(): void {
  for (const key of TRACKED_KEYS) delete process.env[key];
}

describe("secrets-env parsing", () => {
  it("parses export-prefixed and quoted assignments", () => {
    expect(parseSecretsEnvLine('export NVIDIA_API_KEY="nvapi-abc"')).toEqual({
      key: "NVIDIA_API_KEY",
      value: "nvapi-abc",
    });
    expect(parseSecretsEnvLine("NVIDIA_INFERENCE_HUB_API_KEY=sk-xyz")).toEqual({
      key: "NVIDIA_INFERENCE_HUB_API_KEY",
      value: "sk-xyz",
    });
  });

  it("ignores comments and non-allowlisted keys", () => {
    const parsed = parseSecretsEnvContents(`
# comment
NVIDIA_API_KEY=nvapi-1
UNKNOWN_KEY=secret
PATH=/tmp
`);
    expect(parsed).toEqual({ NVIDIA_API_KEY: "nvapi-1" });
  });
});

describe("stageSecretsEnvFile", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    clearTrackedEnv();
    resetSecretsEnvStagingForTests();
  });

  it("stages allowlisted keys without overriding existing env", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-secrets-"));
    process.env.HOME = home;
    const dir = path.join(home, ".nemoclaw");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, "secrets.env"),
      "NVIDIA_API_KEY=nvapi-from-file\nNVIDIA_INFERENCE_HUB_API_KEY=sk-from-file\n",
      { mode: 0o600 },
    );

    clearTrackedEnv();
    process.env.NVIDIA_API_KEY = "nvapi-already-set";
    resetSecretsEnvStagingForTests();

    const staged = stageSecretsEnvFile();
    expect(staged).toEqual(["NVIDIA_INFERENCE_HUB_API_KEY"]);
    expect(process.env.NVIDIA_API_KEY).toBe("nvapi-already-set");
    expect(process.env.NVIDIA_INFERENCE_HUB_API_KEY).toBe("sk-from-file");
  });
});
