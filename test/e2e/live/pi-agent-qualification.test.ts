// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { directDockerfileCopySources } from "../../../scripts/lib/dockerfile-copy-sources.mts";
import {
  CANDIDATE_AGENT_FEATURE_ENV,
  CANDIDATE_QUALIFICATION_RECEIPT_ENV,
} from "../../../src/lib/agent/candidate.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { outputContainsSandbox, resultText, shellQuote } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  sandboxAccessEnv,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { assertNoDockerfileBuild, createDockerBuildGuard } from "../fixtures/docker-build-guard.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { LifecyclePhaseFixture } from "../fixtures/phases/lifecycle.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import { driveInteractiveCommand } from "./onboard-interactive-pty.ts";
import {
  parsePiJsonEvents,
  parsePiInferenceEvidence,
  qualificationPlatform,
  qualifyPiReadTask,
  readPiQualificationReceipt,
} from "./pi-agent-qualification-events.ts";

const GATEWAY = "nemoclaw";
const MODEL = "nvidia/nemotron-3-super-120b-a12b";
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-pi-qual";
const TASK_VERSION = "pi-read-v1";
const LIVE_TIMEOUT_MS = 90 * 60_000;
const PI_COMMAND_TIMEOUT_MS = 5 * 60_000;
const SECURITY_PROBE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const upstreamCredentialNames = Object.entries(process.env).filter(([, value]) => /nvapi-[A-Za-z0-9_-]{10,}/.test(value)).map(([name]) => name);
const stack = ["/sandbox"];
const credentialFiles = [];
let bytes = 0;
let files = 0;
while (stack.length > 0 && files < 10000 && bytes < 32 * 1024 * 1024) {
  const current = stack.pop();
  let status;
  try {
    status = fs.lstatSync(current);
  } catch {
    continue;
  }
  if (status.isSymbolicLink()) continue;
  if (status.isDirectory()) {
    try {
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
    } catch {}
    continue;
  }
  if (!status.isFile() || status.size > 1024 * 1024) continue;
  let descriptor;
  try {
    descriptor = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const openStatus = fs.fstatSync(descriptor);
    if (!openStatus.isFile() || openStatus.size > 1024 * 1024) continue;
    const contents = fs.readFileSync(descriptor, "utf8");
    files += 1;
    bytes += Buffer.byteLength(contents);
    if (/nvapi-[A-Za-z0-9_-]{10,}/.test(contents)) credentialFiles.push(current);
  } catch {
    continue;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}
const dockerSockets = ["/var/run/docker.sock", "/run/docker.sock"].filter((candidate) => fs.existsSync(candidate));
const result = {upstreamCredentialNames, credentialFiles, dockerSockets, files, bytes};
process.stdout.write(JSON.stringify(result) + "\n");
process.exit(upstreamCredentialNames.length === 0 && credentialFiles.length === 0 && dockerSockets.length === 0 ? 0 : 1);
`;
const NETWORK_DENIAL_PROBE = String.raw`
const timer = setTimeout(() => process.exit(2), 20000);
fetch("https://example.com/").then(() => {
  clearTimeout(timer);
  process.exit(1);
}, () => {
  clearTimeout(timer);
  process.exit(0);
});
`;

validateSandboxName(SANDBOX_NAME);

function execPiShell(
  sandbox: SandboxClient,
  script: ReturnType<typeof trustedSandboxShellScript>,
  options: Parameters<SandboxClient["openshell"]>[1],
) {
  return sandbox.openshell(
    [
      "sandbox",
      "exec",
      "-n",
      SANDBOX_NAME,
      "--env",
      "BASH_ENV=",
      "--env",
      "ENV=",
      "--",
      "bash",
      "--noprofile",
      "--norc",
      "-c",
      script,
    ],
    options,
  );
}

async function preclean(
  host: HostCliClient,
  lifecycle: LifecyclePhaseFixture,
  sandbox: SandboxClient,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await host.bestEffortCleanupSandbox(SANDBOX_NAME, {
    artifactName: "pre-cleanup-pi-nemoclaw",
    env,
    timeoutMs: 3 * 60_000,
  });
  await sandbox.cleanupSandbox(SANDBOX_NAME, {
    artifactName: "pre-cleanup-pi-openshell",
    env,
    timeoutMs: 60_000,
  });
  await lifecycle.stopGatewayRuntime();
  await host.cleanupGatewayRegistration(GATEWAY, {
    artifactName: "pre-cleanup-pi-gateway",
    env,
    timeoutMs: 60_000,
  });
}

async function runReadTask(
  artifacts: ArtifactSink,
  host: HostCliClient,
  sandbox: SandboxClient,
  env: NodeJS.ProcessEnv,
  phase: string,
): Promise<{ assistantText: string; eventCount: number; toolCallId: string }> {
  const remotePath = `/sandbox/.nemoclaw-pi-${phase}.txt`;
  const token = `NEMOCLAW_PI_${phase.toUpperCase().replaceAll("-", "_")}_${randomBytes(8).toString("hex").toUpperCase()}`;
  const seed = await execPiShell(
    sandbox,
    trustedSandboxShellScript(
      `umask 077; printf '%s\\n' ${shellQuote(token)} > ${shellQuote(remotePath)}; sync`,
    ),
    {
      artifactName: `pi-${phase}-seed`,
      env,
      timeoutMs: 30_000,
    },
  );
  expect(seed.exitCode, resultText(seed)).toBe(0);
  const prompt = `Use the read tool exactly once to read ${remotePath}. Reply with exactly the file contents and no other text.`;
  const result = await host.nemoclaw(
    [
      SANDBOX_NAME,
      "exec",
      "--workdir",
      "/sandbox",
      "--no-tty",
      "--timeout",
      "300",
      "--",
      "pi",
      "--no-approve",
      "--mode",
      "json",
      "--print",
      "--tools",
      "read",
      "--name",
      `${TASK_VERSION}-${phase}`,
      prompt,
    ],
    {
      artifactName: `pi-${phase}-headless-task`,
      env,
      timeoutMs: PI_COMMAND_TIMEOUT_MS,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  const proof = qualifyPiReadTask(parsePiJsonEvents(result.stdout), remotePath, token);
  await artifacts.writeJson(`pi-${phase}-task-proof.json`, {
    taskVersion: TASK_VERSION,
    remotePath,
    expectedSha256: createHash("sha256").update(token).digest("hex"),
    ...proof,
  });
  return proof;
}

async function sessionInventory(sandbox: SandboxClient, env: NodeJS.ProcessEnv, phase: string) {
  const result = await execPiShell(
    sandbox,
    trustedSandboxShellScript(
      "find /sandbox/.pi/agent/sessions -type f -name '*.jsonl' -print0 | sort -z | xargs -0 -r sha256sum",
    ),
    { artifactName: `pi-${phase}-session-inventory`, env, timeoutMs: 30_000 },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(result.stdout.trim()).not.toBe("");
  return result.stdout.trim();
}

async function runInteractiveTask(
  artifacts: ArtifactSink,
  host: HostCliClient,
  progress: TestProgress,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const token = "NEMOCLAW_PI_INTERACTIVE_V1_OK";
  const prompt =
    "Join these five fragments with underscores and reply with only the result: NEMOCLAW, PI, INTERACTIVE, V1, OK. Do not use tools.";
  const result = await driveInteractiveCommand({
    activityLabel: "command: pi-interactive-qualification",
    cmd: [
      host.commandPath,
      SANDBOX_NAME,
      "exec",
      "--tty",
      "--",
      "sh",
      "-c",
      'stty rows 40 cols 120 && exec pi --no-approve "$1"',
      "nemoclaw-pi-interactive",
      prompt,
    ],
    env,
    progress,
    rules: [{ trigger: token, response: "\u0004" }],
    timeoutMs: PI_COMMAND_TIMEOUT_MS,
  });
  await artifacts.writeText("pi-interactive-terminal.txt", result.output);
  expect(result.timedOut).toBe(false);
  expect(result.firedTriggers).toContain(token);
  expect(result.output).toContain(token);
  expect(result.exitCode).toBe(0);
}

function registryDocument(): Record<string, unknown> {
  const registryPath = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
  return JSON.parse(fs.readFileSync(registryPath, "utf8")) as Record<string, unknown>;
}

test(
  "qualifies the protected Pi candidate through Docker and managed inference",
  {
    timeout: LIVE_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "validate the exact Pi candidate receipt",
        "onboard Pi without a Dockerfile build",
        "run headless and interactive Pi tasks",
        "rebuild Pi and preserve session state",
        "recover Pi after a gateway restart",
        "prove Pi policy and credential boundaries",
        "destroy Pi and publish bounded evidence",
      ],
    },
  },
  async ({ artifacts, cleanup, host, inference, lifecycle, progress, sandbox }) => {
    const platform = qualificationPlatform(
      process.arch,
      process.env.NEMOCLAW_PI_QUALIFICATION_PLATFORM,
    );
    const receipt = readPiQualificationReceipt(platform);
    expect(inference.mode).toBe("public-nvidia");
    expect(inference.model).toBe(MODEL);
    const catalogPath = await artifacts.writeJson("pi-candidate-catalog.json", {
      pi: receipt.contract,
    });
    const guard = createDockerBuildGuard();
    const env = inference.env({
      ...guard.env,
      [CANDIDATE_AGENT_FEATURE_ENV]: "1",
      [CANDIDATE_QUALIFICATION_RECEIPT_ENV]: receipt.path,
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      NEMOCLAW_AGENT: "pi",
      NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: catalogPath,
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
      OPENSHELL_DRIVERS: "docker",
      OPENSHELL_GATEWAY: GATEWAY,
    });
    cleanup.trackDisposable("remove Pi Docker build guard", guard.dispose);
    cleanup.trackGateway(host, GATEWAY, { env, timeoutMs: 60_000 });
    cleanup.trackDisposable("remove Pi OpenShell sandbox", () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, { env, timeoutMs: 60_000 }),
    );
    cleanup.trackSandbox(host, SANDBOX_NAME, { env, timeoutMs: 5 * 60_000 });

    await artifacts.target.declare({
      id: "pi-agent-qualification",
      agent: "pi",
      platform,
      taskVersion: TASK_VERSION,
      contract:
        "exact candidate onboarding, tool execution, lifecycle recovery, policy denial, and credential isolation",
    });

    progress.phase("validate the exact Pi candidate receipt");
    expect(receipt.contract.agent).toBe("pi");
    expect(receipt.contract.platform).toBe(platform);
    expect(receipt.contract.source.repository).toBe("NVIDIA/NemoClaw");
    const piDockerfiles = ["agents/pi/Dockerfile", "agents/pi/Dockerfile.base"];
    const copiedSources = piDockerfiles.flatMap((dockerfile) =>
      directDockerfileCopySources(path.join(REPO_ROOT, dockerfile), dockerfile).map(
        ({ source }) => source,
      ),
    );
    const imageSourcePaths = [
      ...new Set([".dockerignore", ...piDockerfiles, ...copiedSources]),
    ].sort();
    const sourceParity = await host.command(
      "git",
      ["diff", "--quiet", receipt.contract.source.revision, "HEAD", "--", ...imageSourcePaths],
      { artifactName: "pi-image-source-parity", env, timeoutMs: 30_000 },
    );
    expect(sourceParity.exitCode, resultText(sourceParity)).toBe(0);
    await preclean(host, lifecycle, sandbox, env);

    progress.phase("onboard Pi without a Dockerfile build");
    const onboard = await host.nemoclaw(
      [
        "onboard",
        "--temp-managed-runtime",
        "--temp-managed-runtime-catalog",
        catalogPath,
        "--non-interactive",
        "--yes",
        "--yes-i-accept-third-party-software",
        "--no-gpu",
        "--agent",
        "pi",
        "--name",
        SANDBOX_NAME,
      ],
      {
        artifactName: "pi-candidate-onboard",
        env,
        redactionValues: inference.redactionValues(),
        timeoutMs: 20 * 60_000,
      },
    );
    expect(onboard.exitCode, resultText(onboard)).toBe(0);
    await host.expectListed(SANDBOX_NAME, { env });
    await sandbox.expectListed(SANDBOX_NAME, { env });
    const registry = registryDocument() as {
      sandboxes?: Record<string, { agent?: string; workload?: Record<string, unknown> }>;
    };
    expect(registry.sandboxes?.[SANDBOX_NAME]).toMatchObject({
      agent: "pi",
      workload: {
        kind: "managed-image",
        reference: receipt.contract.reference,
        sourceRevision: receipt.contract.source.revision,
        sourceCohort: receipt.contract.source.cohort,
      },
    });

    progress.phase("run headless and interactive Pi tasks");
    const beforeProof = await runReadTask(artifacts, host, sandbox, env, "before-rebuild");
    await runInteractiveTask(artifacts, host, progress, env);
    const sessionsBeforeRebuild = await sessionInventory(sandbox, env, "before-rebuild");

    progress.phase("rebuild Pi and preserve session state");
    const rebuild = await host.nemoclaw([SANDBOX_NAME, "rebuild", "--yes"], {
      artifactName: "pi-candidate-rebuild",
      env,
      redactionValues: inference.redactionValues(),
      timeoutMs: 20 * 60_000,
    });
    expect(rebuild.exitCode, resultText(rebuild)).toBe(0);
    const sessionsAfterRebuild = await sessionInventory(sandbox, env, "after-rebuild");
    expect(sessionsAfterRebuild).toBe(sessionsBeforeRebuild);
    const rebuildProof = await runReadTask(artifacts, host, sandbox, env, "after-rebuild");

    progress.phase("recover Pi after a gateway restart");
    await lifecycle.restartGatewayRuntime({ delayMs: 2_000, sandboxName: SANDBOX_NAME });
    await lifecycle.waitForGatewayConnected({ attempts: 60, intervalMs: 5_000 });
    const recoveryProof = await runReadTask(artifacts, host, sandbox, env, "after-recovery");

    progress.phase("prove Pi policy and credential boundaries");
    const security = await sandbox.exec(SANDBOX_NAME, ["node", "-e", SECURITY_PROBE], {
      artifactName: "pi-security-boundary",
      env: sandboxAccessEnv(),
      timeoutMs: 60_000,
    });
    expect(security.exitCode, resultText(security)).toBe(0);
    const network = await sandbox.exec(
      SANDBOX_NAME,
      ["timeout", "25", "node", "-e", NETWORK_DENIAL_PROBE],
      { artifactName: "pi-network-denial", env, timeoutMs: 30_000 },
    );
    expect(network.exitCode, resultText(network)).toBe(0);
    const registryText = JSON.stringify(registryDocument());
    expect(
      inference.redactionValues().filter((credential) => registryText.includes(credential)),
    ).toEqual([]);
    const logs = await host.command(
      "bash",
      [
        "-lc",
        'set -euo pipefail; output="$("$NEMOCLAW_CLI_BIN" "$NEMOCLAW_SANDBOX_NAME" logs 2>&1)"; [[ "$output" != *"$NVIDIA_INFERENCE_API_KEY"* ]]',
      ],
      {
        artifactName: "pi-log-credential-absence",
        env: { ...env, NEMOCLAW_CLI_BIN: host.commandPath },
        redactionValues: inference.redactionValues(),
        timeoutMs: 60_000,
      },
    );
    expect(logs.exitCode, resultText(logs)).toBe(0);
    const trace = fs.readFileSync(guard.tracePath, "utf8");
    expect(trace.trim(), "Docker build guard trace").not.toBe("");
    assertNoDockerfileBuild(trace);
    await artifacts.writeText("docker-argv.log", trace);
    const inferenceConfig = await execPiShell(
      sandbox,
      trustedSandboxShellScript("cat /sandbox/.pi/agent/models.json"),
      { artifactName: "pi-managed-inference-config", env, timeoutMs: 30_000 },
    );
    expect(inferenceConfig.exitCode, resultText(inferenceConfig)).toBe(0);
    const inferenceEvidence = parsePiInferenceEvidence(inferenceConfig.stdout, inference.model);

    progress.phase("destroy Pi and publish bounded evidence");
    const openshellVersion = await host.command(host.openshellCommandPath, ["--version"], {
      artifactName: "pi-openshell-version",
      env,
      timeoutMs: 30_000,
    });
    expect(openshellVersion.exitCode, resultText(openshellVersion)).toBe(0);
    const destroy = await host.nemoclaw(
      [SANDBOX_NAME, "destroy", "--yes", "--no-cleanup-gateway"],
      {
        artifactName: "pi-candidate-destroy",
        env,
        redactionValues: inference.redactionValues(),
        timeoutMs: 5 * 60_000,
      },
    );
    expect(destroy.exitCode, resultText(destroy)).toBe(0);
    const listAfterDestroy = await host.nemoclaw(["list"], {
      artifactName: "pi-list-after-destroy",
      env,
      timeoutMs: 30_000,
    });
    expect(listAfterDestroy.exitCode, resultText(listAfterDestroy)).toBe(0);
    expect(outputContainsSandbox(listAfterDestroy, SANDBOX_NAME)).toBe(false);
    const openshellAfterDestroy = await sandbox.list({
      artifactName: "pi-openshell-list-after-destroy",
      env,
      timeoutMs: 30_000,
    });
    expect(openshellAfterDestroy.exitCode, resultText(openshellAfterDestroy)).toBe(0);
    expect(outputContainsSandbox(openshellAfterDestroy, SANDBOX_NAME)).toBe(false);

    await artifacts.writeJson("pi-agent-qualification.json", {
      kind: "nemoclaw-pi-agent-qualification-v1",
      candidate: {
        cliRevision: process.env.NEMOCLAW_E2E_EXPECTED_SHA || process.env.GITHUB_SHA || null,
        imageRevision: receipt.contract.source.revision,
        imageReference: receipt.contract.reference,
        receiptSha256: receipt.digest,
        publicationCohort: receipt.contract.source.cohort,
        imageSourceParity: true,
      },
      runtime: {
        platform,
        computeRuntime: "docker",
        openShellVersion: resultText(openshellVersion).trim(),
      },
      inference: {
        provider: inference.expectedRouteProvider,
        ...inferenceEvidence,
      },
      policy: {
        upstreamCredentialEnvironmentAbsent: true,
        credentialFilesAbsent: true,
        upstreamCredentialAbsentFromRegistryAndLogs: true,
        undeclaredNetworkDenied: true,
        containerRuntimeSocketAbsent: true,
      },
      tasks: {
        version: TASK_VERSION,
        headlessBeforeRebuild: beforeProof,
        headlessAfterRebuild: rebuildProof,
        headlessAfterRecovery: recoveryProof,
        interactive: true,
        sessionStatePreservedAcrossRebuild: true,
      },
      lifecycle: ["onboard", "interactive", "rebuild", "gateway-recovery", "destroy"],
      buildCommands: 0,
    });
    await artifacts.target.complete({
      id: "pi-agent-qualification",
      agent: "pi",
      platform,
      model: inference.model,
      taskVersion: TASK_VERSION,
      imageReference: receipt.contract.reference,
      buildCommands: 0,
    });
  },
);
