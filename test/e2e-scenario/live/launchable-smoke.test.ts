// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

// Migrated coverage for test/e2e/test-launchable-smoke.sh (Refs #2599/#5098).
// This is intentionally a single live Vitest test instead of a new fixture
// family: the contract is the real Ubuntu launchable path, so the test invokes
// scripts/brev-launchable-ci-cpu.sh via sudo, then proves the launchable-built
// CLI can onboard, route inference.local, and run an OpenClaw agent turn.
// Legacy shell deletion/nightly lane retirement is deferred to #5098 Phase 11.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const LAUNCHABLE_SCRIPT = path.join(REPO_ROOT, "scripts", "brev-launchable-ci-cpu.sh");
const SENTINEL = "/var/run/nemoclaw-launchable-ready";
const MODEL = process.env.NEMOCLAW_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";
const DEFAULT_SANDBOX_NAME = `e2e-launchable-${randomUUID().slice(0, 8)}`;
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? DEFAULT_SANDBOX_NAME;
const TEST_TIMEOUT_MS = 30 * 60_000;
const INSTALL_TIMEOUT_MS = 30 * 60_000;
const ONBOARD_TIMEOUT_MS = 15 * 60_000;
const INFERENCE_TIMEOUT_MS = 2 * 60_000;
const ONBOARD_ATTEMPTS = 3;

type ChatCompletion = {
  choices?: Array<{
    message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
  }>;
};

type AgentJsonDoc = {
  payloads?: Array<{ text?: unknown }>;
  result?: { payloads?: Array<{ text?: unknown }> };
};

function runEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
  };
}

async function runBash(
  host: HostCliClient,
  script: string,
  options: {
    artifactName: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    redactionValues?: string[];
    timeoutMs?: number;
  },
): Promise<ShellProbeResult> {
  return host.command("bash", ["-lc", script], {
    artifactName: options.artifactName,
    cwd: options.cwd,
    env: options.env ?? runEnv(),
    redactionValues: options.redactionValues,
    timeoutMs: options.timeoutMs,
  });
}

