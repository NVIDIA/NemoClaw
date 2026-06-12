// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

// Live Vitest migration for test/e2e/test-openclaw-skill-cli-e2e.sh.
// This intentionally keeps the same real shell/system boundary: run install.sh,
// onboard a Docker/OpenShell sandbox, execute OpenClaw's skills CLI inside the
// sandbox, and verify install/list/info/check agree on the workspace skill path.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-openclaw-skill-cli";
const SKILL_ID = "openclaw-skill-cli-fixture";
const SKILL_DESCRIPTION = "E2E fixture proving openclaw skills install + list roundtrip";
const REMOTE_SKILL_DIR = `/tmp/${SKILL_ID}`;
const EXPECTED_WORKSPACE_SKILL_PATH = `/sandbox/.openclaw/workspace/skills/${SKILL_ID}/SKILL.md`;
const INSTALL_TIMEOUT_MS = 45 * 60_000;
const SANDBOX_EXEC_TIMEOUT_MS = 120_000;
validateSandboxName(SANDBOX_NAME);

const runOpenClawSkillCliTest = shouldRunLiveE2EScenarios() ? test : test.skip;

function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function isEndpointRateLimited(text: string): boolean {
  return /HTTP 429|rate limit|too many requests/i.test(text);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function singleLineSandboxScript(script: string) {
  if (/[\r\n]/.test(script)) {
    throw new Error("openshell sandbox exec command args must stay single-line");
  }
  return trustedSandboxShellScript(script);
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
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup can run before install.sh has placed OpenShell on this test
    // HOME's PATH. Keep it best-effort so setup failures stay primary.
  }
}

async function cleanupOpenClawSkillCliState(
  host: HostCliClient,
  sandbox: SandboxClient,
  home: string,
): Promise<void> {
  const env = testEnv(home);
  await bestEffort(() =>
    host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "cleanup-nemoclaw-destroy-openclaw-skill-cli",
      env,
      timeoutMs: 120_000,
    }),
  );
  await bestEffort(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete-openclaw-skill-cli",
      env,
      timeoutMs: 60_000,
    }),
  );
  await bestEffort(() =>
    sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "cleanup-openshell-gateway-destroy-openclaw-skill-cli",
      env,
      timeoutMs: 120_000,
    }),
  );
}

function buildWriteSkillFixtureScript(): string {
  const skillPayload = [
    "---",
    `name: "${SKILL_ID}"`,
    `description: "${SKILL_DESCRIPTION}"`,
    "---",
    "",
    "# OpenClaw skill CLI roundtrip fixture",
    "",
    "Written by test/e2e-scenario/live/openclaw-skill-cli.test.ts.",
  ].join("\n");
  const encodedPayload = Buffer.from(skillPayload, "utf8").toString("base64");
  return [
    `rm -rf ${shellQuote(REMOTE_SKILL_DIR)}`,
    `mkdir -p ${shellQuote(REMOTE_SKILL_DIR)}`,
    `printf '%s' ${shellQuote(encodedPayload)} | base64 -d > ${shellQuote(
      `${REMOTE_SKILL_DIR}/SKILL.md`,
    )}`,
  ].join(" && ");
}

