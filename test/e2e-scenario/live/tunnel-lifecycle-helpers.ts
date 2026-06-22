// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest replacement for test/e2e/test-tunnel-lifecycle.sh.
 *
 * Preserves the legacy real boundaries: Docker/OpenShell onboarding, the
 * installed/source NemoClaw CLI, host `cloudflared`, the local dashboard origin,
 * public trycloudflare reachability, cloudflared log diagnosis, and tunnel stop
 * cleanup/status removal.
 */

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import type { E2EScenarioFixtures } from "../fixtures/e2e-test.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const TEST_SANDBOX_PREFIX = "e2e-tunnel-lifecycle";
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? TEST_SANDBOX_PREFIX;
const LOCAL_DASHBOARD_PORT = process.env.NEMOCLAW_DASHBOARD_PORT ?? "18789";
const TEST_TIMEOUT_MS = Number(process.env.NEMOCLAW_E2E_TIMEOUT_SECONDS ?? 3_600) * 1_000;
const ONBOARD_TIMEOUT_MS = 30 * 60_000;
const COMMAND_TIMEOUT_MS = 60_000;
const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b[\w./?%&=-]*/i;
const DASHBOARD_MARKER_PATTERN = /<title>OpenClaw Control<\/title>|<openclaw-app/i;

validateSandboxName(SANDBOX_NAME);

type CurlProbe = {
  httpCode: string;
  body: string;
  result: ShellProbeResult;
};

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

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_POLICY_TIER: "open",
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_PROVIDER: "cloud",
    OPENSHELL_GATEWAY: "nemoclaw",
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
  logRoot = "/tmp",
  sandboxName = SANDBOX_NAME,
): string | undefined {
  // Source boundary: NemoClaw owns the per-sandbox cloudflared service log at
  // /tmp/nemoclaw-services-${sandboxName}/cloudflared.log. If that exact file
  // is missing, this live contract classifies the invalid state as
  // `nemoclaw_no_spawn` instead of falling back to the newest /tmp log, because
  // unrelated parallel/stale sandboxes can otherwise corrupt fault attribution.
  // Remove this filesystem fallback point entirely once NemoClaw exposes
  // machine-readable tunnel diagnostics from `nemoclaw status --json`.
  const sandboxLog = path.join(logRoot, `nemoclaw-services-${sandboxName}`, "cloudflared.log");
  return fs.existsSync(sandboxLog) ? sandboxLog : undefined;
}

function readCloudflaredLog(): string {
  const logPath = getCloudflaredLogPath();
  if (!logPath) return "";
  return fs.readFileSync(logPath, "utf8");
}

function cloudflaredLogTail(lines = 80): string {
  const logPath = getCloudflaredLogPath();
  if (!logPath) return "(no cloudflared.log found under /tmp/nemoclaw-services-*/)";
  const text = fs.readFileSync(logPath, "utf8");
  return [
    `--- cloudflared.log (${logPath}, last ${lines} lines) ---`,
    ...text.split(/\r?\n/).slice(-lines),
  ].join("\n");
}

