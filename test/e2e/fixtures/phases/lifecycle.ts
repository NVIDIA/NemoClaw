// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";

import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import { assertExitZero, outputContainsReadySandbox } from "../clients/command.ts";
import type { GatewayClient, HostGatewayRuntime } from "../clients/gateway.ts";
import type { HostCliClient } from "../clients/host.ts";
import type { SandboxClient } from "../clients/sandbox.ts";
import { RuntimeProviderPrerequisite } from "../runtime-provider.ts";
import type { ShellProbeResult } from "../shell-probe.ts";
import {
  type DcodeInvalidCredentialRebuildOptions,
  isDcodeInvalidCredentialRebuildOptions,
  simulateDcodeInvalidCredentialRebuild,
} from "./lifecycle-dcode-invalid-credential.ts";
import type { NemoClawInstance } from "./onboarding.ts";

export {
  type DcodeInvalidCredentialRebuildOptions,
  dcodeInvalidCredentialRebuildOptionsFromRegistryEntry,
} from "./lifecycle-dcode-invalid-credential.ts";

// Mirror of `OPENSHELL_SANDBOX_NAME_LABEL` in
// `src/lib/onboard/docker-gpu-patch.ts`. Duplicated here because the
// fixture layer must not import from `src/lib/**` (CLI source) — that
// boundary keeps the live runner honest about probing only host-
// observable state. Drift is caught by the integration test that wires
// a real onboarded sandbox through the docker-sandbox-container-present
// probe.
const OPENSHELL_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";
const RUNTIME_PROBE_TIMEOUT_MS = 15_000;
// Recovery can take several minutes while gateway and host-forward
// readiness converge, so keep the status budget generous.
const STATUS_TIMEOUT_MS = 5 * 60_000;
const REBUILD_TIMEOUT_MS = 20 * 60_000;
const SANDBOX_READY_ATTEMPTS = 30;
const SANDBOX_READY_DELAY_MS = 5_000;
const USER_SERVICE_UNAVAILABLE_EXIT = 75;
const NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE =
  "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1";
const NEMOCLAW_INSTALLER = fileURLToPath(
  new URL("../../../../scripts/install.sh", import.meta.url),
);
const NEMOCLAW_OPENSHELL_INSTALLER = fileURLToPath(
  new URL("../../../../scripts/install-openshell.sh", import.meta.url),
);
const USER_SERVICE_STAGE_RESULT_PREFIX = "NEMOCLAW_E2E_GATEWAY_USER_SERVICE=";

type UserServiceStageResult = "upstream" | "existing" | "staged";

export function buildOpenShellGatewayUserServiceStageScript(): string {
  return [
    "set -eu",
    `marker='${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE}'`,
    `result_prefix='${USER_SERVICE_STAGE_RESULT_PREFIX}'`,
    "installer=$1",
    `if [ "$(uname -s)" != Linux ]; then exit ${USER_SERVICE_UNAVAILABLE_EXIT}; fi`,
    `if ! command -v systemctl >/dev/null 2>&1; then exit ${USER_SERVICE_UNAVAILABLE_EXIT}; fi`,
    'case "${XDG_CONFIG_HOME:-}" in',
    '  /*) config_home="$XDG_CONFIG_HOME" ;;',
    '  *) config_home="$HOME/.config" ;;',
    "esac",
    'unit="$config_home/systemd/user/nemoclaw-openshell-gateway.service"',
    "had_marked_unit=0",
    'if [ -f "$unit" ] && grep -Fxq "$marker" "$unit"; then had_marked_unit=1; fi',
    "created=0",
    "cleanup_failed_stage() {",
    "  status=$?",
    "  trap - EXIT",
    '  if [ "$status" -ne 0 ] && [ "$created" -eq 1 ] && [ ! -L "$unit" ] && [ -f "$unit" ] && grep -Fxq "$marker" "$unit"; then',
    '    rm -f -- "$unit"',
    "    systemctl --user daemon-reload >/dev/null 2>&1 || true",
    "  fi",
    "  if declare -F _global_cleanup >/dev/null 2>&1; then _global_cleanup; fi",
    '  exit "$status"',
    "}",
    "trap cleanup_failed_stage EXIT",
    'if [ ! -f "$installer" ] || [ -L "$installer" ]; then',
    '  printf "NemoClaw installer is unavailable: %s\\n" "$installer" >&2',
    "  exit 1",
    "fi",
    'source "$installer"',
    "trap cleanup_failed_stage EXIT",
    'if [ "$had_marked_unit" -eq 0 ]; then created=1; fi',
    "install_nemoclaw_openshell_gateway_user_service",
    "systemctl --user daemon-reload",
    "if systemctl --user cat openshell-gateway >/dev/null 2>&1; then",
    `  printf '%s%s\\n' "$result_prefix" upstream`,
    "  trap - EXIT",
    "  exit 0",
    "fi",
    `if [ ! -f "$unit" ] || ! grep -Fxq "$marker" "$unit"; then exit ${USER_SERVICE_UNAVAILABLE_EXIT}; fi`,
    'if [ "$had_marked_unit" -eq 0 ]; then outcome=staged; else outcome=existing; fi',
    "systemctl --user enable nemoclaw-openshell-gateway >/dev/null",
    `printf '%s%s\\n' "$result_prefix" "$outcome"`,
    "trap - EXIT",
  ].join("\n");
}

