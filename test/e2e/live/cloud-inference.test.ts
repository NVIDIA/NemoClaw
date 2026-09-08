// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Preserves the real boundaries: install.sh non-interactive setup,
 * Docker, a named OpenClaw sandbox, inference.local chat completion from
 * inside the sandbox, repo skill validation, and sandbox /sandbox/.openclaw
 * filesystem validation via the same shell helpers the bash suite uses.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { assertCleanupSucceededOrAbsent } from "../fixtures/cleanup-resources.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { testHomeEnvironment } from "../fixtures/environment-profiles.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import { runBoundedRetry } from "../../../tools/e2e/retry-evidence.mts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  buildPreContractExternalProviderSkipEvidence,
  classifyCloudChatFailure,
  classifyPreContractExternalProviderFailure,
  cloudChatWriteOutArg,
  parseCloudChatResponse,
  type PreContractExternalProviderFailure,
} from "./cloud-inference-provider-skip.ts";
import { buildSandboxCredentialScanCommand } from "./cloud-inference-credential-boundary.ts";

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
  process.env.NEMOCLAW_MODEL ??
  process.env.NEMOCLAW_COMPAT_MODEL ??
  process.env.NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL ??
  "nvidia/nemotron-3-super-120b-a12b";
const INSTALL_TIMEOUT_MS = execTimeout(25 * 60_000);
const CHAT_TIMEOUT_MS = 120_000;
const SANDBOX_PROBE_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = testTimeout(40 * 60_000);
const MAX_ATTEMPTS = boundedPositiveInteger(
  "E2E_PHASE_5B_MAX_ATTEMPTS",
  process.env.E2E_PHASE_5B_MAX_ATTEMPTS,
  3,
);
const RETRY_SLEEP_MS =
  boundedPositiveInteger(
    "E2E_PHASE_5B_RETRY_SLEEP_SEC",
    process.env.E2E_PHASE_5B_RETRY_SLEEP_SEC,
    5,
  ) * 1_000;

validateSandboxName(SANDBOX_NAME);

/** Read a bounded retry setting and name invalid configuration in CI output. */
function boundedPositiveInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error(`${name} must be an integer between 1 and 10; got ${value}`);
  }
  return parsed;
}

async function writePreContractExternalProviderSkip(
  artifacts: ArtifactSink,
  install: ShellProbeResult,
  classification: PreContractExternalProviderFailure,
): Promise<void> {
  const evidence = buildPreContractExternalProviderSkipEvidence(install, classification);
  await artifacts.writeJson("transient-provider-validation.skip.json", evidence);
  await artifacts.target.complete(evidence);
}

function testEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return testHomeEnvironment(home, extra, { ...process.env, OPENSHELL_GATEWAY: "nemoclaw" });
}

async function bestEffortPreclean(run: () => Promise<unknown>): Promise<void> {
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
  await bestEffortPreclean(() => cleanupCloudInferenceNemoClawSandbox(host, home));
  await bestEffortPreclean(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete-cloud-inference",
      env,
      timeoutMs: 60_000,
    }),
  );
}