export function classifyCloudflaredLog(
  logRoot = "/tmp",
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

export function publicTunnelProbeCurlArgs(tunnelUrl: string): string[] {
  // Source boundary: the public tunnel URL already came from `nemoclaw status`
  // and matched `*.trycloudflare.com`. Do not ask curl to follow redirects;
  // a 3xx response is a tunnel/output contract failure unless NemoClaw grows a
  // documented same-host redirect requirement. If that happens, replace this
  // with explicit redirect target inspection before issuing a second request.
  return ["-sS", "--max-time", "30", "-w", "\n__HTTP_CODE:%{http_code}\n", tunnelUrl];
}

function parseCurlProbe(result: ShellProbeResult): CurlProbe {
  const text = result.stdout;
  const match = text.match(/\n__HTTP_CODE:(\d{3})\s*$/);
  const httpCode = match?.[1] ?? "000";
  const body = match ? text.slice(0, match.index) : text;
  return { httpCode, body, result };
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
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
  E2EScenarioFixtures,
  "artifacts" | "cleanup" | "host" | "secrets"
> & {
  skip: (note?: string) => never;
};

type TunnelLifecycleCleanupHost = Pick<E2EScenarioFixtures["host"], "cleanupSandbox" | "nemoclaw">;

type TunnelLifecycleCleanupRegistry = Pick<E2EScenarioFixtures["cleanup"], "add">;

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
  cleanup.add(`destroy sandbox ${SANDBOX_NAME}`, async () => {
    if (process.env.NEMOCLAW_E2E_KEEP_SANDBOX === "1") return;
    await host.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-destroy-tunnel-lifecycle",
      timeoutMs: 15 * 60_000,
    });
  });
  cleanup.add("stop cloudflared quick tunnel", async () => {
    const stop = await host.nemoclaw(["tunnel", "stop"], {
      artifactName: "cleanup-tunnel-stop",
      env: commandEnv(),
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
  secrets,
  skip,
}: TunnelLifecycleFixtures): Promise<void> {
  assertTestOwnedSandboxName();
  const hosted = requireHostedInferenceConfig(secrets);
  const apiKey = hosted.apiKey;

  await artifacts.writeJson("contract.json", {
    legacySource: "test/e2e/test-tunnel-lifecycle.sh",
    sandboxName: SANDBOX_NAME,
    localDashboardPort: LOCAL_DASHBOARD_PORT,
    preservedBoundaries: [
      "real Docker/OpenShell OpenClaw sandbox onboarding",
      "host cloudflared binary and quick-tunnel registration",
      "nemoclaw tunnel start/status/stop CLI commands",
      "local dashboard origin readiness before tunnel attribution",
      "public trycloudflare HTTP probe with dashboard marker assertion",
      "cloudflared.log classification for NemoClaw-vs-Cloudflare failures",
    ],
    inferenceCredential: hosted.contractLabel,
  });

  registerTunnelLifecycleCleanup(cleanup, host);

  const docker = await host.command("docker", ["info"], {
    artifactName: "prereq-docker-info-tunnel-lifecycle",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  if (docker.exitCode !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error(`Docker is required for tunnel lifecycle E2E: ${resultText(docker)}`);
    }
    skip("Docker is required for tunnel lifecycle E2E");
  }

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

  expect(fs.existsSync(path.join(REPO_ROOT, "install.sh"))).toBe(true);
  await host.bestEffortCleanupSandbox(SANDBOX_NAME, {
    artifactName: "pre-cleanup-nemoclaw-destroy-tunnel-lifecycle",
    timeoutMs: 15 * 60_000,
  });

  const install = await host.command(
    "bash",
    ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"],
    {
      artifactName: "install-sh-tunnel-lifecycle",
      cwd: REPO_ROOT,
      env: commandEnv({
        ...hosted.env,
        NVIDIA_INFERENCE_API_KEY: apiKey,
        NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
      }),
      redactionValues: [apiKey],
      timeoutMs: ONBOARD_TIMEOUT_MS,
    },
  );
  expect(install.exitCode, resultText(install)).toBe(0);

  await host.expectListed(SANDBOX_NAME, { artifactName: "post-install-nemoclaw-list" });

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

  const start = await host.nemoclaw(["tunnel", "start"], {
    artifactName: "tunnel-start",
    env: commandEnv(),
    timeoutMs: 90_000,
  });
  if (start.exitCode !== 0) {
    await artifacts.writeText("cloudflared-log-after-start-failure.txt", cloudflaredLogTail());
    if (isCloudflareTransientText(resultText(start)) || classifyCloudflaredLog() === "cloudflare") {
      await bestEffort(() =>
        host.nemoclaw(["tunnel", "stop"], {
          artifactName: "tunnel-stop-after-cloudflare-start-failure",
          env: commandEnv(),
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

  let tunnelUrl: string | undefined;
  let lastStatusText = "";
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const status = await host.nemoclaw(["status"], {
      artifactName: `status-with-tunnel-url-${attempt}`,
      env: commandEnv(),
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
    await bestEffort(() =>
      host.nemoclaw(["tunnel", "stop"], {
        artifactName: "tunnel-stop-after-missing-url",
        env: commandEnv(),
        timeoutMs: COMMAND_TIMEOUT_MS,
      }),
    );
    if (cfClass === "cloudflare") {
      skip("[Cloudflare fault] cloudflared failed to register a quick tunnel URL.");
    }
    let reason: string;
    switch (cfClass) {
      case "nemoclaw_no_spawn":
        reason = "cloudflared.log missing — NemoClaw failed to spawn the cloudflared process";
        break;
      case "nemoclaw_capture_bug":
        reason = "cloudflared.log has a trycloudflare URL but nemoclaw status did not surface it";
        break;
      case "nemoclaw_local":
        reason = `cloudflared.log reports it cannot reach localhost:${LOCAL_DASHBOARD_PORT}`;
        break;
      default:
        reason = `tunnel URL did not surface and cloudflared.log did not match a known pattern; status was:\n${lastStatusText}`;
    }
    throw new Error(`[NemoClaw fault] ${reason}`);
  }

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

  expect(lastPublicProbe, "public tunnel probe should have run").toBeTruthy();
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
  expect(lastPublicProbe!.body, "public tunnel must serve OpenClaw dashboard markers").toMatch(
    DASHBOARD_MARKER_PATTERN,
  );

  const stop = await host.nemoclaw(["tunnel", "stop"], {
    artifactName: "tunnel-stop",
    env: commandEnv(),
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  expect(stop.exitCode, resultText(stop)).toBe(0);

  let postStopUrl: string | undefined;
  let statusReadable = false;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const status = await host.nemoclaw(["status"], {
      artifactName: `status-after-tunnel-stop-${attempt}`,
      env: commandEnv(),
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
  expect(statusReadable, "nemoclaw status should be readable after tunnel stop").toBe(true);
  expect(postStopUrl, "tunnel URL must be absent after nemoclaw tunnel stop").toBeUndefined();
}
