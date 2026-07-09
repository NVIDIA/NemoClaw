// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isLinuxDockerDriverGatewayEnabled } from "../../../src/lib/onboard/docker-driver-platform.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../fixtures/shell-probe.ts";
import { negativeOverlayOutcome } from "./overlayfs-autofix-outcome.ts";

// Keep this direct: the contract mutates the host Docker daemon into
// Docker 26+ containerd-snapshotter overlayfs mode, runs the real installer,
// proves NemoClaw routes the OpenShell cluster through a local
// fuse-overlayfs-patched image, and then proves disabling the auto-fix exposes
// the original nested-overlay failure signature (or skips when the runner does
// not reproduce that kernel-specific failure).

const TEST_SANDBOX_PREFIX = "e2e-overlayfs";
const SANDBOX_NAME =
  process.env.NEMOCLAW_SANDBOX_NAME ??
  [TEST_SANDBOX_PREFIX, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT, process.pid]
    .filter(Boolean)
    .join("-");
const TEST_TIMEOUT_MS = Number(process.env.NEMOCLAW_E2E_TIMEOUT_SECONDS ?? 1_500) * 1_000;
const NEGATIVE_TIMEOUT_SECONDS = Number(process.env.NEMOCLAW_OVERLAYFS_E2E_NEGATIVE_TIMEOUT ?? 300);
const GATEWAY_CONTAINER = "openshell-cluster-nemoclaw";
const DAEMON_JSON = "/etc/docker/daemon.json";

function text(result: ShellProbeResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function assertTestOwnedSandboxName(): void {
  expect(
    SANDBOX_NAME.startsWith(TEST_SANDBOX_PREFIX),
    `overlayfs-autofix live test is destructive and only accepts sandbox names with prefix ${TEST_SANDBOX_PREFIX}; got ${SANDBOX_NAME}`,
  ).toBe(true);
}

function overlayfsAutofixNotInRuntimePath(): boolean {
  return isLinuxDockerDriverGatewayEnabled(os.platform(), process.arch);
}

function overlayEnv(apiKey: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const hosted = requireHostedInferenceConfig({ required: () => apiKey });
  return {
    ...buildAvailabilityProbeEnv(),
    ...hosted.env,
    ...extra,
    NVIDIA_INFERENCE_API_KEY: apiKey,
    NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
  };
}

async function bash(
  host: HostCliClient,
  script: string,
  options: ShellProbeRunOptions = {},
): Promise<ShellProbeResult> {
  return host.command("bash", ["-lc", script], options);
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup stays best-effort so the primary setup/assertion failure is visible.
  }
}

async function preCleanup(
  host: HostCliClient,
  apiKey: string,
  artifactName: string,
): Promise<void> {
  await bash(
    host,
    String.raw`
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$NEMOCLAW_SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$NEMOCLAW_SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
docker rm -f "$GATEWAY_CONTAINER" 2>/dev/null || true
patched_images=$(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^nemoclaw-cluster:' || true)
if [ -n "$patched_images" ]; then
  printf '%s\n' "$patched_images" | xargs docker rmi -f >/dev/null 2>&1 || true
fi
rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
`,
    {
      artifactName,
      env: overlayEnv(apiKey, { GATEWAY_CONTAINER }),
      redactionValues: [apiKey],
      timeoutMs: 5 * 60_000,
    },
  );
}

