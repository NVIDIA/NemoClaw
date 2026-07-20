// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildProcessTokenProbe } from "../fixtures/process-token-probe.ts";
import {
  buildSandboxNodeInvocation,
  buildSandboxShellInvocation,
  isNvidiaEndpointRateLimitFailure,
  OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES,
  parseRuntimeProofPort,
} from "../live/messaging-providers-helpers.ts";
import {
  parseInstalledSlackProof,
  SLACK_INSTALLED_RUNTIME_PROOF_SOURCE,
  SLACK_MANAGED_NPM_PROJECT_DISCOVERY_SOURCE,
} from "../live/messaging-providers-slack-runtime-proof.ts";
import { TELEGRAM_INSTALLED_RUNTIME_PROOF_SOURCE } from "../live/messaging-providers-telegram-runtime-proof.ts";

const FAKE_TELEGRAM_API = path.resolve(import.meta.dirname, "../lib/fake-telegram-api.cjs");
const LIVE_MESSAGING_PROVIDERS_SOURCE = fs.readFileSync(
  path.resolve(import.meta.dirname, "../live/messaging-providers.test.ts"),
  "utf8",
);

function expectValidModuleSource(source: string): void {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    encoding: "utf8",
    input: source,
  });
  expect(result.status, result.stderr).toBe(0);
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let matched = predicate();
  while (!matched && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    matched = predicate();
  }
  expect(matched, message).toBe(true);
}

