// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Preserves the real boundaries: Docker/OpenShell onboarding, the
 * installed/source NemoClaw CLI, host `cloudflared`, the local dashboard origin,
 * public trycloudflare reachability, cloudflared log diagnosis, and tunnel stop
 * cleanup/status removal.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveNemoclawStateDir } from "../../../src/lib/state/paths.ts";
import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import type { E2ETargetFixtures } from "../fixtures/e2e-test.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const TEST_SANDBOX_PREFIX = "e2e-tunnel-life";
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? TEST_SANDBOX_PREFIX;
export function resolveTunnelLifecycleDashboardPort(env: NodeJS.ProcessEnv = process.env): string {
  // Manual PR runs use main's catalogue, which may not carry the candidate's port override.
  return env.NEMOCLAW_DASHBOARD_PORT ?? "18790";
}

const LOCAL_DASHBOARD_PORT = resolveTunnelLifecycleDashboardPort();
const TUNNEL_GATEWAY_PORT = "18080";
const TUNNEL_GATEWAY_NAME = "nemoclaw-18080";
const TEST_TIMEOUT_MS = testTimeout(
  Number(process.env.NEMOCLAW_E2E_TIMEOUT_SECONDS ?? 3_600) * 1_000,
);
const ONBOARD_TIMEOUT_MS = execTimeout(30 * 60_000);
const COMMAND_TIMEOUT_MS = 60_000;
const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b[\w./?%&=-]*/i;
const DASHBOARD_MARKER_PATTERN = /<title>OpenClaw Control<\/title>|<openclaw-app/i;

validateSandboxName(SANDBOX_NAME);

type CurlProbe = {
  httpCode: string;
  body: string;
  result: ShellProbeResult;
};

