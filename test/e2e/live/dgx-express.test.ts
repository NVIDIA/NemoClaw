// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Exercises the DGX Spark and Station Express vLLM paths on physical hardware. */

import assert from "node:assert/strict";
import {
  boundedSparkVllmProfilePlan,
  SPARK_EXTRA_ARGS,
} from "../../../tools/e2e/spark-vllm-qualification.mts";

import { loadServingCatalog } from "../../../src/lib/inference/serving/catalog-loader.ts";
import { materializeHostLocalVllmSelection } from "../../../src/lib/inference/serving/host-local-vllm-selection.ts";
import { resolveManagedVllmBridgeHost } from "../../../src/lib/inference/serving/vllm-host-local-network.ts";
import { buildVllmServeCommand } from "../../../src/lib/inference/vllm-models.ts";
import { buildLocalManagedVllmDockerEnv } from "../../../src/lib/inference/vllm-docker-env.ts";
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
import { assertStockManagedImageReceipt } from "../fixtures/managed-image-receipt.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import {
  assertLocalDockerEnvironment,
  classifyDockerContainerInspection,
  cleanupCapturedSparkResource,
  inspectDockerContainerIdentity,
  inspectSandboxIdentity,
  listedSandboxNames,
  vllmPublicationProbeUrls,
} from "../support/spark-express-vllm-safety.ts";
import {
  cleanupSandbox,
  expectOpenAiChatThroughSandbox,
  requireLivePrerequisites,
} from "./inference-routing-helpers.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-spark-vllm";
const VLLM_CONTAINER = "nemoclaw-vllm";
const TEST_TIMEOUT_MS = 65 * 60_000;
const ONBOARD_TIMEOUT_MS = 55 * 60_000;

const VLLM_PUBLICATION_CURL_ARGS = [
  "-q",
  "--noproxy",
  "*",
  "--globoff",
  "--silent",
  "--show-error",
  "--connect-timeout",
  "3",
  "--max-time",
  "5",
  "--write-out",
  "%{exitcode} %{http_code}\n",
];

interface VllmContainerInspection {
  readonly Id: string;
  readonly Config: {
    readonly Cmd: string[];
    readonly Entrypoint: string[];
    readonly Image: string;
    readonly Labels: Record<string, string>;
  };
  readonly HostConfig: {
    readonly DeviceRequests: Array<{ Count: number; Capabilities: string[][] }>;
    readonly IpcMode: string;
    readonly NetworkMode: string;
    readonly ShmSize: number;
  };
  readonly Mounts: Array<{ Destination: string; RW: boolean; Type: string }>;
}

function e2eEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_SERVING_PRESET: "",
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

async function assertSandboxAbsent(host: HostCliClient, sandboxName: string): Promise<void> {
  const result = await host.command("openshell", ["sandbox", "list", "--names"], {
    artifactName: "preflight-spark-express-sandbox-list",
    env: e2eEnv(),
    timeoutMs: 30_000,
  });
  expect(
    listedSandboxNames(result).has(sandboxName),
    `Refusing to replace a pre-existing ${sandboxName} sandbox.\n${resultText(result)}`,
  ).toBe(false);
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
  sandboxId: string | null,
): Promise<void> {
  const current = await inspectSandbox(host, sandboxName, "cleanup-spark-express-sandbox-inspect");
  await cleanupCapturedSparkResource(
    `sandbox ${sandboxName}`,
    sandboxId,
    current,
    (captured, observed) =>
      removePresentExactSandbox(host, sandbox, sandboxName, captured, observed),
  );
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
  containerId: string | null,
  artifactName: string,
): Promise<void> {
  const inspection = await host.command(
    "docker",
    ["inspect", "--format", "{{.Id}}", VLLM_CONTAINER],
    { artifactName: `${artifactName}-inspect`, env: e2eEnv(), timeoutMs: 30_000 },
  );
  await cleanupCapturedSparkResource(
    VLLM_CONTAINER,
    containerId,
    inspectDockerContainerIdentity(inspection),
    (captured, observed) => removePresentExactVllmContainer(host, captured, observed, artifactName),
  );
}