async function cleanupCloudInferenceNemoClawSandbox(
  host: HostCliClient,
  home: string,
): Promise<void> {
  const result = await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
    artifactName: "cleanup-nemoclaw-destroy-cloud-inference",
    env: testEnv(home),
    timeoutMs: 120_000,
  });
  assertCleanupSucceededOrAbsent(
    result,
    /Sandbox '.+' does not exist|Run 'nemoclaw onboard' to create one|sandbox .* not found|no such sandbox/iu.test(
      resultText(result),
    ),
    `cleanup cloud inference sandbox ${SANDBOX_NAME}`,
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
  artifacts: ArtifactSink,
  home: string,
  apiKey: string,
): Promise<{ attempt: number; content: string }> {
  type ChatAttempt = {
    content: string;
    failure: string;
    httpStatus: string;
    response: ShellProbeResult;
  };
  const payload = JSON.stringify({
    model: CLOUD_MODEL,
    messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
    max_tokens: 100,
  });
  const execution = await runBoundedRetry<ChatAttempt>({
    operation: "cloud-inference.chat",
    owner: "inference-provider",
    idempotence: "read-only",
    maxAttempts: MAX_ATTEMPTS,
    delayMs: RETRY_SLEEP_MS,
    run: async (attempt) => {
      const response = await sandbox.exec(
        SANDBOX_NAME,
        [
          "curl",
          "-sS",
          "--max-time",
          "90",
          "--write-out",
          cloudChatWriteOutArg(),
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
      const parsed = parseCloudChatResponse(response.stdout);
      let content = "";
      let failure = parsed.body.trim() ? "" : "empty response from inference.local";
      try {
        content = parsed.body.trim() ? openAiChatContent(parsed.body) : "";
      } catch {
        failure = "response was not parseable JSON";
      }
      if (!failure && !/pong/iu.test(content)) {
        failure = `expected PONG, got: ${content.slice(0, 300)}`;
      }
      return { content, failure, httpStatus: parsed.httpStatus, response };
    },
    classify: (value, error) => {
      if (!value) {
        return {
          outcome: "failed",
          failureClass: classifyCloudChatFailure("", "", "", error),
        };
      }
      const { content, failure, httpStatus, response } = value;
      if (response.exitCode === 0 && /^2\d{2}$/u.test(httpStatus) && /pong/iu.test(content)) {
        return { outcome: "passed" };
      }
      return {
        outcome: "failed",
        failureClass: classifyCloudChatFailure(
          httpStatus,
          response.stderr,
          failure,
          error,
          response.timedOut,
        ),
      };
    },
    onEvidence: async (evidence) => {
      await artifacts.writeJson("phase-2-inference-local-chat-retry.json", evidence);
    },
  });
  if (execution.outcome === "passed") {
    return { attempt: execution.evidence.attempts.length, content: execution.value.content };
  }
  const value = execution.value;
  throw new Error(
    `Live chat failed after ${execution.evidence.attempts.length} attempt(s): ${
      value?.failure || `exit ${value?.response.exitCode ?? "unknown"}`
    }`,
  );
}

async function expectSandboxCredentialBoundary(
  sandbox: SandboxClient,
  home: string,
  apiKey: string,
): Promise<void> {
  const authProbe = await sandbox.exec(
    SANDBOX_NAME,
    [
      "sh",
      "-lc",
      "find /sandbox -name auth-profiles.json -not -path '*/node_modules/*' -not -path '*/dist/*' -print",
    ],
    {
      artifactName: "phase-3-sandbox-auth-profiles-probe",
      env: testEnv(home),
      timeoutMs: SANDBOX_PROBE_TIMEOUT_MS,
    },
  );
  expect(authProbe.exitCode, resultText(authProbe)).toBe(0);
  expect(authProbe.stdout.trim(), "auth-profiles.json must not be present in sandbox state").toBe(
    "",
  );

  const secretScanCommand = buildSandboxCredentialScanCommand();

  const secretProbe = await sandbox.exec(SANDBOX_NAME, ["sh", "-lc", secretScanCommand], {
    artifactName: "phase-3-sandbox-secret-pattern-probe",
    env: testEnv(home),
    redactionValues: [apiKey],
    timeoutMs: SANDBOX_PROBE_TIMEOUT_MS,
  });
  expect(secretProbe.exitCode, resultText(secretProbe)).toBe(0);
  expect(secretProbe.stdout.trim(), "sandbox config must not contain secret-shaped tokens").toBe(
    "",
  );
}

test(
  "cloud inference: inference.local chat and OpenClaw skill filesystem validate",
  {
    timeout: TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "verify cloud inference prerequisites",
        "install hosted-inference OpenClaw sandbox",
        "exercise managed inference.local chat",
        "scan sandbox agent state for credentials",
        "validate repo and sandbox skill layouts",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets, skip }) => {
    const hosted = requireHostedInferenceConfig(secrets);
    const apiKey = hosted.apiKey;

    expect(fs.existsSync(CLI_ENTRYPOINT), `missing CLI entrypoint: ${CLI_ENTRYPOINT}`).toBe(true);
    expect(
      fs.existsSync(REPO_SKILL_VALIDATOR),
      `missing repo skill validator: ${REPO_SKILL_VALIDATOR}`,
    ).toBe(true);
    expect(
      fs.existsSync(SANDBOX_SKILL_VALIDATOR),
      `missing sandbox skill validator: ${SANDBOX_SKILL_VALIDATOR}`,
    ).toBe(true);

    await artifacts.target.declare({
      id: "cloud-inference",
      boundary: "install-sh-onboard-sandbox-inference-local-skill-filesystem",
      contracts: [
        "the selected runtime is available before install/onboard",
        "NVIDIA_INFERENCE_API_KEY is staged as the compatible endpoint credential",
        "install.sh --non-interactive creates or recreates the named OpenClaw sandbox",
        "nemoclaw and openshell are available on PATH after install",
        "curl inside the sandbox reaches https://inference.local/v1/chat/completions and returns PONG",
        "sandbox agent state contains neither auth-profiles.json nor secret-shaped credential values",
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

    await runtimeProvider.requireAvailable({
      artifactName: "phase-1-runtime-info-cloud-inference",
      scenarioLabel: "cloud inference",
    });

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloud-inference-home-"));
    cleanup.trackDisposable(`remove cloud inference test home ${home}`, () =>
      fs.rmSync(home, { recursive: true, force: true }),
    );
    cleanup.trackDisposable(`delete cloud inference OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cleanup-openshell-sandbox-delete-cloud-inference",
        env: testEnv(home),
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackDisposable(`destroy cloud inference sandbox ${SANDBOX_NAME}`, () =>
      cleanupCloudInferenceNemoClawSandbox(host, home),
    );
    await cleanupCloudInferenceState(host, sandbox, home);

    progress.phase("install hosted-inference OpenClaw sandbox");
    const install = await host.command(
      "bash",
      ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName: "phase-1-install-and-onboard-cloud-inference",
        cwd: REPO_ROOT,
        env: testEnv(home, {
          ...hosted.env,
          NEMOCLAW_AGENT: "openclaw",
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

    progress.phase("exercise managed inference.local chat");
    const chat = await expectLiveChatPong(sandbox, artifacts, home, apiKey);
    await artifacts.writeJson("phase-2-chat-result.json", {
      model: CLOUD_MODEL,
      attempt: chat.attempt,
      content: chat.content,
    });

    progress.phase("scan sandbox agent state for credentials");
    await expectSandboxCredentialBoundary(sandbox, home, apiKey);

    progress.phase("validate repo and sandbox skill layouts");
    const repoSkills = await host.command("bash", [REPO_SKILL_VALIDATOR, "--repo", REPO_ROOT], {
      artifactName: "phase-4-validate-repo-skills",
      cwd: REPO_ROOT,
      env: testEnv(home),
      timeoutMs: 60_000,
    });
    expect(repoSkills.exitCode, resultText(repoSkills)).toBe(0);

    const sandboxSkills = await host.command("bash", [SANDBOX_SKILL_VALIDATOR], {
      artifactName: "phase-4-validate-sandbox-openclaw-skills",
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

    await artifacts.target.complete({
      id: "cloud-inference",
      status: "passed",
      assertions: {
        runtimeProviderAvailable: true,
        installCompleted: install.exitCode === 0,
        chatReturnedPong: /pong/i.test(chat.content),
        sandboxCredentialBoundaryValidated: true,
        repoSkillsValidated: repoSkills.exitCode === 0,
        sandboxOpenClawLayoutValidated: sandboxSkills.exitCode === 0,
        sandboxSkillsSubdir: sandboxSkillStatus,
      },
    });
  },
);
