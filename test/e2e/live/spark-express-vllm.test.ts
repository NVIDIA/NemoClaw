// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Exercises the catalog-backed DGX Spark Express vLLM path on physical hardware. */

import { loadServingCatalog } from "../../../src/lib/inference/serving/catalog-loader.ts";
import type { HostLocalInferenceServingRecipe } from "../../../src/lib/inference/serving/types.ts";
import {
  LOCAL_MODEL_PROFILE_ENABLED_ENV,
  LOCAL_MODEL_PROFILE_RUNTIME_ENV,
  resolveLocalModelProfilePlan,
} from "../../../src/lib/onboard/local-model-profile/plan.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import {
  cleanupSandbox,
  expectOpenAiChatThroughSandbox,
  requireLivePrerequisites,
} from "./inference-routing-helpers.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-spark-express-vllm";
const VLLM_CONTAINER = "nemoclaw-vllm";
const TEST_TIMEOUT_MS = 65 * 60_000;
const ONBOARD_TIMEOUT_MS = 55 * 60_000;

interface VllmContainerInspection {
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
    readonly PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    readonly ShmSize: number;
  };
  readonly Mounts: Array<{ Destination: string; Type: string }>;
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
  if (plan?.runtime !== "vllm") {
    throw new Error("the vLLM local-model profile did not resolve from the serving catalog");
  }
  return plan;
}

async function removeOwnedVllmContainer(host: HostCliClient, artifactName: string): Promise<void> {
  const result = await host.command(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      [
        "set -euo pipefail",
        `container=${VLLM_CONTAINER}`,
        'if ! label="$(docker inspect --format \'{{ index .Config.Labels "com.nvidia.nemoclaw.managed-vllm" }}\' "$container" 2>/dev/null)"; then exit 0; fi',
        '[[ "$label" == "true" ]] || { echo "refusing to remove an unmanaged $container container" >&2; exit 70; }',
        'docker rm -f "$container" >/dev/null',
      ].join("\n"),
    ],
    { artifactName, env: e2eEnv(), timeoutMs: 120_000 },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
}

function assertRecipeCommand(command: string, recipe: HostLocalInferenceServingRecipe): void {
  expect(command).toContain(`vllm serve ${recipe.spec.model.id}`);
  expect(command).toContain(`--revision ${recipe.spec.model.revision}`);
  expect(command).toContain(`--served-model-name ${recipe.spec.model.servedName}`);
  expect(command).not.toContain("pip install");
  for (const argument of recipe.spec.serve.arguments) {
    expect(command).toContain(argument.name);
    expect(command).toContain(
      argument.value === undefined ? argument.name : String(argument.value),
    );
  }
}

test("DGX Spark Express materializes the fixed vLLM profile and routes sandbox inference", {
  timeout: TEST_TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "qualify the physical DGX Spark host",
      "activate Spark Express and onboard through the local-model profile",
      "verify catalog-owned vLLM runtime configuration",
      "prove sandbox inference and unrelated egress denial",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, sandbox, skip }) => {
  const plan = vllmProfilePlan();
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
  await requireLivePrerequisites(host, skip);
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

  cleanup.add(`remove ${VLLM_CONTAINER}`, () =>
    removeOwnedVllmContainer(host, "cleanup-spark-express-vllm-container"),
  );
  cleanup.add(`remove sandbox ${SANDBOX_NAME}`, () =>
    cleanupSandbox(host, sandbox, SANDBOX_NAME, { strict: true }),
  );
  await cleanupSandbox(host, sandbox, SANDBOX_NAME);
  await removeOwnedVllmContainer(host, "preclean-spark-express-vllm-container");

  progress.phase("activate Spark Express and onboard through the local-model profile");
  const onboard = await host.command(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      [
        "set -euo pipefail",
        "source scripts/install.sh >/dev/null",
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
      artifactName: "spark-express-vllm-onboard",
      cwd: REPO_ROOT,
      env: e2eEnv(),
      timeoutMs: ONBOARD_TIMEOUT_MS,
    },
  );
  expect(onboard.exitCode, resultText(onboard)).toBe(0);

  progress.phase("verify catalog-owned vLLM runtime configuration");
  const inspectionResult = await host.command("docker", ["inspect", VLLM_CONTAINER], {
    artifactName: "spark-express-vllm-container-inspect",
    env: e2eEnv(),
    timeoutMs: 30_000,
  });
  expect(inspectionResult.exitCode, resultText(inspectionResult)).toBe(0);
  const [inspection] = JSON.parse(inspectionResult.stdout) as VllmContainerInspection[];
  expect(inspection.Config.Image).toBe(plan.recipe.spec.runtime.image);
  expect(inspection.Config.Entrypoint).toEqual(["/bin/bash"]);
  expect(inspection.Config.Cmd[0]).toBe("-lc");
  assertRecipeCommand(inspection.Config.Cmd[1] ?? "", plan.recipe);
  expect(inspection.Config.Labels).toMatchObject({
    "com.nvidia.nemoclaw.managed-vllm": "true",
    "com.nvidia.nemoclaw.serving-catalog-digest": plan.catalogDigest,
    "com.nvidia.nemoclaw.serving-preset": plan.preset.metadata.id,
    "com.nvidia.nemoclaw.serving-preset-digest": plan.presetDigest,
    "com.nvidia.nemoclaw.serving-recipe": plan.recipe.metadata.id,
    "com.nvidia.nemoclaw.serving-recipe-digest": plan.recipeDigest,
  });
  expect(inspection.HostConfig.NetworkMode).toBe(plan.recipe.spec.runtime.networkMode);
  expect(inspection.HostConfig.IpcMode).toBe(plan.recipe.spec.runtime.ipcMode);
  expect(inspection.HostConfig.ShmSize).toBe(plan.recipe.spec.runtime.sharedMemoryBytes);
  expect(inspection.HostConfig.PortBindings["8000/tcp"]).toEqual([
    { HostIp: "127.0.0.1", HostPort: "8000" },
  ]);
  expect(inspection.HostConfig.DeviceRequests).toEqual(
    expect.arrayContaining([expect.objectContaining({ Count: -1, Capabilities: [["gpu"]] })]),
  );
  expect(inspection.Mounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Destination: plan.recipe.spec.runtime.modelCache.target,
        Type: "bind",
      }),
    ]),
  );

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
      "curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://example.com/",
    ),
    {
      artifactName: "spark-express-unrelated-egress-denied",
      env: e2eEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(denied.exitCode, resultText(denied)).toBe(0);
  expect(denied.stdout.trim()).toBe("403");
});