async function removePresentExactVllmContainer(
  host: HostCliClient,
  containerId: string,
  currentContainerId: string,
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
        "set -uo pipefail",
        `container=${VLLM_CONTAINER}`,
        'expected_id="$1"',
        'current_id="$2"',
        '[[ "$current_id" == "$expected_id" ]] || { echo "refusing to remove a replacement $container container" >&2; exit 70; }',
        'label="$(docker inspect --format \'{{ index .Config.Labels "com.nvidia.nemoclaw.managed-vllm" }}\' "$expected_id")" || exit "$?"',
        '[[ "$label" == "true" ]] || { echo "refusing to remove an unmanaged $container container" >&2; exit 70; }',
        'docker rm -f "$expected_id" >/dev/null',
      ].join("\n"),
      "spark-express-vllm-cleanup",
      containerId,
      currentContainerId,
    ],
    { artifactName, env: e2eEnv(), timeoutMs: 120_000 },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
}

test.for([
  ["spark-express-vllm", "fixed-profile"],
  ["spark-vllm-extra-arguments", "extra-arguments"],
] as const)(
  "%s: %s preserves the selected recipe through managed installation and sandbox inference",
  {
    timeout: TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "qualify the physical DGX Spark host",
        "install the selected Spark vLLM profile",
        "verify selected vLLM runtime configuration",
        "prove sandbox inference and unrelated egress denial",
      ],
    },
  },
  async ([target, variant], { artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    validateSandboxName(SANDBOX_NAME);
    assertLocalDockerEnvironment(process.env);
    const { detectVllmProfile } = await import("../../../src/lib/inference/vllm.ts");
    const extraArguments = variant === "extra-arguments";
    const installEnv = e2eEnv(
      extraArguments
        ? {
            NEMOCLAW_PROVIDER: "install-vllm",
            NEMOCLAW_VLLM_EXTRA_ARGS_JSON: SPARK_EXTRA_ARGS,
          }
        : {},
    );
    const plan = extraArguments ? await boundedSparkVllmProfilePlan() : vllmProfilePlan();
    assert(plan, "the bounded Spark recipe is unavailable");
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
      id: target,
      scenario: variant,
      boundary:
        "physical DGX Spark + Express fixed profile or automatic managed selection with extra arguments + real Docker vLLM + OpenShell sandbox",
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
    expect(platform.exitCode, resultText(platform)).toBe(0);
    expect(platform.stdout.trim()).toBe("DGX Spark");
    const nvidia = await host.command("nvidia-smi", [], {
      artifactName: "spark-express-nvidia-smi",
      env: e2eEnv(),
      timeoutMs: 30_000,
    });
    expect(nvidia.exitCode, resultText(nvidia)).toBe(0);

    await (extraArguments
      ? (async () => {
          const memory = await host.command(
            "node",
            ["-e", "console.log(require('node:os').totalmem())"],
            {
              artifactName: "spark-extra-arguments-physical-memory",
              env: e2eEnv(),
              timeoutMs: 30_000,
            },
          );
          expect(memory.exitCode, resultText(memory)).toBe(0);
          expect(Number(memory.stdout.trim())).toBeGreaterThanOrEqual(60_000_000_000);
          expect(Number(memory.stdout.trim())).toBeLessThan(64_000_000_000);
        })()
      : Promise.resolve());

    const existingContainer = await host.command("docker", ["inspect", VLLM_CONTAINER], {
      artifactName: "preflight-spark-express-vllm-container",
      env: e2eEnv(),
      timeoutMs: 30_000,
    });
    expect(
      classifyDockerContainerInspection(existingContainer),
      `Refusing to replace a pre-existing ${VLLM_CONTAINER} container.\n${resultText(existingContainer)}`,
    ).toBe("absent");
    await assertSandboxAbsent(host, SANDBOX_NAME);

    progress.phase("install the selected Spark vLLM profile");
    let createdContainerId: string | null = null;
    let createdSandboxId: string | null = null;
    cleanup.add(`remove ${VLLM_CONTAINER}`, () =>
      removeExactVllmContainer(host, createdContainerId, "cleanup-spark-express-vllm-container"),
    );
    cleanup.add(`remove sandbox ${SANDBOX_NAME}`, () =>
      removeExactSandbox(host, sandbox, SANDBOX_NAME, createdSandboxId),
    );
    const onboard = await host.command(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        (extraArguments
          ? [
              "set -euo pipefail",
              "exec node bin/nemoclaw.js onboard --fresh --non-interactive --yes --yes-i-accept-third-party-software",
            ]
          : [
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
            ]
        ).join("\n"),
      ],
      {
        artifactName: "spark-express-vllm-onboard",
        cwd: REPO_ROOT,
        env: installEnv,
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );

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

    expect(onboard.exitCode, resultText(onboard)).toBe(0);
    expect(
      createdSandboxId,
      "onboarding did not create the expected sandbox identity",
    ).not.toBeNull();
    const workload = assertStockManagedImageReceipt({
      expectedPlatform: "linux/arm64",
      environment: installEnv,
      expectedAgent: "openclaw",
      sandboxName: SANDBOX_NAME,
    });

    await artifacts.writeJson("spark-sandbox-image.json", workload);

    progress.phase("verify selected vLLM runtime configuration");
    expect(inspectionResult.exitCode, resultText(inspectionResult)).toBe(0);
    const [inspection] = JSON.parse(inspectionResult.stdout) as VllmContainerInspection[];
    expect(inspection.Id).toBe(createdContainerId);
    expect(inspection.Config.Image).toBe(plan.recipe.spec.runtime.image);
    expect(inspection.Config.Entrypoint).toEqual(["/bin/bash"]);
    expect(inspection.Config.Cmd[0]).toBe("-lc");
    const command = inspection.Config.Cmd[1];
    expect(command).toBe(buildVllmServeCommand(materialized.model, installEnv));
    expect(inspection.Config.Labels).toMatchObject({
      "com.nvidia.nemoclaw.managed-vllm": "true",
    });
    extraArguments
      ? undefined
      : expect(inspection.Config.Labels).toMatchObject({
          "com.nvidia.nemoclaw.serving-catalog-digest": plan.catalogDigest,
          "com.nvidia.nemoclaw.serving-preset": plan.preset.metadata.id,
          "com.nvidia.nemoclaw.serving-preset-digest": plan.presetDigest,
          "com.nvidia.nemoclaw.serving-recipe": plan.recipe.metadata.id,
          "com.nvidia.nemoclaw.serving-recipe-digest": plan.recipeDigest,
        });
    expect(inspection.HostConfig.NetworkMode).toBe(plan.recipe.spec.runtime.networkMode);
    expect(inspection.HostConfig.IpcMode).toBe(plan.recipe.spec.runtime.ipcMode);
    expect(inspection.HostConfig.ShmSize).toBe(plan.recipe.spec.runtime.sharedMemoryBytes);
    expect(inspection.HostConfig.DeviceRequests).toEqual(
      expect.arrayContaining([expect.objectContaining({ Count: -1, Capabilities: [["gpu"]] })]),
    );
    expect(inspection.Mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Destination: `${plan.recipe.spec.runtime.modelCache.target}/hub`,
          RW: false,
          Type: "bind",
        }),
      ]),
    );

    const publicationEnv = e2eEnv();
    const probes = vllmPublicationProbeUrls(
      resolveManagedVllmBridgeHost(undefined, buildLocalManagedVllmDockerEnv({}, publicationEnv)),
    );
    await artifacts.writeJson("spark-express-vllm-publication-probes", probes);
    const allowed = await host.command(
      "curl",
      [
        ...VLLM_PUBLICATION_CURL_ARGS,
        ...probes.allowed.flatMap((url) => ["--output", "/dev/null", url]),
      ],
      {
        artifactName: "spark-express-vllm-publication-allowed",
        env: publicationEnv,
        timeoutMs: 30_000,
      },
    );
    expect(allowed.exitCode, resultText(allowed)).toBe(0);
    expect(allowed.stdout.trim().split("\n")).toEqual(["0 200", "0 200"]);
    const refused = await host.command(
      "curl",
      [
        ...VLLM_PUBLICATION_CURL_ARGS,
        ...probes.denied.flatMap((url) => ["--output", "/dev/null", url]),
      ],
      {
        artifactName: "spark-express-vllm-publication-denied",
        env: publicationEnv,
        timeoutMs: 60_000,
      },
    );
    expect(refused.exitCode, resultText(refused)).toBe(7);
    expect(refused.stdout.trim().split("\n")).toEqual(probes.denied.map(() => "7 000"));

    progress.phase("prove sandbox inference and unrelated egress denial");
    await expectOpenAiChatThroughSandbox(
      sandbox,
      SANDBOX_NAME,
      plan.recipe.spec.model.servedName,
      [],
      "spark-express-inference-local-chat",
    );
    const denied = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        "status=0; code=$(curl -sS -o /dev/null -w '%{http_connect}' --max-time 20 https://example.com/) || status=$?; printf '%s %s' \"$status\" \"$code\"",
      ),
      {
        artifactName: "spark-express-unrelated-egress-denied",
        env: e2eEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(denied.exitCode, resultText(denied)).toBe(0);
    expect(denied.stdout.trim()).toBe("56 403");
    await artifacts.target.complete({ id: target, scenario: variant });
  },
);

