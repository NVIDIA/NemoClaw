// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  cleanupWhenCommandAvailable,
  cleanupWhenOpenShellAvailable,
} from "../fixtures/cleanup-resources.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-jetson-nvmap";
const TIMEOUT_MS = 50 * 60_000;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    HOME: process.env.HOME,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_JETSON_WORKSPACE: process.env.NEMOCLAW_JETSON_WORKSPACE,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_PROVIDER: process.env.NEMOCLAW_PROVIDER ?? "ollama",
    NEMOCLAW_RECREATE_SANDBOX: "1",
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

function expectGroupMembership(idGroupsOutput: string, gid: string): void {
  expect(gid).toMatch(/^[0-9]+$/u);
  expect(idGroupsOutput.trim().split(/\s+/u)).toContain(gid);
}

test("Jetson nvmap GPU onboard grants device-node group and reports verified CUDA", {
  timeout: TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "detect Jetson hardware",
      "clear previous Jetson runtime state",
      "confirm nvmap and NVIDIA Docker runtime",
      "install NemoClaw on the Jetson host",
      "inspect sandbox nvmap access",
      "prove CUDA initialization inside the sandbox",
      "confirm verified GPU status",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, sandbox, skip }) => {
  await artifacts.target.declare({
    id: "jetson-nvmap-gpu",
    issue: 4231,
    boundary:
      "Jetson/Tegra host + install.sh Ollama onboard + Docker NVIDIA runtime + OpenShell sandbox exec + CUDA cuInit proof + nemoclaw status",
    sandboxName: SANDBOX_NAME,
  });

  // A1: non-Jetson hosts skip cleanly before mutating Docker/OpenShell state.
  const hardwareGate = await hostShell(
    host,
    String.raw`if [ -e /dev/nvmap ]; then
  echo "jetson:/dev/nvmap"
elif [ -f /etc/nv_tegra_release ]; then
  echo "jetson:/etc/nv_tegra_release"
elif [ -r /proc/device-tree/model ] && grep -qi "jetson\|orin\|tegra" /proc/device-tree/model 2>/dev/null; then
  printf 'jetson:model:'
  tr -d '\0' </proc/device-tree/model
  printf '\n'
else
  echo "non-jetson"
fi`,
    "phase-0-jetson-hardware-gate",
  );
  expect(hardwareGate.exitCode, resultText(hardwareGate)).toBe(0);
  hardwareGate.stdout.startsWith("jetson:") ||
    skip(
      "Not a Jetson/Tegra host (/dev/nvmap absent) — reporter workflow requires Jetson hardware; hermetic #4231 coverage remains in src/lib/onboard/docker-gpu-patch.test.ts.",
    );

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

  progress.phase("confirm nvmap and NVIDIA Docker runtime");
  const hostNvmap = await hostShell(
    host,
    "ls -l /dev/nvmap && stat -c 'gid=%g group=%G' /dev/nvmap",
    "phase-0-host-nvmap",
  );
  expect(hostNvmap.exitCode, resultText(hostNvmap)).toBe(0);
  expect(hostNvmap.stdout).toContain("/dev/nvmap");
  const hostNvmapGid = hostNvmap.stdout.match(/gid=([0-9]+)/u)?.[1] ?? "";
  expect(hostNvmapGid).toMatch(/^[0-9]+$/u);

  expect(env().NEMOCLAW_NON_INTERACTIVE).toBe("1");
  expect(env().NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE).toBe("1");

  // A2: Jetson prerequisites match the original lane: Docker and the NVIDIA runtime.
  const docker = await host.command("docker", ["info"], {
    artifactName: "phase-1-docker-info",
    env: env(),
    timeoutMs: 30_000,
  });
  expect(docker.exitCode, resultText(docker)).toBe(0);
  const dockerRuntimes = await host.command("docker", ["info", "--format", "{{json .Runtimes}}"], {
    artifactName: "phase-1-docker-runtimes",
    env: env(),
    timeoutMs: 30_000,
  });
  expect(dockerRuntimes.exitCode, resultText(dockerRuntimes)).toBe(0);
  expect(resultText(dockerRuntimes)).toMatch(/"nvidia"|nvidia:/u);

  // A3: preserve the reporter workflow by installing/running the real onboarding shell path.
  progress.phase("install NemoClaw on the Jetson host");
  const ollamaBaseline = await hostShell(
    host,
    "command -v ollama && ollama list",
    "phase-1-ollama-baseline",
    120_000,
  );
  expect(ollamaBaseline.exitCode, resultText(ollamaBaseline)).toBe(0);

  const install = await host.command("bash", ["install.sh", "--non-interactive"], {
    artifactName: "phase-2-install-jetson-nvmap",
    cwd: REPO_ROOT,
    env: env(),
    timeoutMs: 40 * 60_000,
  });
  await artifacts.writeText("install-jetson-nvmap.log", resultText(install));
  expect(install.exitCode, resultText(install)).toBe(0);

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

  // A4: the Jetson recreate must grant Tegra device-node groups via --group-add.
  expect(resultText(install)).toContain(
    "Granting sandbox user the detected Jetson GPU device groups via --group-add",
  );

  // A5: the sandbox user must be in the host /dev/nvmap owning GID.
  progress.phase("inspect sandbox nvmap access");
  const sandboxId = await sandbox.execShell(SANDBOX_NAME, trustedSandboxShellScript("id -G"), {
    artifactName: "phase-3-sandbox-id-groups",
    env: env(),
    timeoutMs: 60_000,
  });
  expect(sandboxId.exitCode, resultText(sandboxId)).toBe(0);
  expectGroupMembership(resultText(sandboxId), hostNvmapGid);

  // A6: /dev/nvmap must be mounted/present inside the sandbox.
  const sandboxNvmap = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript("ls -l /dev/nvmap"),
    { artifactName: "phase-3-sandbox-nvmap", env: env(), timeoutMs: 60_000 },
  );
  expect(sandboxNvmap.exitCode, resultText(sandboxNvmap)).toBe(0);
  expect(resultText(sandboxNvmap)).toContain("/dev/nvmap");

  // A7: authoritative CUDA usability proof must succeed, not reproduce
  // NvRmMemInitNvmap permission denial / cuInit(0)=999 from #4231.
  progress.phase("prove CUDA initialization inside the sandbox");
  const cudaProbe = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      `python3 -c 'import ctypes; lib = ctypes.CDLL("libcuda.so.1"); rc = lib.cuInit(0); print(f"cuInit(0)={rc}"); raise SystemExit(0 if rc == 0 else 1)'`,
    ),
    { artifactName: "phase-3-sandbox-cuda-cuinit", env: env(), timeoutMs: 120_000 },
  );
  expect(resultText(cudaProbe)).not.toMatch(/NvRmMemInitNvmap|Permission denied/u);
  expect(cudaProbe.exitCode, resultText(cudaProbe)).toBe(0);
  expect(resultText(cudaProbe)).toContain("cuInit(0)=0");

  // A8: status must say enabled with verified CUDA, never bare/unverified/failed.
  progress.phase("confirm verified GPU status");
  const status = await hostShell(
    host,
    `nemoclaw "$NEMOCLAW_SANDBOX_NAME" status`,
    "phase-4-nemoclaw-status",
    120_000,
  );
  expect(status.exitCode, resultText(status)).toBe(0);
  expect(resultText(status)).toContain("Sandbox GPU: enabled");
  expect(resultText(status)).toContain("CUDA verified");
  expect(resultText(status)).not.toMatch(/last CUDA proof failed|CUDA unverified/u);
});
