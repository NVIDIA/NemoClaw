// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest replacement for test/e2e/test-cloud-inference-e2e.sh.
 *
 * Preserves the legacy real boundaries: install.sh non-interactive setup,
 * Docker, a named OpenClaw sandbox, inference.local chat completion from
 * inside the sandbox, repo skill validation, and sandbox /sandbox/.openclaw
 * filesystem validation via the same shell helpers the bash suite uses.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  buildPreContractExternalProviderSkipEvidence,
  classifyPreContractExternalProviderFailure,
  type PreContractExternalProviderFailure,
} from "./cloud-inference-provider-skip.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const REPO_SKILL_VALIDATOR = path.join(
  REPO_ROOT,
  "test",
  "e2e",
  "e2e-cloud-experimental",
  "features",
  "skill",
  "lib",
  "validate_repo_skills.sh",
);
const SANDBOX_SKILL_VALIDATOR = path.join(
  REPO_ROOT,
  "test",
  "e2e",
  "e2e-cloud-experimental",
  "features",
  "skill",
  "lib",
  "validate_sandbox_openclaw_skills.sh",
);
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-cloud-inference";
const CLOUD_MODEL =
  process.env.NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";
const INSTALL_TIMEOUT_MS = 25 * 60_000;
const CHAT_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 40 * 60_000;
const MAX_ATTEMPTS = positiveInteger(process.env.E2E_PHASE_5B_MAX_ATTEMPTS, 3);
const RETRY_SLEEP_MS = positiveInteger(process.env.E2E_PHASE_5B_RETRY_SLEEP_SEC, 5) * 1_000;

validateSandboxName(SANDBOX_NAME);

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return fallback;
  return Number.parseInt(value, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

async function writePreContractExternalProviderSkip(
  artifacts: ArtifactSink,
  install: ShellProbeResult,
  classification: PreContractExternalProviderFailure,
): Promise<void> {
  const evidence = buildPreContractExternalProviderSkipEvidence(install, classification);
  await artifacts.writeJson("transient-provider-validation.skip.json", evidence);
  await artifacts.writeJson("scenario-result.json", evidence);
}

function testEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const base = buildAvailabilityProbeEnv();
  return {
    ...base,
    HOME: home,
    PATH: [path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin"), base.PATH]
      .filter(Boolean)
      .join(":"),
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup mirrors the legacy teardown: best effort, because some failures
    // happen before OpenShell or the sandbox exists.
  }
}

async function cleanupCloudInferenceState(
  host: HostCliClient,
  sandbox: SandboxClient,
  home: string,
): Promise<void> {
  const env = testEnv(home);
  await bestEffort(() =>
    host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "cleanup-nemoclaw-destroy-cloud-inference",
      env,
      timeoutMs: 120_000,
    }),
  );
  await bestEffort(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete-cloud-inference",
      env,
      timeoutMs: 60_000,
    }),
  );
}

