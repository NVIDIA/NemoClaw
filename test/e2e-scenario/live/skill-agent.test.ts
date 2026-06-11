// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";

// Focused Vitest live replacement coverage for test/e2e/test-skill-agent-e2e.sh.
// Keep this as a direct live test: the legacy contract is skill fixture
// injection into a real OpenClaw sandbox plus an agent turn that must read
// SKILL.md and return the verification token. The retained legacy bash lane
// remains in nightly-e2e.yaml until #5098 Phase 11 shell retirement.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const ADD_SKILL_SCRIPT = path.join(
  REPO_ROOT,
  "test",
  "e2e",
  "e2e-cloud-experimental",
  "features",
  "skill",
  "add-sandbox-skill.sh",
);
const VERIFY_SKILL_SCRIPT = path.join(
  REPO_ROOT,
  "test",
  "e2e",
  "e2e-cloud-experimental",
  "features",
  "skill",
  "verify-sandbox-skill-via-agent.sh",
);
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-skill-agent";
validateSandboxName(SANDBOX_NAME);
const SKILL_ID = "skill-smoke-fixture";
const VERIFY_PHRASE = "SKILL_SMOKE_VERIFY_K9X2";
const ONBOARD_TIMEOUT_MS = 20 * 60_000;
const AGENT_VERIFY_TIMEOUT_MS = 4 * 60_000;
const MAX_ATTEMPTS = Number.parseInt(process.env.E2E_SKILL_AGENT_MAX_ATTEMPTS ?? "3", 10);
const RETRY_SLEEP_MS =
  Number.parseInt(process.env.E2E_SKILL_AGENT_RETRY_SLEEP_SEC ?? "15", 10) * 1_000;

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

function resultText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isExternalAgentVerificationFlake(text: string): boolean {
  // Only provider/model/transport timeout signatures are skippable. OpenClaw
  // tool/runtime errors must fail this migration guard because the contract is
  // that the real agent can read SKILL.md and return the token.
  return /LLM idle timeout|request timed out|fetch timeout|model did not produce a response|ssh\/agent exit 124|exit 124/i.test(
    text,
  );
}

function isExternalProviderValidationFailure(text: string): boolean {
  return (
    /NVIDIA Endpoints endpoint validation failed/i.test(text) &&
    /HTTP 429|rate limit|quota|temporarily unavailable|timed out|timeout/i.test(text)
  );
}