function expectExitZero(result: ShellProbeResult, label: string): void {
  expect(result.exitCode, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
}

function parseChatContent(raw: string): string {
  const response = JSON.parse(raw) as ChatCompletion;
  const message = response.choices?.[0]?.message;
  const content = message?.content ?? message?.reasoning_content ?? message?.reasoning ?? "";
  return typeof content === "string" ? content.trim() : "";
}

function parseAgentJsonDocs(raw: string): AgentJsonDoc[] {
  try {
    const parsed = JSON.parse(raw) as AgentJsonDoc | AgentJsonDoc[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Fall through to a raw decoder-style scan. `openclaw agent --json` has
    // emitted both single JSON documents and log-prefixed streams across
    // versions, so match the legacy helper's permissive extraction shape.
  }

  const docs: AgentJsonDoc[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== "{") continue;
    for (let end = index + 1; end <= raw.length; end += 1) {
      try {
        const parsed = JSON.parse(raw.slice(index, end)) as AgentJsonDoc | AgentJsonDoc[];
        docs.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        index = end - 1;
        break;
      } catch {
        // Keep extending the candidate slice until it becomes valid JSON.
      }
    }
  }
  return docs;
}

function parseAgentText(raw: string): string {
  return parseAgentJsonDocs(raw)
    .flatMap((doc) => doc.payloads ?? doc.result?.payloads ?? [])
    .map((payload) => payload.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

async function preseedLaunchableClone(
  host: HostCliClient,
  cloneDir: string,
  artifacts: ArtifactSink,
): Promise<void> {
  await artifacts.writeJson("launchable-clone.json", { cloneDir, ref: "main" });
  const result = await runBash(
    host,
    [
      `rm -rf ${JSON.stringify(cloneDir)}`,
      `git clone --local --no-hardlinks ${JSON.stringify(REPO_ROOT)} ${JSON.stringify(cloneDir)}`,
      `git -C ${JSON.stringify(cloneDir)} checkout -B main HEAD`,
      `git -C ${JSON.stringify(cloneDir)} remote set-url origin ${JSON.stringify(cloneDir)}`,
    ].join(" && "),
    {
      artifactName: "phase-0-preseed-launchable-clone",
      env: runEnv(),
      timeoutMs: 120_000,
    },
  );
  expectExitZero(result, "preseed launchable clone");
}

async function cleanupLaunchableState(host: HostCliClient, cloneDir: string): Promise<void> {
  await runBash(
    host,
    [
      `if command -v nemoclaw >/dev/null 2>&1; then nemoclaw ${JSON.stringify(SANDBOX_NAME)} destroy --yes 2>/dev/null || true; fi`,
      `if command -v openshell >/dev/null 2>&1; then openshell sandbox delete ${JSON.stringify(SANDBOX_NAME)} 2>/dev/null || true; fi`,
      "if command -v openshell >/dev/null 2>&1; then openshell gateway destroy -g nemoclaw 2>/dev/null || true; fi",
      `sudo rm -rf ${JSON.stringify(cloneDir)} 2>/dev/null || rm -rf ${JSON.stringify(cloneDir)} || true`,
    ].join("\n"),
    {
      artifactName: "cleanup-launchable-state",
      env: runEnv({ PATH: `/usr/local/bin:${process.env.PATH ?? ""}` }),
      timeoutMs: 180_000,
    },
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectPongFromSandboxInference(
  sandboxExec: (command: string[], artifactName: string) => Promise<ShellProbeResult>,
): Promise<void> {
  const payload = JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
    max_tokens: 100,
  });

  let lastContent = "";
  let lastResult: ShellProbeResult | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResult = await sandboxExec(
      [
        "curl",
        "-s",
        "--max-time",
        "60",
        "https://inference.local/v1/chat/completions",
        "-H",
        "Content-Type: application/json",
        "-d",
        payload,
      ],
      `phase-6-sandbox-inference-attempt-${attempt}`,
    );
    if (lastResult.stdout.trim()) {
      try {
        lastContent = parseChatContent(lastResult.stdout);
      } catch {
        lastContent = lastResult.stdout.slice(0, 200);
      }
      if (/PONG/i.test(lastContent)) return;
    }
    if (attempt < 3) await sleep(5_000);
  }

  throw new Error(
    `sandbox inference.local expected PONG after 3 attempts; last content='${lastContent}'; ` +
      `stdout='${lastResult?.stdout.slice(0, 300) ?? ""}'; stderr='${lastResult?.stderr.slice(0, 300) ?? ""}'`,
  );
}

const runLaunchableSmokeTest = shouldRunLiveE2EScenarios() ? test : test.skip;

runLaunchableSmokeTest(
  "launchable smoke: bootstrap, onboard, sandbox health, live inference, cleanup",
  { timeout: TEST_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    validateSandboxName(SANDBOX_NAME);

    await artifacts.writeJson("scenario.json", {
      id: "launchable-smoke",
      runner: "vitest",
      boundary: "ubuntu-launchable-install-flow",
      migratedFrom: "test/e2e/test-launchable-smoke.sh",
      refs: ["#2599", "#5098"],
      phases: [
        "preseed-launchable-clone",
        "prerequisites",
        "brev-launchable-ci-cpu",
        "install-artifacts",
        "onboard",
        "sandbox-health",
        "live-inference",
        "cleanup",
      ],
      workflowRetirement: "deferred to #5098 Phase 11",
    });

    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    expect(apiKey.startsWith("nvapi-"), "NVIDIA_INFERENCE_API_KEY must start with nvapi-").toBe(
      true,
    );

    expect(fs.existsSync(LAUNCHABLE_SCRIPT), `${LAUNCHABLE_SCRIPT} missing`).toBe(true);

    const sudo = await host.command("sudo", ["-n", "true"], {
      artifactName: "prereq-passwordless-sudo",
      env: runEnv(),
      timeoutMs: 30_000,
    });
    if (sudo.exitCode !== 0) skip("passwordless sudo is required for launchable smoke");

    const dockerInfo = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info",
      env: runEnv(),
      timeoutMs: 30_000,
    });
    expectExitZero(dockerInfo, "Docker is running");

    const network = await host.command(
      "curl",
      ["-sf", "--max-time", "10", "https://inference-api.nvidia.com/v1/models"],
      { artifactName: "prereq-inference-api-models", env: runEnv(), timeoutMs: 30_000 },
    );
    expectExitZero(network, "inference-api.nvidia.com reachable");

    const cloneDir = path.join(os.tmpdir(), `NemoClaw-launchable-vitest-${randomUUID()}`);
    cleanup.add(`remove launchable clone ${cloneDir}`, async () =>
      cleanupLaunchableState(host, cloneDir),
    );
    await cleanupLaunchableState(host, cloneDir);
    await preseedLaunchableClone(host, cloneDir, artifacts);

    const installLog = artifacts.pathFor("launch-plugin.log");
    const install = await host.command("sudo", ["-E", "bash", LAUNCHABLE_SCRIPT], {
      artifactName: "phase-2-brev-launchable-ci-cpu",
      env: runEnv({
        LAUNCH_LOG: installLog,
        NEMOCLAW_CLONE_DIR: cloneDir,
        NEMOCLAW_REF: "main",
        SKIP_DOCKER_PULL: process.env.SKIP_DOCKER_PULL ?? "1",
      }),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    expectExitZero(install, "brev-launchable-ci-cpu.sh completed");

    const pathEnv = runEnv({ PATH: `/usr/local/bin:${process.env.PATH ?? ""}` });

    const nemoclawHelp = await runBash(host, "command -v nemoclaw && nemoclaw --help >/dev/null", {
      artifactName: "phase-3-nemoclaw-help",
      env: pathEnv,
      timeoutMs: 30_000,
    });
    expectExitZero(nemoclawHelp, "nemoclaw is on PATH and --help works");

    const openshellVersion = await runBash(host, "command -v openshell && openshell --version", {
      artifactName: "phase-3-openshell-version",
      env: pathEnv,
      timeoutMs: 30_000,
    });
    expectExitZero(openshellVersion, "openshell is on PATH and --version works");

    const nodeVersion = await host.command(
      "node",
      [
        "-p",
        "JSON.stringify({version: process.version, major: Number(process.versions.node.split('.')[0])})",
      ],
      { artifactName: "phase-3-node-version", env: pathEnv, timeoutMs: 30_000 },
    );
    expectExitZero(nodeVersion, "node version probe");
    const node = JSON.parse(nodeVersion.stdout) as { version: string; major: number };
    await artifacts.writeJson("node-version.json", node);
    expect(
      node.major,
      `Node.js too old after launchable install: ${node.version}`,
    ).toBeGreaterThanOrEqual(20);

    const dockerAfterInstall = await host.command("docker", ["info"], {
      artifactName: "phase-3-docker-info-after-install",
      env: pathEnv,
      timeoutMs: 30_000,
    });
    expectExitZero(dockerAfterInstall, "Docker running after install");
    expect(fs.existsSync(SENTINEL), `${SENTINEL} missing`).toBe(true);
    expect(fs.existsSync(path.join(cloneDir, ".git")), `${cloneDir}/.git missing`).toBe(true);
    expect(fs.existsSync(path.join(cloneDir, "dist")), `${cloneDir}/dist missing`).toBe(true);
    expect(
      fs.existsSync(path.join(cloneDir, "nemoclaw", "dist")),
      `${cloneDir}/nemoclaw/dist missing`,
    ).toBe(true);

    let onboard: ShellProbeResult | undefined;
    for (let attempt = 1; attempt <= ONBOARD_ATTEMPTS; attempt += 1) {
      onboard = await host.command("nemoclaw", ["onboard", "--non-interactive"], {
        artifactName: attempt === 1 ? "phase-4-onboard" : `phase-4-onboard-attempt-${attempt}`,
        cwd: cloneDir,
        env: runEnv({
          PATH: `/usr/local/bin:${process.env.PATH ?? ""}`,
          NVIDIA_INFERENCE_API_KEY: apiKey,
          NEMOCLAW_MODEL: MODEL,
          NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
          NEMOCLAW_RECREATE_SANDBOX: "1",
        }),
        redactionValues: [apiKey],
        timeoutMs: ONBOARD_TIMEOUT_MS,
      });
      if (onboard.exitCode === 0) break;
      if (isTransientProviderValidationFailure(onboard) && attempt < ONBOARD_ATTEMPTS) {
        await sleep(30_000 * attempt);
        continue;
      }
      if (isTransientProviderValidationFailure(onboard) && process.env.GITHUB_ACTIONS === "true") {
        await artifacts.writeJson("transient-provider-validation.skip.json", {
          reason: "transient NVIDIA Endpoints validation failure during launchable onboard",
          attempts: ONBOARD_ATTEMPTS,
          sourceBoundary: "external NVIDIA Endpoints provider availability",
          removalCondition:
            "remove once CI endpoint validation is stable for a release cycle or covered by a hermetic provider-validation fixture",
        });
        skip(
          `NVIDIA Endpoints validation hit a transient upstream/rate-limit failure after ${ONBOARD_ATTEMPTS} attempts`,
        );
      }
      break;
    }
    expectExitZero(onboard as ShellProbeResult, "nemoclaw onboard --non-interactive");

    const list = await host.command("nemoclaw", ["list"], {
      artifactName: "phase-5-nemoclaw-list",
      cwd: cloneDir,
      env: pathEnv,
      timeoutMs: 60_000,
    });
    expectExitZero(list, "nemoclaw list");
    expect(list.stdout).toContain(SANDBOX_NAME);

    const status = await host.command("nemoclaw", [SANDBOX_NAME, "status"], {
      artifactName: "phase-5-nemoclaw-status",
      cwd: cloneDir,
      env: pathEnv,
      timeoutMs: 60_000,
    });
    expectExitZero(status, `nemoclaw ${SANDBOX_NAME} status`);

    const inferenceConfig = await host.command("openshell", ["inference", "get"], {
      artifactName: "phase-5-openshell-inference-get",
      env: pathEnv,
      timeoutMs: 30_000,
    });
    expectExitZero(inferenceConfig, "openshell inference get");
    expect(inferenceConfig.stdout).toMatch(/nvidia-prod/i);

    const gatewayContainer = await runBash(
      host,
      "docker ps --format '{{.Names}}' | grep -E 'nemoclaw|openshell'",
      { artifactName: "phase-5-gateway-container", env: pathEnv, timeoutMs: 30_000 },
    );
    const gatewayContainerNames = gatewayContainer.stdout.trim();
    await artifacts.writeJson("gateway-container.json", {
      confirmed: gatewayContainerNames.length > 0,
      stdout: gatewayContainer.stdout,
    });
    expect(gatewayContainerNames, "expected a NemoClaw/OpenShell gateway container").not.toBe("");

    const directPayload = JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: 100,
    });
    const direct = await host.command(
      "curl",
      [
        "-s",
        "--max-time",
        "30",
        "-X",
        "POST",
        "https://inference-api.nvidia.com/v1/chat/completions",
        "-H",
        "Content-Type: application/json",
        "-H",
        `Authorization: Bearer ${apiKey}`,
        "-d",
        directPayload,
      ],
      {
        artifactName: "phase-6-direct-nvidia-chat",
        env: pathEnv,
        redactionValues: [apiKey],
        timeoutMs: INFERENCE_TIMEOUT_MS,
      },
    );
    expectExitZero(direct, "direct NVIDIA Endpoints chat completion");
    expect(parseChatContent(direct.stdout)).toMatch(/PONG/i);

    const sandboxExec = (command: string[], artifactName: string) =>
      sandbox.exec(SANDBOX_NAME, command, {
        artifactName,
        env: pathEnv,
        timeoutMs: INFERENCE_TIMEOUT_MS,
      });
    await expectPongFromSandboxInference(sandboxExec);

    const sessionId = `e2e-launchable-${Date.now()}-${randomUUID()}`;
    const agent = await sandboxExec(
      [
        "openclaw",
        "agent",
        "--agent",
        "main",
        "--json",
        "--thinking",
        "off",
        "--session-id",
        sessionId,
        "-m",
        "What is 6 multiplied by 7? Reply with only the integer, no extra words.",
      ],
      "phase-6-openclaw-agent",
    );
    expect(
      agent.exitCode,
      `openclaw agent failed; rc=${agent.exitCode}; stdout='${agent.stdout.slice(0, 300)}'; stderr='${agent.stderr.slice(0, 300)}'`,
    ).toBe(0);
    const agentReply = parseAgentText(agent.stdout);
    expect(
      /(^|[^0-9])42([^0-9]|$)/.test(agentReply),
      `expected agent reply to contain 42; rc=${agent.exitCode}; reply='${agentReply.slice(0, 200)}'; stdout='${agent.stdout.slice(0, 300)}'; stderr='${agent.stderr.slice(0, 300)}'`,
    ).toBe(true);

    const destroy = await host.command("nemoclaw", [SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "phase-7-nemoclaw-destroy",
      cwd: cloneDir,
      env: pathEnv,
      timeoutMs: 120_000,
    });
    expectExitZero(destroy, `destroy ${SANDBOX_NAME}`);
    await sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "phase-7-openshell-gateway-destroy",
      env: pathEnv,
      timeoutMs: 60_000,
    });

    const registryFile = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
    if (fs.existsSync(registryFile)) {
      expect(fs.readFileSync(registryFile, "utf8")).not.toContain(`"${SANDBOX_NAME}"`);
    }

    await cleanupLaunchableState(host, cloneDir);
  },
);
