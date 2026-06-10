// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import { assertExitZero } from "../clients/command.ts";
import type { HostCliClient } from "../clients/host.ts";
import type { SandboxClient } from "../clients/sandbox.ts";
import type { ShellProbeResult } from "../shell-probe.ts";
import type { NemoClawInstance } from "./onboarding.ts";

// Mirror of `OPENSHELL_SANDBOX_NAME_LABEL` in
// `src/lib/onboard/docker-gpu-patch.ts`. Duplicated here because the
// fixture layer must not import from `src/lib/**` (CLI source) — that
// boundary keeps the live runner honest about probing only host-
// observable state. Drift is caught by the integration test that wires
// a real onboarded sandbox through the docker-sandbox-container-present
// probe.
const OPENSHELL_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";
const DOCKER_PROBE_TIMEOUT_MS = 15_000;
// Status invocation can take several minutes on unfixed code while
// the gateway recovery path retries. Keep the budget generous; the
// bug is independent of latency.
const STATUS_TIMEOUT_MS = 5 * 60_000;

export type LifecycleProfile = "post-reboot-recovery";

export interface LifecycleCleanup {
  add(name: string, run: () => Promise<void> | void): void;
}

/**
 * How the post-reboot-recovery profile leaves Docker before the test
 * exits the lifecycle phase:
 *
 *   - `stop-original`  — `docker stop` the labeled container in place.
 *                        Matches the common Spark reboot path: the
 *                        container exists, is exited, retains its
 *                        OpenShell labels, but is no longer running.
 *
 *   - `rename-to-gpu-backup` — stop the labeled container, then
 *                        `docker rename` it to `<original>-nemoclaw-
 *                        gpu-backup-<ts>`. Reproduces the rarer GPU-
 *                        patch reboot path where only the backup
 *                        sibling survives and recovery has to rename
 *                        it back. Mirrors `buildBackupContainerName()`
 *                        in `src/lib/onboard/docker-gpu-patch.ts`.
 */
export type PostRebootMode = "stop-original" | "rename-to-gpu-backup";

export interface PostRebootOptions {
  mode?: PostRebootMode;
}

export interface LifecycleResult {
  profile: LifecycleProfile;
  steps: Array<{ id: string; results: ShellProbeResult[] }>;
}

export class LifecyclePhaseFixture {
  constructor(
    private readonly host: HostCliClient,
    private readonly sandbox: SandboxClient,
    private readonly cleanup: LifecycleCleanup,
  ) {}

  async simulate(
    profile: LifecycleProfile,
    instance: NemoClawInstance,
    options: PostRebootOptions = {},
  ): Promise<LifecycleResult> {
    switch (profile) {
      case "post-reboot-recovery":
        return await this.simulatePostReboot(instance, options);
      default: {
        const _exhaustive: never = profile;
        throw new Error(`Unsupported lifecycle profile '${_exhaustive}'.`);
      }
    }
  }