async function expectSandboxShellZero(
  sandbox: SandboxClient,
  script: string,
  artifactName: string,
  env: NodeJS.ProcessEnv,
): Promise<ShellProbeResult> {
  const result = await sandbox.execShell(SANDBOX_NAME, singleLineSandboxScript(script), {
    artifactName,
    env,
    timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  return result;
}

runOpenClawSkillCliTest(
  "openclaw-skill-cli: direct OpenClaw skills install/list/info/check roundtrip uses workspace path",
  { timeout: INSTALL_TIMEOUT_MS + 10 * 60_000 },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      "run `npm run build:cli` before live repo CLI scenarios",
    ).toBe(true);

    await artifacts.writeJson("scenario.json", {
      id: "openclaw-skill-cli",
      runner: "vitest",
      boundary: "install-sh-onboard-and-openclaw-skills-cli-in-sandbox",
      legacySource: "test/e2e/test-openclaw-skill-cli-e2e.sh",
      sandboxName: SANDBOX_NAME,
      contracts: [
        "Docker is available before install/onboard",
        "NVIDIA_API_KEY is present and nvapi-prefixed",
        "install.sh creates/recreates a real OpenClaw sandbox",
        "OPENCLAW_HOME, OPENCLAW_STATE_DIR, and OPENCLAW_WORKSPACE_DIR reach the sandbox runtime shell",
        "openclaw skills install <path> accepts a non-managed source directory inside the sandbox",
        "the installed SKILL.md lands under ${OPENCLAW_WORKSPACE_DIR}/skills/<id>",
        "openclaw skills list --json enumerates the installed workspace skill",
        "openclaw skills info <id> --json reports the workspace install path",
        "openclaw skills check --json includes the installed skill",
      ],
    });

    const apiKey = secrets.required("NVIDIA_API_KEY");
    expect(apiKey.startsWith("nvapi-"), "NVIDIA_API_KEY must start with nvapi-").toBe(true);

    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info-openclaw-skill-cli",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(`Docker is required for openclaw-skill-cli E2E: ${resultText(docker)}`);
      }
      skip("Docker is required for openclaw-skill-cli E2E");
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-skill-cli-home-"));
    const env = testEnv(home);
    cleanup.add(`remove openclaw-skill-cli state for ${SANDBOX_NAME}`, async () => {
      await cleanupOpenClawSkillCliState(host, sandbox, home);
      fs.rmSync(home, { recursive: true, force: true });
    });
    await cleanupOpenClawSkillCliState(host, sandbox, home);

    const install = await host.command(
      "bash",
      ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName: "install-and-onboard-openclaw-skill-cli",
        cwd: REPO_ROOT,
        env: testEnv(home, {
          NVIDIA_API_KEY: apiKey,
          NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
          NEMOCLAW_RECREATE_SANDBOX: "1",
        }),
        redactionValues: [apiKey],
        timeoutMs: INSTALL_TIMEOUT_MS,
      },
    );
    const installText = resultText(install);
    if (install.exitCode !== 0 && isEndpointRateLimited(installText)) {
      await artifacts.writeText("endpoint-rate-limit-skip.txt", installText);
      skip(
        "NVIDIA endpoint validation was rate-limited before the OpenClaw skill CLI contract could run",
      );
    }
    expect(install.exitCode, installText).toBe(0);

    const envCheck = await expectSandboxShellZero(
      sandbox,
      'printf "OPENCLAW_HOME=%s\\nOPENCLAW_STATE_DIR=%s\\nOPENCLAW_WORKSPACE_DIR=%s\\n" "${OPENCLAW_HOME:-}" "${OPENCLAW_STATE_DIR:-}" "${OPENCLAW_WORKSPACE_DIR:-}"',
      "sandbox-openclaw-runtime-env-check",
      env,
    );
    for (const requiredVar of ["OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_WORKSPACE_DIR"]) {
      expect(
        resultText(envCheck),
        `${requiredVar} must be exported in sandbox runtime shell`,
      ).toMatch(new RegExp(`^${requiredVar}=.+$`, "m"));
    }

    await expectSandboxShellZero(
      sandbox,
      buildWriteSkillFixtureScript(),
      "sandbox-write-openclaw-skill-cli-fixture",
      env,
    );

    const skillInstall = await expectSandboxShellZero(
      sandbox,
      `openclaw skills install ${shellQuote(REMOTE_SKILL_DIR)}`,
      "sandbox-openclaw-skills-install-fixture",
      env,
    );
    await artifacts.writeText("openclaw-skills-install-output.txt", resultText(skillInstall));

    const diskCheck = await expectSandboxShellZero(
      sandbox,
      `ls -1 "\${OPENCLAW_WORKSPACE_DIR}/skills/${SKILL_ID}/" 2>&1; test -f "\${OPENCLAW_WORKSPACE_DIR}/skills/${SKILL_ID}/SKILL.md" && echo SKILL_MD_PRESENT`,
      "sandbox-openclaw-skill-cli-disk-check",
      env,
    );
    expect(resultText(diskCheck)).toContain("SKILL_MD_PRESENT");

    const list = await expectSandboxShellZero(
      sandbox,
      "openclaw skills list --json",
      "sandbox-openclaw-skills-list-json",
      env,
    );
    const listText = resultText(list);
    expect(listText).toContain(`"${SKILL_ID}"`);
    expect(listText).toContain("openclaw-workspace");

    const info = await expectSandboxShellZero(
      sandbox,
      `openclaw skills info ${shellQuote(SKILL_ID)} --json`,
      "sandbox-openclaw-skills-info-json",
      env,
    );
    const infoText = resultText(info);
    expect(infoText).toContain(SKILL_ID);
    expect(infoText).toContain(`/.openclaw/workspace/skills/${SKILL_ID}`);

    const check = await expectSandboxShellZero(
      sandbox,
      "openclaw skills check --json",
      "sandbox-openclaw-skills-check-json",
      env,
    );
    expect(resultText(check)).toContain(`"${SKILL_ID}"`);

    await artifacts.writeJson("scenario-result.json", {
      id: "openclaw-skill-cli",
      status: "passed",
      sandboxName: SANDBOX_NAME,
      installedSkill: SKILL_ID,
      expectedDiskPath: EXPECTED_WORKSPACE_SKILL_PATH,
    });
  },
);