export function buildOpenShellGatewayUserServiceRemovalScript(): string {
  return [
    "set -eu",
    `marker='${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE}'`,
    'case "${XDG_CONFIG_HOME:-}" in',
    '  /*) config_home="$XDG_CONFIG_HOME" ;;',
    '  *) config_home="$HOME/.config" ;;',
    "esac",
    'unit="$config_home/systemd/user/nemoclaw-openshell-gateway.service"',
    'if [ ! -e "$unit" ] && [ ! -L "$unit" ]; then exit 0; fi',
    'if [ -L "$unit" ] || [ ! -f "$unit" ] || ! grep -Fxq "$marker" "$unit"; then',
    '  printf "Refusing to remove foreign OpenShell gateway user service: %s\\n" "$unit" >&2',
    "  exit 1",
    "fi",
    "systemctl --user stop nemoclaw-openshell-gateway",
    "systemctl --user disable nemoclaw-openshell-gateway >/dev/null",
    'rm -f -- "$unit"',
    "systemctl --user daemon-reload",
  ].join("\n");
}

export function buildOpenShellGatewayUserServiceRestartScript(): string {
  return [
    "set -eu",
    'if [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1 && brew list --formula openshell >/dev/null 2>&1; then',
    '  brew info --json=v2 openshell | grep -Eq \'"tap"[[:space:]]*:[[:space:]]*"nvidia/openshell"\' || exit 1',
    "  brew services restart openshell",
    "  exit 0",
    "fi",
    `if ! command -v systemctl >/dev/null 2>&1; then exit ${USER_SERVICE_UNAVAILABLE_EXIT}; fi`,
    "service=openshell-gateway",
    'if ! systemctl --user cat "$service" >/dev/null 2>&1; then',
    '  case "${XDG_CONFIG_HOME:-}" in',
    '    /*) config_home="$XDG_CONFIG_HOME" ;;',
    '    *) config_home="$HOME/.config" ;;',
    "  esac",
    '  unit="$config_home/systemd/user/nemoclaw-openshell-gateway.service"',
    `  if [ ! -f "$unit" ]; then exit ${USER_SERVICE_UNAVAILABLE_EXIT}; fi`,
    `  grep -Fxq '${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE}' "$unit" || exit ${USER_SERVICE_UNAVAILABLE_EXIT}`,
    "  service=nemoclaw-openshell-gateway",
    "fi",
    'systemctl --user is-enabled "$service" >/dev/null',
    "systemctl --user daemon-reload",
    'systemctl --user restart "$service"',
  ].join("\n");
}

export function buildOpenShellGatewayUserServiceDiagnosticsScript(): string {
  return [
    "set +e",
    "service=openshell-gateway",
    'if ! systemctl --user cat "$service" >/dev/null 2>&1; then',
    "  service=nemoclaw-openshell-gateway",
    "fi",
    'printf "OpenShell gateway user service: %s\\n" "$service"',
    'systemctl --user show "$service" --no-pager --property=ActiveState --property=SubState --property=Result --property=ExecMainCode --property=ExecMainStatus',
    'systemctl --user status "$service" --no-pager --full',
    "if command -v journalctl >/dev/null 2>&1; then",
    '  journalctl --user --unit "$service" --no-pager --lines=200',
    "fi",
    "exit 0",
  ].join("\n");
}