test(
  "dgx-station-express: Station Express installs cached Super VL vLLM and NemoClaw, routes inference, and cleans up runtime",
  {
    timeout: 48 * 60_000,
    meta: {
      e2ePhases: [
        "inspect the prepared Station",
        "install Station Express from the candidate checkout",
        "assert managed Super VL and routed inference",
        "clean up the job runtime",
      ],
      e2eCleanupTimeoutMs: 6 * 60_000,
    },
  },
  async ({ host, sandbox, artifacts, progress, cleanup }) => {
    const { runStationExpressSmoke } = await import("../support/dgx-station-express.ts");
    await artifacts.target.declare({
      id: "dgx-station-express",
      contract: [
        "local candidate Express installation",
        "default Super VL model and routed inference",
        "runtime cleanup with unchanged model-cache metadata and retained vLLM image",
      ],
    });
    await runStationExpressSmoke({
      host,
      sandbox,
      cleanup,
      environment: process.env,
      repoRoot: REPO_ROOT,
      phases: {
        inspect: () => progress.phase("inspect the prepared Station"),
        install: () => progress.phase("install Station Express from the candidate checkout"),
        assert: () => progress.phase("assert managed Super VL and routed inference"),
        cleanup: () => progress.phase("clean up the job runtime"),
      },
      verifyPublication: async (env) => {
        const probes = vllmPublicationProbeUrls(
          resolveManagedVllmBridgeHost(undefined, buildLocalManagedVllmDockerEnv({}, env)),
        );
        await artifacts.writeJson("station-express-vllm-publication-probes", probes);
        const allowed = await host.command(
          "curl",
          [
            ...VLLM_PUBLICATION_CURL_ARGS,
            ...probes.allowed.flatMap((url) => ["--output", "/dev/null", url]),
          ],
          {
            artifactName: "station-express-vllm-publication-allowed",
            env,
            timeoutMs: 30_000,
          },
        );
        expect(allowed.exitCode, resultText(allowed)).toBe(0);
        expect(allowed.stdout.trim().split("\n")).toEqual(["0 200", "0 200"]);
        const refused = await host.command(
          "curl",
          [
            ...VLLM_PUBLICATION_CURL_ARGS,
            ...probes.denied.flatMap((url) => ["--output", "/dev/null", url]),
          ],
          {
            artifactName: "station-express-vllm-publication-denied",
            env,
            timeoutMs: 60_000,
          },
        );
        expect(refused.exitCode, resultText(refused)).toBe(7);
        expect(refused.stdout.trim().split("\n")).toEqual(probes.denied.map(() => "7 000"));
      },
      writeEvidence: (name, value) => artifacts.writeJson(name, value),
    });
    await artifacts.target.complete({ id: "dgx-station-express" });
  },
);
