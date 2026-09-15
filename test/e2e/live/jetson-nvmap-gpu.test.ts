// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { getBuildIdentity } from "../../../src/lib/core/version";
import { MANAGED_IMAGE_REPOSITORIES } from "../../../src/lib/onboard/managed-image/contract";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  cleanupWhenCommandAvailable,
  cleanupWhenOpenShellAvailable,
} from "../fixtures/cleanup-resources.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import type { FakeOpenAiCompatibleRequest } from "../fixtures/fake-openai-compatible.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-jetson-nvmap";
const INFERENCE_API_KEY = "jetson-nvmap-e2e-key";
const INFERENCE_MODEL = "jetson-nvmap-e2e";
const REGISTRY_FILE = path.join(process.env.HOME ?? "/tmp", ".nemoclaw", "sandboxes.json");
const TIMEOUT_MS = 50 * 60_000;
const CANDIDATE_SOURCE_REVISION = getBuildIdentity({ rootDir: REPO_ROOT }).sourceRevision;
const MANAGED_IMAGE_SOURCE_REVISION =
  process.env.E2E_MANAGED_IMAGE_REVISION ?? CANDIDATE_SOURCE_REVISION;

function sandboxManagedImage(): {
  imageTag: string;
  workload: Record<string, unknown>;
} {
  expect(fs.existsSync(REGISTRY_FILE), `${REGISTRY_FILE} missing`).toBe(true);
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as {
    sandboxes?: Record<string, { imageTag?: unknown; workload?: unknown }>;
  };
  const entry = registry.sandboxes?.[SANDBOX_NAME];
  const imageTag = entry?.imageTag;
  const normalizedImageTag = typeof imageTag === "string" ? imageTag.trim() : "";
  expect(normalizedImageTag, `registry imageTag missing for ${SANDBOX_NAME}`).not.toBe("");
  expect(entry?.workload).toBeTypeOf("object");
  expect(entry?.workload).not.toBeNull();
  return {
    imageTag: normalizedImageTag,
    workload: entry?.workload as Record<string, unknown>,
  };
}

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    E2E_MANAGED_IMAGE_REVISION: MANAGED_IMAGE_SOURCE_REVISION,
    GITHUB_ACTIONS: "true",
    HOME: process.env.HOME,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_JETSON_WORKSPACE: process.env.NEMOCLAW_JETSON_WORKSPACE,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_E2E_EXPECTED_SHA: CANDIDATE_SOURCE_REVISION,
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_GPU: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    XDG_BIN_HOME: process.env.XDG_BIN_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    npm_config_prefix: process.env.npm_config_prefix,
    ...extra,
  };
}

async function hostShell(
  host: HostCliClient,
  script: string,
  artifactName: string,
  timeoutMs = 60_000,
): Promise<ShellProbeResult> {
  return await host.command("bash", ["-lc", script], {
    artifactName,
    cwd: REPO_ROOT,
    env: env(),
    timeoutMs,
  });
}

async function cleanupJetsonSandbox(host: HostCliClient): Promise<void> {
  await hostShell(
    host,
    String.raw`set +e
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$NEMOCLAW_SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$NEMOCLAW_SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi`,
    "cleanup-jetson-nvmap",
    120_000,
  ).catch(() => undefined);
}