async function dockerInfoJson(
  host: HostCliClient,
  artifactName: string,
): Promise<Record<string, unknown>> {
  const result = await host.command("docker", ["info", "--format", "{{json .}}"], {
    artifactName,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  expect(result.exitCode, `${artifactName}: docker info must succeed`).toBe(0);
  try {
    return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Could not parse docker info JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function waitForDocker(host: HostCliClient): Promise<boolean> {
  let ready = false;
  for (let attempt = 0; attempt < 10 && !ready; attempt += 1) {
    const result = await host.command("docker", ["info"], {
      artifactName: `wait-docker-info-${attempt + 1}`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    ready = result.exitCode === 0;
    await new Promise((resolve) => setTimeout(resolve, ready ? 0 : 2_000));
  }
  return ready;
}

test.skipIf(overlayfsAutofixNotInRuntimePath())(
  "overlayfs-autofix: patched cluster image handles Docker containerd overlayfs",
  async ({ artifacts, cleanup, host, secrets, skip }) => {
    assertTestOwnedSandboxName();

    await artifacts.writeJson("contract.json", {
      id: "overlayfs-autofix",
      sandboxName: SANDBOX_NAME,
      issue: "#2481",
      preservedBoundaries: [
        "real Docker daemon feature flip through sudo-managed /etc/docker/daemon.json",
        "real Docker daemon restart and docker info overlayfs/containerd-snapshotter probe",
        "real install.sh --non-interactive onboarding with hosted compatible inference",
        "real local nemoclaw-cluster:*fuse-overlayfs* Docker image build/cache check",
        "real OpenShell gateway container image/log inspection",
        "real NEMOCLAW_DISABLE_OVERLAY_FIX=1 negative install attempt with bounded timeout",
      ],
    });

    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    const redactionValues = [apiKey];

    const dockerPrereq = await host.command("docker", ["info"], {
      artifactName: "phase-0-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    dockerPrereq.exitCode !== 0 &&
      process.env.GITHUB_ACTIONS !== "true" &&
      skip("Docker is required for overlayfs-autofix live coverage");
    expect(
      dockerPrereq.exitCode,
      `Docker is required for overlayfs-autofix: ${text(dockerPrereq)}`,
    ).toBe(0);

    const sudoPrereq = await host.command("sudo", ["-n", "true"], {
      artifactName: "phase-0-sudo-check",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    sudoPrereq.exitCode !== 0 &&
      process.env.GITHUB_ACTIONS !== "true" &&
      skip(`Passwordless sudo is required to edit ${DAEMON_JSON}`);
    expect(
      sudoPrereq.exitCode,
      `Passwordless sudo is required to edit ${DAEMON_JSON}: ${text(sudoPrereq)}`,
    ).toBe(0);

    const installExists = fs.existsSync(path.join(process.cwd(), "install.sh"));
    expect(installExists, "install.sh must exist at repo root").toBe(true);

    const version = await bash(
      host,
      "docker info --format '{{.ServerVersion}}' 2>/dev/null || echo unknown",
      {
        artifactName: "phase-0-docker-version",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    const major = Number.parseInt(version.stdout.trim().split(".")[0] ?? "", 10);
    Number.isFinite(major) &&
      major < 23 &&
      skip(`Docker ${version.stdout.trim()} predates the containerd-snapshotter feature flag`);

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-overlayfs-"));
    const daemonBackup = path.join(stateDir, "daemon.json.bak");
    const daemonAbsentMarker = path.join(stateDir, "daemon.json.absent");
    cleanup.add("restore Docker daemon configuration after overlayfs-autofix", async () => {
      const restore = await (fs.existsSync(daemonAbsentMarker)
        ? bash(host, `sudo rm -f ${DAEMON_JSON}; sudo systemctl restart docker`, {
            artifactName: "cleanup-restore-daemon-absent",
            env: buildAvailabilityProbeEnv(),
            timeoutMs: 60_000,
          })
        : fs.existsSync(daemonBackup)
          ? bash(
              host,
              `sudo cp ${JSON.stringify(daemonBackup)} ${DAEMON_JSON}; sudo systemctl restart docker`,
              {
                artifactName: "cleanup-restore-daemon-backup",
                env: buildAvailabilityProbeEnv(),
                timeoutMs: 60_000,
              },
            )
          : Promise.resolve<ShellProbeResult>({
              command: [],
              exitCode: 0,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: "",
              artifacts: { stdout: "", stderr: "", result: "" },
            }));
      expect(restore.exitCode, `Docker daemon restore failed: ${text(restore)}`).toBe(0);
      expect(await waitForDocker(host), "Docker must come back after daemon restore").toBe(true);
      fs.rmSync(stateDir, { recursive: true, force: true });
    });
    cleanup.add(`destroy overlayfs-autofix sandbox ${SANDBOX_NAME}`, async () => {
      process.env.NEMOCLAW_E2E_KEEP_SANDBOX !== "1" &&
        (await bestEffort(() => preCleanup(host, apiKey, "cleanup-overlayfs-sandbox")));
    });

    const backup = await bash(
      host,
      `if [ -f ${DAEMON_JSON} ]; then sudo cp ${DAEMON_JSON} ${JSON.stringify(daemonBackup)}; else touch ${JSON.stringify(daemonAbsentMarker)}; fi`,
      {
        artifactName: "phase-1-backup-daemon-json",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 60_000,
      },
    );
    expect(backup.exitCode, `daemon backup failed: ${text(backup)}`).toBe(0);

    const writeDaemon = await bash(
      host,
      String.raw`sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "features": { "containerd-snapshotter": true }
}
EOF
sudo systemctl restart docker`,
      {
        artifactName: "phase-1-enable-containerd-snapshotter",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 90_000,
      },
    );
    expect(
      writeDaemon.exitCode,
      `failed to enable containerd-snapshotter: ${text(writeDaemon)}`,
    ).toBe(0);
    expect(await waitForDocker(host), "Docker must come back after daemon restart").toBe(true);

    const info = await dockerInfoJson(host, "phase-1-docker-info-json");
    info.Driver !== "overlayfs" &&
      (await artifacts.writeJson("phase-1-skip-driver.json", { driver: info.Driver ?? null }),
      skip(
        `Docker reports Driver=${String(info.Driver ?? "?")} — runner did not switch to overlayfs`,
      ));
    !JSON.stringify(info).includes("io.containerd.snapshotter.v1") &&
      (await artifacts.writeJson("phase-1-skip-driver-status.json", {
        driverStatus: info.DriverStatus ?? null,
      }),
      skip("Docker overlayfs is active but DriverStatus does not advertise the v1 snapshotter"));

    await preCleanup(host, apiKey, "phase-2-pre-cleanup");

    const positive = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "phase-3-install-autofix-on",
      cwd: process.cwd(),
      env: overlayEnv(apiKey),
      redactionValues,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    await artifacts.writeText("phase-3-install-autofix-on.log", text(positive));
    expect(
      positive.exitCode,
      `install.sh + onboard failed with auto-fix on: ${text(positive)}`,
    ).toBe(0);
    expect(text(positive)).toContain("Detected Docker 26+ containerd-snapshotter overlayfs");

    const patchedImageResult = await bash(
      host,
      "docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^nemoclaw-cluster:.*-fuse-overlayfs-[0-9a-f]{8}$' | head -1 || true",
      {
        artifactName: "phase-3-patched-image-list",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    const patchedTag = patchedImageResult.stdout.trim();
    expect(
      patchedTag,
      "a nemoclaw-cluster:*fuse-overlayfs-* image must exist after onboard",
    ).toMatch(/^nemoclaw-cluster:.*-fuse-overlayfs-[0-9a-f]{8}$/);
    await artifacts.writeJson("phase-3-patched-image.json", { patchedTag });

    const gatewayImageResult = await bash(
      host,
      `docker inspect --format '{{.Config.Image}}' ${GATEWAY_CONTAINER}`,
      {
        artifactName: "phase-3-gateway-image",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(
      gatewayImageResult.exitCode,
      `gateway image inspect failed: ${text(gatewayImageResult)}`,
    ).toBe(0);
    expect(gatewayImageResult.stdout.trim()).toBe(patchedTag);

    const gatewayLogs = await bash(host, `docker logs ${GATEWAY_CONTAINER} 2>&1`, {
      artifactName: "phase-3-gateway-logs",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(text(gatewayLogs)).not.toMatch(/overlayfs.*snapshotter cannot be enabled/i);

    const beforeCreated = await bash(
      host,
      `docker inspect --format '{{.Created}}' ${JSON.stringify(patchedTag)}`,
      {
        artifactName: "phase-4-patched-image-created-before",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(beforeCreated.exitCode).toBe(0);
    const openshellVersion = patchedTag.replace(
      /^nemoclaw-cluster:(.*)-fuse-overlayfs-[0-9a-f]{8}$/,
      "$1",
    );
    const upstreamImage = `ghcr.io/nvidia/openshell/cluster:${openshellVersion}`;
    const secondTagResult = await host.command(
      "node",
      [
        "-e",
        "const m = require('./dist/lib/cluster-image-patch'); const tag = m.ensurePatchedClusterImage({ upstreamImage: process.argv[1], logger: () => {} }); console.log(tag);",
        upstreamImage,
      ],
      {
        artifactName: "phase-4-ensure-patched-image-second-call",
        cwd: process.cwd(),
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 60_000,
      },
    );
    expect(
      secondTagResult.exitCode,
      `second ensurePatchedClusterImage failed: ${text(secondTagResult)}`,
    ).toBe(0);
    expect(secondTagResult.stdout.trim().split(/\r?\n/).at(-1)).toBe(patchedTag);
    const afterCreated = await bash(
      host,
      `docker inspect --format '{{.Created}}' ${JSON.stringify(patchedTag)}`,
      {
        artifactName: "phase-4-patched-image-created-after",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(afterCreated.exitCode).toBe(0);
    expect(afterCreated.stdout.trim()).toBe(beforeCreated.stdout.trim());

    await preCleanup(host, apiKey, "phase-5-negative-pre-cleanup");
    const negative = await host.command(
      "timeout",
      [String(NEGATIVE_TIMEOUT_SECONDS), "bash", "install.sh", "--non-interactive"],
      {
        artifactName: "phase-5-install-autofix-disabled",
        cwd: process.cwd(),
        env: overlayEnv(apiKey, { NEMOCLAW_DISABLE_OVERLAY_FIX: "1" }),
        redactionValues,
        timeoutMs: (NEGATIVE_TIMEOUT_SECONDS + 30) * 1_000,
      },
    );
    await artifacts.writeText("phase-5-install-autofix-disabled.log", text(negative));
    expect(
      negative.exitCode,
      "install.sh must not succeed with NEMOCLAW_DISABLE_OVERLAY_FIX=1",
    ).not.toBe(0);

    const negativeClusterLogs = await bash(host, `docker logs ${GATEWAY_CONTAINER} 2>&1 || true`, {
      artifactName: "phase-5-negative-cluster-logs",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    const negativeEvidence = [text(negativeClusterLogs), text(negative)].join("\n");
    switch (negativeOverlayOutcome(negative, negativeEvidence)) {
      case "reproduced":
        await artifacts.writeJson("phase-5-negative-evidence.json", { reproduced: true });
        break;
      case "timeout":
        await artifacts.writeJson("phase-5-negative-evidence.json", {
          reproduced: false,
          skipped: true,
          reason: `runner did not reproduce nested-overlay bug before ${NEGATIVE_TIMEOUT_SECONDS}s timeout`,
        });
        skip(
          `Runner did not reproduce the nested-overlay bug under the upstream image before ${NEGATIVE_TIMEOUT_SECONDS}s timeout`,
        );
        break;
      case "unrelated":
        throw new Error(
          `Negative phase exited ${negative.exitCode} without nested-overlay signature; likely unrelated flake: ${text(negative).slice(0, 1_000)}`,
        );
    }
  },
  TEST_TIMEOUT_MS * 3,
);
