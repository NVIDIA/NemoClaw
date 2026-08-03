// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { execTimeout, testTimeoutOptions } from "./helpers/timeouts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const DRIVER = path.join(import.meta.dirname, "fixtures", "onboard-intent-draft-pty-driver.ts");
const ptySupported =
  process.platform === "linux" &&
  spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;

async function runPty(
  replies: readonly string[],
): Promise<{ status: number | null; output: string }> {
  const child = spawn("script", ["-qec", `${TSX} ${DRIVER}`, "/dev/null"], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let sent = 0;
  const sendRepliesForVisiblePrompts = () => {
    const visiblePrompts = output.match(/PTY_PROMPT:\d+:/g)?.length ?? 0;
    while (sent < visiblePrompts && sent < replies.length) {
      child.stdin.write(`${replies[sent++]}\n`);
    }
  };
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
    sendRepliesForVisiblePrompts();
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`PTY driver timed out after ${sent}/${replies.length} replies:\n${output}`));
    }, execTimeout(20_000));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, output });
    });
  });
}

describe.runIf(ptySupported)("onboarding intent draft under a pseudo-TTY (#6005)", () => {
  it(
    "prefills defaults and walks Model -> Provider -> Agent before reaching review",
    testTimeoutOptions(30_000),
    async () => {
      const replies = [
        "", // Agent
        "", // Provider
        "b", // Model -> Provider
        "b", // Provider -> Agent
        "", // Agent
        "", // Provider
        "", // Model
        "demo", // Sandbox
        "", // Web search
        "none", // Messaging
        "", // Resource profile
        "", // GPU
        "", // Policy
        "", // Apply
      ];
      const run = await runPty(replies);
      const { output } = run;

      expect(run.status, output).toBe(0);
      expect(output).toContain("Choose [openclaw]");
      expect(output).toContain("Choose [build]");
      expect(output).toContain("Model [nemotron]");
      expect(output.match(/  Agent:/g)?.length).toBeGreaterThanOrEqual(2);
      expect(output.match(/  Inference provider:/g)?.length).toBeGreaterThanOrEqual(3);
      expect(output).toContain("  Review configuration");
      expect(output).toContain("PTY_RESULT:apply:openclaw:build:none:demo");
    },
  );

  it(
    "re-prompts incompatible provider and web-search choices after an Agent edit",
    testTimeoutOptions(30_000),
    async () => {
      const replies = [
        "", // OpenClaw
        "2", // OpenAI
        "", // Model
        "demo", // Sandbox
        "2", // Brave
        "none", // Messaging
        "", // Resource profile
        "", // GPU
        "", // Policy
        "2", // Edit a choice
        "1", // Agent
        "2", // Hermes
        "2", // Hermes Provider replaces incompatible OpenAI
        "", // Model
        "2", // Tavily replaces incompatible Brave
        "", // Policy
        "", // Apply
      ];
      const run = await runPty(replies);
      const { output } = run;

      expect(run.status, output).toBe(0);
      expect(output.match(/  Inference provider:/g)?.length).toBeGreaterThanOrEqual(2);
      expect(output.match(/  Web search:/g)?.length).toBeGreaterThanOrEqual(2);
      expect(output.match(/  Review configuration/g)?.length).toBeGreaterThanOrEqual(2);
      expect(output).toContain("PTY_RESULT:apply:hermes:hermesProvider:tavily:demo");
    },
  );
});