export type LifecycleProfile = "post-reboot-recovery" | "dcode-rebuild-invalid-credential";

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

export type LifecycleSimulationOptions = PostRebootOptions | DcodeInvalidCredentialRebuildOptions;

export interface LifecycleResult {
  profile: LifecycleProfile;
  steps: Array<{ id: string; results: ShellProbeResult[] }>;
}

export interface RebuildSandboxOptions {
  artifactName?: string;
  env?: NodeJS.ProcessEnv;
  redactionValues?: string[];
  timeoutMs?: number;
  verbose?: boolean;
}

export interface SandboxReadyOptions {
  attempts?: number;
  delayMs?: number;
  env?: NodeJS.ProcessEnv;
  artifactNamePrefix?: string;
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function instanceName(instance: NemoClawInstance | string): string {
  const name = typeof instance === "string" ? instance : instance.sandboxName;
  return name;
}

export class LifecyclePhaseFixture {
  private postRebootUserServiceStage: UserServiceStageResult | undefined;
  private readonly runtimeProvider: RuntimeProviderPrerequisite;

  constructor(
    private readonly host: HostCliClient,
    private readonly sandbox: SandboxClient,
    private readonly cleanup: LifecycleCleanup,
    private readonly gateway?: GatewayClient,
    runtimeProvider?: RuntimeProviderPrerequisite,
  ) {
    this.runtimeProvider =
      runtimeProvider ??
      new RuntimeProviderPrerequisite(host, (reason) => {
        throw new Error(reason);
      });
  }

  private requireRuntimeProvider(): RuntimeProviderPrerequisite {
    return this.runtimeProvider;
  }

  /**
   * Ensure OpenShell is installed and stage the OpenShell gateway user service
   * before onboarding. Onboarding must see the service so it writes the
   * Docker-driver environment that the unit needs after a user-manager restart.
   */
  async preparePostReboot(): Promise<UserServiceStageResult> {
    if (this.postRebootUserServiceStage) return this.postRebootUserServiceStage;

    if (!(await this.host.isCommandAvailable("openshell-gateway"))) {
      const install = await this.host.command("bash", [NEMOCLAW_OPENSHELL_INSTALLER], {
        artifactName: "lifecycle-prereq-install-openshell",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 10 * 60_000,
      });
      assertExitZero(install, "install OpenShell before reboot lifecycle onboarding");
    }

    const stage = await this.ensureOpenShellGatewayUserService();
    this.postRebootUserServiceStage = stage;
    if (stage === "staged") {
      this.cleanup.add("lifecycle.remove-staged-gateway-user-service", async () => {
        await this.removeStagedOpenShellGatewayUserService();
      });
    }
    return stage;
  }

  async rebuildSandbox(
    instance: NemoClawInstance | string,
    options: RebuildSandboxOptions = {},
  ): Promise<ShellProbeResult> {
    const sandboxName = instanceName(instance);
    const args = [sandboxName, "rebuild", "--yes"];
    if (options.verbose) args.push("--verbose");
    const result = await this.host.nemoclaw(args, {
      artifactName: options.artifactName ?? `lifecycle-rebuild-${sandboxName}`,
      env: {
        ...buildAvailabilityProbeEnv(),
        ...(options.env ?? {}),
      },
      redactionValues: options.redactionValues,
      timeoutMs: options.timeoutMs ?? REBUILD_TIMEOUT_MS,
    });
    assertExitZero(result, `nemoclaw ${sandboxName} rebuild --yes`);
    return result;
  }

  async assertSandboxReadyAfterRebuild(
    instance: NemoClawInstance | string,
    options: SandboxReadyOptions = {},
  ): Promise<ShellProbeResult> {
    return await this.waitForSandboxReady(instance, options, "after rebuild");
  }

  async assertSandboxReadyAfterGatewayRestart(
    instance: NemoClawInstance | string,
    options: SandboxReadyOptions = {},
  ): Promise<ShellProbeResult> {
    return await this.waitForSandboxReady(instance, options, "after gateway restart");
  }

