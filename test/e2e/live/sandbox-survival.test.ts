// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Preserves the real boundaries: install.sh/onboard, Docker, OpenShell
 * gateway stop/start, NemoClaw registry/list/status, sandbox SSH/exec, durable
 * /sandbox/.openclaw state markers, and inference.local chat completion before
 * and after gateway restart.
 */

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  cleanupWhenCommandAvailable,
  cleanupWhenOpenShellAvailable,
} from "../fixtures/cleanup-resources.ts";
import {
  assertExitZero,
  type HostCliClient,
  resultText,
  sandboxAccessEnv,
} from "../fixtures/clients/index.ts";
import { trustedProviderEndpoint } from "../fixtures/clients/provider.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { NemoClawInstance } from "../fixtures/phases/index.ts";
import type { SandboxMarker } from "../fixtures/phases/state-validation.ts";
import type { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-survival";
const MIN_OPENSHELL_VERSION = "0.0.24";
const MODEL = process.env.NEMOCLAW_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";

const SURVIVAL_DIAGNOSTICS_SCRIPT = String.raw`
set +e
sandbox_name="$1"
shift
runtime_command=("$@")

printf '%s\n' '== OpenShell sandbox status =='
openshell sandbox get "$sandbox_name" 2>&1
printf '%s\n' '== OpenShell forwards =='
openshell forward list 2>&1
printf '%s\n' '== OpenShell gateway service =='
systemctl --user status nemoclaw-openshell-gateway --no-pager -l 2>&1
printf '%s\n' '== OpenShell gateway journal =='
journalctl --user -u nemoclaw-openshell-gateway -n 200 --no-pager 2>&1

container_ids="$("\${runtime_command[@]}" container ps --all --quiet \
  --filter "label=openshell.ai/sandbox-name=$sandbox_name")"
printf '%s\n' '== matching containers =='
if [ -n "$container_ids" ]; then
  "\${runtime_command[@]}" container ps --all --no-trunc \
    --filter "label=openshell.ai/sandbox-name=$sandbox_name" \
    --format '{{.ID}} {{.Names}} {{.Status}}'
else
  printf '%s\n' 'none'
fi

for container_id in $container_ids; do
  printf '%s\n' "== container $container_id inspect =="
  "\${runtime_command[@]}" container inspect "$container_id" 2>&1 | node -e '
    const fs = require("node:fs");
    const row = JSON.parse(fs.readFileSync(0, "utf8"))[0] || {};
    const prefix = "OPENSHELL_SANDBOX_COMMAND=";
    const matches = (row.Config?.Env || []).filter((entry) => entry.startsWith(prefix));
    const command = matches.length === 1 ? matches[0].slice(prefix.length) : "";
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    process.stdout.write(JSON.stringify({
      name: row.Name || "",
      configUser: row.Config?.User || "",
      state: {
        status: row.State?.Status || "",
        running: Boolean(row.State?.Running),
        restarting: Boolean(row.State?.Restarting),
        pid: row.State?.Pid || 0,
        exitCode: row.State?.ExitCode ?? null,
        error: row.State?.Error || "",
        startedAt: row.State?.StartedAt || "",
        finishedAt: row.State?.FinishedAt || "",
        health: row.State?.Health?.Status || "",
      },
      restartPolicy: row.HostConfig?.RestartPolicy?.Name || "",
      startupCommandCount: matches.length,
      startupCommandIsSleepInfinity: tokens.length === 2
        && tokens[0] === "sleep" && tokens[1] === "infinity",
      startupCommandEndsWithNemoclawStart: tokens.length > 0
        && ["nemoclaw-start", "/usr/local/bin/nemoclaw-start"].includes(tokens.at(-1)),
    }) + "\n");
  '
  printf '%s\n' "== container $container_id host process tree =="
  "\${runtime_command[@]}" container top "$container_id" -eo pid,ppid,user,stat,comm 2>&1
  printf '%s\n' "== container $container_id runtime state =="
  "\${runtime_command[@]}" container exec "$container_id" sh -lc '
    printf "%s\n" "== pid 1 =="
    cat /proc/1/comm 2>/dev/null || true
    printf "\n%s\n" "== process tree =="
    ps -eo user=,pid=,ppid=,stat=,comm= 2>&1 || true
    printf "%s\n" "== direct gateway health =="
    curl -q --noproxy "*" -sS -o /dev/null -w "HTTP %{http_code}\n" \
      --connect-timeout 2 --max-time 5 http://127.0.0.1:18789/health 2>&1 || true
    printf "%s\n" "== managed controller status =="
    cat /run/nemoclaw/gateway-control/status 2>&1 || true
    printf "%s\n" "== startup log =="
    tail -n 300 /tmp/nemoclaw-start.log 2>&1 || true
    printf "%s\n" "== gateway log =="
    tail -n 300 /tmp/gateway.log 2>&1 || true
  ' 2>&1
  printf '%s\n' "== container $container_id logs =="
  "\${runtime_command[@]}" container logs --tail 300 "$container_id" 2>&1
done
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function versionGte(actual: string, minimum: string): boolean {
  const actualParts = actual.split(".").map((part) => Number.parseInt(part, 10));
  const minimumParts = minimum.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const a = Number.isFinite(actualParts[index]) ? actualParts[index] : 0;
    const b = Number.isFinite(minimumParts[index]) ? minimumParts[index] : 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function extractSemver(raw: string): string | undefined {
  return raw.match(/\d+\.\d+\.\d+/)?.[0];
}

function installEnv(hostedEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...hostedEnv,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_AGENT: "openclaw",
  };
}

async function captureSurvivalDiagnostics(
  host: HostCliClient,
  runtimeProvider: RuntimeProviderPrerequisite,
  stage: string,
  redactionValues: string[],
): Promise<void> {
  const invocation = runtimeProvider.hostInvocation([]);
  await host.command(
    "bash",
    [
      "-lc",
      SURVIVAL_DIAGNOSTICS_SCRIPT,
      "sandbox-survival-diagnostics",
      SANDBOX_NAME,
      invocation.command,
      ...invocation.args,
    ],
    {
      artifactName: `sandbox-survival-${stage}-diagnostics`,
      env: buildAvailabilityProbeEnv(),
      redactionValues,
      timeoutMs: 60_000,
    },
  );
}

async function expectSandboxExecAlive(
  sandboxName: string,
  exec: (
    script: string,
    artifactName: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>,
  artifactName: string,
): Promise<void> {
  const alive = await exec("echo alive", artifactName);
  expect(alive.exitCode, `${sandboxName} exec failed: ${resultText(alive)}`).toBe(0);
  expect(alive.stdout.trim(), resultText(alive)).toBe("alive");
}

test(
  "sandbox survives gateway restart with registry, state, SSH, and live inference intact",
  {
    timeout: 30 * 60_000,
    meta: {
      e2ePhases: [
        "confirm the selected runtime and inference prerequisites",
        "install and register the OpenClaw sandbox",
        "prove baseline sandbox access and inference",
        "write persistent OpenClaw markers",
        "restart the gateway and reconnect the sandbox",
        "recheck state and inference after restart",
        "destroy the sandbox and confirm registry removal",
      ],
    },
  },
  async ({
    artifacts,
    cleanup,
    host,
    lifecycle,
    provider,
    progress,
    runtime,
    runtimeProvider,
    sandbox,
    secrets,
    skip,
    stateValidation,
  }) => {
    const hosted = requireHostedInferenceConfig(secrets);
    const apiKey = hosted.apiKey;

    await artifacts.target.declare({
      id: "sandbox-survival",
      boundary: "install-sh-docker-openshell-gateway-sandbox-inference",
      contracts: [
        "install.sh --non-interactive creates the named OpenClaw sandbox",
        "NemoClaw registry, nemoclaw list/status, and openshell sandbox list discover the sandbox",
        "OpenShell version supports gateway resume and state persistence",
        "sandbox exec/SSH-equivalent access works before and after gateway restart",
        "inference.local returns a live PONG before and after gateway restart",
        "declared workspace, session, and memory markers survive the gateway stop/start cycle",
        "final destroy removes the sandbox from NemoClaw registry/list state",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "prereq-runtime-info-sandbox-survival",
      scenarioLabel: "sandbox survival",
    });

    const endpointReachable = await provider.probeReachability(
      trustedProviderEndpoint(hosted.endpointUrl, {
        allowedHosts: ["inference-api.nvidia.com"],
      }),
      {
        artifactName: "prereq-inference-api-reachability",
        env: buildAvailabilityProbeEnv(),
        redactionValues: [apiKey],
        timeoutMs: 25_000,
      },
    );
    const reachabilityStatus = endpointReachable.stdout.trim();
    expect(endpointReachable.exitCode, resultText(endpointReachable)).toBe(0);
    expect(["000", "401", "403"], resultText(endpointReachable)).not.toContain(reachabilityStatus);
    expect(Number(reachabilityStatus), resultText(endpointReachable)).toBeLessThan(500);
    expect(fs.existsSync(path.join(REPO_ROOT, "install.sh"))).toBe(true);

    await host.bestEffortCleanupSandbox(SANDBOX_NAME, {
      artifactName: "pre-cleanup-nemoclaw-destroy-sandbox-survival",
    });
    await host.command(
      "sh",
      [
        "-lc",
        `command -v openshell >/dev/null 2>&1 && openshell sandbox delete ${SANDBOX_NAME} || true`,
      ],
      {
        artifactName: "pre-cleanup-openshell-delete-sandbox-survival",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      },
    );
    await lifecycle.stopGatewayRuntime();
    await host.command(
      "sh",
      [
        "-lc",
        "command -v openshell >/dev/null 2>&1 && openshell gateway destroy -g nemoclaw || true",
      ],
      {
        artifactName: "pre-cleanup-openshell-gateway-destroy",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      },
    );
    fs.rmSync(path.join(process.env.HOME ?? "", ".nemoclaw", "onboard.lock"), {
      force: true,
    });

    const gatewayCleanupOptions = {
      artifactName: "cleanup-openshell-gateway-destroy",
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    };
    cleanup.trackGateway(
      {
        cleanupGatewayRegistration: (name: string) =>
          cleanupWhenOpenShellAvailable(
            host,
            {
              artifactName: "cleanup-probe-openshell-gateway-sandbox-survival",
              env: gatewayCleanupOptions.env,
              redactionValues: gatewayCleanupOptions.redactionValues,
              timeoutMs: 30_000,
            },
            () => host.cleanupGatewayRegistration(name, gatewayCleanupOptions),
          ),
      },
      "nemoclaw",
      gatewayCleanupOptions,
    );
    const sandboxCleanupOptions = {
      artifactName: "cleanup-nemoclaw-destroy-sandbox-survival",
      redactionValues: [apiKey],
    };
    cleanup.trackSandbox(
      {
        cleanupSandbox: (name: string) =>
          cleanupWhenCommandAvailable(
            host,
            host.commandPath,
            {
              artifactName: "cleanup-probe-nemoclaw-sandbox-survival",
              env: buildAvailabilityProbeEnv(),
              redactionValues: sandboxCleanupOptions.redactionValues,
              timeoutMs: 30_000,
            },
            () => host.cleanupSandbox(name, sandboxCleanupOptions),
          ),
      },
      SANDBOX_NAME,
      sandboxCleanupOptions,
    );

    progress.phase("install and register the OpenClaw sandbox");
    const install = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "install-sh-sandbox-survival",
      cwd: REPO_ROOT,
      env: installEnv(hosted.env),
      redactionValues: [apiKey],
      timeoutMs: 20 * 60_000,
    });
    expect(install.exitCode, resultText(install)).toBe(0);

    await host.expectNemoclawAvailable();
    const openshellVersion = await host.command("openshell", ["--version"], {
      artifactName: "openshell-version-sandbox-survival",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    assertExitZero(openshellVersion, "openshell --version");
    const version = extractSemver(resultText(openshellVersion));
    expect(version, resultText(openshellVersion)).toBeTruthy();
    expect(versionGte(version!, MIN_OPENSHELL_VERSION), resultText(openshellVersion)).toBe(true);

    const instance: NemoClawInstance = {
      onboarding: "cloud-openclaw",
      sandboxName: SANDBOX_NAME,
      agent: "openclaw",
      provider: "nvidia",
      providerEnv: "cloud",
      platformOs: "ubuntu",
      gatewayUrl: "http://127.0.0.1:18789",
      result: install,
    };

    stateValidation.expectLocalRegistryContains(SANDBOX_NAME);
    await host.expectListed(SANDBOX_NAME, {
      artifactName: "post-install-nemoclaw-list",
    });
    await sandbox.expectListed(SANDBOX_NAME, {
      artifactName: "post-install-openshell-sandbox-list",
    });
    await host.expectStatus(SANDBOX_NAME, {
      artifactName: "post-install-nemoclaw-status",
    });

    progress.phase("prove baseline sandbox access and inference");
    const execShell = (script: string, artifactName: string) =>
      sandbox.exec(SANDBOX_NAME, ["sh", "-lc", script], {
        artifactName,
        env: sandboxAccessEnv(),
        timeoutMs: 60_000,
      });
    await expectSandboxExecAlive(SANDBOX_NAME, execShell, "baseline-sandbox-exec-alive");

    await runtime.expectInferenceLocalPong(instance, {
      artifactName: "baseline-inference-local-pong",
      model: MODEL,
      curlMaxTimeSeconds: 60,
      timeoutMs: 90_000,
      redactionValues: [apiKey],
    });

    progress.phase("write persistent OpenClaw markers");
    const markerValue = `nemoclaw-survival-${Date.now()}`;
    const markers: SandboxMarker[] = [
      {
        path: "/sandbox/.openclaw/workspace/.survival-workspace-marker",
        value: markerValue,
      },
      {
        path: "/sandbox/.openclaw/agents/main/sessions/.survival-session-marker",
        value: markerValue,
      },
      {
        path: "/sandbox/.openclaw/memory/.survival-memory-marker",
        value: markerValue,
      },
    ];
    await stateValidation.writeSandboxMarkers(instance, markers);
    await stateValidation.expectSandboxMarkers(instance, markers, "pre-restart-marker-read");

    progress.phase("restart the gateway and reconnect the sandbox");
    await captureSurvivalDiagnostics(host, runtimeProvider, "before-gateway-restart", [apiKey]);
    await lifecycle.restartGatewayRuntime({
      delayMs: 5_000,
      sandboxName: SANDBOX_NAME,
    });
    await captureSurvivalDiagnostics(host, runtimeProvider, "after-gateway-restart", [apiKey]);
    await lifecycle.waitForGatewayConnected({
      attempts: 60,
      intervalMs: 5_000,
    });

    progress.phase("recheck state and inference after restart");
    await lifecycle.assertSandboxReadyAfterGatewayRestart(instance, {
      artifactNamePrefix: "post-restart-openshell-sandbox-ready",
    });
    stateValidation.expectLocalRegistryContains(SANDBOX_NAME);
    await host.expectListed(SANDBOX_NAME, {
      artifactName: "post-restart-nemoclaw-list",
    });
    await host.expectStatus(SANDBOX_NAME, {
      artifactName: "post-restart-nemoclaw-status",
      timeoutMs: 120_000,
    });
    await stateValidation.from("cloud-openclaw-ready", instance);
    await expectSandboxExecAlive(SANDBOX_NAME, execShell, "post-restart-sandbox-exec-alive");
    await stateValidation.expectSandboxMarkers(instance, markers, "post-restart-marker-read");
    await stateValidation.expectSandboxDirectoryPopulated(
      instance,
      "/sandbox/.openclaw",
      "post-restart-openclaw-directory-populated",
    );

    await runtime.expectInferenceLocalPong(instance, {
      artifactName: "post-restart-inference-local-pong",
      model: MODEL,
      curlMaxTimeSeconds: 60,
      timeoutMs: 90_000,
      redactionValues: [apiKey],
    });

    progress.phase("destroy the sandbox and confirm registry removal");
    await host.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "final-destroy-sandbox-survival",
      timeoutMs: 15 * 60_000,
    });
    const afterDestroyList = await host.nemoclaw(["list"], {
      artifactName: "post-destroy-nemoclaw-list",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
    expect(resultText(afterDestroyList), "sandbox still listed after destroy").not.toMatch(
      new RegExp(`(^|\\s)${SANDBOX_NAME}(\\s|$)`, "m"),
    );

    await artifacts.target.complete({
      id: "sandbox-survival",
      status: "passed",
      assertions: {
        installCompleted: install.exitCode === 0,
        registryListedBeforeRestart: true,
        inferenceLocalBeforeRestart: true,
        markersPersistedAfterRestart: true,
        inferenceLocalAfterRestart: true,
        destroyedAtEnd: true,
      },
    });
  },
);
