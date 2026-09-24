// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import { buildGatewayRuntimeStartScript } from "../gateway-runtime-start.ts";
import { REPO_ROOT } from "../paths.ts";
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

const REBUILD_TIMEOUT_MS = 20 * 60_000;
const SANDBOX_READY_ATTEMPTS = 30;
const SANDBOX_READY_DELAY_MS = 5_000;
const USER_SERVICE_UNAVAILABLE_EXIT = 75;
const NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE =
  "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1";
const NEMOCLAW_INSTALLER = fileURLToPath(
  new URL("../../../../scripts/install.sh", import.meta.url),
);
const USER_SERVICE_STAGE_RESULT_PREFIX = "NEMOCLAW_E2E_GATEWAY_USER_SERVICE=";
const USER_SERVICE_STOP_RESULT_PREFIX = "NEMOCLAW_E2E_STOPPED_GATEWAY_USER_SERVICE=";

type UserServiceSelection =
  | "homebrew:homebrew.mxcl.openshell"
  | "homebrew:sh.brew.openshell"
  | "systemd:nemoclaw-openshell-gateway.service"
  | "systemd:openshell-gateway.service";

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

export function buildOpenShellGatewayUserServiceStopScript(): string {
  return [
    "set -eu",
    "installer=$1",
    'if [ ! -f "$installer" ] || [ -L "$installer" ]; then',
    '  printf "NemoClaw installer is unavailable: %s\\n" "$installer" >&2',
    "  exit 1",
    "fi",
    'source "$installer"',
    "selection=",
    "if stop_active_openshell_gateway_user_service selection; then",
    '  case "$selection" in',
    "    homebrew:homebrew.mxcl.openshell|homebrew:sh.brew.openshell|systemd:nemoclaw-openshell-gateway.service|systemd:openshell-gateway.service|unavailable) ;;",
    "    *) exit 1 ;;",
    "  esac",
    `  printf '%s%s\\n' '${USER_SERVICE_STOP_RESULT_PREFIX}' "$selection"`,
    "  exit 0",
    "else",
    "  status=$?",
    `  if [ "$status" -eq 1 ]; then exit ${USER_SERVICE_UNAVAILABLE_EXIT}; fi`,
    '  exit "$status"',
    "fi",
  ].join("\n");
}