  private async waitForSandboxReady(
    instance: NemoClawInstance | string,
    options: SandboxReadyOptions,
    transition: "after rebuild" | "after gateway restart" | "after the boot restart",
  ): Promise<ShellProbeResult> {
    const sandboxName = instanceName(instance);
    const attempts = options.attempts ?? SANDBOX_READY_ATTEMPTS;
    const delayMs = options.delayMs ?? SANDBOX_READY_DELAY_MS;
    const env = { ...buildAvailabilityProbeEnv(), ...(options.env ?? {}) };
    let last: ShellProbeResult | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const artifactPrefix = options.artifactNamePrefix ?? `lifecycle-rebuild-ready-${sandboxName}`;
      last = await this.sandbox.list({
        artifactName: `${artifactPrefix}-${attempt}`,
        env,
        timeoutMs: options.timeoutMs ?? 30_000,
      });
      if (last.exitCode === 0 && outputContainsReadySandbox(last, sandboxName)) {
        return last;
      }
      if (attempt < attempts) await sleep(delayMs);
    }
    const detail = last ? `${last.stdout}\n${last.stderr}`.trim() : "no probe result";
    throw new Error(
      `sandbox ${sandboxName} did not become Ready ${transition} within ${attempts} attempts: ${detail}`,
    );
  }

  async simulate(
    profile: LifecycleProfile,
    instance: NemoClawInstance,
    options: LifecycleSimulationOptions = {},
  ): Promise<LifecycleResult> {
    switch (profile) {
      case "post-reboot-recovery":
        return await this.simulatePostReboot(instance, options as PostRebootOptions);
      case "dcode-rebuild-invalid-credential":
        if (!isDcodeInvalidCredentialRebuildOptions(options)) {
          throw new Error(
            "dcode-rebuild-invalid-credential requires gateway/provider/credential/model options",
          );
        }
        return await simulateDcodeInvalidCredentialRebuild(instance, options, {
          host: this.host,
          sandbox: this.sandbox,
          cleanup: this.cleanup,
        });
      default: {
        const _exhaustive: never = profile;
        throw new Error(`Unsupported lifecycle profile '${_exhaustive}'.`);
      }
    }
  }

