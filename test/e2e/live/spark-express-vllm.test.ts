// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Exercises the catalog-backed DGX Spark Express vLLM path on physical hardware. */

import assert from "node:assert/strict";

import { loadServingCatalog } from "../../../src/lib/inference/serving/catalog-loader.ts";
import { materializeHostLocalVllmSelection } from "../../../src/lib/inference/serving/host-local-vllm-selection.ts";
import { detectVllmProfile } from "../../../src/lib/inference/vllm.ts";
import { buildVllmServeCommand } from "../../../src/lib/inference/vllm-models.ts";
import {
  LOCAL_MODEL_PROFILE_ENABLED_ENV,
  LOCAL_MODEL_PROFILE_RUNTIME_ENV,
  resolveLocalModelProfilePlan,
} from "../../../src/lib/onboard/local-model-profile/plan.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { type CommandExitResult, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import {
  assertLocalDockerEnvironment,
  classifyDockerContainerInspection,
  inspectSandboxIdentity,
  listedSandboxNames,
} from "../support/spark-express-vllm-safety.ts";
import {
  cleanupSandbox,
  expectOpenAiChatThroughSandbox,
  requireLivePrerequisites,
} from "./inference-routing-helpers.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-spark-vllm";
const REPLACEMENT_SANDBOX_NAME =
  SANDBOX_NAME === "e2e-vllm-after" ? "e2e-vllm-next" : "e2e-vllm-after";
const VLLM_CONTAINER = "nemoclaw-vllm";
const CUSTOM_VLLM_PORT = 46_145;
const TEST_TIMEOUT_MS = 120 * 60_000;
const ONBOARD_TIMEOUT_MS = 55 * 60_000;

interface VllmContainerInspection {
  readonly Id: string;
  readonly Config: {
    readonly Cmd: string[];
    readonly Labels: Record<string, string>;
  };
  readonly HostConfig: {
    readonly PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  };
}

function e2eEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE: "",
    NEMOCLAW_FRESH: "1",
    NEMOCLAW_LOCAL_MODEL_RUNTIME: "",
    NEMOCLAW_MODEL: "",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_POLICY_TIER: "balanced",
    NEMOCLAW_PROVIDER: "",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_VLLM_EXTRA_ARGS_JSON: "",
    NEMOCLAW_VLLM_MODEL: "",
    NEMOCLAW_VLLM_PORT: "",
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

function vllmProfilePlan() {
  const plan = resolveLocalModelProfilePlan(loadServingCatalog(), {
    [LOCAL_MODEL_PROFILE_ENABLED_ENV]: "1",
    [LOCAL_MODEL_PROFILE_RUNTIME_ENV]: "vllm",
  });
  assert(
    plan?.runtime === "vllm",
    "the vLLM local-model profile did not resolve from the serving catalog",
  );
  return plan;
}

function capturedVllmContainerId(result: CommandExitResult): string | null {
  const [candidate] =
    result.exitCode === 0
      ? (JSON.parse(result.stdout) as VllmContainerInspection[])
      : ([] as VllmContainerInspection[]);
  return candidate && /^[a-f0-9]{64}$/u.test(candidate.Id) ? candidate.Id : null;
}

async function probeVllmContainer(
  host: HostCliClient,
  artifactName: string,
): Promise<CommandExitResult> {
  return host.command("docker", ["inspect", VLLM_CONTAINER], {
    artifactName,
    env: e2eEnv(),
    timeoutMs: 30_000,
  });
}

async function probeSandboxNames(
  host: HostCliClient,
  artifactName: string,
): Promise<CommandExitResult> {
  return host.command("openshell", ["sandbox", "list", "--names"], {
    artifactName,
    env: e2eEnv(),
    timeoutMs: 30_000,
  });
}

async function probeHostPort(
  host: HostCliClient,
  port: number,
  artifactName: string,
): Promise<CommandExitResult> {
  return host.command("ss", ["-H", "-ltn", `sport = :${String(port)}`], {
    artifactName,
    env: e2eEnv(),
    timeoutMs: 30_000,
  });
}

