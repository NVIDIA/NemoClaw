// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CHILD_TIMEOUT_MS = 30_000;

function buildHermeticEnv(tmpDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmpDir };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("NEMOCLAW_") ||
      key.startsWith("DISCORD_") ||
      key.startsWith("TELEGRAM_") ||
      key.startsWith("AWS_") ||
      key.startsWith("GCP_") ||
      key.startsWith("GOOGLE_") ||
      key.startsWith("GCLOUD_") ||
      key.startsWith("AZURE_") ||
      key.endsWith("_CREDENTIALS") ||
      key.endsWith("_API_KEY") ||
      key.includes("SECRET") ||
      key.includes("TOKEN")
    ) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

describe("Hermes Provider onboarding selection", () => {
  it("prompts for the agent and keeps OpenClaw when the default is accepted", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-default-"));
    const scriptPath = path.join(tmpDir, "agent-default-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    const script = String.raw`
const { selectOnboardAgent } = require(${onboardPath});

(async () => {
  const agent = await selectOnboardAgent({ canPrompt: true });
  console.log(JSON.stringify({ agent: agent && agent.name }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      // Accept the bracketed default ([1] = OpenClaw) by sending a bare Enter.
      input: "\n",
      env: buildHermeticEnv(tmpDir),
      timeout: CHILD_TIMEOUT_MS,
    });

    expect(result.status).toBe(0);
    // The interactive picker offers both agents before defaulting to OpenClaw.
    expect(result.stdout).toContain("Select your agent:");
    expect(result.stdout).toContain("OpenClaw");
    expect(result.stdout).toContain("Hermes");
    const lastLine = result.stdout.trim().split("\n").at(-1) || "{}";
    expect(JSON.parse(lastLine)).toEqual({ agent: null });
  });

  it("selects Hermes Agent when chosen from the interactive picker", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-hermes-"));
    const scriptPath = path.join(tmpDir, "agent-hermes-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    const script = String.raw`
const { selectOnboardAgent } = require(${onboardPath});

(async () => {
  const agent = await selectOnboardAgent({ canPrompt: true });
  console.log(JSON.stringify({ agent: agent && agent.name }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      // Choose option 2 (Hermes) from the agent picker.
      input: "2\n",
      env: buildHermeticEnv(tmpDir),
      timeout: CHILD_TIMEOUT_MS,
    });

    expect(result.status).toBe(0);
    const lastLine = result.stdout.trim().split("\n").at(-1) || "{}";
    expect(JSON.parse(lastLine)).toEqual({ agent: "hermes" });
  });

  it("rejects Hermes Provider when Hermes Agent was not selected", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-provider-hidden-"));
    const scriptPath = path.join(tmpDir, "hermes-provider-hidden-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    const script = String.raw`
const runner = require(${runnerPath});
runner.runCapture = () => "";
const { setupNim } = require(${onboardPath});

(async () => {
  await setupNim(null, "my-assistant", null);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: buildHermeticEnv(tmpDir, {
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "hermes-provider",
      }),
      timeout: CHILD_TIMEOUT_MS,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Hermes Provider is only available when onboarding Hermes Agent",
    );
    expect(result.stderr).toContain(
      "Re-run with `nemohermes onboard` or `nemoclaw onboard --agent hermes`.",
    );
  });

  it("selects the API-key Hermes Provider path for Hermes Agent", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-provider-api-"));
    const scriptPath = path.join(tmpDir, "hermes-provider-api-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    const script = String.raw`
const runner = require(${runnerPath});
runner.runCapture = () => "";
const { setupNim } = require(${onboardPath});

(async () => {
  const result = await setupNim(null, "my-assistant", { name: "hermes" });
  console.log(JSON.stringify(result));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: buildHermeticEnv(tmpDir, {
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "hermes-provider",
        NEMOCLAW_HERMES_AUTH_METHOD: "nous-api-key",
        NOUS_API_KEY: "nous-key-1",
      }),
      timeout: CHILD_TIMEOUT_MS,
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim().split("\n").at(-1) || "{}");
    expect(payload.provider).toBe("hermes-provider");
    expect(payload.credentialEnv).toBe("NOUS_API_KEY");
    expect(payload.hermesAuthMethod).toBe("api_key");
  });
});