export function buildOpenShellGatewayUserServiceRestartScript(): string {
  return [
    "set -eu",
    "installer=$1",
    "selection=$2",
    'if [ ! -f "$installer" ] || [ -L "$installer" ]; then',
    '  printf "NemoClaw installer is unavailable: %s\\n" "$installer" >&2',
    "  exit 1",
    "fi",
    'source "$installer"',
    'restart_selected_openshell_gateway_user_service "$selection"',
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

export type LifecycleProfile = "dcode-rebuild-invalid-credential";

export interface LifecycleCleanup {
  add(name: string, run: () => Promise<void> | void): void;
}

export type LifecycleSimulationOptions = DcodeInvalidCredentialRebuildOptions;

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
  private readonly runtimeProvider: RuntimeProviderPrerequisite;
  private stoppedOpenShellGatewayUserService: UserServiceSelection | null = null;

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

  trackInstallerGatewayUserService(): void {
    const env = buildAvailabilityProbeEnv();
    const configured = env.XDG_CONFIG_HOME;
    const configHome =
      configured && path.isAbsolute(configured)
        ? configured
        : path.join(env.HOME ?? os.homedir(), ".config");
    const unit = path.join(configHome, "systemd", "user", "nemoclaw-openshell-gateway.service");
    try {
      fs.lstatSync(unit);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.cleanup.add("lifecycle.remove-installer-gateway-user-service", () =>
      this.removeStagedOpenShellGatewayUserService(env),
    );
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

  async waitForSandboxReadyAfterGatewayRestart(
    instance: NemoClawInstance | string,
    options: SandboxReadyOptions = {},
  ): Promise<ShellProbeResult> {
    return await this.waitForSandboxReady(instance, options, "after gateway restart");
  }

  private async waitForSandboxReady(
    instance: NemoClawInstance | string,
    options: SandboxReadyOptions,
    transition: "after rebuild" | "after gateway restart",
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
    options?: LifecycleSimulationOptions,
  ): Promise<LifecycleResult> {
    switch (profile) {
      case "dcode-rebuild-invalid-credential":
        if (!options || !isDcodeInvalidCredentialRebuildOptions(options)) {
          throw new Error(
            "dcode-rebuild-invalid-credential requires gateway/provider/credential/model options",
          );
        }
        return await simulateDcodeInvalidCredentialRebuild(instance, options, {
          host: this.host,
          sandbox: this.sandbox,
          cleanup: this.cleanup,
          runtimeProvider: this.requireRuntimeProvider(),
        });
      default: {
        const _exhaustive: never = profile;
        throw new Error(`Unsupported lifecycle profile '${_exhaustive}'.`);
      }
    }
  }

  private async removeStagedOpenShellGatewayUserService(
    env = buildAvailabilityProbeEnv(),
  ): Promise<void> {
    const result = await this.host.command(
      "sh",
      ["-lc", buildOpenShellGatewayUserServiceRemovalScript()],
      {
        artifactName: "lifecycle-cleanup-gateway-user-service",
        env,
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
    if (await this.stopOpenShellGatewayUserService()) return runtime;

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

  private async stopOpenShellGatewayUserService(): Promise<boolean> {
    const pendingSelection = this.stoppedOpenShellGatewayUserService;
    const result = await this.host.command(
      "bash",
      [
        "-c",
        buildOpenShellGatewayUserServiceStopScript(),
        "stop-openshell-gateway-user-service",
        NEMOCLAW_INSTALLER,
      ],
      {
        artifactName: "lifecycle-gateway-user-service-stop",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      },
    );
    if (result.exitCode === 0) {
      const match = result.stdout.match(
        new RegExp(
          `(?:^|\\n)${USER_SERVICE_STOP_RESULT_PREFIX}` +
            `(homebrew:(?:homebrew\\.mxcl|sh\\.brew)\\.openshell|systemd:nemoclaw-openshell-gateway\\.service|systemd:openshell-gateway\\.service|unavailable)(?:\\n|$)`,
          "u",
        ),
      );
      if (!match) {
        throw new Error("OpenShell gateway user service stop did not report its selection.");
      }
      if (match[1] === "unavailable") return pendingSelection !== null;
      const selection = match[1] as UserServiceSelection;
      this.stoppedOpenShellGatewayUserService = selection;
      this.cleanup.add(`lifecycle.gateway-user-service-restart:${selection}`, async () => {
        if (this.stoppedOpenShellGatewayUserService !== selection) return;
        await this.startOpenShellGatewayUserService({ requireAvailable: true });
      });
      return true;
    }
    if (result.exitCode === USER_SERVICE_UNAVAILABLE_EXIT) return pendingSelection !== null;
    throw new Error(
      `OpenShell gateway user service stop failed during lifecycle qualification: ` +
        `${result.stderr || result.stdout || `exit ${String(result.exitCode)}`}`,
    );
  }

  async startGatewayRuntime(
    options: { requireUserService?: boolean; sandboxName?: string } = {},
  ): Promise<ShellProbeResult> {
    const userServiceStart = await this.startOpenShellGatewayUserService({
      requireAvailable: options.requireUserService,
    });
    if (userServiceStart) return userServiceStart;
    if (!options.sandboxName?.trim()) {
      throw new Error("Gateway recovery requires the registered sandbox name.");
    }
    // The fixture knows it stopped this gateway. Observational recovery can
    // refuse an unreachable gateway whose identity the CLI cannot report.
    return await this.host.command(
      process.execPath,
      ["-e", buildGatewayRuntimeStartScript(), options.sandboxName],
      {
        artifactName: "lifecycle-gateway-start",
        cwd: REPO_ROOT,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      },
    );
  }

  private async startOpenShellGatewayUserService(options: {
    requireAvailable?: boolean;
  }): Promise<ShellProbeResult | null> {
    if (!this.stoppedOpenShellGatewayUserService) {
      if (!options.requireAvailable) return null;
      throw new Error(
        `OpenShell gateway user service is not available for reboot lifecycle recovery.`,
      );
    }
    const selection = this.stoppedOpenShellGatewayUserService;
    const result = await this.host.command(
      "bash",
      [
        "-c",
        buildOpenShellGatewayUserServiceRestartScript(),
        "restart-openshell-gateway-user-service",
        NEMOCLAW_INSTALLER,
        selection,
      ],
      {
        artifactName: "lifecycle-gateway-user-service-restart",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      },
    );
    if (result.exitCode === 0) {
      this.stoppedOpenShellGatewayUserService = null;
      return result;
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
    if (options.requireUserService !== true && !options.sandboxName?.trim()) {
      throw new Error("Gateway restart requires a sandbox name or a required user service.");
    }
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
    const start = await this.startGatewayRuntime({
      requireUserService: options.requireUserService,
      sandboxName: options.sandboxName,
    });
    assertExitZero(start, "restart OpenShell gateway runtime");
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
}
