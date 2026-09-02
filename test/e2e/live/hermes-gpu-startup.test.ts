// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertStockManagedImageReceipt } from "../fixtures/managed-image-receipt.ts";
import { cleanupUnlessVerified } from "../fixtures/cleanup-resources.ts";
import {
  type HostCliClient,
  outputContainsSandbox,
  resultText,
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";
import {
  createHermesGpuFallbackWrapper,
  extractHermesGpuDiagnosticsDirectory,
  HERMES_GPU_FALLBACK_EVENTS,
  readHermesGpuFallbackEvents,
  resolveHermesGpuStartupScenario,
} from "./hermes-gpu-startup-fallback.ts";
import {
  assertHermesGpuStartupProof,
  HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS,
} from "./hermes-gpu-startup-proof.ts";

const GATEWAY_CLEANUP_MODULE = path.join(REPO_ROOT, "dist/lib/actions/sandbox/destroy-gateway.js");
// Clean runners do not have OpenShell until install.sh runs. Tool absence is
// accepted here only because the bind probe below and the later no-reuse log
// assertions still reject an orphaned runtime or stale registration.
const GATEWAY_CLEANUP_SCRIPT = String.raw`
command -v openshell >/dev/null 2>&1 || exit 0
exec node -e 'const { cleanupGatewayAfterLastSandbox } = require(process.argv[1]); cleanupGatewayAfterLastSandbox(process.argv[2]);' "$@"
`;
const GATEWAY_ALREADY_ABSENT =
  /gateway[^\n]*(?:does not exist|not found)|No (?:active )?gateway|No gateway metadata found/i;
const FAKE_API_KEY = "e2e-hermes-gpu-startup-key";
const FAKE_MODEL = "test-model";
const LIVE_TIMEOUT_MS = 70 * 60_000;
const { route: GPU_ROUTE, scenario: GPU_STARTUP_SCENARIO } = resolveHermesGpuStartupScenario(
  process.env.E2E_HERMES_GPU_STARTUP_SCENARIO,
  process.env.NEMOCLAW_DOCKER_GPU_PATCH === "1",
);
const SANDBOX_NAME =
  process.env.NEMOCLAW_SANDBOX_NAME ??
  (GPU_STARTUP_SCENARIO === "fallback"
    ? "e2e-hgpu-fallback"
    : GPU_STARTUP_SCENARIO === "compatibility-only"
      ? "e2e-hgpu-compat"
      : "e2e-hgpu-native");
const GPU_ROUTE_CONTROL =
  GPU_ROUTE === "compatibility-only"
    ? "1"
    : GPU_ROUTE === "compatibility-fallback"
      ? "fallback"
      : undefined;
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
    ...(GPU_ROUTE_CONTROL ? { NEMOCLAW_DOCKER_GPU_PATCH: GPU_ROUTE_CONTROL } : {}),
  };
}

async function preCleanBestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Pre-cleanup must not mask the primary live-test result.
  }
}

async function captureDiagnosticsBestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Failure diagnostics must not mask the primary live-test result.
  }
}

