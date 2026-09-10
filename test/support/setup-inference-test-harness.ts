// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type {
  PodmanExecutableAuthorityDeps,
  PodmanExecutableStat,
  PodmanSocketAuthority,
} from "../../src/lib/adapters/podman";
import type {
  ContainerEngineCommandCapture,
  ContainerEngineCommandResult,
} from "../../src/lib/adapters/container-engine";
import type { CheckpointPortableRuntimeAuthority } from "../../src/lib/state/onboard-checkpoint-types";
import { createPortableOnboardEnvironmentScope } from "../../src/lib/onboard/session-bootstrap";
import { createHermesPortableOllamaInferenceResolver } from "../../src/lib/onboard/experimental/hermes-portable-ollama-inference";
import { PORTABLE_PROBE_IMAGE } from "../../src/lib/onboard/experimental/hermes-portable-ollama-authority";
import { createPodmanHostLocalInferenceTestHarness } from "../helpers/podman-host-local-inference-test-harness";
import {
  createPortableGatewayProviderHarness,
  createPortablePodmanCapture,
  type PortablePodmanAuthorityState,
} from "../helpers/hermes-portable-ollama-test-harness";
import {
  createGatewayScopedOpenshellRunner,
  type SetupInference,
  type SetupInferenceDeps,
} from "../../src/lib/onboard/setup-inference.js";

const onboardProviderHelpers = require("../../src/lib/onboard/providers") as {
  upsertProvider: (
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: Record<string, string | undefined>,
    runOpenshell: DirectRunOpenshell,
  ) => Promise<{ ok: boolean; status?: number; message?: string }>;
  providerExistsInGateway: (name: string, runOpenshell: DirectRunOpenshell) => Promise<boolean>;
};
const localInferenceModule =
  require("../../src/lib/inference/local") as typeof import("../../src/lib/inference/local.js");

export type DirectCommandEntry = {
  command: string;
  env?: Record<string, string | undefined>;
  ignoreError?: boolean;
};

type CreateSetupInference = (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
type DirectRunOpenshell = SetupInferenceDeps["runOpenshell"];
type DirectRunOptions = NonNullable<Parameters<DirectRunOpenshell>[1]>;
type DirectRunResult = ReturnType<DirectRunOpenshell>;

export type DirectRunStubResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
};

export type DirectSetupHarnessOptions = {
  runOpenshell?: (
    args: string[],
    options: DirectRunOptions,
    calls: DirectCommandEntry[],
  ) => DirectRunStubResult | undefined;
  overrides?: Partial<SetupInferenceDeps>;
};

const OPENAI_ENDPOINTLESS_PROFILE = JSON.stringify({
  id: "openai",
  credentials: [],
  endpoints: [],
  binaries: [],
  inference_capable: true,
});

type DirectCommandRoute = {
  name: string;
  matches(command: string): boolean;
  results: readonly [DirectRunStubResult | undefined, ...(DirectRunStubResult | undefined)[]];
};

export type ProductionOpenshellCommandRecord = {
  argv: string[];
  env: Record<string, string>;
};

export type ProductionSetupInferenceBoundaryResult = {
  commands: ProductionOpenshellCommandRecord[];
  credentialEvidence: {
    argvContainingSecret: string[];
    parentCredentialUnchanged: boolean;
    providerCommand: ProductionOpenshellCommandRecord;
    secretBearingCommands: string[];
    setupCredentialValues: Array<string | null>;
    unscopedCommandKinds: string[];
    unscopedCommandsContainingSecret: string[];
    unscopedCredentialValues: Array<string | null>;
  };
  setupCredentialAfter: string | null;
  setupCredentialBefore: string | null;
};

