// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import type { NemoClawInstance } from "../phases/onboarding.ts";
import { pollUntil } from "../polling.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../shell-probe.ts";
import { RuntimeProviderPrerequisite } from "../runtime-provider.ts";
import { assertExitZero } from "./command.ts";
import type { HostCliClient } from "./host.ts";
import type { SandboxClient } from "./sandbox.ts";

/**
 * Build the env passed to in-sandbox probes via `openshell sandbox exec`.
 *
 * The framework's ShellProbe accepts only an explicit spawned-process env,
 * normally produced through `buildChildEnv`'s allowlist (HOME, PATH, …).
 * `OPENSHELL_GATEWAY` is not in that allowlist, so even when the workflow
 * sets it, raw `openshell sandbox exec` invocations fail with
 * "× No active gateway" because the openshell binary cannot resolve which
 * gateway to talk to. Inject the gateway name read from the test process's
 * env (defaulting to the canonical `nemoclaw` registered by
 * src/lib/actions/sandbox/connect.ts:NEMOCLAW_GATEWAY_NAME) on top of the
 * framework's allowlisted env.
 */
function probeEnv(): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
}

/**
 * Default expected exports inside `/tmp/nemoclaw-proxy-env.sh` that prove the
 * NODE_OPTIONS preload chain is wired. The legacy 2478 test verified guards
 * by reading this file rather than `/proc/<pid>/environ` because
 * `kernel.yama.ptrace_scope=1` blocks cross-tree environ reads. We mirror
 * that approach here for the same reason.
 */
const DEFAULT_GUARD_MARKERS: ReadonlyArray<string> = [
  "nemoclaw-sandbox-safety-net",
  "nemoclaw-ciao-network-guard",
];
const GUARD_CHAIN_PROXY_ENV_PATH = "/tmp/nemoclaw-proxy-env.sh";
const GUARD_CHAIN_ACTIVE_SENTINEL = "NEMOCLAW_GUARD_CHAIN_ACTIVE";
const GUARD_CHAIN_FILE_UNAVAILABLE_EXIT_CODE = 20;
const GUARD_CHAIN_MARKER_MISSING_EXIT_CODE = 21;

/** Default gateway log path inside the sandbox. */
const GATEWAY_LOG_PATH = "/tmp/gateway.log";
const DOCKER_DRIVER_GATEWAY_PID_RELPATH = [
  ".local",
  "state",
  "nemoclaw",
  "openshell-docker-gateway",
  "openshell-gateway.pid",
] as const;
const DEFAULT_GATEWAY_CONTAINER = "openshell-cluster-nemoclaw";

export interface ExpectGuardChainOptions extends ShellProbeRunOptions {
  /** Markers required in `/tmp/nemoclaw-proxy-env.sh`. Defaults to safety-net + ciao. */
  expectedMarkers?: ReadonlyArray<string>;
}

export interface ExpectLogOptions extends ShellProbeRunOptions {
  /** Number of trailing log lines to inspect. Defaults to 200. */
  lines?: number;
}

export interface ExpectPidStableOptions extends ShellProbeRunOptions {
  /** Total observation window in seconds. */
  durationSeconds: number;
  /** Polling interval in seconds. Defaults to 3. */
  pollIntervalSeconds?: number;
}

export interface WaitForMissingManagedSupervisorOptions {
  attempts?: number;
  delayMs?: number;
  settleMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (attempt: number) => void;
}

export interface GatewayProcessIdentity {
  pid: number;
  startIdentity: string;
}

export interface HostGatewayRuntime {
  kind: "pid" | "container";
  id: string;
}

function isMissingManagedSupervisorProof(result: ShellProbeResult): boolean {
  const stderrLines = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    result.exitCode === 1 &&
    result.timedOut === false &&
    result.signal === null &&
    result.stdout.trim() === "" &&
    stderrLines.length === 1 &&
    stderrLines[0] === "SUPERVISOR_NOT_RUNNING"
  );
}

export class GatewayClient {
  private readonly host: HostCliClient;
  private readonly sandbox: SandboxClient;
  private readonly runtimeProvider: RuntimeProviderPrerequisite;

  constructor(
    host: HostCliClient,
    sandbox: SandboxClient,
    runtimeProvider?: RuntimeProviderPrerequisite,
  ) {
    this.host = host;
    this.sandbox = sandbox;
    this.runtimeProvider =
      runtimeProvider ??
      new RuntimeProviderPrerequisite(host, (reason) => {
        throw new Error(reason);
      });
  }

  status(options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    return this.host.nemoclaw(["gateway", "status"], {
      artifactName: "gateway-status",
      ...options,
    });
  }