  /**
   * Reproduce the host-side conditions of a Linux Docker-driver reboot and
   * drive the user-visible action that exposes reboot recovery bugs:
   *
   *   1. Locate the OpenShell-labeled Docker container for the
   *      target's sandbox name and either stop it (default) or
   *      stop+rename it to a `*-nemoclaw-gpu-backup-*` sibling.
   *      The gateway runtime is stopped and restarted through the
   *      selected OpenShell user service, which mirrors a reboot or
   *      user-manager restart. This target requires either the upstream
   *      `openshell-gateway` service or the marked
   *      `nemoclaw-openshell-gateway` service.
   *
   *   2. Model the Docker daemon's boot-owned container restart. Wait until
   *      the OpenShell gateway reports the preserved sandbox Ready.
   *
   *   3. Invoke `nemoclaw <name> status` — the user-visible action
   *      that documented the regression in #4423. On unfixed `main`
   *      the destructive `missing` branch in `status.ts` wipes the
   *      registry entry. Status must also restore the OpenClaw gateway
   *      and host forward before it exits successfully.
   *
   *   The final status must exit zero to verify the restored sandbox
   *   delivery path. The state-validation phase that follows additionally
   *   verifies preservation through the
   *   `local-registry-entry-present` and `docker-sandbox-container-present`
   *   probes.
   *
   * Cleanups (run in reverse order at end of test):
   *   - rename the backup sibling back to the original name (if we
   *     created one);
   *   - `docker start` the labeled container so the sandbox returns
   *     to a usable state for any teardown that expects it live;
   *   - remove a user service staged only for this source-checkout
   *     fixture after the sandbox cleanup has used it.
   */
  async simulatePostReboot(
    instance: NemoClawInstance,
    options: PostRebootOptions = {},
  ): Promise<LifecycleResult> {
    if (!this.postRebootUserServiceStage) {
      throw new Error(
        "OpenShell gateway user service must be prepared before post-reboot onboarding.",
      );
    }
    const mode: PostRebootMode = options.mode ?? "stop-original";
    const steps: LifecycleResult["steps"] = [];

    const containerNames = await this.discoverLabeledContainerNames(instance);
    if (containerNames.length === 0) {
      throw new Error(
        `lifecycle.post-reboot-recovery expected at least one managed runtime resource labeled ` +
          `'${OPENSHELL_SANDBOX_NAME_LABEL}=${instance.sandboxName}', but the selected provider returned none. ` +
          `Did onboarding create the sandbox?`,
      );
    }
    const originalName = containerNames[0];
    let bootContainerName = originalName;

    const stop = await this.requireRuntimeProvider().command(["container", "stop", originalName], {
      artifactName: `lifecycle-post-reboot-runtime-stop-${originalName}`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: RUNTIME_PROBE_TIMEOUT_MS,
    });
    assertExitZero(stop, `stop managed runtime resource ${originalName}`);
    steps.push({ id: `runtime-stop:${originalName}`, results: [stop] });
    this.cleanup.add(`lifecycle.runtime-start:${originalName}`, async () => {
      await this.requireRuntimeProvider().command(["container", "start", originalName], {
        artifactName: `lifecycle-cleanup-runtime-start-${originalName}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: RUNTIME_PROBE_TIMEOUT_MS,
      });
    });

    if (mode === "rename-to-gpu-backup") {
      const backupName = buildBackupContainerName(originalName, Date.now());
      const rename = await this.requireRuntimeProvider().command(
        ["container", "rename", originalName, backupName],
        {
          artifactName: `lifecycle-post-reboot-runtime-rename-${originalName}`,
          env: buildAvailabilityProbeEnv(),
          timeoutMs: RUNTIME_PROBE_TIMEOUT_MS,
        },
      );
      assertExitZero(rename, `rename managed runtime resource ${originalName} ${backupName}`);
      steps.push({
        id: `runtime-rename:${originalName}->${backupName}`,
        results: [rename],
      });
      bootContainerName = backupName;
      this.cleanup.add(`lifecycle.runtime-rename-back:${backupName}`, async () => {
        await this.requireRuntimeProvider().command(
          ["container", "rename", backupName, originalName],
          {
            artifactName: `lifecycle-cleanup-runtime-rename-back-${backupName}`,
            env: buildAvailabilityProbeEnv(),
            timeoutMs: RUNTIME_PROBE_TIMEOUT_MS,
          },
        );
      });
    }

    const previousRuntime = await this.restartGatewayRuntime({
      delayMs: 0,
      requireUserService: true,
      sandboxName: instance.sandboxName,
    });
    steps.push({
      id: `gateway-restart:${previousRuntime?.kind ?? "user-service"}`,
      results: [],
    });
    await this.waitForGatewayConnected();
    steps.push({ id: "gateway-connected:nemoclaw", results: [] });

    // `docker stop` suppresses Docker restart-policy handling until the
    // daemon restarts. Start the same container here to model that boot-owned
    // transition without restarting the GitHub-hosted runner's Docker daemon.
    const bootStart = await this.requireRuntimeProvider().command(
      ["container", "start", bootContainerName],
      {
        artifactName: `lifecycle-post-reboot-runtime-start-${bootContainerName}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: RUNTIME_PROBE_TIMEOUT_MS,
      },
    );
    assertExitZero(bootStart, `start managed runtime resource ${bootContainerName}`);
    steps.push({
      id: `runtime-boot-start:${bootContainerName}`,
      results: [bootStart],
    });

    const ready = await this.waitForSandboxReady(
      instance,
      {
        artifactNamePrefix: `lifecycle-post-reboot-ready-${instance.sandboxName}`,
      },
      "after the boot restart",
    );
    steps.push({
      id: `sandbox-ready-after-boot:${instance.sandboxName}`,
      results: [ready],
    });

    // `nemoclaw <name> status` owns the post-reboot delivery-chain recovery.
    // It must restore OpenClaw and the host forward without invoking `nemoclaw <name> start`.
    const statusResult = await this.host.expectStatus(instance.sandboxName, {
      artifactName: `lifecycle-post-reboot-nemoclaw-status-${instance.sandboxName}`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    steps.push({
      id: `nemoclaw-status:${instance.sandboxName}`,
      results: [statusResult],
    });

    return { profile: "post-reboot-recovery", steps };
  }

  private async ensureOpenShellGatewayUserService(): Promise<UserServiceStageResult> {
    const result = await this.host.command(
      "bash",
      [
        "-lc",
        buildOpenShellGatewayUserServiceStageScript(),
        "stage-nemoclaw-openshell-gateway-service",
        NEMOCLAW_INSTALLER,
      ],
      {
        artifactName: "lifecycle-gateway-user-service-stage",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      },
    );
    assertExitZero(result, "stage OpenShell gateway user service for reboot lifecycle");
    const match = result.stdout.match(
      new RegExp(
        `(?:^|\\n)${USER_SERVICE_STAGE_RESULT_PREFIX}(upstream|existing|staged)(?:\\n|$)`,
        "u",
      ),
    );
    if (!match) {
      throw new Error("OpenShell gateway user service staging did not report its outcome.");
    }
    return match[1] as UserServiceStageResult;
  }

  private async removeStagedOpenShellGatewayUserService(): Promise<void> {
    const result = await this.host.command(
      "sh",
      ["-lc", buildOpenShellGatewayUserServiceRemovalScript()],
      {
        artifactName: "lifecycle-cleanup-gateway-user-service",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      },
    );
    assertExitZero(result, "remove staged OpenShell gateway user service");
  }

  async stopGatewayRuntime(): Promise<HostGatewayRuntime | null> {
    const runtime = (await this.gateway?.resolveHostRuntime()) ?? null;
    await this.host.command(
      "sh",
      ["-lc", "command -v openshell >/dev/null 2>&1 && openshell forward stop 18789 || true"],
      {
        artifactName: "lifecycle-gateway-forward-stop",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    await this.host.command(
      "sh",
      ["-lc", "command -v openshell >/dev/null 2>&1 && openshell gateway stop -g nemoclaw || true"],
      {
        artifactName: "lifecycle-gateway-stop",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 60_000,
      },
    );

    const pidFileStop = await this.host.command(
      "sh",
      [
        "-lc",
        `pid_file="$HOME/.local/state/nemoclaw/openshell-docker-gateway/openshell-gateway.pid"; ` +
          `if [ -f "$pid_file" ]; then ` +
          `pid="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"; ` +
          `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then ` +
          `kill "$pid" 2>/dev/null || true; ` +
          `for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || exit 0; sleep 1; done; ` +
          `kill -9 "$pid" 2>/dev/null || true; ` +
          `fi; fi`,
      ],
      {
        artifactName: "lifecycle-gateway-pid-stop",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    assertExitZero(pidFileStop, "stop Docker-driver gateway PID");

    // Docker's name filter is a regular-expression substring match unless it
    // is explicitly anchored. The unanchored form can select a sandbox whose
    // name contains the gateway prefix; stopping that container remounts its
    // tmpfs and turns a gateway-restart probe into a sandbox-restart probe.
    const runtimeProvider = this.requireRuntimeProvider();
    const gatewayResources = await runtimeProvider.command(
      ["container", "ps", "--format", "{{.ID}}\t{{.Names}}"],
      {
        artifactName: "lifecycle-gateway-runtime-discover",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 60_000,
      },
    );
    assertExitZero(gatewayResources, "discover OpenShell gateway runtime resource");
    const gatewayHandles = gatewayResources.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u))
      .filter(([, name]) => name === "openshell-cluster-nemoclaw")
      .map(([handle]) => handle)
      .filter((handle): handle is string => Boolean(handle));
    if (gatewayHandles.length > 1) {
      throw new Error("OpenShell gateway runtime resource identity is ambiguous.");
    }
    if (gatewayHandles[0]) {
      const containerStop = await runtimeProvider.command(
        ["container", "stop", gatewayHandles[0]],
        {
          artifactName: "lifecycle-gateway-container-stop",
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 60_000,
        },
      );
      assertExitZero(containerStop, "stop OpenShell gateway runtime resource");
    }
    return runtime;
  }

  async startGatewayRuntime(
    previousRuntime: HostGatewayRuntime | null,
    options: { requireUserService?: boolean; sandboxName?: string } = {},
  ): Promise<ShellProbeResult> {
    if (options.sandboxName && options.requireUserService !== true) {
      return await this.host.nemoclaw([options.sandboxName, "status"], {
        artifactName: `lifecycle-gateway-recover-through-nemoclaw-status-${options.sandboxName}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      });
    }
    const userServiceStart = await this.startOpenShellGatewayUserService({
      requireAvailable: options.requireUserService,
    });
    if (userServiceStart) return userServiceStart;
    if (options.sandboxName) {
      return await this.host.nemoclaw([options.sandboxName, "status"], {
        artifactName: `lifecycle-gateway-recover-through-nemoclaw-status-${options.sandboxName}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      });
    }
    if (previousRuntime?.kind === "pid") {
      return await this.host.nemoclaw(["status"], {
        artifactName: "lifecycle-gateway-recover-through-nemoclaw-status",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      });
    }
    return await this.host.command("openshell", ["gateway", "start", "--name", "nemoclaw"], {
      artifactName: "lifecycle-gateway-start",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 120_000,
    });
  }

  private async startOpenShellGatewayUserService(options: {
    requireAvailable?: boolean;
  }): Promise<ShellProbeResult | null> {
    const result = await this.host.command(
      "sh",
      ["-lc", buildOpenShellGatewayUserServiceRestartScript()],
      {
        artifactName: "lifecycle-gateway-user-service-restart",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      },
    );
    if (result.exitCode === 0) return result;
    if (result.exitCode === USER_SERVICE_UNAVAILABLE_EXIT && !options.requireAvailable) {
      return null;
    }
    if (result.exitCode === USER_SERVICE_UNAVAILABLE_EXIT) {
      throw new Error(
        `OpenShell gateway user service is not available for reboot lifecycle recovery.`,
      );
    }
    throw new Error(
      `OpenShell gateway user service restart failed during reboot lifecycle: ` +
        `${result.stderr || result.stdout || `exit ${String(result.exitCode)}`}`,
    );
  }

  async restartGatewayRuntime(
    options: { delayMs?: number; requireUserService?: boolean; sandboxName?: string } = {},
  ): Promise<HostGatewayRuntime | null> {
    const previousRuntime = await this.stopGatewayRuntime();
    if (this.gateway) {
      await this.gateway.expectHostRuntimeStopped({
        artifactName: "lifecycle-gateway-stopped",
      });
    }
    const delayMs = options.delayMs ?? 5_000;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    await this.startGatewayRuntime(previousRuntime, {
      requireUserService: options.requireUserService,
      sandboxName: options.sandboxName,
    });
    return previousRuntime;
  }

  async waitForGatewayConnected(
    options: { attempts?: number; intervalMs?: number } = {},
  ): Promise<void> {
    const attempts = options.attempts ?? 60;
    const intervalMs = options.intervalMs ?? 5_000;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        if (this.gateway) {
          await this.gateway.expectOpenshellStatusConnected("nemoclaw", {
            artifactName: `lifecycle-gateway-health-${attempt}`,
          });
          return;
        }
        const status = await this.host.command("openshell", ["status"], {
          artifactName: `lifecycle-gateway-health-${attempt}`,
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 30_000,
        });
        assertExitZero(status, "openshell status");
        if (/connected/i.test(`${status.stdout}\n${status.stderr}`)) return;
      } catch (error) {
        lastError = error;
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    const diagnostics = await this.host.command(
      "sh",
      ["-lc", buildOpenShellGatewayUserServiceDiagnosticsScript()],
      {
        artifactName: "lifecycle-gateway-user-service-diagnostics",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    throw new Error(
      `gateway did not become healthy after restart: ${
        lastError instanceof Error ? lastError.message : String(lastError ?? "unknown")
      }; service diagnostics: ${diagnostics.artifacts.result}`,
    );
  }

  private async discoverLabeledContainerNames(instance: NemoClawInstance): Promise<string[]> {
    const result = await this.requireRuntimeProvider().command(
      [
        "container",
        "ps",
        "--all",
        "--filter",
        `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${instance.sandboxName}`,
        "--format",
        "{{.Names}}",
      ],
      {
        artifactName: `lifecycle-post-reboot-runtime-discover-${instance.sandboxName}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: RUNTIME_PROBE_TIMEOUT_MS,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `lifecycle.post-reboot-recovery could not query the selected runtime provider for label ` +
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