async function onboardSparkExpressVllm(
  host: HostCliClient,
  sandboxName: string,
  artifactName: string,
): Promise<CommandExitResult> {
  return host.command(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      [
        "set -euo pipefail",
        "source scripts/install.sh >/dev/null",
        "exec 9<<<'2'",
        "select_spark_express_inference 9",
        "exec 9<&-",
        '[[ "${_SPARK_EXPRESS_INFERENCE_SELECTION:-}" == "fixed-vllm" ]]',
        'activate_express_install "DGX Spark"',
        '[[ "${NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE:-}" == "1" ]]',
        '[[ "${NEMOCLAW_LOCAL_MODEL_RUNTIME:-}" == "vllm" ]]',
        '[[ -z "${NEMOCLAW_PROVIDER:-}" ]]',
        '[[ -z "${NEMOCLAW_MODEL:-}" ]]',
        '[[ -z "${NEMOCLAW_VLLM_MODEL:-}" ]]',
        "exec node bin/nemoclaw.js onboard --fresh --non-interactive --yes --yes-i-accept-third-party-software",
      ].join("\n"),
    ],
    {
      artifactName,
      cwd: REPO_ROOT,
      env: e2eEnv({
        NEMOCLAW_SANDBOX_NAME: sandboxName,
        NEMOCLAW_VLLM_PORT: String(CUSTOM_VLLM_PORT),
      }),
      timeoutMs: ONBOARD_TIMEOUT_MS,
    },
  );
}

async function runCandidateNemoClaw(
  host: HostCliClient,
  args: string[],
  artifactName: string,
  timeoutMs = 180_000,
): Promise<CommandExitResult> {
  return host.command("node", ["bin/nemoclaw.js", ...args], {
    artifactName,
    cwd: REPO_ROOT,
    env: e2eEnv(),
    timeoutMs,
  });
}

async function inspectSandbox(host: HostCliClient, sandboxName: string, artifactName: string) {
  const result = await host.command("openshell", ["sandbox", "get", "-o", "json", sandboxName], {
    artifactName,
    env: e2eEnv(),
    timeoutMs: 30_000,
  });
  return inspectSandboxIdentity(result, sandboxName);
}

async function removeExactSandbox(
  host: HostCliClient,
  sandbox: Parameters<typeof cleanupSandbox>[1],
  sandboxName: string,
  sandboxId: string,
): Promise<void> {
  const current = await inspectSandbox(host, sandboxName, "cleanup-spark-express-sandbox-inspect");
  return current.kind === "absent"
    ? undefined
    : removePresentExactSandbox(host, sandbox, sandboxName, sandboxId, current.id);
}

async function removePresentExactSandbox(
  host: HostCliClient,
  sandbox: Parameters<typeof cleanupSandbox>[1],
  sandboxName: string,
  sandboxId: string,
  currentSandboxId: string,
): Promise<void> {
  expect(
    currentSandboxId,
    `Refusing to remove replacement sandbox ${sandboxName}; expected ${sandboxId}, got ${currentSandboxId}`,
  ).toBe(sandboxId);
  await cleanupSandbox(host, sandbox, sandboxName, { strict: true });
  const list = await host.command("openshell", ["sandbox", "list", "--names"], {
    artifactName: "cleanup-spark-express-sandbox-list",
    env: e2eEnv(),
    timeoutMs: 30_000,
  });
  expect(
    listedSandboxNames(list).has(sandboxName),
    `Sandbox ${sandboxName} still exists after cleanup.`,
  ).toBe(false);
}

async function captureOnboardFailureDiagnostics(
  host: HostCliClient,
  sandboxName: string,
): Promise<void> {
  await host.command("docker", ["logs", "--tail", "300", VLLM_CONTAINER], {
    artifactName: "failure-spark-express-vllm-container-logs",
    env: e2eEnv(),
    timeoutMs: 30_000,
  });
  await host.command("openshell", ["sandbox", "get", sandboxName], {
    artifactName: "failure-spark-express-sandbox-get",
    env: e2eEnv(),
    timeoutMs: 30_000,
  });
}