export function runProductionSetupInferenceCredentialBoundary(options: {
  credentialEnv: string;
  credentialValue: string;
  endpointUrl?: string | null;
  model: string;
  provider: string;
  timeoutMs?: number;
}): ProductionSetupInferenceBoundaryResult {
  const parentCredentialBefore = process.env[options.credentialEnv];
  const repoRoot = path.join(import.meta.dirname, "..", "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-setup-inference-boundary-"));
  const fakeBin = path.join(tmpDir, "bin");
  const openshellPath = path.join(fakeBin, "openshell");
  const commandLogPath = path.join(tmpDir, "openshell-commands.jsonl");
  const setupResultPath = path.join(tmpDir, "setup-result.json");
  const childScriptPath = path.join(tmpDir, "setup-inference-boundary.js");
  const onboardPath = path.join(repoRoot, "src", "lib", "onboard.ts");
  const sourceHookPath = path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs");

  try {
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      openshellPath,
      `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLogPath)}, JSON.stringify({ argv, env: process.env }) + "\\n");
if (argv[0] === "inference" && argv[1] === "get") {
  process.stdout.write(${JSON.stringify(
    `Gateway inference:\n  Provider: ${options.provider}\n  Model: ${options.model}\n`,
  )});
}
if (argv[0] === "provider" && argv[1] === "get") {
  process.stdout.write(${JSON.stringify(
    [
      `Name: ${options.provider}`,
      `Type: ${options.provider === "nvidia-prod" ? "nvidia" : "openai"}`,
      `Credential keys: ${options.credentialEnv}`,
      `Config keys: ${options.provider === "nvidia-prod" ? "<none>" : "OPENAI_BASE_URL"}`,
      "",
    ].join("\n"),
  )});
}
process.exit(0);
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      childScriptPath,
      `const fs = require("node:fs");
const { setupInference } = require(${JSON.stringify(onboardPath)});
const credentialEnv = ${JSON.stringify(options.credentialEnv)};
const setupCredentialBefore = process.env[credentialEnv] || null;
(async () => {
  await setupInference(
    null,
    ${JSON.stringify(options.model)},
    ${JSON.stringify(options.provider)},
    ${JSON.stringify(options.endpointUrl ?? null)},
    credentialEnv,
  );
  fs.writeFileSync(
    ${JSON.stringify(setupResultPath)},
    JSON.stringify({
      setupCredentialBefore,
      setupCredentialAfter: process.env[credentialEnv] || null,
    }),
  );
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`,
    );

    const result = spawnSync(process.execPath, [childScriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 15_000,
      env: {
        HOME: tmpDir,
        NODE_ENV: "test",
        NODE_OPTIONS: `--require=${sourceHookPath}`,
        NEMOCLAW_OPENSHELL_BIN: openshellPath,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        TMPDIR: tmpDir,
        VITEST: "true",
        [options.credentialEnv]: options.credentialValue,
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `Production setupInference boundary exited ${result.status}: ${result.stderr || result.stdout}`,
      );
    }

    const commands = fs
      .readFileSync(commandLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProductionOpenshellCommandRecord);
    const setupResult = JSON.parse(fs.readFileSync(setupResultPath, "utf8")) as Omit<
      ProductionSetupInferenceBoundaryResult,
      "commands" | "credentialEvidence"
    >;
    const commandKind = ({ argv }: ProductionOpenshellCommandRecord) => argv.slice(0, 2).join(" ");
    const providerCommand = commands.find(({ argv }) =>
      /^provider (create|update) /.test(argv.join(" ")),
    );
    if (!providerCommand) throw new Error("Production setupInference did not mutate a provider");
    const unscopedCommands = commands.filter(({ argv }) => {
      if (argv[0] === "gateway" && argv[1] === "select") return true;
      if (argv[0] !== "provider" && argv[0] !== "inference") return false;
      return (
        !argv.some(
          (arg, index) =>
            (arg === "-g" || arg === "--gateway") && typeof argv[index + 1] === "string",
        ) && !argv.some((arg) => arg.startsWith("--gateway="))
      );
    });
    const containsSecret = ({ env }: ProductionOpenshellCommandRecord) =>
      Object.values(env).some((value) => value.includes(options.credentialValue));
    const credentialEvidence = {
      argvContainingSecret: commands
        .filter(({ argv }) => argv.some((arg) => arg.includes(options.credentialValue)))
        .map(commandKind),
      parentCredentialUnchanged: process.env[options.credentialEnv] === parentCredentialBefore,
      providerCommand,
      secretBearingCommands: commands.filter(containsSecret).map(commandKind),
      setupCredentialValues: [setupResult.setupCredentialBefore, setupResult.setupCredentialAfter],
      unscopedCommandKinds: unscopedCommands.map(commandKind),
      unscopedCommandsContainingSecret: unscopedCommands.filter(containsSecret).map(commandKind),
      unscopedCredentialValues: unscopedCommands.map(
        ({ env }) => env[options.credentialEnv] ?? null,
      ),
    };
    return { commands, credentialEvidence, ...setupResult };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function withProcessEnv<T>(
  values: Record<string, string | undefined>,
  runTest: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await runTest();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function createDirectCommandRouter(routes: readonly DirectCommandRoute[]) {
  const callCounts = new Map<string, number>();
  const runOpenshell: NonNullable<DirectSetupHarnessOptions["runOpenshell"]> = (args) => {
    const command = args.join(" ");
    const route = routes.find((candidate) => candidate.matches(command));
    if (!route) return undefined;
    const callIndex = callCounts.get(route.name) ?? 0;
    callCounts.set(route.name, callIndex + 1);
    return route.results[Math.min(callIndex, route.results.length - 1)];
  };
  return {
    callCount: (name: string) => callCounts.get(name) ?? 0,
    runOpenshell,
  };
}

export function directRunResult({
  status = 0,
  stdout = "",
  stderr = "",
}: Partial<DirectRunStubResult> = {}): DirectRunResult {
  return {
    pid: 0,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null,
  };
}

export function createDirectSetupInferenceHarnessFactory(
  createSetupInference: CreateSetupInference,
) {
  return function createDirectSetupInferenceHarness(options: DirectSetupHarnessOptions = {}) {
    const commands: DirectCommandEntry[] = [];
    const errors: string[] = [];
    const logs: string[] = [];
    const updateSandbox = vi.fn(() => true);
    const unloadOllamaModels = vi.fn();
    const verifyInferenceRoute = vi.fn();
    const verifyOnboardInferenceSmoke = vi.fn();
    const runOpenshell: DirectRunOpenshell = (args, runOptions = {}) => {
      commands.push({
        command: args.join(" "),
        env: runOptions.env,
        ignoreError: runOptions.ignoreError,
      });
      const routed = options.runOpenshell?.(args, runOptions, commands);
      if (routed !== undefined) {
        if (args[0] === "provider" && args[1] === "get") {
          const providerName = args.at(-1) ?? "provider";
          if (routed.status === 1 && !routed.stdout && !routed.stderr) {
            return directRunResult({
              ...routed,
              stderr: `provider '${providerName}' not found`,
            });
          }
        }
        return directRunResult(routed);
      }
      if (
        args[0] === "provider" &&
        args[1] === "profile" &&
        args.includes("export") &&
        args.includes("openai")
      ) {
        return directRunResult({ status: 0, stdout: OPENAI_ENDPOINTLESS_PROFILE });
      }
      if (args[0] === "provider" && args[1] === "get") {
        const providerName = args.at(-1) ?? "provider";
        return directRunResult({
          status: 1,
          stderr: `provider '${providerName}' not found`,
        });
      }
      return directRunResult();
    };
    const setupInferenceWithoutPolicyAuthority = createSetupInference({
      checkGatewayRouteCompatibility: () => ({ ok: true }),
      withGatewayRouteMutationLock: async <T>(
        _gatewayName: string,
        operation: () => Promise<T> | T,
      ) => await operation(),
      withSandboxMutationLock: async <T>(_sandboxName: string, operation: () => Promise<T> | T) =>
        await operation(),
      step: () => {},
      getGatewayName: () => "nemoclaw",
      runOpenshell,
      upsertProvider: async (
        name: string,
        type: string,
        credentialEnv: string,
        baseUrl: string | null,
        env: Record<string, string | undefined> | undefined,
        gatewayName: string,
      ) =>
        await onboardProviderHelpers.upsertProvider(
          name,
          type,
          credentialEnv,
          baseUrl,
          env ?? {},
          createGatewayScopedOpenshellRunner(runOpenshell, gatewayName),
        ),
      verifyInferenceRoute,
      verifyOnboardInferenceSmoke,
      providerExistsInGateway: (name: string, gatewayName: string) =>
        onboardProviderHelpers.providerExistsInGateway(
          name,
          createGatewayScopedOpenshellRunner(runOpenshell, gatewayName),
        ),
      isNonInteractive: () => false,
      updateSandbox,
      resolveHermesNousApiKey: () => process.env.NOUS_API_KEY || null,
      checkHermesProviderStoreReachable: (run: DirectRunOpenshell) => {
        run(["provider", "list"], { ignoreError: true });
        return { ok: true };
      },
      hydrateCredentialEnv: (envName: string | null | undefined) =>
        envName ? process.env[envName] || null : null,
      // Direct setup tests use documentation-only hostnames and intentionally
      // bypass the selection phase that normally supplies validated pins.
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
      promptValidationRecovery: async () => "selection",
      bedrockRuntimeOnboard: {
        setupBedrockRuntimeInference: async () => ({ handled: false as const }),
      },
      openrouterRuntimeOnboard: {
        setupOpenRouterRuntimeInference: async () => ({ handled: false as const }),
      },
      validateLocalProvider: () => ({ ok: true }),
      getLocalProviderHealthCheck: () => null,
      getLocalProviderBaseUrl: (provider: string) =>
        provider === "ollama-local"
          ? "http://host.openshell.internal:11435/v1"
          : "http://host.openshell.internal:8000/v1",
      applyLocalInferenceRoute: async () => false,
      run: () => directRunResult(),
      shouldFrontOllamaWithProxy: () => false,
      ensureOllamaAuthProxy: () => {},
      isProxyHealthy: () => true,
      getOllamaProxyToken: () => null,
      persistAndProbeOllamaProxy: async () => {},
      localInference: {
        ...localInferenceModule,
        validateOllamaModelWithToolsOverride: () => ({ ok: true }),
      },
      log: (message: string) => logs.push(message),
      error: (message: string) => errors.push(message),
      exitProcess: (code: number): never => {
        throw Object.assign(new Error(`EXIT_CALLED:${code}`), { code });
      },
      // #9110: neutralize the GPU-release seams so harness consumers backed by
      // the production defaults never read the developer's real registry or
      // curl a live Ollama daemon.
      getSandbox: () => null,
      listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
      unloadOllamaModels,
      withOllamaModelOwnershipLock: (operation) => operation(),
      ...options.overrides,
    });
    const revalidateSandboxIdentity = vi.fn();
    const setupInference: SetupInference = (
      sandboxName,
      model,
      provider,
      endpointUrl,
      credentialEnv,
      hermesAuthMethod,
      hermesToolGateways,
      inferenceOptions = {},
    ) =>
      setupInferenceWithoutPolicyAuthority(
        sandboxName,
        model,
        provider,
        endpointUrl,
        credentialEnv,
        hermesAuthMethod,
        hermesToolGateways,
        {
          ...inferenceOptions,
          revalidateSandboxIdentity:
            inferenceOptions.revalidateSandboxIdentity ?? revalidateSandboxIdentity,
        },
      );
    return {
      commands,
      errors,
      logs,
      runOpenshell,
      setupInference,
      revalidateSandboxIdentity,
      unloadOllamaModels,
      updateSandbox,
      verifyInferenceRoute,
      verifyOnboardInferenceSmoke,
    };
  };
}

export const PORTABLE_INFERENCE_PODMAN_PATH = "/usr/bin/podman";
const PODMAN_BYTES = Buffer.from("portable-podman-5.7.0", "utf8");
export const PORTABLE_INFERENCE_NETWORK_ID = "6".repeat(64);
export const PORTABLE_INFERENCE_GPU_DEVICE =
  "nvidia.com/gpu=GPU-12345678-1234-1234-1234-123456789abc";

export const FRESH_PORTABLE_INFERENCE_INPUT = {
  application: "hermes" as const,
  sandboxName: "portable-hermes",
  provider: "ollama-local",
  model: "qwen3-vl:4b",
  acceleration: "nvidia-gpu" as const,
  requireToolCalling: true,
  allowPublishedResume: false,
  recover: false,
};

function runtimeAuthority(homeDir: string): CheckpointPortableRuntimeAuthority {
  const uid = process.getuid!();
  return {
    schemaVersion: 1,
    kind: "podman",
    ownership: "current-user",
    uid,
    homeDir,
    configHome: path.join(homeDir, ".config"),
    runtimeDir: `/run/user/${String(uid)}`,
    socketPath: `/run/user/${String(uid)}/podman/podman.sock`,
  };
}

function socketAuthority(runtime: CheckpointPortableRuntimeAuthority): PodmanSocketAuthority {
  return {
    device: "1",
    inode: "2",
    mode: String(0o140600),
    ownerUid: String(runtime.uid),
    socketPath: runtime.socketPath,
    directoryChain: [],
  };
}

function executableAuthorityDeps(): PodmanExecutableAuthorityDeps {
  const executable = (): PodmanExecutableStat => ({
    dev: 1n,
    ino: 10n,
    mode: 0o100755n,
    uid: 0n,
    size: BigInt(PODMAN_BYTES.byteLength),
    mtimeNs: 10n,
    ctimeNs: 11n,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  return {
    uid: process.getuid!(),
    lstat: (filePath) =>
      filePath === PORTABLE_INFERENCE_PODMAN_PATH
        ? executable()
        : {
            ...executable(),
            ino: filePath === "/usr/bin" ? 20n : 30n,
            mode: 0o40755n,
            size: 0n,
            isDirectory: () => true,
            isFile: () => false,
          },
    readFile: () => PODMAN_BYTES,
    realpath: (filePath) => filePath,
  };
}

export function createHermesPortableInferenceFixture(
  pullFailure?: { readonly image: string; readonly result: ContainerEngineCommandResult },
  gatewayName = "nemoclaw",
) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-inference-"));
  const runtime = runtimeAuthority(homeDir);
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("PATH", "/usr/bin");
  const environmentScope = createPortableOnboardEnvironmentScope(process.env, null);
  environmentScope.installRuntime({
    containersConf: path.join(runtime.configHome, "nemoclaw", "portable", "containers.conf"),
    socketPath: runtime.socketPath,
  });
  const events: string[] = [];
  const authorityState: PortablePodmanAuthorityState = {
    networkId: PORTABLE_INFERENCE_NETWORK_ID,
    images: new Set<string>(),
    failPull: pullFailure?.image ?? null,
  };
  const gatewayProvider = createPortableGatewayProviderHarness(events);
  const runGatewayOpenshell = vi.fn(gatewayProvider.run);
  const assertSocketAuthority = vi.fn();
  const harness = createPodmanHostLocalInferenceTestHarness({
    probeImageRef: PORTABLE_PROBE_IMAGE,
  });
  harness.state.networkId = PORTABLE_INFERENCE_NETWORK_ID;
  harness.state.networkName = "openshell-docker";
  harness.state.networkGatewayIp = "10.87.0.1";
  harness.state.ollamaPsModels = [
    {
      name: "qwen3-vl:4b",
      model: "qwen3-vl:4b",
      size: 8 * 1024 ** 3,
      size_vram: 8 * 1024 ** 3,
      digest: "8".repeat(64),
    },
  ];
  let cdiDevices = ["nvidia.com/gpu=all", PORTABLE_INFERENCE_GPU_DEVICE];
  const capture = createPortablePodmanCapture(events, authorityState, harness.engine.capture);
  const injectedCapture: ContainerEngineCommandCapture = pullFailure
    ? (executable, args, timeoutMs, input, environment) => {
        const result = capture(executable, args, timeoutMs, input, environment);
        return args[2] === "pull" && args[3] === pullFailure.image ? pullFailure.result : result;
      }
    : capture;
  const resolverOptions = {
    runtimeContext: { authority: runtime, environmentScope },
    gatewayName,
    credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    getReservationSessionId: () => "portable-session",
    runGatewayOpenshell,
    stateDir: path.join(homeDir, "state"),
    captureSocketAuthority: () => socketAuthority(runtime),
    captureGpuDevices: () => [PORTABLE_INFERENCE_GPU_DEVICE],
    captureCdiDevices: () => cdiDevices,
    podmanAuthorityDeps: {
      capture: injectedCapture,
      executableAuthorityDeps: executableAuthorityDeps(),
      assertSocketAuthority,
      resolveExecutablePath: () => PORTABLE_INFERENCE_PODMAN_PATH,
      platform: "linux",
      architecture: "x64",
      uid: runtime.uid,
    },
  } as const;
  return {
    assertSocketAuthority,
    authorityState,
    events,
    gatewayProvider,
    harness,
    homeDir,
    resolverOptions,
    runtime,
    restoreEnvironment: () => environmentScope.restore(),
    resolve: (input = FRESH_PORTABLE_INFERENCE_INPUT) =>
      createHermesPortableOllamaInferenceResolver(resolverOptions)(input),
    setCdiDevices: (devices: string[]) => {
      cdiDevices = devices;
    },
  };
}
