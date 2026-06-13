// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import type { NemoClawInstance } from "../phases/onboarding.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../shell-probe.ts";
import { assertExitZero } from "./command.ts";
import type { HostCliClient } from "./host.ts";
import type { SandboxClient } from "./sandbox.ts";

/**
 * Build the env passed to in-sandbox probes via `openshell sandbox exec`.
 *
 * The framework's ShellProbe defaults to `inheritEnv: false` and routes the
 * spawned-process env through `buildChildEnv`'s allowlist (HOME, PATH, …).
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

export interface HostGatewayRuntime {
  kind: "pid" | "container";
  id: string;
}

export class GatewayClient {
  private readonly host: HostCliClient;
  private readonly sandbox: SandboxClient;

  constructor(host: HostCliClient, sandbox: SandboxClient) {
    this.host = host;
    this.sandbox = sandbox;
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

    const container = await this.host.command(
      "docker",
      ["ps", "-qf", `name=${DEFAULT_GATEWAY_CONTAINER}`],
      {
        artifactName: "gateway-runtime-container-probe",
        env: probeEnv(),
        timeoutMs: 15_000,
      },
    );
    const id = container.stdout.trim().split(/\r?\n/).find(Boolean);
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

  // ─── Guard-chain recovery probes (#2478, #2701) ────────────────────

  /**
   * Resolve the running openclaw gateway PID inside the sandbox by parsing
   * `ps`. Returns the lowest matching PID, or null if no gateway process is
   * running. Mirrors the legacy bash `gateway_pid()` helper.
   *
   * Two-pass match: first prefer rows whose argv contains "gateway" alongside
   * comm "openclaw"; fall back to any "openclaw" comm. The two-pass shape
   * tolerates older builds that exposed gateway under a slightly different
   * argv but the same comm.
   */
  async resolveGatewayPid(instance: NemoClawInstance): Promise<number | null> {
    const script =
      "set -e; " +
      // Primary: argv contains "gateway" and comm is "openclaw".
      'pid="$(ps -eo pid=,comm=,args= 2>/dev/null | ' +
      "awk '($2 == \"openclaw\" && $0 ~ /gateway/) || $0 ~ /openclaw[ -]gateway/ { print $1 }' | " +
      'sort -n | head -n 1)"; ' +
      // Fallback: any process with comm "openclaw".
      'if [ -z "$pid" ]; then ' +
      'pid="$(ps -eo pid=,comm=,args= 2>/dev/null | ' +
      'awk \'$2 == "openclaw" { print $1 }\' | sort -n | head -n 1)"; ' +
      "fi; " +
      'printf "%s\\n" "$pid"';

    const result = await this.sandbox.exec(instance.sandboxName, ["sh", "-c", script], {
      artifactName: `gateway-resolve-pid-${instance.sandboxName}`,
      env: probeEnv(),
    });
    const trimmed = result.stdout.trim();
    if (!/^[0-9]+$/.test(trimmed)) return null;
    const pid = Number(trimmed);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  }

  /**
   * Assert that the NODE_OPTIONS guard chain is active for the gateway by
   * reading `/tmp/nemoclaw-proxy-env.sh` and verifying it contains the
   * expected preload markers (`--require` paths). The proxy-env file is
   * the single source of truth — when recovery sources it, the gateway
   * inherits the chain.
   *
   * We deliberately read the file rather than `/proc/<pid>/environ`:
   * `kernel.yama.ptrace_scope=1` blocks reads of /proc/.../environ across
   * non-ancestor process trees. This matches the legacy 2478 bash test's
   * approach (`gateway_guards_active` -> `proxy_env_contents`).
   *
   * @throws if the file is missing or any expected marker is absent.
   */
  async expectGuardChainActive(
    instance: NemoClawInstance,
    options: ExpectGuardChainOptions = {},
  ): Promise<void> {
    const expected = options.expectedMarkers ?? DEFAULT_GUARD_MARKERS;
    const result = await this.sandbox.exec(
      instance.sandboxName,
      ["sh", "-c", "cat /tmp/nemoclaw-proxy-env.sh 2>/dev/null"],
      {
        artifactName: `gateway-guard-chain-${instance.sandboxName}`,
        env: probeEnv(),
        ...options,
      },
    );

    if (result.exitCode !== 0 || result.stdout.trim() === "") {
      throw new Error(
        `expectGuardChainActive: /tmp/nemoclaw-proxy-env.sh missing or empty in ${instance.sandboxName}`,
      );
    }

    const missing = expected.filter((marker) => !result.stdout.includes(marker));
    if (missing.length > 0) {
      throw new Error(
        `expectGuardChainActive: /tmp/nemoclaw-proxy-env.sh missing markers ${JSON.stringify(missing)} in ${instance.sandboxName}`,
      );
    }
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
   * Verify the gateway PID is stable over `durationSeconds`. A crash loop
   * shows up as the PID changing every few seconds because the supervisor
   * keeps respawning. We sample at `pollIntervalSeconds` and fail on first
   * change (or on the gateway disappearing entirely).
   */
  async expectPidStable(
    instance: NemoClawInstance,
    options: ExpectPidStableOptions,
  ): Promise<number> {
    const pollIntervalSeconds = options.pollIntervalSeconds ?? 3;
    if (options.durationSeconds <= 0) {
      throw new Error("expectPidStable: durationSeconds must be > 0");
    }
    if (pollIntervalSeconds <= 0) {
      throw new Error("expectPidStable: pollIntervalSeconds must be > 0");
    }

    const initialPid = await this.resolveGatewayPid(instance);
    if (initialPid === null) {
      throw new Error(
        `expectPidStable: no gateway process in ${instance.sandboxName} at start of observation window`,
      );
    }

    const samples = Math.max(1, Math.floor(options.durationSeconds / pollIntervalSeconds));
    for (let i = 0; i < samples; i += 1) {
      await sleepSeconds(pollIntervalSeconds);
      const pid = await this.resolveGatewayPid(instance);
      if (pid === null) {
        throw new Error(
          `expectPidStable: gateway disappeared in ${instance.sandboxName} after ${(i + 1) * pollIntervalSeconds}s`,
        );
      }
      if (pid !== initialPid) {
        throw new Error(
          `expectPidStable: gateway PID changed ${initialPid}→${pid} in ${instance.sandboxName} after ${(i + 1) * pollIntervalSeconds}s (crash-loop suspected)`,
        );
      }
    }
    return initialPid;
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