function agentSectionContainsToken(agentOutput: string): boolean {
  const match = agentOutput.match(/--- agent stdout\/stderr[\s\S]*?--- end ---/);
  if (!match) return false;
  const collapsed = match[0].replace(/[\n\r`"']/g, "").toLowerCase();
  return collapsed.includes(VERIFY_PHRASE.toLowerCase());
}

function buildVerifySkillFixtureScript(): string {
  // OpenShell rejects newline-bearing command args, so keep this readable as
  // discrete clauses while emitting a single-line `sh -lc` script.
  const skillPaths = [
    `/sandbox/.openclaw/skills/${SKILL_ID}/SKILL.md`,
    `\${HOME:-/home/sandbox}/.openclaw/skills/${SKILL_ID}/SKILL.md`,
    `/home/sandbox/.openclaw/skills/${SKILL_ID}/SKILL.md`,
    `/home/openclaw/.openclaw/skills/${SKILL_ID}/SKILL.md`,
  ];
  return [
    `token=${shellQuote(VERIFY_PHRASE)}`,
    `skill=${shellQuote(SKILL_ID)}`,
    "found=0",
    `for path in ${skillPaths.map(shellQuote).join(" ")}; do if [ -f "$path" ] && grep -Fq "$token" "$path"; then echo "SKILL_TOKEN_PATH=$path"; found=1; fi; done`,
    'test "$found" = 1',
  ].join("; ");
}

async function verifySkillFixturePresent(
  sandbox: SandboxClient,
  sandboxName: string,
): Promise<boolean> {
  const result = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(buildVerifySkillFixtureScript()),
    {
      artifactName: "verify-skill-fixture-present",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  return result.exitCode === 0;
}

async function ignoreCleanupError(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Best-effort cleanup only; the test may be running before OpenShell exists
    // or after onboarding already removed part of the runtime state.
  }
}

const runSkillAgentTest = shouldRunLiveE2EScenarios() ? test : test.skip;

runSkillAgentTest(
  "skill-agent: injected sandbox skill is read by a real OpenClaw agent turn",
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      "run `npm run build:cli` before live repo CLI scenarios",
    ).toBe(true);
    expect(fs.existsSync(ADD_SKILL_SCRIPT), `missing skill add helper: ${ADD_SKILL_SCRIPT}`).toBe(
      true,
    );
    expect(
      fs.existsSync(VERIFY_SKILL_SCRIPT),
      `missing skill verify helper: ${VERIFY_SKILL_SCRIPT}`,
    ).toBe(true);

    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info-skill-agent",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(`Docker is required for skill-agent E2E: ${resultText(docker)}`);
      }
      skip("Docker is required for skill-agent E2E");
    }

    const apiKey = secrets.required("NVIDIA_API_KEY");
    expect(apiKey.startsWith("nvapi-"), "NVIDIA_API_KEY must start with nvapi-").toBe(true);

    await artifacts.writeJson("scenario.json", {
      id: "skill-agent",
      runner: "vitest",
      boundary: "direct-cli-onboard-sandbox-skill-and-agent-turn",
      legacySource: "test/e2e/test-skill-agent-e2e.sh",
      contract: [
        "Docker is available before onboarding",
        "NVIDIA_API_KEY is present and nvapi-prefixed",
        "nemoclaw onboard creates/recreates a real OpenClaw sandbox",
        "skill-smoke-fixture is injected into sandbox and home skill roots",
        "openclaw agent reads SKILL.md and returns SKILL_SMOKE_VERIFY_K9X2",
        "provider/tool-call transport flakes only skip after the skill fixture is proven present",
      ],
    });

    const cleanupEnv = buildAvailabilityProbeEnv();
    await ignoreCleanupError(() =>
      host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "pre-cleanup-nemoclaw-destroy-skill-agent",
        env: cleanupEnv,
        timeoutMs: 120_000,
      }),
    );
    await ignoreCleanupError(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-openshell-sandbox-delete-skill-agent",
        env: cleanupEnv,
        timeoutMs: 60_000,
      }),
    );

    cleanup.add(`destroy skill-agent sandbox ${SANDBOX_NAME}`, async () => {
      await ignoreCleanupError(() =>
        host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: "cleanup-nemoclaw-destroy-skill-agent",
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 120_000,
        }),
      );
      await ignoreCleanupError(() =>
        sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-openshell-sandbox-delete-skill-agent",
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 60_000,
        }),
      );
    });

    const onboard = await host.command(
      "node",
      [
        CLI_ENTRYPOINT,
        "onboard",
        "--fresh",
        "--non-interactive",
        "--yes",
        "--yes-i-accept-third-party-software",
      ],
      {
        artifactName: "onboard-skill-agent",
        env: {
          ...buildAvailabilityProbeEnv(),
          NVIDIA_API_KEY: apiKey,
          NEMOCLAW_AGENT: "openclaw",
          NEMOCLAW_PROVIDER: "cloud",
          NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
          NEMOCLAW_RECREATE_SANDBOX: "1",
          // This migration targets skill injection + agent skill discovery, not
          // policy rendering/enforcement. Dedicated policy E2Es own that
          // boundary; skipping policies keeps this live guard focused and avoids
          // conflating policy setup failures with the skill-agent contract.
          NEMOCLAW_POLICY_MODE: "skip",
        },
        redactionValues: [apiKey],
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    const onboardText = resultText(onboard);
    if (onboard.exitCode !== 0 && isExternalProviderValidationFailure(onboardText)) {
      await artifacts.writeJson("scenario-result.json", {
        id: "skill-agent",
        status: "skipped",
        reason: "external-provider-validation-unavailable-before-sandbox-skill-check",
        onboardExitCode: onboard.exitCode,
      });
      skip("NVIDIA endpoint validation was unavailable/rate-limited during onboarding");
    }
    expect(onboard.exitCode, onboardText).toBe(0);

    const addSkill = await host.command("bash", [ADD_SKILL_SCRIPT], {
      artifactName: "add-sandbox-skill-fixture",
      cwd: REPO_ROOT,
      env: {
        ...buildAvailabilityProbeEnv(),
        SANDBOX_NAME,
        SKILL_ID,
        SKILL_DESCRIPTION: "E2E smoke skill injected for agent verification",
      },
      timeoutMs: 120_000,
    });
    expect(addSkill.exitCode, resultText(addSkill)).toBe(0);
    expect(addSkill.stdout).toContain(`QUERY_PATH=/sandbox/.openclaw/skills/${SKILL_ID}/SKILL.md`);
    expect(addSkill.stdout).toContain("HOME_QUERY_PATH=");
    expect(await verifySkillFixturePresent(sandbox, SANDBOX_NAME)).toBe(true);

    let lastAgentOutput = "";
    let agentOk = false;
    let lastExitCode: number | null = null;
    const attempts = Math.max(1, Number.isFinite(MAX_ATTEMPTS) ? MAX_ATTEMPTS : 3);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const verify = await host.command("bash", [VERIFY_SKILL_SCRIPT], {
        artifactName: `verify-sandbox-skill-via-agent-${attempt}`,
        cwd: REPO_ROOT,
        env: {
          ...buildAvailabilityProbeEnv(),
          NVIDIA_API_KEY: apiKey,
          SANDBOX_NAME,
          SKILL_ID,
          VERIFY_TOKEN: VERIFY_PHRASE,
          SKILL_VERIFY_SESSION_ID: `skill-agent-vitest-${process.pid}-${attempt}`,
        },
        redactionValues: [apiKey],
        timeoutMs: AGENT_VERIFY_TIMEOUT_MS,
      });
      lastAgentOutput = resultText(verify);
      lastExitCode = verify.exitCode;
      if (verify.exitCode === 0 || agentSectionContainsToken(lastAgentOutput)) {
        agentOk = true;
        break;
      }
      if (attempt < attempts) await sleep(RETRY_SLEEP_MS);
    }

    if (!agentOk && isExternalAgentVerificationFlake(lastAgentOutput)) {
      const fixturePresent = await verifySkillFixturePresent(sandbox, SANDBOX_NAME);
      if (fixturePresent) {
        await artifacts.writeJson("scenario-result.json", {
          id: "skill-agent",
          status: "skipped",
          reason: "external-agent-verification-flake-after-fixture-present",
          lastExitCode,
        });
        skip(
          "agent verification inconclusive due to model/tool-call behavior; skill fixture is present",
        );
      }
    }

    expect(
      agentOk,
      `Agent did not return ${VERIFY_PHRASE}; last exit ${lastExitCode}\n${lastAgentOutput.slice(-12_000)}`,
    ).toBe(true);

    await artifacts.writeJson("scenario-result.json", {
      id: "skill-agent",
      status: "passed",
      assertions: {
        dockerRunning: docker.exitCode === 0,
        onboardCompleted: onboard.exitCode === 0,
        skillInjected: addSkill.exitCode === 0,
        agentReturnedVerificationToken: agentOk,
      },
    });
  },
  30 * 60_000,
);