async function removeExactVllmContainer(
  host: HostCliClient,
  containerId: string,
  artifactName: string,
): Promise<void> {
  assert(
    /^[a-f0-9]{64}$/u.test(containerId),
    "cleanup requires the exact full Docker container ID created by this test",
  );
  const result = await host.command(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      [
        "set -euo pipefail",
        `container=${VLLM_CONTAINER}`,
        'expected_id="$1"',
        'if ! current_id="$(docker inspect --format \'{{.Id}}\' "$container" 2>/dev/null)"; then exit 0; fi',
        '[[ "$current_id" == "$expected_id" ]] || { echo "refusing to remove a replacement $container container" >&2; exit 70; }',
        'label="$(docker inspect --format \'{{ index .Config.Labels "com.nvidia.nemoclaw.managed-vllm" }}\' "$expected_id")"',
        '[[ "$label" == "true" ]] || { echo "refusing to remove an unmanaged $container container" >&2; exit 70; }',
        'docker rm -f "$expected_id" >/dev/null',
      ].join("\n"),
      "spark-express-vllm-cleanup",
      containerId,
    ],
    { artifactName, env: e2eEnv(), timeoutMs: 120_000 },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
}

test(
  "DGX Spark Express option 2 releases and reacquires managed vLLM on a recorded custom port",
  {
    timeout: TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "qualify the physical DGX Spark host",
        "select Spark Express option 2 and onboard on a custom port",
        "verify catalog-owned vLLM runtime configuration",
        "verify status, doctor, connect, and inference use the recorded port",
        "destroy the final consumer and verify managed vLLM retirement",
        "onboard a replacement after the GPU resource is released",
        "prove replacement inference and unrelated egress denial",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    validateSandboxName(SANDBOX_NAME);
    validateSandboxName(REPLACEMENT_SANDBOX_NAME);
    assertLocalDockerEnvironment(process.env);
    const plan = vllmProfilePlan();
    const baseProfile = detectVllmProfile({ platform: "spark" });
    assert(baseProfile, "the DGX Spark vLLM base profile is unavailable");
    const materialized = materializeHostLocalVllmSelection(
      {
        outcome: "selected",
        selection: "explicit",
        catalogDigest: plan.catalogDigest,
        presetDigest: plan.presetDigest,
        recipeDigest: plan.recipeDigest,
        preset: plan.preset,
        recipe: plan.recipe,
      },
      baseProfile,
    );
    await artifacts.target.declare({
      id: "spark-express-vllm",
      boundary:
        "DGX Spark Express activation + serving catalog preset/recipe + dedicated onboarder + managed vLLM + OpenShell sandbox",
      catalogDigest: plan.catalogDigest,
      presetId: plan.preset.metadata.id,
      presetDigest: plan.presetDigest,
      recipeId: plan.recipe.metadata.id,
      recipeDigest: plan.recipeDigest,
      sandboxName: SANDBOX_NAME,
    });

    progress.phase("qualify the physical DGX Spark host");
    await requireLivePrerequisites(host, runtimeProvider);
    const platform = await host.command(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        "source scripts/install.sh >/dev/null; detect_express_platform",
      ],
      {
        artifactName: "spark-express-platform",
        cwd: REPO_ROOT,
        env: e2eEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(platform.stdout.trim()).toBe("DGX Spark");

    let createdContainerId: string | null = null;
    let createdSandboxId: string | null = null;
    let createdReplacementSandboxId: string | null = null;
    cleanup.add(`remove ${VLLM_CONTAINER}`, () =>
      createdContainerId
        ? removeExactVllmContainer(host, createdContainerId, "cleanup-spark-express-vllm-container")
        : Promise.resolve(),
    );
    cleanup.add(`remove sandbox ${SANDBOX_NAME}`, () =>
      createdSandboxId
        ? removeExactSandbox(host, sandbox, SANDBOX_NAME, createdSandboxId)
        : Promise.resolve(),
    );
    cleanup.add(`remove sandbox ${REPLACEMENT_SANDBOX_NAME}`, () =>
      createdReplacementSandboxId
        ? removeExactSandbox(host, sandbox, REPLACEMENT_SANDBOX_NAME, createdReplacementSandboxId)
        : Promise.resolve(),
    );
    const preflightContainer = await probeVllmContainer(
      host,
      "preflight-spark-express-vllm-container",
    );
    expect(
      classifyDockerContainerInspection(preflightContainer),
      `Refusing to replace a pre-existing ${VLLM_CONTAINER} container.\n${resultText(preflightContainer)}`,
    ).toBe("absent");
    const preflightSandboxes = await probeSandboxNames(
      host,
      "preflight-spark-express-sandbox-list",
    );
    expect(
      listedSandboxNames(preflightSandboxes).has(SANDBOX_NAME) ||
        listedSandboxNames(preflightSandboxes).has(REPLACEMENT_SANDBOX_NAME),
      `Refusing to replace a pre-existing test sandbox.\n${resultText(preflightSandboxes)}`,
    ).toBe(false);
    const preflightPort = await probeHostPort(
      host,
      CUSTOM_VLLM_PORT,
      "preflight-spark-express-vllm-port",
    );
    expect(preflightPort.exitCode, resultText(preflightPort)).toBe(0);
    expect(
      preflightPort.stdout.trim(),
      `TCP port ${String(CUSTOM_VLLM_PORT)} is already in use`,
    ).toBe("");

    progress.phase("select Spark Express option 2 and onboard on a custom port");
    const onboard = await onboardSparkExpressVllm(host, SANDBOX_NAME, "spark-express-vllm-onboard");

    const inspectionResult = await host.command("docker", ["inspect", VLLM_CONTAINER], {
      artifactName: "spark-express-vllm-container-inspect",
      env: e2eEnv(),
      timeoutMs: 30_000,
    });
    createdContainerId = capturedVllmContainerId(inspectionResult);
    const sandboxInspection = await inspectSandbox(
      host,
      SANDBOX_NAME,
      "spark-express-vllm-sandbox-inspect",
    );
    createdSandboxId = sandboxInspection.kind === "present" ? sandboxInspection.id : null;
    await (onboard.exitCode !== 0
      ? captureOnboardFailureDiagnostics(host, SANDBOX_NAME)
      : Promise.resolve());

    progress.phase("verify catalog-owned vLLM runtime configuration");
    expect(onboard.exitCode, resultText(onboard)).toBe(0);
    expect(
      createdSandboxId,
      "onboarding did not create the expected sandbox identity",
    ).not.toBeNull();
    expect(createdContainerId, "onboarding did not create managed vLLM").not.toBeNull();
    const [inspection] = JSON.parse(inspectionResult.stdout) as VllmContainerInspection[];
    expect(inspection.Config.Cmd[1]).toBe(buildVllmServeCommand(materialized.model, e2eEnv()));
    expect(inspection.Config.Labels).toMatchObject({
      "com.nvidia.nemoclaw.managed-vllm": "true",
      "com.nvidia.nemoclaw.serving-catalog-digest": plan.catalogDigest,
      "com.nvidia.nemoclaw.serving-preset": plan.preset.metadata.id,
      "com.nvidia.nemoclaw.serving-preset-digest": plan.presetDigest,
      "com.nvidia.nemoclaw.serving-recipe": plan.recipe.metadata.id,
      "com.nvidia.nemoclaw.serving-recipe-digest": plan.recipeDigest,
    });
    const portBindings = inspection.HostConfig.PortBindings["8000/tcp"];
    expect(portBindings).toContainEqual({
      HostIp: "127.0.0.1",
      HostPort: String(CUSTOM_VLLM_PORT),
    });

    progress.phase("verify status, doctor, connect, and inference use the recorded port");
    const status = await runCandidateNemoClaw(
      host,
      [SANDBOX_NAME, "status", "--json"],
      "spark-express-vllm-status",
    );
    expect(status.exitCode, resultText(status)).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      inferenceHealth: {
        ok: true,
        endpoint: `http://127.0.0.1:${String(CUSTOM_VLLM_PORT)}/v1/models`,
      },
    });
    const doctor = await runCandidateNemoClaw(
      host,
      [SANDBOX_NAME, "doctor", "--json"],
      "spark-express-vllm-doctor",
    );
    expect(doctor.exitCode, resultText(doctor)).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({
          group: "Inference",
          label: "Provider health",
          status: "ok",
          detail: `http://127.0.0.1:${String(CUSTOM_VLLM_PORT)}/v1/models reachable`,
        }),
      ]),
    });
    const connect = await runCandidateNemoClaw(
      host,
      [SANDBOX_NAME, "connect", "--probe-only"],
      "spark-express-vllm-connect-probe",
      300_000,
    );
    expect(connect.exitCode, resultText(connect)).toBe(0);

    progress.phase("destroy the final consumer and verify managed vLLM retirement");
    const destroy = await runCandidateNemoClaw(
      host,
      [SANDBOX_NAME, "destroy", "--yes"],
      "spark-express-vllm-destroy",
      300_000,
    );
    expect(destroy.exitCode, resultText(destroy)).toBe(0);
    const retiredSandboxes = await probeSandboxNames(host, "retired-spark-express-sandbox-list");
    expect(
      listedSandboxNames(retiredSandboxes).has(SANDBOX_NAME),
      `Sandbox ${SANDBOX_NAME} still exists after destroy.\n${resultText(retiredSandboxes)}`,
    ).toBe(false);
    const retiredContainer = await probeVllmContainer(host, "retired-spark-express-vllm-container");
    expect(
      classifyDockerContainerInspection(retiredContainer),
      `Managed container ${VLLM_CONTAINER} still exists after destroy.\n${resultText(retiredContainer)}`,
    ).toBe("absent");
    const retiredPort = await probeHostPort(
      host,
      CUSTOM_VLLM_PORT,
      "retired-spark-express-vllm-port",
    );
    expect(retiredPort.exitCode, resultText(retiredPort)).toBe(0);
    expect(
      retiredPort.stdout.trim(),
      `TCP port ${String(CUSTOM_VLLM_PORT)} is still in use after destroy`,
    ).toBe("");
    createdSandboxId = null;
    createdContainerId = null;

    progress.phase("onboard a replacement after the GPU resource is released");
    const replacementOnboard = await onboardSparkExpressVllm(
      host,
      REPLACEMENT_SANDBOX_NAME,
      "spark-express-vllm-replacement-onboard",
    );
    const replacementInspection = await host.command("docker", ["inspect", VLLM_CONTAINER], {
      artifactName: "spark-express-vllm-replacement-container-inspect",
      env: e2eEnv(),
      timeoutMs: 30_000,
    });
    createdContainerId = capturedVllmContainerId(replacementInspection);
    const replacementSandboxInspection = await inspectSandbox(
      host,
      REPLACEMENT_SANDBOX_NAME,
      "spark-express-vllm-replacement-sandbox-inspect",
    );
    createdReplacementSandboxId =
      replacementSandboxInspection.kind === "present" ? replacementSandboxInspection.id : null;
    await (replacementOnboard.exitCode !== 0
      ? captureOnboardFailureDiagnostics(host, REPLACEMENT_SANDBOX_NAME)
      : Promise.resolve());
    expect(replacementOnboard.exitCode, resultText(replacementOnboard)).toBe(0);
    expect(
      createdReplacementSandboxId,
      "replacement onboarding did not create its sandbox",
    ).not.toBeNull();
    expect(createdContainerId, "replacement onboarding did not create managed vLLM").not.toBeNull();

    progress.phase("prove replacement inference and unrelated egress denial");
    await expectOpenAiChatThroughSandbox(
      sandbox,
      REPLACEMENT_SANDBOX_NAME,
      plan.recipe.spec.model.servedName,
      [],
      "spark-express-replacement-inference-local-chat",
    );
    const denied = await sandbox.execShell(
      REPLACEMENT_SANDBOX_NAME,
      trustedSandboxShellScript(
        "status=0; code=$(curl -sS -o /dev/null -w '%{http_connect}' --max-time 20 https://example.com/) || status=$?; printf '%s %s' \"$status\" \"$code\"",
      ),
      {
        artifactName: "spark-express-unrelated-egress-denied",
        env: e2eEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(denied.stdout.trim()).toBe("56 403");
  },
);