  /**
   * Reproduce the host-side conditions of a DGX Spark / Linux Docker-driver
   * reboot AND drive the user-visible action that exposes the bug:
   *
   *   1. Locate the OpenShell-labeled Docker container for the
   *      scenario's sandbox name and either stop it (default) or
   *      stop+rename it to a `*-nemoclaw-gpu-backup-*` sibling.
   *      The gateway runtime is left HEALTHY — attempting to stop
   *      and restart it from the OpenShell CLI is unreliable on
   *      `ubuntu-latest` (no `gateway start` subcommand) and the
   *      remaining bug class for #4423 specifically requires a
   *      `healthy_named` gateway when status runs (otherwise
   *      #4578's mitigation takes over and masks the signal).
   *
   *   2. Invoke `nemoclaw <name> status` — the user-visible action
   *      that documented the regression in #4423. On unfixed `main`
   *      the destructive `missing` branch in `status.ts` wipes the
   *      registry entry. On the PR-A fix branch the new Docker-driver
   *      recovery helper restarts the labeled container before
   *      stale-removal can fire.
   *
   *   We deliberately do NOT assert on the status exit code here
   *   because the bug is precisely that status "succeeds" at
   *   destroying state. The state-validation phase that follows is
   *   what catches the regression via the
   *   `local-registry-entry-present` and `docker-sandbox-container-present`
   *   probes.
   *
   * Cleanups (run in reverse order at end of test):
   *   - rename the backup sibling back to the original name (if we
   *     created one);
   *   - `docker start` the labeled container so the sandbox returns
   *     to a usable state for any teardown that expects it live.
   */
  async simulatePostReboot(
    instance: NemoClawInstance,
    options: PostRebootOptions = {},
  ): Promise<LifecycleResult> {
    const mode: PostRebootMode = options.mode ?? "stop-original";
    const steps: LifecycleResult["steps"] = [];

    const containerNames = await this.discoverLabeledContainerNames(instance);
    if (containerNames.length === 0) {
      throw new Error(
        `lifecycle.post-reboot-recovery expected at least one Docker container labeled ` +
          `'${OPENSHELL_SANDBOX_NAME_LABEL}=${instance.sandboxName}', but docker ps -a returned none. ` +
          `Did onboarding create the sandbox?`,
      );
    }
    const originalName = containerNames[0];

    const stop = await this.host.command("docker", ["stop", originalName], {
      artifactName: `lifecycle-post-reboot-docker-stop-${originalName}`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
    });
    assertExitZero(stop, `docker stop ${originalName}`);
    steps.push({ id: `docker-stop:${originalName}`, results: [stop] });
    this.cleanup.add(`lifecycle.docker-start:${originalName}`, async () => {
      await this.host.command("docker", ["start", originalName], {
        artifactName: `lifecycle-cleanup-docker-start-${originalName}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
      });
    });

    if (mode === "rename-to-gpu-backup") {
      const backupName = buildBackupContainerName(originalName, Date.now());
      const rename = await this.host.command("docker", ["rename", originalName, backupName], {
        artifactName: `lifecycle-post-reboot-docker-rename-${originalName}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
      });
      assertExitZero(rename, `docker rename ${originalName} ${backupName}`);
      steps.push({ id: `docker-rename:${originalName}->${backupName}`, results: [rename] });
      this.cleanup.add(`lifecycle.docker-rename-back:${backupName}`, async () => {
        await this.host.command("docker", ["rename", backupName, originalName], {
          artifactName: `lifecycle-cleanup-docker-rename-back-${backupName}`,
          env: buildAvailabilityProbeEnv(),
          timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
        });
      });
    }

    // Final step: drive the user-visible action that exposed #4423.
    // We invoke status through the host CLI client so artifacts are
    // captured and the command goes through the same
    // shellProbe/redaction layer the rest of the fixture code uses.
    // Status is allowed to fail (exit non-zero) because on unfixed
    // code it intentionally fails after destroying state — the
    // post-action invariants are checked by state-validation.
    const statusResult = await this.host.nemoclaw([instance.sandboxName, "status"], {
      artifactName: `lifecycle-post-reboot-nemoclaw-status-${instance.sandboxName}`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    steps.push({ id: `nemoclaw-status:${instance.sandboxName}`, results: [statusResult] });

    return { profile: "post-reboot-recovery", steps };
  }

  private async discoverLabeledContainerNames(instance: NemoClawInstance): Promise<string[]> {
    const result = await this.host.command(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${instance.sandboxName}`,
        "--format",
        "{{.Names}}",
      ],
      {
        artifactName: `lifecycle-post-reboot-docker-discover-${instance.sandboxName}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `lifecycle.post-reboot-recovery could not query Docker for label ` +
          `'${OPENSHELL_SANDBOX_NAME_LABEL}=${instance.sandboxName}' (exit ${result.exitCode}).`,
      );
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }
}

// Mirror of `MAX_DOCKER_CONTAINER_NAME_LENGTH` in
// `src/lib/onboard/docker-gpu-patch.ts`.
const MAX_DOCKER_CONTAINER_NAME_LENGTH = 253;

export function buildBackupContainerName(originalName: string, nowMs: number): string {
  const suffix = `-nemoclaw-gpu-backup-${String(nowMs)}`;
  const maxOriginalLength = MAX_DOCKER_CONTAINER_NAME_LENGTH - suffix.length;
  return `${originalName.slice(0, Math.max(1, maxOriginalLength))}${suffix}`;
}