export function cloudflaredTargetsRegisteredPort(
  pid: number,
  command: ShellProbeResult,
  dashboardPort: string,
): boolean {
  const targetArgument = command.stdout.match(/(?:^|\s)--url\s+["']?(https?:\/\/[^\s"']+)/i)?.[1];
  if (!targetArgument) return false;

  let target: URL;
  try {
    target = new URL(targetArgument);
  } catch {
    return false;
  }

  return (
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    command.exitCode === 0 &&
    target.protocol === "http:" &&
    target.hostname === "localhost" &&
    target.port === dashboardPort &&
    target.pathname === "/" &&
    target.search === "" &&
    target.hash === ""
  );
}

function assertTestOwnedSandboxName(): void {
  if (!SANDBOX_NAME.startsWith(TEST_SANDBOX_PREFIX)) {
    throw new Error(
      `tunnel-lifecycle live test is destructive and only accepts sandbox names with prefix ${TEST_SANDBOX_PREFIX}; got ${SANDBOX_NAME}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function tunnelLifecycleCommandEnv(
  extra: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(base),
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_POLICY_TIER: "open",
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_PROVIDER: "cloud",
    NEMOCLAW_GATEWAY_PORT: TUNNEL_GATEWAY_PORT,
    OPENSHELL_GATEWAY: TUNNEL_GATEWAY_NAME,
    ...(process.env.NEMOCLAW_DASHBOARD_PORT
      ? { NEMOCLAW_DASHBOARD_PORT: process.env.NEMOCLAW_DASHBOARD_PORT }
      : {}),
    ...extra,
  };
}

function isCloudflareTransientText(text: string): boolean {
  return /failed to unmarshal quick Tunnel|quick tunnels? (are )?(temporarily )?disabled|failed to (dial|register)|tunnel server.*error|i\/o timeout|EOF.*tunnel|couldn.?t start tunnel|tunnel creation failed|bad gateway|\b50[234]\b/i.test(
    text,
  );
}

function isCloudflareTransientHttpCode(code: string): boolean {
  return ["000", "502", "503", "504"].includes(code);
}

export function getCloudflaredLogPath(
  stateRoot = resolveTunnelLifecycleStateDir(),
  _sandboxName = SANDBOX_NAME,
): string | undefined {
  // Source boundary: NemoClaw owns one gateway-scoped host-side dashboard tunnel log. If
  // that exact file is missing, this live contract classifies the invalid state
  // as `nemoclaw_no_spawn` instead of falling back to legacy per-sandbox logs,
  // because unrelated stale processes can otherwise corrupt fault attribution.
  // Remove this filesystem fallback point entirely once NemoClaw exposes
  // machine-readable tunnel diagnostics from `nemoclaw tunnel status --json`.
  const tunnelLog = path.join(stateRoot, "tunnel", "cloudflared.log");
  return fs.existsSync(tunnelLog) ? tunnelLog : undefined;
}

export function resolveTunnelLifecycleStateDir(
  homeDir?: string,
  gatewayPort = Number(TUNNEL_GATEWAY_PORT),
): string {
  return resolveNemoclawStateDir(homeDir, gatewayPort);
}

export function getCloudflaredPidPath(stateRoot = resolveTunnelLifecycleStateDir()): string {
  return path.join(stateRoot, "tunnel", "cloudflared.pid");
}

function readCloudflaredLog(): string {
  const logPath = getCloudflaredLogPath();
  if (!logPath) return "";
  return fs.readFileSync(logPath, "utf8");
}

function cloudflaredLogTail(lines = 80): string {
  const logPath = getCloudflaredLogPath();
  if (!logPath) return "(no gateway-scoped cloudflared.log found in NemoClaw state)";
  const text = fs.readFileSync(logPath, "utf8");
  return [
    `--- cloudflared.log (${logPath}, last ${lines} lines) ---`,
    ...text.split(/\r?\n/).slice(-lines),
  ].join("\n");
}

export function classifyCloudflaredLog(
  logRoot = resolveTunnelLifecycleStateDir(),
  sandboxName = SANDBOX_NAME,
): "nemoclaw_no_spawn" | "nemoclaw_capture_bug" | "nemoclaw_local" | "cloudflare" | "unknown" {
  const logPath = getCloudflaredLogPath(logRoot, sandboxName);
  if (!logPath) return "nemoclaw_no_spawn";
  const log = fs.readFileSync(logPath, "utf8");
  if (TUNNEL_URL_PATTERN.test(log)) return "nemoclaw_capture_bug";
  if (
    /unable to reach the origin|connection refused.*127\.0\.0\.1|connection refused.*localhost|dial tcp.*127\.0\.0\.1.*refused/i.test(
      log,
    )
  ) {
    return "nemoclaw_local";
  }
  if (isCloudflareTransientText(log)) return "cloudflare";
  return "unknown";
}

function extractTunnelUrl(text: string): string | undefined {
  return text.match(TUNNEL_URL_PATTERN)?.[0];
}

function extractTunnelPid(text: string): number | undefined {
  const raw = text.match(/cloudflared\s+\(PID\s+(\d+)\)/i)?.[1];
  return raw ? Number(raw) : undefined;
}

export function publicTunnelProbeCurlArgs(tunnelUrl: string): string[] {
  // Source boundary: the public tunnel URL already came from `nemoclaw tunnel status`
  // and matched `*.trycloudflare.com`. Do not ask curl to follow redirects;
  // a 3xx response is a tunnel/output contract failure unless NemoClaw grows a
  // documented same-host redirect requirement. If that happens, replace this
  // with explicit redirect target inspection before issuing a second request.
  return ["-sS", "--max-time", "30", "-w", "\n__HTTP_CODE:%{http_code}\n", tunnelUrl];
}

export function tunnelLifecycleInstallArgs(): string[] {
  // Self-hosted runners can retain an unrelated failed onboarding session.
  // This target owns a fresh sandbox and must not resume or reject stale state
  // from an earlier job before it reaches the tunnel lifecycle under test.
  return ["install.sh", "--non-interactive", "--fresh", "--yes-i-accept-third-party-software"];
}

function parseCurlProbe(result: ShellProbeResult): CurlProbe {
  const text = result.stdout;
  const match = text.match(/\n__HTTP_CODE:(\d{3})\s*$/);
  const httpCode = match?.[1] ?? "000";
  const body = match ? text.slice(0, match.index) : text;
  return { httpCode, body, result };
}

async function bestEffortRecovery(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Inline recovery remains best-effort so the primary E2E failure stays visible.
  }
}

function isBenignTunnelStopFailure(text: string): boolean {
  return /no active tunnel|no tunnel.*running|tunnel.*not.*running|already stopped|cloudflared.*not.*running|no cloudflared/i.test(
    text,
  );
}

export const TUNNEL_LIFECYCLE_TEST_TIMEOUT_MS = TEST_TIMEOUT_MS;

type TunnelLifecycleFixtures = Pick<
  E2ETargetFixtures,
  "artifacts" | "cleanup" | "host" | "progress" | "runtimeProvider" | "secrets"
> & {
  skip: (note?: string) => never;
};

type TunnelLifecycleCleanupHost = Pick<E2ETargetFixtures["host"], "cleanupSandbox" | "nemoclaw">;

type TunnelLifecycleCleanupRegistry = Pick<E2ETargetFixtures["cleanup"], "add" | "trackSandbox">;

export function registerTunnelLifecycleCleanup(
  cleanup: TunnelLifecycleCleanupRegistry,
  host: TunnelLifecycleCleanupHost,
): void {
  // CleanupRegistry runs callbacks in reverse registration order. Register the
  // sandbox destroy first so host `cloudflared` is stopped before the sandbox is
  // torn down on early failures. Source boundary: `nemoclaw tunnel stop` owns
  // quick-tunnel process cleanup; `cleanupSandbox` owns the Docker/OpenShell
  // sandbox and only suppresses already-missing sandboxes. Keep both callbacks
  // strict so unexpected cleanup failures surface in cleanup.json. Removal
  // condition: replace this ordering guard once NemoClaw exposes one atomic
  // machine-readable lifecycle cleanup that stops tunnels before destroying the
  // sandbox.
  if (process.env.NEMOCLAW_E2E_KEEP_SANDBOX !== "1") {
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-destroy-tunnel-lifecycle",
      env: tunnelLifecycleCommandEnv(),
      timeoutMs: 15 * 60_000,
    });
  }
  cleanup.add("stop cloudflared quick tunnel", async () => {
    const stop = await host.nemoclaw(["tunnel", "stop"], {
      artifactName: "cleanup-tunnel-stop",
      env: tunnelLifecycleCommandEnv(),
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (stop.exitCode === 0) return;
    const text = resultText(stop);
    if (isBenignTunnelStopFailure(text)) return;
    throw new Error(
      `[NemoClaw fault] cleanup tunnel stop failed with exit ${stop.exitCode ?? "unknown"}: ${text}`,
    );
  });
}

export async function runTunnelLifecycleContract({
  artifacts,
  cleanup,
  host,
  progress,
  runtimeProvider,
  secrets,
  skip,
}: TunnelLifecycleFixtures): Promise<void> {
  assertTestOwnedSandboxName();
  const hosted = requireHostedInferenceConfig(secrets);
  const apiKey = hosted.apiKey;

  await artifacts.writeJson("contract.json", {
    sandboxName: SANDBOX_NAME,
    localDashboardPort: LOCAL_DASHBOARD_PORT,
    gatewayName: TUNNEL_GATEWAY_NAME,
    gatewayPort: TUNNEL_GATEWAY_PORT,
    preservedBoundaries: [
      "real Docker/OpenShell OpenClaw sandbox onboarding",
      "host cloudflared binary and quick-tunnel registration",
      "recorded cloudflared process targets the registered dashboard port",
      "nemoclaw tunnel start/status/stop CLI commands",
      "local dashboard origin readiness before tunnel attribution",
      "public trycloudflare HTTP probe with dashboard marker assertion",
      "sandbox destroy preserves host cloudflared ownership and status",
      "cloudflared.log classification for NemoClaw-vs-Cloudflare failures",
    ],
    inferenceCredential: hosted.contractLabel,
  });

  registerTunnelLifecycleCleanup(cleanup, host);

  await runtimeProvider.requireAvailable({
    artifactName: "prereq-docker-info-tunnel-lifecycle",
    scenarioLabel: "tunnel lifecycle",
  });

  const cloudflared = await host.command("cloudflared", ["--version"], {
    artifactName: "prereq-cloudflared-version",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  if (cloudflared.exitCode !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error(
        `cloudflared is required for tunnel lifecycle E2E: ${resultText(cloudflared)}`,
      );
    }
    skip("cloudflared is required for tunnel lifecycle E2E");
  }

  progress.phase("onboard the OpenClaw tunnel sandbox");
  await host.bestEffortCleanupSandbox(SANDBOX_NAME, {
    artifactName: "pre-cleanup-nemoclaw-destroy-tunnel-lifecycle",
    env: tunnelLifecycleCommandEnv(),
    timeoutMs: 15 * 60_000,
  });

  progress.phase("register the non-default dashboard port");
  const install = await host.command("bash", tunnelLifecycleInstallArgs(), {
    artifactName: "install-sh-tunnel-lifecycle",
    cwd: REPO_ROOT,
    env: tunnelLifecycleCommandEnv({
      ...hosted.env,
      NVIDIA_INFERENCE_API_KEY: apiKey,
      NEMOCLAW_DASHBOARD_PORT: LOCAL_DASHBOARD_PORT,
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
    }),
    redactionValues: [apiKey],
    timeoutMs: ONBOARD_TIMEOUT_MS,
  });
  expect(install.exitCode, resultText(install)).toBe(0);
  await host.expectListed(SANDBOX_NAME, {
    artifactName: "post-install-nemoclaw-list",
    env: tunnelLifecycleCommandEnv(),
  });

  progress.phase("wait for the local dashboard origin");
  let localReady = false;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const local = await host.command(
      "curl",
      [
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "5",
        `http://localhost:${LOCAL_DASHBOARD_PORT}/`,
      ],
      {
        artifactName: `local-dashboard-ready-${attempt}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 10_000,
      },
    );
    const code = local.stdout.trim() || "000";
    if (code !== "000") {
      localReady = true;
      break;
    }
    await sleep(1_000);
  }
  expect(
    localReady,
    `[NemoClaw fault] Local OpenClaw dashboard not reachable on localhost:${LOCAL_DASHBOARD_PORT} after 30s; tunnel cannot proxy a dead origin.`,
  ).toBe(true);

  progress.phase("start the quick tunnel and discover its URL");
  const start = await host.nemoclaw(["tunnel", "start"], {
    artifactName: "tunnel-start",
    env: tunnelLifecycleCommandEnv(),
    timeoutMs: 90_000,
  });
  if (start.exitCode !== 0) {
    await artifacts.writeText("cloudflared-log-after-start-failure.txt", cloudflaredLogTail());
    if (isCloudflareTransientText(resultText(start)) || classifyCloudflaredLog() === "cloudflare") {
      await bestEffortRecovery(() =>
        host.nemoclaw(["tunnel", "stop"], {
          artifactName: "tunnel-stop-after-cloudflare-start-failure",
          env: tunnelLifecycleCommandEnv(),
          timeoutMs: COMMAND_TIMEOUT_MS,
        }),
      );
      skip(
        `[Cloudflare fault] nemoclaw tunnel start exited ${start.exitCode ?? "unknown"} because quick-tunnel registration returned a transient external error.`,
      );
    }
    throw new Error(
      `[NemoClaw fault] nemoclaw tunnel start failed with exit ${start.exitCode ?? "unknown"}: ${resultText(start)}`,
    );
  }

  progress.phase("verify cloudflared targets the registered dashboard port");
  const cloudflaredPidFile = getCloudflaredPidPath();
  const cloudflaredPid = Number(fs.readFileSync(cloudflaredPidFile, "utf8").trim());
  const cloudflaredCommand = await host.command(
    "ps",
    ["-ww", "-p", String(cloudflaredPid), "-o", "args="],
    {
      artifactName: "cloudflared-command-line-for-registered-port",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: COMMAND_TIMEOUT_MS,
    },
  );
  const cloudflaredTargetMatches = cloudflaredTargetsRegisteredPort(
    cloudflaredPid,
    cloudflaredCommand,
    LOCAL_DASHBOARD_PORT,
  );

  let tunnelUrl: string | undefined;
  let lastStatusText = "";
  for (let attempt = 1; cloudflaredTargetMatches && attempt <= 15; attempt += 1) {
    const status = await host.nemoclaw(["tunnel", "status"], {
      artifactName: `status-with-tunnel-url-${attempt}`,
      env: tunnelLifecycleCommandEnv(),
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    lastStatusText = resultText(status);
    tunnelUrl = extractTunnelUrl(lastStatusText);
    if (tunnelUrl) break;
    await sleep(1_000);
  }

  if (!tunnelUrl) {
    await artifacts.writeText("cloudflared-log-without-status-url.txt", cloudflaredLogTail());
    const cfClass = classifyCloudflaredLog();
    await bestEffortRecovery(() =>
      host.nemoclaw(["tunnel", "stop"], {
        artifactName: "tunnel-stop-after-missing-url",
        env: tunnelLifecycleCommandEnv(),
        timeoutMs: COMMAND_TIMEOUT_MS,
      }),
    );
    if (cloudflaredTargetMatches && cfClass === "cloudflare") {
      skip("[Cloudflare fault] cloudflared failed to register a quick tunnel URL.");
    }
    let reason: string;
    switch (cloudflaredTargetMatches ? cfClass : "wrong_dashboard_port") {
      case "wrong_dashboard_port":
        reason = `cloudflared PID ${String(cloudflaredPid)} does not target the registered dashboard port ${LOCAL_DASHBOARD_PORT}`;
        break;
      case "nemoclaw_no_spawn":
        reason = "cloudflared.log missing — NemoClaw failed to spawn the cloudflared process";
        break;
      case "nemoclaw_capture_bug":
        reason =
          "cloudflared.log has a trycloudflare URL but nemoclaw tunnel status did not surface it";
        break;
      case "nemoclaw_local":
        reason = `cloudflared.log reports it cannot reach localhost:${LOCAL_DASHBOARD_PORT}`;
        break;
      default:
        reason = `tunnel URL did not surface and cloudflared.log did not match a known pattern; status was:\n${lastStatusText}`;
    }
    throw new Error(`[NemoClaw fault] ${reason}`);
  }

  progress.phase("probe public tunnel reachability");
  let lastPublicProbe: CurlProbe | undefined;
  let backoffMs = 2_000;
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const probe = parseCurlProbe(
      await host.command("curl", publicTunnelProbeCurlArgs(tunnelUrl), {
        artifactName: `public-tunnel-probe-${attempt}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 35_000,
      }),
    );
    lastPublicProbe = probe;
    if (probe.httpCode === "200") break;

    const local = await host.command(
      "curl",
      [
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "5",
        `http://localhost:${LOCAL_DASHBOARD_PORT}/`,
      ],
      {
        artifactName: `local-dashboard-recheck-${attempt}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 10_000,
      },
    );
    const localCode = local.stdout.trim() || "000";
    if (localCode === "000") {
      throw new Error(
        `[NemoClaw fault] Tunnel returned ${probe.httpCode} and local dashboard regressed during retry loop; likely sandbox/dashboard crash, not Cloudflare.`,
      );
    }
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }

  // The bounded loop always executes at least once.
  if (lastPublicProbe!.httpCode !== "200") {
    if (
      isCloudflareTransientHttpCode(lastPublicProbe!.httpCode) ||
      isCloudflareTransientText(lastPublicProbe!.body) ||
      isCloudflareTransientText(readCloudflaredLog())
    ) {
      skip(
        `[Cloudflare fault] Tunnel URL never became reachable while local stayed healthy; last HTTP status ${lastPublicProbe!.httpCode}.`,
      );
    }
    throw new Error(
      `[NemoClaw fault] Tunnel returned unexpected HTTP ${lastPublicProbe!.httpCode} while local stayed healthy; body prefix: ${lastPublicProbe!.body.slice(0, 200)}`,
    );
  }
  expect(
    DASHBOARD_MARKER_PATTERN.test(lastPublicProbe!.body),
    `Public tunnel must serve OpenClaw; ps exit ${cloudflaredCommand.exitCode}: ${cloudflaredCommand.stdout.trim()} ${resultText(cloudflaredCommand)}`,
  ).toBe(true);

  const tunnelPid = extractTunnelPid(lastStatusText);
  expect(tunnelPid, "status must report the managed cloudflared PID before destroy").toBeTruthy();

  progress.phase("destroy the sandbox without stopping the host tunnel");
  const destroy = await host.nemoclaw([SANDBOX_NAME, "destroy", "--no-cleanup-gateway"], {
    artifactName: "destroy-with-active-tunnel",
    env: tunnelLifecycleCommandEnv(),
    timeoutMs: 15 * 60_000,
  });
  expect(destroy.exitCode, resultText(destroy)).toBe(0);

  const statusAfterDestroy = await host.nemoclaw(["tunnel", "status"], {
    artifactName: "tunnel-status-after-sandbox-destroy",
    env: tunnelLifecycleCommandEnv(),
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  const statusAfterDestroyText = resultText(statusAfterDestroy);
  expect(
    extractTunnelPid(statusAfterDestroyText) === tunnelPid &&
      extractTunnelUrl(statusAfterDestroyText) === tunnelUrl,
    "destroy must preserve the managed cloudflared PID and public URL",
  ).toBe(true);

  progress.phase("stop the tunnel and confirm status removal");
  const stop = await host.nemoclaw(["tunnel", "stop"], {
    artifactName: "tunnel-stop",
    env: tunnelLifecycleCommandEnv(),
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  expect(stop.exitCode, resultText(stop)).toBe(0);
  let postStopUrl: string | undefined = "status unreadable";
  let statusReadable = false;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const status = await host.nemoclaw(["tunnel", "status"], {
      artifactName: `status-after-tunnel-stop-${attempt}`,
      env: tunnelLifecycleCommandEnv(),
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (status.exitCode !== 0) {
      await sleep(1_000);
      continue;
    }
    statusReadable = true;
    postStopUrl = extractTunnelUrl(resultText(status));
    if (!postStopUrl) break;
    await sleep(1_000);
  }
  expect(
    postStopUrl,
    statusReadable
      ? "tunnel URL must be absent after nemoclaw tunnel stop"
      : "nemoclaw tunnel status must be readable after tunnel stop",
  ).toBeUndefined();
}