  async expectHealthy(options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    const result = await this.status(options);
    assertExitZero(result, "nemoclaw gateway status");
    return result;
  }

  async resolveHostRuntime(): Promise<HostGatewayRuntime | null> {
    const pid = await this.host.command(
      "sh",
      [
        "-lc",
        `pid_file=\"$HOME/${DOCKER_DRIVER_GATEWAY_PID_RELPATH.join("/")}\"; ` +
          `if [ -f \"$pid_file\" ]; then ` +
          `pid=\"$(tr -d '[:space:]' <\"$pid_file\" 2>/dev/null || true)\"; ` +
          `if [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null; then printf '%s\\n' \"$pid\"; exit 0; fi; ` +
          `fi; exit 1`,
      ],
      {
        artifactName: "gateway-runtime-pid-probe",
        env: probeEnv(),
        timeoutMs: 15_000,
      },
    );
    if (pid.exitCode === 0 && pid.stdout.trim()) {
      return { kind: "pid", id: pid.stdout.trim() };
    }

    const container = await this.runtimeProvider.command(
      ["container", "ps", "--format", "{{.ID}}\t{{.Names}}"],
      {
        artifactName: "gateway-runtime-container-probe",
        env: probeEnv(),
        timeoutMs: 15_000,
      },
    );
    const ids = container.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u))
      .filter(([, name]) => name === DEFAULT_GATEWAY_CONTAINER)
      .map(([id]) => id)
      .filter((id): id is string => Boolean(id));
    if (ids.length > 1) throw new Error("OpenShell gateway runtime identity is ambiguous.");
    const [id] = ids;
    return id ? { kind: "container", id } : null;
  }

  async expectHostRuntimeStopped(options: ShellProbeRunOptions = {}): Promise<void> {
    const runtime = await this.resolveHostRuntime();
    if (runtime) {
      throw new Error(
        `gateway runtime still appears to be running after stop: ${runtime.kind}:${runtime.id}`,
      );
    }
    if (options.artifactName) {
      await this.host.command("true", [], {
        artifactName: options.artifactName,
        env: probeEnv(),
        timeoutMs: 5_000,
      });
    }
  }

  async expectOpenshellStatusConnected(
    gatewayName = "nemoclaw",
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    const result = await this.host.command("openshell", ["status"], {
      artifactName: `openshell-status-${gatewayName}`,
      env: probeEnv(),
      timeoutMs: 30_000,
      ...options,
    });
    assertExitZero(result, "openshell status");
    const text = `${result.stdout}\n${result.stderr}`;
    if (!/connected/i.test(text) || !new RegExp(gatewayName, "i").test(text)) {
      throw new Error(`openshell status did not report connected gateway '${gatewayName}'.`);
    }
    return result;
  }

  /**
   * Wait until the trusted root controller proves that a restarted legacy
   * container has no managed supervisor. This keeps the live E2E recovery test
   * out of the brief process-churn window after OpenShell becomes reachable.
   * The fixture owns this wait because Docker restart and OpenShell readiness
   * can complete before the container process table settles, while production
   * recovery must keep treating uncertain controller output as terminal. Remove
   * the wait when OpenShell readiness guarantees the controller absence proof
   * remains stable across the settle interval.
   */
  async waitForMissingManagedSupervisor(
    containerId: string,
    options: WaitForMissingManagedSupervisorOptions = {},
  ): Promise<void> {
    const attempts = options.attempts ?? 12;
    const delayMs = options.delayMs ?? 3_000;
    const settleMs = options.settleMs ?? delayMs;
    const sleep =
      options.sleep ??
      ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

    await pollUntil({
      artifactPrefix: "legacy-restart-supervisor-absent",
      attempts,
      delayMs,
      sleep,
      probe: async (_attempt, artifactName) => {
        const runProbe = async (name: string) =>
          await this.host.command(
            "docker",
            [
              "exec",
              "--env",
              "LD_PRELOAD=",
              "--env",
              "PYTHONPATH=",
              "--user",
              "root",
              containerId,
              "/usr/local/bin/nemoclaw-gateway-control",
              "probe",
              randomBytes(32).toString("hex"),
            ],
            {
              artifactName: name,
              env: probeEnv(),
              timeoutMs: 30_000,
            },
          );
        const initial = await runProbe(artifactName);
        if (!isMissingManagedSupervisorProof(initial) || settleMs <= 0) return initial;
        await sleep(settleMs);
        return await runProbe(`${artifactName}-after-settle`);
      },
      accept: (result, attempt) => {
        if (isMissingManagedSupervisorProof(result)) return true;
        options.onRetry?.(attempt);
        return false;
      },
    });
  }

  // ─── Guard-chain recovery probes (#2478, #2701) ────────────────────

  /**
   * Resolve the supervisor-owned gateway PID record inside the sandbox.
   * The PID is accepted only while the process exists and its `/proc` start
   * identity still matches the second field recorded by the supervisor.
   */
  async resolveGatewayIdentity(instance: NemoClawInstance): Promise<GatewayProcessIdentity | null> {
    const script =
      "set -e; " +
      'record="$(cat /tmp/nemoclaw-gateway.pid 2>/dev/null || true)"; ' +
      'set -- $record; [ "$#" -eq 2 ] || exit 0; ' +
      'pid="$1"; expected_start="$2"; ' +
      'case "$pid" in ""|*[!0-9]*) exit 0 ;; esac; ' +
      'case "$expected_start" in ""|*[!0-9]*) exit 0 ;; esac; ' +
      'kill -0 "$pid" 2>/dev/null || exit 0; ' +
      'stat="$(cat "/proc/$pid/stat" 2>/dev/null || true)"; ' +
      '[ -n "$stat" ] || exit 0; rest="${stat##*) }"; ' +
      '[ "$rest" != "$stat" ] || exit 0; set -- $rest; ' +
      'case "$1" in Z|X) exit 0 ;; esac; state="$1"; ' +
      '[ "$#" -ge 20 ] || exit 0; actual_start="${20}"; ' +
      'printf "%s %s %s %s\\n" "$pid" "$expected_start" "$actual_start" "$state"';

    const result = await this.sandbox.exec(instance.sandboxName, ["sh", "-c", script], {
      artifactName: `gateway-resolve-pid-${instance.sandboxName}`,
      env: probeEnv(),
    });
    const identity = result.stdout.trim().match(/^([0-9]+) ([0-9]+) ([0-9]+) ([A-Za-z])$/);
    if (
      result.exitCode !== 0 ||
      !identity ||
      identity[2] !== identity[3] ||
      /^(?:X|Z)$/.test(identity[4])
    ) {
      return null;
    }
    const pid = Number(identity[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    return { pid, startIdentity: identity[2] };
  }

  async resolveGatewayPid(instance: NemoClawInstance): Promise<number | null> {
    return (await this.resolveGatewayIdentity(instance))?.pid ?? null;
  }

  /**
   * Assert that the NODE_OPTIONS guard chain is active for the gateway. The
   * sandbox command checks `/tmp/nemoclaw-proxy-env.sh` for every expected
   * preload marker and returns only a fixed credential-free sentinel. It does
   * not return the proxy environment file contents to the host or store them
   * in evidence artifacts.
   *
   * We deliberately read the file rather than `/proc/<pid>/environ`:
   * `kernel.yama.ptrace_scope=1` blocks reads of /proc/.../environ across
   * non-ancestor process trees. This matches the legacy 2478 bash test's
   * approach (`gateway_guards_active` -> `proxy_env_contents`).
   *
   * @throws if the expected marker list is empty or a marker is empty or
   * contains a carriage return or line feed; the file is missing, unreadable,
   * or empty; an expected marker is absent; or the sentinel response is invalid.
   */
  async expectGuardChainActive(
    instance: NemoClawInstance,
    options: ExpectGuardChainOptions = {},
  ): Promise<void> {
    const expected = options.expectedMarkers ?? DEFAULT_GUARD_MARKERS;
    if (
      expected.length === 0 ||
      expected.some((marker) => marker.length === 0 || /[\r\n]/u.test(marker))
    ) {
      throw new Error(
        "expectGuardChainActive: expectedMarkers must be a non-empty list of non-empty single-line markers",
      );
    }
    const script =
      'set -eu; proxy_env="$1"; sentinel="$2"; shift 2; ' +
      '[ -r "$proxy_env" ] && [ -s "$proxy_env" ] || exit 20; ' +
      'for marker do grep -Fq -- "$marker" "$proxy_env" 2>/dev/null || exit 21; done; ' +
      'printf "%s\\n" "$sentinel"';
    const result = await this.sandbox.exec(
      instance.sandboxName,
      [
        "sh",
        "-c",
        script,
        "nemoclaw-guard-chain-proof",
        GUARD_CHAIN_PROXY_ENV_PATH,
        GUARD_CHAIN_ACTIVE_SENTINEL,
        ...expected,
      ],
      {
        artifactName: `gateway-guard-chain-${instance.sandboxName}`,
        env: probeEnv(),
        ...options,
      },
    );

    if (
      result.exitCode === 0 &&
      result.signal === null &&
      !result.timedOut &&
      result.stdout === `${GUARD_CHAIN_ACTIVE_SENTINEL}\n` &&
      result.stderr === ""
    ) {
      return;
    }

    const quietFailure =
      result.signal === null && !result.timedOut && result.stdout === "" && result.stderr === "";
    if (quietFailure && result.exitCode === GUARD_CHAIN_FILE_UNAVAILABLE_EXIT_CODE) {
      throw new Error(
        `expectGuardChainActive: /tmp/nemoclaw-proxy-env.sh missing, unreadable, or empty in ${instance.sandboxName}`,
      );
    }
    if (quietFailure && result.exitCode === GUARD_CHAIN_MARKER_MISSING_EXIT_CODE) {
      throw new Error(
        `expectGuardChainActive: /tmp/nemoclaw-proxy-env.sh missing an expected marker in ${instance.sandboxName}`,
      );
    }
    throw new Error(
      `expectGuardChainActive: guard-chain check was invalid in ${instance.sandboxName}`,
    );
  }

  /**
   * Tail the gateway log inside the sandbox and assert the regex matches.
   * Used to verify recovery emitted (or did not emit) specific markers like
   * `[gateway-recovery] WARNING`.
   */
  async expectLogContains(
    instance: NemoClawInstance,
    pattern: RegExp,
    options: ExpectLogOptions = {},
  ): Promise<void> {
    const tail = await this.tailLog(instance, options);
    if (!pattern.test(tail)) {
      throw new Error(
        `expectLogContains: ${GATEWAY_LOG_PATH} did not match ${pattern.source} in ${instance.sandboxName}`,
      );
    }
  }

  /** Inverse of {@link expectLogContains}. */
  async expectLogDoesNotContain(
    instance: NemoClawInstance,
    pattern: RegExp,
    options: ExpectLogOptions = {},
  ): Promise<void> {
    const tail = await this.tailLog(instance, options);
    if (pattern.test(tail)) {
      throw new Error(
        `expectLogDoesNotContain: ${GATEWAY_LOG_PATH} unexpectedly matched ${pattern.source} in ${instance.sandboxName}`,
      );
    }
  }

  /**
   * Verify the gateway process identity is stable over `durationSeconds`. A
   * crash loop changes either the PID or its `/proc` start identity when the
   * supervisor respawns. We sample at `pollIntervalSeconds` and fail on the
   * first identity change (or on the gateway disappearing entirely).
   */
  async expectPidStable(
    instance: NemoClawInstance,
    options: ExpectPidStableOptions,
  ): Promise<GatewayProcessIdentity> {
    const pollIntervalSeconds = options.pollIntervalSeconds ?? 3;
    if (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0) {
      throw new Error("expectPidStable: durationSeconds must be > 0");
    }
    if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
      throw new Error("expectPidStable: pollIntervalSeconds must be > 0");
    }

    const initialIdentity = await this.resolveGatewayIdentity(instance);
    if (initialIdentity === null) {
      throw new Error(
        `expectPidStable: no gateway process in ${instance.sandboxName} at start of observation window`,
      );
    }

    const samples = Math.max(1, Math.floor(options.durationSeconds / pollIntervalSeconds));
    for (let i = 0; i < samples; i += 1) {
      await sleepSeconds(pollIntervalSeconds);
      const identity = await this.resolveGatewayIdentity(instance);
      if (identity === null) {
        throw new Error(
          `expectPidStable: gateway disappeared in ${instance.sandboxName} after ${(i + 1) * pollIntervalSeconds}s`,
        );
      }
      if (
        identity.pid !== initialIdentity.pid ||
        identity.startIdentity !== initialIdentity.startIdentity
      ) {
        throw new Error(
          `expectPidStable: gateway identity changed ${initialIdentity.pid}:${initialIdentity.startIdentity}→${identity.pid}:${identity.startIdentity} in ${instance.sandboxName} after ${(i + 1) * pollIntervalSeconds}s (crash-loop suspected)`,
        );
      }
    }
    return initialIdentity;
  }

  // ─── Internal helpers ──────────────────────────────────────────────

  private async tailLog(instance: NemoClawInstance, options: ExpectLogOptions): Promise<string> {
    const lines = options.lines ?? 200;
    if (!Number.isInteger(lines) || lines <= 0) {
      throw new Error("tailLog: lines must be a positive integer");
    }
    const result = await this.sandbox.exec(
      instance.sandboxName,
      ["sh", "-c", `tail -n ${lines} ${GATEWAY_LOG_PATH} 2>/dev/null`],
      {
        artifactName: `gateway-log-tail-${instance.sandboxName}`,
        env: probeEnv(),
        ...options,
      },
    );
    return result.stdout;
  }
}

function sleepSeconds(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