function openAiChatContent(raw: string): string {
  const parsed = JSON.parse(raw) as {
    choices?: Array<{
      message?: {
        content?: unknown;
        reasoning?: unknown;
        reasoning_content?: unknown;
      };
      text?: unknown;
    }>;
  };
  const first = parsed.choices?.[0];
  const message = first?.message;
  for (const value of [
    message?.content,
    message?.reasoning_content,
    message?.reasoning,
    first?.text,
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function expectCliOnPath(host: HostCliClient, home: string): Promise<void> {
  const result = await host.command(
    "bash",
    [
      "-lc",
      "command -v nemoclaw && command -v openshell && nemoclaw --version && openshell --version",
    ],
    {
      artifactName: "phase-1-cli-path-check",
      env: testEnv(home),
      timeoutMs: 30_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
}

async function expectLiveChatPong(
  sandbox: SandboxClient,
  home: string,
  apiKey: string,
): Promise<{ attempt: number; content: string }> {
  const payload = JSON.stringify({
    model: CLOUD_MODEL,
    messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
    max_tokens: 100,
  });
  let lastFailure = "chat completion was not attempted";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await sandbox.exec(
      SANDBOX_NAME,
      [
        "curl",
        "-sS",
        "--max-time",
        "90",
        "https://inference.local/v1/chat/completions",
        "-H",
        "Content-Type: application/json",
        "--data-raw",
        payload,
      ],
      {
        artifactName: `phase-2-inference-local-chat-attempt-${attempt}`,
        env: testEnv(home),
        redactionValues: [apiKey],
        timeoutMs: CHAT_TIMEOUT_MS,
      },
    );

    if (response.exitCode !== 0) {
      lastFailure = `ssh/curl failed (exit ${response.exitCode}): ${resultText(response).slice(0, 500)}`;
    } else if (!response.stdout.trim()) {
      lastFailure = "empty response from inference.local";
    } else {
      try {
        const content = openAiChatContent(response.stdout);
        if (/pong/i.test(content)) return { attempt, content };
        lastFailure = `expected PONG, got: ${content.slice(0, 300)}`;
      } catch (error) {
        lastFailure = `response was not parseable JSON: ${
          error instanceof Error ? error.message : String(error)
        }; body: ${response.stdout.slice(0, 500)}`;
      }
    }

    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_SLEEP_MS);
  }

  throw new Error(`Live chat failed after ${MAX_ATTEMPTS} attempt(s): ${lastFailure}`);
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "cloud inference: inference.local chat and OpenClaw skill filesystem validate",
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    const apiKey = secrets.required("NVIDIA_API_KEY");
    expect(apiKey.startsWith("nvapi-"), "NVIDIA_API_KEY must start with nvapi-").toBe(true);

    expect(fs.existsSync(CLI_ENTRYPOINT), `missing CLI entrypoint: ${CLI_ENTRYPOINT}`).toBe(true);
    expect(
      fs.existsSync(REPO_SKILL_VALIDATOR),
      `missing repo skill validator: ${REPO_SKILL_VALIDATOR}`,
    ).toBe(true);
    expect(
      fs.existsSync(SANDBOX_SKILL_VALIDATOR),
      `missing sandbox skill validator: ${SANDBOX_SKILL_VALIDATOR}`,
    ).toBe(true);

    await artifacts.writeJson("scenario.json", {
      id: "cloud-inference",
      runner: "vitest",
      boundary: "install-sh-onboard-sandbox-inference-local-skill-filesystem",
      legacySource: "test/e2e/test-cloud-inference-e2e.sh",
      contracts: [
        "Docker is running before install/onboard",
        "NVIDIA_API_KEY is present and nvapi-prefixed",
        "install.sh --non-interactive creates or recreates the named OpenClaw sandbox",
        "nemoclaw and openshell are available on PATH after install",
        "curl inside the sandbox reaches https://inference.local/v1/chat/completions and returns PONG",
        "repo .agents/skills SKILL.md frontmatter and body validate",
        "sandbox /sandbox/.openclaw and openclaw.json validate; skills subdir may be present or absent",
      ],
      model: CLOUD_MODEL,
      maxChatAttempts: MAX_ATTEMPTS,
      preContractExternalProviderFailureHandling: {
        status: "skip",
        sourceBoundary: "external NVIDIA Endpoints provider availability",
        evidenceArtifact: "transient-provider-validation.skip.json",
      },
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "phase-1-docker-info-cloud-inference",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(`Docker is required for cloud inference E2E: ${resultText(docker)}`);
      }
      return skip("Docker is required for cloud inference E2E");
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloud-inference-home-"));
    cleanup.add(`remove cloud inference state for ${SANDBOX_NAME}`, async () => {
      await cleanupCloudInferenceState(host, sandbox, home);
      fs.rmSync(home, { recursive: true, force: true });
    });
    await cleanupCloudInferenceState(host, sandbox, home);

    const install = await host.command(
      "bash",
      ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName: "phase-1-install-and-onboard-cloud-inference",
        cwd: REPO_ROOT,
        env: testEnv(home, {
          NVIDIA_API_KEY: apiKey,
          NEMOCLAW_AGENT: "openclaw",
          NEMOCLAW_PROVIDER: "cloud",
          NEMOCLAW_RECREATE_SANDBOX: "1",
          NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
        }),
        redactionValues: [apiKey],
        timeoutMs: INSTALL_TIMEOUT_MS,
      },
    );
    const preContractFailure =
      install.exitCode === 0 ? null : classifyPreContractExternalProviderFailure(install);
    if (preContractFailure) {
      await writePreContractExternalProviderSkip(artifacts, install, preContractFailure);
      return skip("NVIDIA endpoint validation was unavailable/rate-limited during install/onboard");
    }
    expect(install.exitCode, resultText(install)).toBe(0);

    await expectCliOnPath(host, home);

    const chat = await expectLiveChatPong(sandbox, home, apiKey);
    await artifacts.writeJson("phase-2-chat-result.json", {
      model: CLOUD_MODEL,
      attempt: chat.attempt,
      content: chat.content,
    });

    const repoSkills = await host.command("bash", [REPO_SKILL_VALIDATOR, "--repo", REPO_ROOT], {
      artifactName: "phase-3-validate-repo-skills",
      cwd: REPO_ROOT,
      env: testEnv(home),
      timeoutMs: 60_000,
    });
    expect(repoSkills.exitCode, resultText(repoSkills)).toBe(0);

    const sandboxSkills = await host.command("bash", [SANDBOX_SKILL_VALIDATOR], {
      artifactName: "phase-3-validate-sandbox-openclaw-skills",
      cwd: REPO_ROOT,
      env: testEnv(home, { SANDBOX_NAME }),
      timeoutMs: 90_000,
    });
    expect(sandboxSkills.exitCode, resultText(sandboxSkills)).toBe(0);
    const sandboxSkillStatus = /SKILLS_SUBDIR=present/.test(sandboxSkills.stdout)
      ? "present"
      : /SKILLS_SUBDIR=absent/.test(sandboxSkills.stdout)
        ? "absent"
        : "unknown";
    expect(sandboxSkillStatus, resultText(sandboxSkills)).not.toBe("unknown");

    await artifacts.writeJson("scenario-result.json", {
      id: "cloud-inference",
      status: "passed",
      assertions: {
        dockerRunning: docker.exitCode === 0,
        installCompleted: install.exitCode === 0,
        chatReturnedPong: /pong/i.test(chat.content),
        repoSkillsValidated: repoSkills.exitCode === 0,
        sandboxOpenClawLayoutValidated: sandboxSkills.exitCode === 0,
        sandboxSkillsSubdir: sandboxSkillStatus,
      },
    });
  },
  TEST_TIMEOUT_MS,
);
