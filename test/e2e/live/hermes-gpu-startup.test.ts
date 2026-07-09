// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  type HostCliClient,
  resultText,
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import {
  assertHermesGpuStartupProof,
  HERMES_GPU_EXTRA_PLACEHOLDER_KEYS,
} from "./hermes-gpu-startup-proof.ts";

const GATEWAY_CLEANUP_MODULE = path.join(REPO_ROOT, "dist/lib/actions/sandbox/destroy-gateway.js");
// Clean runners do not have OpenShell until install.sh runs. Tool absence is
// accepted here only because the bind probe below and the later no-reuse log
// assertions still reject an orphaned runtime or stale registration.
const GATEWAY_CLEANUP_SCRIPT = String.raw`
command -v openshell >/dev/null 2>&1 || exit 0
exec node -e 'const { cleanupGatewayAfterLastSandbox } = require(process.argv[1]); cleanupGatewayAfterLastSandbox(process.argv[2]);' "$@"
`;
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-hermes-gpu-startup";
const FAKE_API_KEY = "e2e-hermes-gpu-startup-key";
const FAKE_MODEL = "test-model";
const EXTRA_PLACEHOLDER_TOKEN_A = "e2e-hermes-gpu-extra-telegram-token";
const EXTRA_PLACEHOLDER_TOKEN_B = "e2e-hermes-gpu-extra-slack-token";
const LIVE_TIMEOUT_MS = 70 * 60_000;
const FORCE_LEGACY_GPU_PATCH = process.env.NEMOCLAW_DOCKER_GPU_PATCH === "1";
const GPU_ROUTE = FORCE_LEGACY_GPU_PATCH ? "legacy-patch" : "native-openshell";
validateSandboxName(SANDBOX_NAME);

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_GPU: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS: "60",
    ...(FORCE_LEGACY_GPU_PATCH ? { NEMOCLAW_DOCKER_GPU_PATCH: "1" } : {}),
  };
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup and failure diagnostics must not mask the primary live-test result.
  }
}