async function expectSandboxAbsent(host: HostCliClient, label: string): Promise<void> {
  // Check the OpenShell control-plane view before intentionally removing its
  // gateway. A clean runner can have the CLI installed but no active gateway;
  // that explicit state is also valid absence evidence.
  const sandboxList = await host.command(
    "bash",
    [
      "-lc",
      "if command -v openshell >/dev/null 2>&1; then openshell sandbox list; else printf '%s\\n' openshell-unavailable; fi",
    ],
    {
      artifactName: `${label}-openshell-sandbox-absent`,
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  const sandboxAbsenceProven =
    sandboxList.exitCode === 0
      ? !outputContainsSandbox(sandboxList, SANDBOX_NAME)
      : GATEWAY_ALREADY_ABSENT.test(resultText(sandboxList));
  expect(sandboxAbsenceProven, resultText(sandboxList)).toBe(true);
}

async function cleanupOwnedGatewayRuntime(host: HostCliClient, label: string): Promise<void> {
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
}

async function cleanupGatewayRegistrationBeforeTest(
  host: HostCliClient,
  label: string,
): Promise<void> {
  await host
    .cleanupGatewayRegistration("nemoclaw", {
      artifactName: `${label}-openshell-gateway`,
      env: commandEnv(),
      timeoutMs: 60_000,
    })
    .catch((error: unknown) => {
      expect(error).toMatchObject({ message: "spawn openshell ENOENT" });
    });
}

async function expectGatewayPortAvailable(
  host: HostCliClient,
  runtimeProvider: RuntimeProviderPrerequisite,
  label: string,
): Promise<void> {
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

  const labeledContainers = await runtimeProvider.command(
    [
      "container",
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=openshell.ai/sandbox-name=${SANDBOX_NAME}`,
    ],
    {
      artifactName: `${label}-labeled-containers-absent`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(labeledContainers.exitCode, resultText(labeledContainers)).toBe(0);
  expect(labeledContainers.stdout.trim()).toBe("");

  const namedContainers = await runtimeProvider.command(
    ["container", "ps", "--all", "--filter", `name=${SANDBOX_NAME}`, "--format", "{{.Names}}"],
    {
      artifactName: `${label}-backup-containers-absent`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(namedContainers.exitCode, resultText(namedContainers)).toBe(0);
  expect(
    namedContainers.stdout
      .split(/\r?\n/u)
      .filter((name) => name.includes(`${SANDBOX_NAME}-nemoclaw-gpu-backup-`)),
  ).toEqual([]);
}

async function cleanupHermes(
  host: HostCliClient,
  runtimeProvider: RuntimeProviderPrerequisite,
  sandbox: SandboxClient,
  label: string,
): Promise<void> {
  await host.cleanupSandbox(SANDBOX_NAME, {
    artifactName: `${label}-nemoclaw-destroy`,
    env: commandEnv(),
    timeoutMs: 120_000,
  });
  await sandbox.cleanupSandbox(SANDBOX_NAME, {
    artifactName: `${label}-openshell-sandbox-delete`,
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  await expectSandboxAbsent(host, label);
  await cleanupOwnedGatewayRuntime(host, label);
  await host.cleanupGatewayRegistration("nemoclaw", {
    artifactName: `${label}-openshell-gateway`,
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  await expectGatewayPortAvailable(host, runtimeProvider, label);
}

async function preCleanHermes(
  host: HostCliClient,
  runtimeProvider: RuntimeProviderPrerequisite,
  sandbox: SandboxClient,
  label: string,
): Promise<void> {
  await preCleanBestEffort(() =>
    host.nemoclaw([SANDBOX_NAME, "destroy", "--yes", "--cleanup-gateway"], {
      artifactName: `${label}-nemoclaw-destroy`,
      env: commandEnv(),
      timeoutMs: 120_000,
    }),
  );
  await preCleanBestEffort(() =>
    sandbox.cleanupSandbox(SANDBOX_NAME, {
      artifactName: `${label}-openshell-sandbox-delete`,
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
  await expectSandboxAbsent(host, label);
  await cleanupOwnedGatewayRuntime(host, label);
  await cleanupGatewayRegistrationBeforeTest(host, label);
  await expectGatewayPortAvailable(host, runtimeProvider, label);
}

async function captureFailedGpuContainer(
  host: HostCliClient,
  runtimeProvider: RuntimeProviderPrerequisite,
  preRollbackDiagnosticsDir: string,
): Promise<void> {
  const sandboxFilter = `label=openshell.ai/sandbox-name=${SANDBOX_NAME}`;
  const runtimeInvocation = runtimeProvider.hostInvocation([]);
  const script = String.raw`set -u
sandbox_filter="$1"
diagnostics_dir="$2"
shift 2
runtime_command=("$@")
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
ids="$("\${runtime_command[@]}" container ps --all --quiet --filter "$sandbox_filter")"
if [ -z "$ids" ]; then
  printf '%s\n' "no runtime container found for $sandbox_filter"
  exit 0
fi
for id in $ids; do
  printf '%s\n' "== container $id inspect =="
  "\${runtime_command[@]}" container inspect --format '{{json .Name}} {{json .Config.User}} {{json .Config.Entrypoint}} {{json .Config.Cmd}} {{json .State}} {{json .HostConfig.RestartPolicy}}' "$id" 2>&1 || true
  printf '%s\n' "== container $id top =="
  "\${runtime_command[@]}" container top "$id" -eo user,pid,ppid,stat,args 2>&1 || true
  printf '%s\n' "== container $id logs =="
  "\${runtime_command[@]}" container logs --tail 300 "$id" 2>&1 || true
done`;
  await captureDiagnosticsBestEffort(() =>
    host.command(
      "bash",
      [
        "-lc",
        script,
        "hermes-gpu-failure-diagnostics",
        sandboxFilter,
        preRollbackDiagnosticsDir,
        runtimeInvocation.command,
        ...runtimeInvocation.args,
      ],
      {
        artifactName: "phase-2-hermes-gpu-startup-failure-diagnostics",
        env: buildAvailabilityProbeEnv(),
        redactionValues: [FAKE_API_KEY],
        timeoutMs: 30_000,
      },
    ),
  );
}

test(
  `hermes-gpu-startup: ${GPU_STARTUP_SCENARIO} OpenShell GPU route reaches stable Ready state`,
  {
    timeout: LIVE_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "prepare clean Hermes GPU runner",
        "install Hermes sandbox on selected GPU route",
        "validate GPU startup and supervisor proof",
        "exercise authenticated GPU inference route",
        "remove Hermes GPU resources",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    await artifacts.target.declare({
      id: "hermes-gpu-startup",
      boundary: "install.sh --non-interactive --fresh + Hermes GPU-supervised startup",
      sandboxName: SANDBOX_NAME,
      inference: "hermetic fake OpenAI-compatible endpoint",
      gpuRoute: GPU_ROUTE,
      scenario: GPU_STARTUP_SCENARIO,
    });

    await preCleanHermes(host, runtimeProvider, sandbox, "pre-cleanup");

    await runtimeProvider.requireAvailable({
      artifactName: "phase-1-runtime-info",
      scenarioLabel: "Hermes GPU startup",
    });

    const hostAddress = "host.openshell.internal";

    const fake = await startFakeOpenAiCompatibleServer({
      apiKey: FAKE_API_KEY,
      host: "0.0.0.0",
      model: FAKE_MODEL,
      progress,
      publicHost: hostAddress,
      requireAuth: true,
    });
    cleanup.trackDisposable("close fake OpenAI-compatible endpoint", async () => {
      await artifacts.writeJson("fake-openai-compatible-requests.json", fake.requests());
      await fake.close();
    });
    let cleanTeardownVerified = false;
    const cleanupEnv = commandEnv();
    const cleanupHost: Pick<HostCliClient, "cleanupGatewayRegistration" | "cleanupSandbox"> = {
      cleanupGatewayRegistration: (name, options) =>
        cleanupUnlessVerified(cleanTeardownVerified, () =>
          host.cleanupGatewayRegistration(name, options),
        ),
      cleanupSandbox: (name, options) =>
        cleanupUnlessVerified(cleanTeardownVerified, () => host.cleanupSandbox(name, options)),
    };
    // Phase 5 runs this ordered teardown explicitly so the target can record a
    // clean-teardown proof. Once that succeeds, fixture teardown must not retry
    // resource operations after their OpenShell gateway has been removed.
    cleanup.trackDisposable("verify Hermes GPU gateway port is available", () =>
      cleanupUnlessVerified(cleanTeardownVerified, () =>
        expectGatewayPortAvailable(host, runtimeProvider, "cleanup"),
      ),
    );
    cleanup.trackGateway(cleanupHost, "nemoclaw", {
      artifactName: "cleanup-openshell-gateway",
      env: cleanupEnv,
      timeoutMs: 60_000,
    });
    cleanup.trackDisposable("clean up owned Hermes GPU gateway runtime", () =>
      cleanupUnlessVerified(cleanTeardownVerified, () =>
        cleanupOwnedGatewayRuntime(host, "cleanup"),
      ),
    );
    cleanup.trackDisposable("verify Hermes GPU sandbox is absent", () =>
      cleanupUnlessVerified(cleanTeardownVerified, () => expectSandboxAbsent(host, "cleanup")),
    );
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      cleanupUnlessVerified(cleanTeardownVerified, () =>
        sandbox.cleanupSandbox(SANDBOX_NAME, {
          artifactName: "cleanup-openshell-sandbox-delete",
          env: cleanupEnv,
          timeoutMs: 60_000,
        }),
      ),
    );
    cleanup.trackSandbox(cleanupHost, SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-destroy",
      env: cleanupEnv,
      timeoutMs: 120_000,
    });
    await artifacts.writeJson("fake-openai-compatible.json", {
      baseUrl: fake.baseUrl,
      model: FAKE_MODEL,
      publicHost: hostAddress,
    });

    const prepareFallbackWrapper = async () => {
      const openshellInstall = await host.command(
        "bash",
        [path.join(REPO_ROOT, "scripts/install-openshell.sh")],
        {
          artifactName: "phase-2-install-openshell-for-gpu-fallback-wrapper",
          cwd: REPO_ROOT,
          env: commandEnv(),
          timeoutMs: 5 * 60_000,
        },
      );
      expect(openshellInstall.exitCode, resultText(openshellInstall)).toBe(0);
      const realOpenshell = await host.command("bash", ["-lc", "command -v openshell"], {
        artifactName: "phase-2-resolve-real-openshell-for-gpu-fallback-wrapper",
        env: commandEnv(),
        timeoutMs: 30_000,
      });
      expect(realOpenshell.exitCode, resultText(realOpenshell)).toBe(0);
      const wrapper = createHermesGpuFallbackWrapper(realOpenshell.stdout.trim());
      // Security-scoped #6110 fault injection: always remove the private wrapper root through the
      // E2E cleanup stack. Do not generalize PATH interception to other tests without review.
      cleanup.trackDisposable("remove Hermes GPU fallback wrapper", () =>
        fs.rmSync(wrapper.rootDir, { recursive: true, force: true }),
      );
      await artifacts.writeJson("gpu-fallback-wrapper.json", {
        behavior:
          "reject the exact native --gpu create before progress, then delegate one compatibility create and GPU proof",
        eventVocabulary: HERMES_GPU_FALLBACK_EVENTS,
      });
      return wrapper;
    };
    const fallbackWrapper =
      GPU_STARTUP_SCENARIO === "fallback" ? await prepareFallbackWrapper() : undefined;

    const env = commandEnv({
      COMPATIBLE_API_KEY: FAKE_API_KEY,
      NEMOCLAW_COMPAT_MODEL: FAKE_MODEL,
      NEMOCLAW_ENDPOINT_URL: fake.baseUrl,
      NEMOCLAW_MODEL: FAKE_MODEL,
      NEMOCLAW_POLICY_MODE: "suggested",
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
      ...(fallbackWrapper?.componentEnv ?? {}),
    });
    progress.phase("install Hermes sandbox on selected GPU route");
    const install = await host.command("bash", ["install.sh", "--non-interactive", "--fresh"], {
      artifactName: "phase-2-install-hermes-gpu-startup",
      cwd: REPO_ROOT,
      env,
      redactionValues: [FAKE_API_KEY],
      timeoutMs: 60 * 60_000,
    });
    const gpuDiagnosticsDir = extractHermesGpuDiagnosticsDirectory(resultText(install));
    await (install.exitCode !== 0
      ? captureFailedGpuContainer(host, runtimeProvider, gpuDiagnosticsDir)
      : Promise.resolve());
    expect(install.exitCode, resultText(install)).toBe(0);
    assertStockManagedImageReceipt({
      environment: env,
      expectedAgent: "hermes",
      sandboxName: SANDBOX_NAME,
    });

    const verifyFallback = async (wrapper: ReturnType<typeof createHermesGpuFallbackWrapper>) => {
      const fallbackEvents = readHermesGpuFallbackEvents(wrapper.eventsPath);
      await artifacts.writeJson("gpu-fallback-events.json", fallbackEvents);
      expect(fallbackEvents).toEqual([
        HERMES_GPU_FALLBACK_EVENTS.rejectNativeCreateBeforeProgress,
        HERMES_GPU_FALLBACK_EVENTS.delegateCompatibilityCreate,
        HERMES_GPU_FALLBACK_EVENTS.delegateNvidiaSmiProofAfterFallback,
      ]);
      expect(resultText(install)).toContain("Native GPU diagnostics saved:");
      expect(
        HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS.every((fragment) =>
          resultText(install).includes(fragment),
        ),
      ).toBe(true);
    };
    await (fallbackWrapper ? verifyFallback(fallbackWrapper) : Promise.resolve());

    progress.phase("validate GPU startup and supervisor proof");
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
      runtimeProvider,
      sandbox,
      sandboxName: SANDBOX_NAME,
      status,
    });

    progress.phase("exercise authenticated GPU inference route");
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

    progress.phase("remove Hermes GPU resources");
    await cleanupHermes(host, runtimeProvider, sandbox, "phase-5-clean-teardown");
    cleanTeardownVerified = true;

    await artifacts.target.complete({
      id: "hermes-gpu-startup",
      gpuRoute: GPU_ROUTE,
      scenario: GPU_STARTUP_SCENARIO,
      assertions: {
        selectedGpuRouteVerified: true,
        ...(GPU_ROUTE === "compatibility-fallback"
          ? { automaticCompatibilityFallbackVerified: true }
          : GPU_ROUTE === "native-success"
            ? { nativeGpuRouteVerified: true }
            : { compatibilityOnlyRouteVerified: true }),
        openshellReady: true,
        sandboxCudaVerified: true,
        managedWorkloadAuthorityVerified: true,
        stableSingleContainer: true,
        startupConfigHashesValid: true,
        supervisorTopologyValid: true,
        authenticatedInferenceRequestVerified: true,
        cleanTeardownVerified,
      },
    });
  },
);