test(
  "Jetson onboarding proves native OpenShell CDI CUDA (#8910)",
  {
    timeout: TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "detect Jetson hardware",
        "clear previous Jetson runtime state",
        "confirm nvmap and NVIDIA CDI",
        "install NemoClaw with native sandbox GPU access",
        "confirm NemoClaw recorded the CUDA proof",
        "prove non-root CUDA through the OpenShell sandbox",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox, skip }) => {
    await artifacts.target.declare({
      id: "jetson-nvmap-gpu",
      issue: 8910,
      boundary:
        "AGX Thor or IGX Orin onboarding through install.sh and native OpenShell CDI with non-root cuInit(0)=0",
      sandboxName: SANDBOX_NAME,
    });

    // A1: Skip before changing Docker or OpenShell state when the host is not
    // one of the accepted qualification devices.
    progress.phase("detect Jetson hardware");
    const hardwareGate = await hostShell(
      host,
      String.raw`model="$(tr -d '\0' </proc/device-tree/model 2>/dev/null || true)"
gpu="$(nvidia-smi -L 2>/dev/null || true)"
case "$model $gpu" in
  *Thor*|*IGX*Orin*) printf 'qualified:model=%s gpu=%s\n' "$model" "$gpu" ;;
  *) printf 'unsupported:model=%s gpu=%s\n' "$model" "$gpu" ;;
esac`,
      "phase-0-jetson-hardware-gate",
    );
    expect(hardwareGate.exitCode, resultText(hardwareGate)).toBe(0);
    hardwareGate.stdout.startsWith("qualified:") ||
      skip("This test requires an AGX Thor or IGX Orin host with /dev/nvmap.");

    const gatewayCleanupOptions = {
      artifactName: "cleanup-jetson-openshell-gateway",
      env: env(),
      timeoutMs: 120_000,
    };
    cleanup.trackGateway(
      {
        cleanupGatewayRegistration: (name: string) =>
          cleanupWhenOpenShellAvailable(
            host,
            {
              artifactName: "cleanup-probe-jetson-openshell-gateway",
              env: gatewayCleanupOptions.env,
              timeoutMs: 30_000,
            },
            () => host.cleanupGatewayRegistration(name, gatewayCleanupOptions),
          ),
      },
      "nemoclaw",
      gatewayCleanupOptions,
    );
    const openshellSandboxCleanupOptions = {
      artifactName: "cleanup-jetson-openshell-sandbox",
      env: env(),
      timeoutMs: 120_000,
    };
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      cleanupWhenOpenShellAvailable(
        host,
        {
          artifactName: "cleanup-probe-jetson-openshell-sandbox",
          env: openshellSandboxCleanupOptions.env,
          timeoutMs: 30_000,
        },
        () => sandbox.cleanupSandbox(SANDBOX_NAME, openshellSandboxCleanupOptions),
      ),
    );
    const nemoclawSandboxCleanupOptions = {
      artifactName: "cleanup-jetson-nemoclaw-sandbox",
      env: env(),
      timeoutMs: 120_000,
    };
    cleanup.trackSandbox(
      {
        cleanupSandbox: (name: string) =>
          cleanupWhenCommandAvailable(
            host,
            host.commandPath,
            {
              artifactName: "cleanup-probe-jetson-nemoclaw-sandbox",
              env: nemoclawSandboxCleanupOptions.env,
              timeoutMs: 30_000,
            },
            () => host.cleanupSandbox(name, nemoclawSandboxCleanupOptions),
          ),
      },
      SANDBOX_NAME,
      nemoclawSandboxCleanupOptions,
    );
    progress.phase("clear previous Jetson runtime state");
    await cleanupJetsonSandbox(host);

    progress.phase("confirm nvmap and NVIDIA CDI");
    const hostNvmap = await hostShell(
      host,
      "test -c /dev/nvmap && ls -l /dev/nvmap",
      "phase-0-host-nvmap",
    );
    expect(hostNvmap.exitCode, resultText(hostNvmap)).toBe(0);
    expect(hostNvmap.stdout).toContain("/dev/nvmap");

    // A2: Native Jetson GPU onboarding requires Docker CDI discovery and a
    // readable NVIDIA spec. The OpenShell stack owns translating that spec
    // into sandbox devices, libraries, groups, and policy.
    const docker = await host.command("docker", ["info"], {
      artifactName: "phase-1-docker-info",
      env: env(),
      timeoutMs: 30_000,
    });
    expect(docker.exitCode, resultText(docker)).toBe(0);
    const dockerCdiDevices = await host.command(
      "docker",
      ["info", "--format", "{{json .DiscoveredDevices}}"],
      {
        artifactName: "phase-1-docker-cdi-devices",
        env: env(),
        timeoutMs: 30_000,
      },
    );
    expect(dockerCdiDevices.exitCode, resultText(dockerCdiDevices)).toBe(0);
    expect(resultText(dockerCdiDevices)).toMatch(/nvidia\.com\/gpu=(?:0|all)/u);
    const cdiSpec = await hostShell(
      host,
      String.raw`set -euo pipefail
spec="$(grep -R -l '/dev/nvmap' /etc/cdi /run/cdi 2>/dev/null | sort -u | sed -n '1p')"
grep -q 'libcuda\.so' "$spec"
printf 'nvidia_cdi_spec=%s\n' "$spec"`,
      "phase-1-nvidia-cdi-spec",
    );
    expect(cdiSpec.exitCode, resultText(cdiSpec)).toBe(0);

    const inference = await startFakeOpenAiCompatibleServer({
      apiKey: INFERENCE_API_KEY,
      host: "0.0.0.0",
      model: INFERENCE_MODEL,
      progress,
      publicHost: "host.openshell.internal",
      requireAuth: true,
      requireAuthModels: true,
    });
    cleanup.trackDisposable("close Jetson compatible inference fixture", async () => {
      let requests: readonly FakeOpenAiCompatibleRequest[] = [];
      try {
        requests = inference.requests();
      } finally {
        await inference.close();
      }
      await artifacts.writeJson("jetson-compatible-inference-requests.json", requests);
    });
    await artifacts.writeJson("jetson-compatible-inference.json", { baseUrl: inference.baseUrl });
    const inferenceEnv = {
      COMPATIBLE_API_KEY: INFERENCE_API_KEY,
      NEMOCLAW_ENDPOINT_URL: inference.baseUrl,
      NEMOCLAW_MODEL: INFERENCE_MODEL,
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
    };

    // A3: install.sh must complete on the native OpenShell CDI route. NemoClaw
    // may verify the GPU only through sandbox exec as the sandbox identity.
    progress.phase("install NemoClaw with native sandbox GPU access");
    const install = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "phase-2-install-jetson-nvmap",
      cwd: REPO_ROOT,
      env: env(inferenceEnv),
      timeoutMs: 40 * 60_000,
    });
    await artifacts.writeText("install-jetson-nvmap.log", resultText(install));
    expect(install.exitCode, resultText(install)).toBe(0);

    // #3508 failed after Jetson onboarding silently fell back to building
    // Dockerfile.base locally. Prove this buildless path instead registered
    // the dispatched, immutable published linux/arm64 managed image. The v2
    // Jetson dispatch contract carries the exact revision, so bind its remote
    // durable receipt to the immutable image's cohort label here.
    expect(resultText(install)).not.toContain(
      "Building OpenClaw sandbox base image locally because no compatible published base image was found.",
    );
    const managedImage = sandboxManagedImage();
    const expectedReference = new RegExp(
      `^${MANAGED_IMAGE_REPOSITORIES.openclaw.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}@sha256:[0-9a-f]{64}$`,
      "u",
    );
    expect(managedImage.imageTag).toMatch(expectedReference);
    const sourceCohort = managedImage.workload.sourceCohort;
    expect(sourceCohort).toMatch(/^ghrun-[1-9][0-9]*-[1-9][0-9]*$/u);
    expect(managedImage.workload).toMatchObject({
      kind: "managed-image",
      platform: "linux/arm64",
      reference: managedImage.imageTag,
      shared: true,
      sourceCohort,
      sourceRevision: MANAGED_IMAGE_SOURCE_REVISION,
    });
    const managedImageLabels = await host.command(
      "docker",
      ["image", "inspect", "--format", "{{json .Config.Labels}}", managedImage.imageTag],
      {
        artifactName: "phase-2-published-managed-image-labels",
        env: env(),
        timeoutMs: 30_000,
      },
    );
    expect(managedImageLabels.exitCode, resultText(managedImageLabels)).toBe(0);
    const labels = JSON.parse(managedImageLabels.stdout.trim()) as Record<string, unknown>;
    expect(labels).toMatchObject({
      "io.nvidia.nemoclaw.agent": "openclaw",
      "io.nvidia.nemoclaw.managed-image.capabilities": "1",
      "io.nvidia.nemoclaw.managed-image.cohort": sourceCohort,
      "io.nvidia.nemoclaw.managed-image.contract": "1",
      "io.nvidia.nemoclaw.managed-image.platform": "linux/arm64",
      "io.nvidia.nemoclaw.managed-image.startup-profile": "1",
      "org.opencontainers.image.revision": MANAGED_IMAGE_SOURCE_REVISION,
      "org.opencontainers.image.source": "https://github.com/NVIDIA/NemoClaw",
    });
    await artifacts.writeJson("phase-2-published-managed-image.json", {
      imageTag: managedImage.imageTag,
      labels,
      workload: managedImage.workload,
    });

    const inferenceRoute = await host.command(
      "bash",
      ["-lc", "openshell inference get -g nemoclaw 2>&1 || openshell inference get 2>&1"],
      {
        artifactName: "phase-2-openshell-inference-route",
        env: env(),
        timeoutMs: 30_000,
      },
    );
    expect(inferenceRoute.exitCode, resultText(inferenceRoute)).toBe(0);
    const plainInferenceRoute = resultText(inferenceRoute).replace(/\x1b\[[0-9;]*m/g, "");
    expect(plainInferenceRoute).toContain("Provider: compatible-endpoint");
    expect(plainInferenceRoute).toContain(`Model: ${INFERENCE_MODEL}`);

    const inferenceRequests = inference.requests();
    await artifacts.writeJson("phase-2-compatible-inference-requests.json", inferenceRequests);
    expect(inferenceRequests).toContainEqual(
      expect.objectContaining({
        auth: "ok",
        method: "GET",
        path: "/v1/models",
      }),
    );

    const installedCli = await hostShell(host, "command -v nemoclaw", "phase-2-command-v-nemoclaw");
    expect(installedCli.exitCode, resultText(installedCli)).toBe(0);
    expect(installedCli.stdout.trim()).not.toBe("");

    const installedBinaries = await hostShell(
      host,
      String.raw`set -euo pipefail
[ -n "$NEMOCLAW_JETSON_WORKSPACE" ]
for installed_command in nemoclaw openshell openshell-gateway openshell-sandbox; do
  installed_path="$(command -v "$installed_command")"
  canonical_path="$(realpath -e "$installed_path")"
  case "$canonical_path" in
    "$NEMOCLAW_JETSON_WORKSPACE"/*) printf '%s\t%s\n' "$installed_command" "$canonical_path" ;;
    *) echo "$installed_command resolved outside the Jetson job workspace" >&2; exit 1 ;;
  esac
done`,
      "phase-2-job-local-installation",
    );
    expect(installedBinaries.exitCode, resultText(installedBinaries)).toBe(0);
    expect(installedBinaries.stdout.trim().split("\n")).toHaveLength(4);

    const installLog = resultText(install);
    expect(installLog).toContain("Jetson sandbox GPU enabled through native OpenShell CDI");
    expect(installLog).not.toMatch(
      /Recreating OpenShell Docker sandbox container with NVIDIA GPU access|Docker GPU mode selected/u,
    );
    expect(installLog).toMatch(
      /GPU proof passed: nvidia-smi when available.*GPU proof passed: \/proc\/<pid>\/task\/<tid>\/comm write.*GPU proof passed: cuInit\(0\) via libcuda\.so\.1/su,
    );

    // A4: the durable status must retain the successful onboarding CUDA proof.
    progress.phase("confirm NemoClaw recorded the CUDA proof");
    const status = await hostShell(
      host,
      `nemoclaw "$NEMOCLAW_SANDBOX_NAME" status`,
      "phase-4-nemoclaw-status",
      120_000,
    );
    expect(status.exitCode, resultText(status)).toBe(0);
    expect(resultText(status)).toContain("Sandbox GPU: enabled");
    expect(resultText(status)).toContain("CUDA verified");

    progress.phase("prove non-root CUDA through the OpenShell sandbox");
    const sandboxCuda = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(String.raw`set -euo pipefail
test "$(id -u)" -ne 0
printf 'sandbox_uid=%s\n' "$(id -u)"
test -c /dev/nvmap
ls /sys >/dev/null
printf 'nemoclaw-cuda' > /proc/self/comm
command -v nvidia-smi
nvidia-smi -L
python3 -c 'import ctypes; lib=ctypes.CDLL("libcuda.so.1"); rc=lib.cuInit(0); print("cuInit(0)=%d" % rc); raise SystemExit(0 if rc == 0 else 1)'`),
      {
        artifactName: "phase-5-sandbox-native-cdi-cuda",
        env: env(),
        timeoutMs: 60_000,
      },
    );
    expect(sandboxCuda.exitCode, resultText(sandboxCuda)).toBe(0);
    expect(sandboxCuda.stdout).toMatch(/sandbox_uid=[1-9][0-9]*/u);
    expect(sandboxCuda.stdout).toContain("cuInit(0)=0");
  },
);
