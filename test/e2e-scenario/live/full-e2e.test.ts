// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-full-e2e.sh. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { containsInteger42Answer } from "../../helpers/e2e-answer-assertions.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { type HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import {
  assertSecurityPosture,
  securityPostureEnabled,
  securityPostureModeEnv,
} from "../fixtures/security-posture.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-full-vitest";
const LIVE_TIMEOUT_MS = 50 * 60_000;
const liveTest = shouldRunLiveE2EScenarios() ? test : test.skip;

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;
validateSandboxName(SANDBOX_NAME);

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${process.env.PATH ?? ""}`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...securityPostureModeEnv(),
    ...extra,
  };
}

function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

async function repoNemoclaw(
  host: HostCliClient,
  args: string[],
  artifactName: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = 120_000,
): Promise<ShellProbeResult> {
  return await host.command(process.execPath, [CLI_ENTRYPOINT, ...args], {
    artifactName,
    env: env(extraEnv),
    timeoutMs,
  });
}

async function cleanup(host: HostCliClient, sandbox: SandboxClient): Promise<void> {
  await repoNemoclaw(host, [SANDBOX_NAME, "destroy", "--yes"], "cleanup-nemoclaw-destroy").catch(
    () => undefined,
  );
  await sandbox
    .openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  await sandbox
    .openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "cleanup-openshell-gateway-destroy",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
}

function chatRequest(model: string): string {
  return JSON.stringify({
    model,
    messages: [
      {
        role: "user",
        content: "What is 6 multiplied by 7? Reply with only the integer, no extra words.",
      },
    ],
    max_tokens: 100,
  });
}

function parseReplyCommand(): string {
  return String.raw`python3 -c 'import json,sys; d=json.load(sys.stdin); m=d["choices"][0]["message"]; print((m.get("content") or m.get("reasoning_content") or "").strip())'`;
}

liveTest(
  "full e2e: install, onboard, inference, cli operations, and cleanup",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup: cleanupRegistry, host, sandbox, secrets, skip }) => {
    const hosted = requireHostedInferenceConfig(secrets);
    const redactionValues = [hosted.apiKey];
    await artifacts.writeJson("scenario.json", {
      id: "full-e2e",
      legacySource: "test/e2e/test-full-e2e.sh",
      sandboxName: SANDBOX_NAME,
      endpointUrl: hosted.endpointUrl,
      model: hosted.model,
      contracts: [
        "install.sh --non-interactive completes onboarding",
        "nemoclaw and openshell are installed and usable",
        "sandbox appears in list/status and has policy/inference configuration",
        "direct hosted inference and sandbox inference.local both respond",
        "nemoclaw logs produces output and cleanup removes registry state",
        ...(securityPostureEnabled()
          ? ["non-root host, locked rc/proxy files, configure guard, and clean startup log"]
          : []),
      ],
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "phase-0-docker-info",
      env: env(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") throw new Error(resultText(docker));
      skip(`Docker is required: ${resultText(docker)}`);
    }

    cleanupRegistry.add("remove full-e2e sandbox", () => cleanup(host, sandbox));
    await cleanup(host, sandbox);

    const install = await host.command("bash", ["install.sh", "--non-interactive", "--fresh"], {
      artifactName: "phase-1-install-sh",
      cwd: REPO_ROOT,
      env: env({ ...hosted.env, NVIDIA_INFERENCE_API_KEY: hosted.apiKey }),
      redactionValues,
      timeoutMs: 25 * 60_000,
    });
    expect(install.exitCode, resultText(install)).toBe(0);

    const pathProbe = await host.command(
      "bash",
      [
        "-lc",
        'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; command -v nemoclaw; command -v openshell; nemoclaw --help >/dev/null',
      ],
      { artifactName: "phase-2-path-probe", env: env(), timeoutMs: 60_000 },
    );
    expect(pathProbe.exitCode, resultText(pathProbe)).toBe(0);
    expect(pathProbe.stdout).toContain("nemoclaw");
    expect(pathProbe.stdout).toContain("openshell");

    const list = await repoNemoclaw(host, ["list"], "phase-3-nemoclaw-list");
    expect(list.exitCode, resultText(list)).toBe(0);
    expect(list.stdout).toContain(SANDBOX_NAME);
    const status = await repoNemoclaw(host, [SANDBOX_NAME, "status"], "phase-3-nemoclaw-status");
    expect(status.exitCode, resultText(status)).toBe(0);

    const inference = await sandbox.openshell(["inference", "get"], {
      artifactName: "phase-3-openshell-inference-get",
      env: env(),
      timeoutMs: 60_000,
    });
    expect(inference.exitCode, resultText(inference)).toBe(0);
    expect(resultText(inference)).toContain(hosted.model);

    const policy = await sandbox.openshell(["policy", "get", "--full", SANDBOX_NAME], {
      artifactName: "phase-3-openshell-policy-get",
      env: env(),
      timeoutMs: 60_000,
    });
    expect(policy.exitCode, resultText(policy)).toBe(0);
    expect(resultText(policy)).toMatch(/network_policies|egress/i);

    const direct = await host.command(
      "curl",
      [
        "-fsS",
        "--max-time",
        "60",
        "-H",
        `Authorization: Bearer ${hosted.apiKey}`,
        `${hosted.endpointUrl}/models`,
      ],
      {
        artifactName: "phase-4-direct-hosted-inference-models",
        env: env(),
        redactionValues,
        timeoutMs: 90_000,
      },
    );
    expect(direct.exitCode, resultText(direct)).toBe(0);
    expect(resultText(direct)).toContain("data");

    const sandboxInference = await sandbox.exec(
      SANDBOX_NAME,
      [
        "sh",
        "-lc",
        `curl -fsS --max-time 90 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' --data '${chatRequest(hosted.model)}' | ${parseReplyCommand()}`,
      ],
      {
        artifactName: "phase-4-sandbox-inference-local",
        env: env(),
        redactionValues,
        timeoutMs: 120_000,
      },
    );
    expect(sandboxInference.exitCode, resultText(sandboxInference)).toBe(0);
    expect(containsInteger42Answer(sandboxInference.stdout), resultText(sandboxInference)).toBe(
      true,
    );

    const logs = await repoNemoclaw(
      host,
      [SANDBOX_NAME, "logs"],
      "phase-5-nemoclaw-logs",
      {},
      90_000,
    );
    expect(logs.exitCode, resultText(logs)).toBe(0);
    expect(resultText(logs).trim().length, resultText(logs)).toBeGreaterThan(0);

    const securityPosture = securityPostureEnabled()
      ? await assertSecurityPosture(host, sandbox, SANDBOX_NAME, "openclaw")
      : null;

    await cleanup(host, sandbox);
    const registry = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
    const registryText = fs.existsSync(registry) ? fs.readFileSync(registry, "utf8") : "";
    expect(registryText).not.toContain(SANDBOX_NAME);

    await artifacts.writeJson("scenario-result.json", {
      id: "full-e2e",
      securityPosture,
      status: "passed",
    });
  },
);