describe("messaging provider installed-runtime proofs", () => {
  it("keeps raw process-probe tokens out of argv and fails closed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-process-token-probe-"));
    const token = `xoxb-nemoclaw-process-probe-secret-${process.pid}`;

    try {
      const selfProc = path.join(dir, "101");
      fs.mkdirSync(selfProc);
      const script = buildProcessTokenProbe(token, dir);
      const invocation = buildSandboxShellInvocation(script);
      fs.writeFileSync(path.join(selfProc, "cmdline"), `${invocation.join("\0")}\0`);

      expect(script).not.toContain(token);
      expect(script).not.toContain("grep");
      expect(script).toContain('case "$nemoclaw_process_probe_cmdline" in');
      expect(invocation.every((argument) => !argument.includes(token))).toBe(true);

      const [command, ...args] = invocation;
      const selfOnlyResults = Array.from({ length: 20 }, () =>
        spawnSync(command, args, { encoding: "utf8" }),
      );
      expect(selfOnlyResults.map((result) => result.status)).toEqual(Array(20).fill(0));
      expect(selfOnlyResults.map((result) => result.stdout.trim())).toEqual(
        Array(20).fill("ABSENT"),
      );

      const otherProc = path.join(dir, "202");
      fs.mkdirSync(otherProc);
      fs.writeFileSync(
        path.join(otherProc, "cmdline"),
        `node\0worker.js\0--messaging-token=${token}\0`,
      );
      const tokenInOtherProcess = spawnSync(command, args, { encoding: "utf8" });
      expect(tokenInOtherProcess.status, tokenInOtherProcess.stderr).toBe(0);
      expect(tokenInOtherProcess.stdout.trim()).toBe("FOUND pid=202");

      fs.rmSync(selfProc, { recursive: true });
      fs.rmSync(otherProc, { recursive: true });
      const noProcessData = spawnSync(command, args, { encoding: "utf8" });
      expect(noProcessData.status, noProcessData.stderr).toBe(0);
      expect(noProcessData.stdout.trim()).toBe("ABSENT");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconstructs multi-argument Node source byte-for-byte below the OpenShell limit", () => {
    const source = [
      'import fs from "node:fs";',
      "const scriptUrl = new URL(import.meta.url);",
      'if (process.env.RUNTIME_PROOF_MARKER !== "marker value") throw new Error("missing marker");',
      'const reconstructed = fs.readFileSync(scriptUrl, "utf8");',
      "fs.unlinkSync(scriptUrl);",
      "process.stdout.write(reconstructed);",
      `/* ${"x".repeat(OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES * 2)} */`,
    ].join("\n");
    const invocation = buildSandboxNodeInvocation(source, {
      artifactName: `runtime-proof-round-trip-${process.pid}`,
      env: { RUNTIME_PROOF_MARKER: "marker value" },
    });

    expect(invocation.length).toBeGreaterThan(8);
    expect(
      Math.max(...invocation.map((argument) => Buffer.byteLength(argument, "utf8"))),
    ).toBeLessThan(OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES);
    expect(invocation.filter((argument) => /[\r\n]/u.test(argument))).toEqual([]);
    const [command, ...args] = invocation;
    const result = spawnSync(command, args, { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(source);
  });

  it.each([
    ["1", 1],
    ["443", 443],
    ["65535", 65_535],
    ["00080", 80],
  ])("accepts bounded decimal runtime-proof port %s", (rawPort, expected) => {
    expect(parseRuntimeProofPort(rawPort)).toBe(expected);
  });

  it.each([
    "",
    "0",
    "65536",
    "-1",
    "+1",
    "1.5",
    "1e3",
    " 443",
    "443 ",
    "abc",
  ])("rejects invalid runtime-proof port %j", (rawPort) => {
    expect(() => parseRuntimeProofPort(rawPort)).toThrow(/runtime proof port/u);
  });

  it("classifies only rate-limited NVIDIA endpoint validation failures", () => {
    expect(
      isNvidiaEndpointRateLimitFailure(
        "NVIDIA Endpoints endpoint validation failed.\nChat Completions API validation returned HTTP 429",
      ),
    ).toBe(true);
    expect(
      isNvidiaEndpointRateLimitFailure(
        "NVIDIA Endpoints endpoint validation failed: too many requests",
      ),
    ).toBe(true);
    expect(
      isNvidiaEndpointRateLimitFailure(
        [
          "Using Other OpenAI-compatible endpoint with model: nvidia/nvidia/nemotron-3-ultra",
          "No GITHUB_TOKEN (60 req/hr rate limit — set it for better rates)",
          "Docker GPU patch failed: spawnSync docker ETIMEDOUT",
        ].join("\n"),
      ),
    ).toBe(false);
    expect(
      isNvidiaEndpointRateLimitFailure(
        "NVIDIA Endpoints endpoint validation failed: invalid credential",
      ),
    ).toBe(false);
  });

  it("keeps the Slack allow, deny, feedback, and send contract on installed exports", () => {
    expectValidModuleSource(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE);
    expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("prepareSlackMessage");
    expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("sendMessageSlack");
    expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("deniedPrepared === null");
    expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("senderFeedbackCalls.length === 1");
    expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("openclaw-pipeline-runtime");
    expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain(
      'process.env.NEMOCLAW_E2E_ALLOW_LEGACY_SLACK_TEST_API === "1"',
    );
    expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE.match(/allowLegacyTestApi &&/gu)).toHaveLength(2);
    expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("/api/chat.postMessage");
  });

  it("finds Slack only in its canonical managed npm project", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-managed-project-"));
    const projectsDir = path.join(dir, "npm", "projects");
    const slackProject = path.join(projectsDir, "openclaw-slack-reviewed");
    const unrelatedProject = path.join(projectsDir, "unrelated-plugin");
    const malformedProject = path.join(projectsDir, "malformed-plugin");
    const slackPackageRoot = path.join(slackProject, "node_modules", "@openclaw", "slack");

    try {
      fs.mkdirSync(slackPackageRoot, { recursive: true });
      fs.writeFileSync(
        path.join(slackProject, "package.json"),
        JSON.stringify({ dependencies: { "@openclaw/slack": "2026.6.10" } }),
      );
      fs.mkdirSync(path.join(unrelatedProject, "node_modules", "@openclaw", "slack"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(unrelatedProject, "package.json"),
        JSON.stringify({ dependencies: { "@openclaw/discord": "2026.6.10" } }),
      );
      fs.mkdirSync(malformedProject, { recursive: true });
      fs.writeFileSync(path.join(malformedProject, "package.json"), "not json");

      const source = [
        'import fs from "node:fs";',
        'import path from "node:path";',
        SLACK_MANAGED_NPM_PROJECT_DISCOVERY_SOURCE,
        "const candidates = [];",
        "addManagedNpmProjectSlackCandidates(",
        "  process.env.NEMOCLAW_TEST_PROJECTS_DIR,",
        "  (candidate) => candidates.push(path.resolve(candidate)),",
        ");",
        "process.stdout.write(JSON.stringify(candidates));",
      ].join("\n");
      const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
        encoding: "utf8",
        env: { ...process.env, NEMOCLAW_TEST_PROJECTS_DIR: projectsDir },
        input: source,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([path.resolve(slackPackageRoot)]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports loader stderr without accepting stderr as a Slack proof (#6467)", () => {
    const proof = JSON.stringify({
      ok: true,
      proof: "openclaw-pipeline-runtime",
      allowedReplyTarget: "channel:C0E2ESLACK",
      deniedPrepared: true,
      deniedFeedbackMethod: "chat.postEphemeral",
      deniedFeedbackCount: 1,
      messageId: "1710000000.000201",
      channelId: "C0E2ESLACK",
    });
    const stderr = [
      "[channels] [slack] provider failed to start: this[#customizations].loadSync is not a function",
      proof,
    ].join("\n");

    expect(() => parseInstalledSlackProof("", stderr)).toThrow(
      /stderr:.*loadSync is not a function/su,
    );
  });

  it("continues to accept only a complete Slack proof from stdout (#6467)", () => {
    const proof = {
      ok: true as const,
      proof: "openclaw-pipeline-runtime" as const,
      allowedReplyTarget: "channel:C0E2ESLACK",
      deniedPrepared: true as const,
      deniedFeedbackMethod: "chat.postEphemeral" as const,
      deniedFeedbackCount: 1 as const,
      messageId: "1710000000.000201",
      channelId: "C0E2ESLACK",
    };

    expect(parseInstalledSlackProof(`diagnostic\n${JSON.stringify(proof)}`, "warning")).toEqual(
      proof,
    );
  });

  it("requires the reviewed Slack pipeline/runtime proof in the default 2026.6.10 live lane", () => {
    expect(LIVE_MESSAGING_PROVIDERS_SOURCE).toContain(
      'installedSlackProof.proof === "openclaw-pipeline-runtime"',
    );
    expect(LIVE_MESSAGING_PROVIDERS_SOURCE).not.toContain(
      'installedSlackProof.proof === "openclaw-private-helper"',
    );
  });

  it("requires channel-list output without suppressing loader failures (#6467)", () => {
    expect(LIVE_MESSAGING_PROVIDERS_SOURCE).toContain(
      '"timeout 45 openclaw channels list --all --json --no-color"',
    );
    expect(LIVE_MESSAGING_PROVIDERS_SOURCE).toContain(
      "OpenClaw channels list did not emit channel state",
    );
    expect(LIVE_MESSAGING_PROVIDERS_SOURCE).not.toContain(
      "OpenClaw channels list returned no output",
    );
    expect(LIVE_MESSAGING_PROVIDERS_SOURCE).not.toContain(
      "openclaw channels list --all --json --no-color 2>/dev/null || true",
    );
  });

  it("keeps Telegram on runtime-api.js with a fake send boundary", () => {
    expectValidModuleSource(TELEGRAM_INSTALLED_RUNTIME_PROOF_SOURCE);
    expect(TELEGRAM_INSTALLED_RUNTIME_PROOF_SOURCE).toContain(
      "dist/extensions/telegram/runtime-api.js",
    );
    expect(TELEGRAM_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("sendMessageTelegram");
    expect(TELEGRAM_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("host.openshell.internal");
    expect(TELEGRAM_INSTALLED_RUNTIME_PROOF_SOURCE).not.toContain("telegram/test-api.js");
  });

  it("redacts Telegram tokens from fake API captures", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-telegram-redaction-"));
    const portFile = path.join(dir, "port");
    const captureFile = path.join(dir, "capture.jsonl");
    const token = "123456:SUPER-SECRET-TELEGRAM-TOKEN";
    const child = spawn(process.execPath, [FAKE_TELEGRAM_API], {
      env: {
        ...process.env,
        FAKE_TELEGRAM_API_HOST: "127.0.0.1",
        FAKE_TELEGRAM_API_PORT: "0",
        FAKE_TELEGRAM_API_PORT_FILE: portFile,
        FAKE_TELEGRAM_API_CAPTURE_FILE: captureFile,
        FAKE_TELEGRAM_API_EXPECTED_TOKEN: token,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitFor(() => fs.existsSync(portFile), `fake Telegram API did not start: ${stderr}`);
      const port = parseRuntimeProofPort(fs.readFileSync(portFile, "utf8").trim());
      const endpoint = new URL(
        "http://127.0.0.1/bot123456:SUPER-SECRET-TELEGRAM-TOKEN/sendMessage",
      );
      endpoint.port = String(port);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: "42424242", text: "redaction proof" }),
      });
      expect(response.status).toBe(200);
      await waitFor(
        () =>
          fs.existsSync(captureFile) &&
          fs.readFileSync(captureFile, "utf8").includes("sendMessage"),
        `fake Telegram API did not capture the request: ${stderr}`,
      );
      const capture = fs.readFileSync(captureFile, "utf8");
      expect(capture).not.toContain(token);
      const request = capture
        .trim()
        .split(/\n+/u)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((row) => row.event === "request");
      expect(request).toMatchObject({
        endpoint: "sendMessage",
        path: "/bot[redacted]/sendMessage",
        tokenMatchesExpected: true,
        tokenRedacted: true,
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        child.exitCode !== null ? resolve() : child.once("exit", () => resolve()),
      );
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