async function cleanupHermes(
  host: HostCliClient,
  sandbox: SandboxClient,
  label: string,
): Promise<void> {
  await bestEffort(() =>
    host.nemoclaw([SANDBOX_NAME, "destroy", "--yes", "--cleanup-gateway"], {
      artifactName: `${label}-nemoclaw-destroy`,
      env: commandEnv(),
      timeoutMs: 120_000,
    }),
  );
  await bestEffort(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: `${label}-openshell-sandbox-delete`,
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
  const runtimeCleanup = await host.command(
    "bash",
    ["-c", GATEWAY_CLEANUP_SCRIPT, "gateway-runtime-cleanup", GATEWAY_CLEANUP_MODULE, "nemoclaw"],
    {
      artifactName: `${label}-gateway-runtime-cleanup`,
      env: commandEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(
    runtimeCleanup.exitCode,
    `owned gateway runtime cleanup failed: ${resultText(runtimeCleanup)}`,
  ).toBe(0);
  await host
    .cleanupGatewayRegistration("nemoclaw", {
      artifactName: `${label}-openshell-gateway`,
      env: commandEnv(),
      timeoutMs: 60_000,
    })
    .catch((error: unknown) => {
      expect(error).toMatchObject({ message: "spawn openshell ENOENT" });
    });
  const gatewayPort = process.env.NEMOCLAW_GATEWAY_PORT ?? "8080";
  const portAvailable = await host.command(
    "node",
    [
      "-e",
      'const net=require("node:net"); const server=net.createServer(); server.once("error", error => { console.error(error.code || "bind failed"); process.exit(1); }); server.listen(Number(process.argv[1]), "127.0.0.1", () => server.close(error => { if (error) { console.error(error.message); process.exit(1); } console.log("available"); }));',
      gatewayPort,
    ],
    {
      artifactName: `${label}-gateway-port-available`,
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(
    portAvailable.exitCode,
    `gateway port ${gatewayPort} remains occupied after cleanup: ${resultText(portAvailable)}`,
  ).toBe(0);
}

async function captureFailedGpuContainer(
  host: HostCliClient,
  preRollbackDiagnosticsDir: string,
): Promise<void> {
  const sandboxFilter = `label=openshell.ai/sandbox-name=${SANDBOX_NAME}`;
  const script = String.raw`set -u
diagnostics_dir="$2"
if [ -n "$diagnostics_dir" ] && [ -d "$diagnostics_dir" ]; then
  printf '%s\n' "== pre-rollback diagnostics $diagnostics_dir =="
  for name in summary.txt patched-container-state.json docker-inspect.json docker-network-summary.txt docker-top.txt docker-logs.txt openshell-sandbox-get.txt openshell-sandbox-list.txt openshell-logs.txt; do
    file="$diagnostics_dir/$name"
    if [ -f "$file" ]; then
      printf '%s\n' "== $name =="
      if [ "$name" = openshell-logs.txt ]; then
        tail -n 800 "$file"
      else
        sed -n '1,800p' "$file"
      fi
    fi
  done
else
  printf '%s\n' "pre-rollback diagnostics directory unavailable: $diagnostics_dir"
fi
ids="$(docker ps -aq --filter "$1")"
if [ -z "$ids" ]; then
  printf '%s\n' "no Docker container found for $1"
  exit 0
fi
for id in $ids; do
  printf '%s\n' "== container $id inspect =="
  docker inspect --format '{{json .Name}} {{json .Config.User}} {{json .Config.Entrypoint}} {{json .Config.Cmd}} {{json .State}} {{json .HostConfig.RestartPolicy}}' "$id" 2>&1 || true
  printf '%s\n' "== container $id top =="
  docker top "$id" -eo user,pid,ppid,stat,args 2>&1 || true
  printf '%s\n' "== container $id logs =="
  docker logs --tail 300 "$id" 2>&1 || true
done`;
  await bestEffort(() =>
    host.command(
      "bash",
      ["-lc", script, "hermes-gpu-failure-diagnostics", sandboxFilter, preRollbackDiagnosticsDir],
      {
        artifactName: "phase-2-hermes-gpu-startup-failure-diagnostics",
        env: buildAvailabilityProbeEnv(),
        redactionValues: [FAKE_API_KEY, EXTRA_PLACEHOLDER_TOKEN_A, EXTRA_PLACEHOLDER_TOKEN_B],
        timeoutMs: 30_000,
      },
    ),
  );
}

test("hermes-gpu-startup: selected OpenShell GPU route reaches stable Ready state", {
  timeout: LIVE_TIMEOUT_MS,
}, async ({ artifacts, cleanup, host, sandbox }) => {
  await artifacts.target.declare({
    id: "hermes-gpu-startup",
    boundary: "install.sh --non-interactive --fresh + Hermes GPU-supervised startup",
    sandboxName: SANDBOX_NAME,
    inference: "hermetic fake OpenAI-compatible endpoint",
    gpuRoute: GPU_ROUTE,
  });

  await cleanupHermes(host, sandbox, "pre-cleanup");

  const dockerInfo = await host.command("docker", ["info"], {
    artifactName: "phase-1-docker-info",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  expect(dockerInfo.exitCode, resultText(dockerInfo)).toBe(0);

  const hostAddress = "host.openshell.internal";

  const fake = await startFakeOpenAiCompatibleServer({
    apiKey: FAKE_API_KEY,
    forbiddenMarkers: [EXTRA_PLACEHOLDER_TOKEN_A, EXTRA_PLACEHOLDER_TOKEN_B],
    host: "0.0.0.0",
    model: FAKE_MODEL,
    publicHost: hostAddress,
    requireAuth: true,
  });
  cleanup.add("close fake OpenAI-compatible endpoint", async () => {
    await artifacts.writeJson("fake-openai-compatible-requests.json", fake.requests());
    await fake.close();
  });
  cleanup.add(`destroy Hermes sandbox ${SANDBOX_NAME}`, async () => {
    await cleanupHermes(host, sandbox, "cleanup");
  });
  await artifacts.writeJson("fake-openai-compatible.json", {
    baseUrl: fake.baseUrl,
    model: FAKE_MODEL,
    publicHost: hostAddress,
  });

  const env = commandEnv({
    COMPATIBLE_API_KEY: FAKE_API_KEY,
    NEMOCLAW_COMPAT_MODEL: FAKE_MODEL,
    NEMOCLAW_ENDPOINT_URL: fake.baseUrl,
    NEMOCLAW_MODEL: FAKE_MODEL,
    NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: HERMES_GPU_EXTRA_PLACEHOLDER_KEYS.join(","),
    NEMOCLAW_POLICY_MODE: "suggested",
    NEMOCLAW_PREFERRED_API: "openai-completions",
    NEMOCLAW_PROVIDER: "custom",
    [HERMES_GPU_EXTRA_PLACEHOLDER_KEYS[0]]: EXTRA_PLACEHOLDER_TOKEN_A,
    [HERMES_GPU_EXTRA_PLACEHOLDER_KEYS[1]]: EXTRA_PLACEHOLDER_TOKEN_B,
  });
  const install = await host.command("bash", ["install.sh", "--non-interactive", "--fresh"], {
    artifactName: "phase-2-install-hermes-gpu-startup",
    cwd: REPO_ROOT,
    env,
    redactionValues: [FAKE_API_KEY, EXTRA_PLACEHOLDER_TOKEN_A, EXTRA_PLACEHOLDER_TOKEN_B],
    timeoutMs: 60 * 60_000,
  });
  const preRollbackDiagnosticsDir =
    resultText(install).match(/Pre-rollback diagnostics saved:\s*(\S+)/)?.[1] ?? "";
  await (install.exitCode !== 0
    ? captureFailedGpuContainer(host, preRollbackDiagnosticsDir)
    : Promise.resolve());
  expect(install.exitCode, resultText(install)).toBe(0);

  const status = await host.command("nemoclaw", [SANDBOX_NAME, "status"], {
    artifactName: "phase-3-nemoclaw-status",
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(status.exitCode, resultText(status)).toBe(0);

  await assertHermesGpuStartupProof({
    env: commandEnv(),
    gpuRoute: GPU_ROUTE,
    host,
    install,
    sandbox,
    sandboxName: SANDBOX_NAME,
    status,
  });

  const inference = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      `curl -fsS --max-time 60 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' --data '${JSON.stringify(
        {
          model: FAKE_MODEL,
          messages: [{ role: "user", content: "reply with OK" }],
          max_tokens: 8,
        },
      )}'`,
    ),
    {
      artifactName: "phase-5-authenticated-inference-post",
      env: commandEnv(),
      timeoutMs: 90_000,
    },
  );
  expect(inference.exitCode, resultText(inference)).toBe(0);

  const fakeRequests = fake.requests();
  const inferencePosts = fakeRequests.filter(
    (request) =>
      request.method === "POST" &&
      ["/v1/chat/completions", "/chat/completions", "/v1/responses", "/responses"].includes(
        request.path,
      ),
  );
  expect(
    inferencePosts.length,
    `expected authenticated fake inference POST, got ${JSON.stringify(fakeRequests)}`,
  ).toBeGreaterThan(0);
  expect(inferencePosts.filter((request) => request.auth !== "ok")).toEqual([]);
  expect(inferencePosts.filter((request) => request.authorizationSent !== true)).toEqual([]);
  expect(inferencePosts.filter((request) => (request.forbiddenMarkerMatches ?? 0) > 0)).toEqual([]);
  expect(JSON.stringify(fakeRequests)).not.toContain(EXTRA_PLACEHOLDER_TOKEN_A);
  expect(JSON.stringify(fakeRequests)).not.toContain(EXTRA_PLACEHOLDER_TOKEN_B);

  await artifacts.target.complete({
    id: "hermes-gpu-startup",
    assertions: {
      selectedGpuRouteVerified: true,
      openshellReady: true,
      sandboxCudaVerified: true,
      extraPlaceholderCommandRoundTripValid: true,
      stableSingleContainer: true,
      startupConfigHashesValid: true,
      supervisorTopologyValid: true,
      authenticatedInferenceRequestVerified: true,
      placeholderTokensAbsentFromInference: true,
    },
  });
});
