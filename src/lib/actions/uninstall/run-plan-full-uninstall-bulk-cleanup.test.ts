// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  withProvenManagedGatewayProcess,
  writeManagedGatewayRuntimeProof,
} from "../../../../test/support/uninstall-managed-gateway-test-support";

import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
} from "../../onboard/docker-driver-gateway-config";
import { writeCompleteDockerDriverGatewayLocalTlsBundle } from "../../onboard/__test-helpers__/docker-driver-gateway-local-tls";
import { getDockerDriverGatewayLocalTlsBundle } from "../../onboard/docker-driver-gateway-local-tls";
import {
  ensureManagedGatewayStateRoot,
  MANAGED_GATEWAY_STATE_ROOT_MARKER,
  resolveGatewayStateDirName,
} from "../../onboard/gateway-binding";
import * as gatewayRegistry from "../../state/gateway-registry";
import { createSetupInference, type SetupInferenceDeps } from "../../onboard/setup-inference";
import {
  applyNativeNvidiaProviderAuthority,
  readNativeNvidiaProviderAuthority,
} from "../../state/registry/native-provider-authority-state";
import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function writeFullCleanupState(
  home: string,
  gatewayStateDir = path.join(
    home,
    ".local",
    "state",
    "nemoclaw",
    resolveGatewayStateDirName(8080),
  ),
): string {
  const registryFile = path.join(home, ".nemoclaw", "sandboxes.json");
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(
    registryFile,
    JSON.stringify({
      defaultSandbox: "my-assistant",
      sandboxes: {
        "my-assistant": { name: "my-assistant", gatewayName: "nemoclaw", gatewayPort: 8080 },
      },
    }),
  );

  writeCompleteDockerDriverGatewayLocalTlsBundle(gatewayStateDir);
  const jwtBundle = ensureDockerDriverGatewayJwtBundle(gatewayStateDir);
  const configPath = path.join(gatewayStateDir, "openshell-gateway.toml");
  fs.writeFileSync(
    configPath,
    buildDockerDriverGatewayConfigToml(
      {
        OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
        OPENSHELL_LOCAL_TLS_DIR: path.join(gatewayStateDir, "tls"),
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
      },
      "/usr/bin/openshell-sandbox",
      jwtBundle,
      gatewayIdForStateDir(gatewayStateDir),
    ),
    { mode: 0o600 },
  );
  fs.chmodSync(configPath, 0o600);
  return registryFile;
}

function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return runUninstallPlanBase(
    options,
    withProvenManagedGatewayProcess({
      isPortFree: () => true,
      resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
        gatewayName,
        gatewayPort,
        mode: "nemoclaw-managed",
        source: "packaged-service",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      ...deps,
    }),
  );
}

function fullCleanupDeps(
  home: string,
  calls: string[][],
  sandboxInventory: string,
  commandInvocations?: Array<{ args: string[]; env?: NodeJS.ProcessEnv }>,
) {
  const responses = new Map<string, RunResult>([
    ["gateway list -o json", ok(JSON.stringify([{ name: "nemoclaw" }]))],
    ["sandbox list", ok(sandboxInventory)],
  ]);
  return {
    commandExists: (command: string) => command === "docker" || command === "openshell",
    env: {
      HOME: home,
      NEMOCLAW_NON_INTERACTIVE: "1",
      OPENSHELL_GATEWAY: "foreign-gateway",
      OPENSHELL_GATEWAY_ENDPOINT: "https://foreign.invalid",
      OPENSHELL_LOCAL_TLS_DIR: "/foreign/tls",
      OPENSHELL_WORKSPACE: "foreign-workspace",
    } as NodeJS.ProcessEnv,
    error: vi.fn(),
    existsSync: (target: string) => target.startsWith(home) && fs.existsSync(target),
    hasPortableRuntimeCleanup: () => false,
    isTty: false,
    log: vi.fn(),
    rmSync: fs.rmSync,
    run: (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      calls.push(args);
      commandInvocations?.push({ args, env: options?.env });
      return responses.get(args.join(" ")) ?? ok();
    },
    runDocker: () => ok(),
    sleep: vi.fn(),
  } satisfies UninstallRunDeps;
}

describe("full uninstall bulk sandbox cleanup", () => {
  it("verifies stable empty inventory before provider cleanup (#11831)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-bulk-empty-"));
    try {
      writeFullCleanupState(home);
      const calls: string[][] = [];
      const commandInvocations: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
      const result = await runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        fullCleanupDeps(home, calls, "No sandboxes found.\n", commandInvocations),
      );

      expect(result.exitCode).toBe(0);
      const deleteIndex = calls.findIndex((args) => args.join(" ") === "sandbox delete --all");
      const inventoryIndexes = calls
        .map((args, index) => (args.join(" ") === "sandbox list" ? index : -1))
        .filter((index) => index >= 0);
      const providerIndex = calls.findIndex(
        (args) => args.join(" ") === "provider delete nvidia-nim",
      );
      expect(inventoryIndexes).toHaveLength(2);
      expect(inventoryIndexes[0]).toBeGreaterThan(deleteIndex);
      expect(providerIndex).toBeGreaterThan(inventoryIndexes[1]!);
      const selectedGatewayTlsDir = getDockerDriverGatewayLocalTlsBundle(
        path.join(home, ".local", "state", "nemoclaw", resolveGatewayStateDirName(8080)),
      ).localTlsDir;
      const deleteInvocations = commandInvocations.filter(
        ({ args }) => args.join(" ") === "sandbox delete --all",
      );
      expect(deleteInvocations).toHaveLength(1);
      expect(deleteInvocations[0]?.env).toMatchObject({
        OPENSHELL_GATEWAY: "nemoclaw",
        OPENSHELL_LOCAL_TLS_DIR: selectedGatewayTlsDir,
        OPENSHELL_WORKSPACE: "default",
      });
      expect(deleteInvocations[0]?.env?.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();
      const providerEnvironments = commandInvocations
        .filter(({ args }) => args[0] === "provider" && args[1] === "delete")
        .map(({ env }) => env);
      expect(providerEnvironments.length).toBeGreaterThan(0);
      expect(
        providerEnvironments.every(
          (env) =>
            env?.OPENSHELL_GATEWAY === "nemoclaw" &&
            env.OPENSHELL_WORKSPACE === "default" &&
            env.OPENSHELL_LOCAL_TLS_DIR === selectedGatewayTlsDir &&
            env.OPENSHELL_GATEWAY_ENDPOINT === undefined,
        ),
      ).toBe(true);
      const gatewayRemoveInvocations = commandInvocations.filter(
        ({ args }) => args.join(" ") === "gateway remove nemoclaw",
      );
      expect(gatewayRemoveInvocations).toHaveLength(1);
      expect(gatewayRemoveInvocations[0]?.env).toMatchObject({
        OPENSHELL_GATEWAY: "nemoclaw",
        OPENSHELL_LOCAL_TLS_DIR: selectedGatewayTlsDir,
        OPENSHELL_WORKSPACE: "default",
      });
      expect(gatewayRemoveInvocations[0]?.env?.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves downstream cleanup when inventory remains nonempty (#11831)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-bulk-partial-"));
    try {
      const registryFile = writeFullCleanupState(home);
      const calls: string[][] = [];
      const result = await runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        fullCleanupDeps(home, calls, "my-assistant Ready\n"),
      );

      expect(result.exitCode).toBe(1);
      expect(calls.filter((args) => args.join(" ") === "sandbox delete --all")).toHaveLength(1);
      expect(calls.filter((args) => args.join(" ") === "sandbox list")).toHaveLength(5);
      expect(calls.some((args) => args[0] === "provider" && args[1] === "delete")).toBe(false);
      expect(calls.some((args) => args[0] === "gateway" && args[1] === "remove")).toBe(false);
      expect(fs.existsSync(registryFile)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses bulk sandbox cleanup for an externally supervised gateway (#11831)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-bulk-external-"));
    try {
      const registryFile = writeFullCleanupState(home);
      const gatewayStateDir = path.join(
        home,
        ".local",
        "state",
        "nemoclaw",
        resolveGatewayStateDirName(8080),
      );
      const calls: string[][] = [];
      const deps = fullCleanupDeps(home, calls, "No sandboxes found.\n");
      const result = await runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        {
          ...deps,
          resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
            gatewayName,
            gatewayPort,
            mode: "externally-supervised",
            source: "declared",
            endpoint: `http://127.0.0.1:${String(gatewayPort)}`,
            stateDir: gatewayStateDir,
            supervisor: {
              kind: "systemd-user",
              serviceName: "openshell-gateway.service",
              execPath: "/usr/local/bin/openshell-gateway",
            },
            requiredCapabilities: [],
          }),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(calls.some((args) => args.join(" ") === "sandbox delete --all")).toBe(false);
      expect(calls.some((args) => args[0] === "provider" && args[1] === "delete")).toBe(false);
      expect(calls.some((args) => args[0] === "gateway" && args[1] === "remove")).toBe(false);
      expect(deps.error).toHaveBeenCalledWith(
        "Refusing bulk sandbox cleanup for an externally supervised gateway; preserving its state for retry.",
      );
      expect(fs.existsSync(registryFile)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("revalidates explicit gateway state ownership inside the default root (#11831)", async () => {
    const home = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-bulk-ownership-"));
    try {
      const gatewayStateDir = path.join(
        home,
        ".local",
        "state",
        "nemoclaw",
        "explicit-gateway-state",
      );
      fs.mkdirSync(path.dirname(gatewayStateDir), { recursive: true });
      ensureManagedGatewayStateRoot({
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        stateDir: gatewayStateDir,
      });
      const registryFile = writeFullCleanupState(home, gatewayStateDir);
      writeManagedGatewayRuntimeProof(gatewayStateDir, 8080);
      const calls: string[][] = [];
      const deps = fullCleanupDeps(home, calls, "No sandboxes found.\n");
      const processEnvironment = {
        [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]: gatewayIdForStateDir(gatewayStateDir),
      };
      const readProcessEnvironment = vi
        .fn()
        .mockReturnValueOnce(processEnvironment)
        .mockImplementationOnce(() => {
          fs.writeFileSync(path.join(gatewayStateDir, MANAGED_GATEWAY_STATE_ROOT_MARKER), "{}\n", {
            mode: 0o600,
          });
          return processEnvironment;
        });
      const result = await runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        {
          ...deps,
          env: {
            ...deps.env,
            NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: gatewayStateDir,
          },
          readProcessEnvironment,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(readProcessEnvironment).toHaveBeenCalledTimes(2);
      expect(calls.some((args) => args.join(" ") === "sandbox delete --all")).toBe(false);
      expect(deps.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "configured state directory is not proven to be the selected gateway's dedicated managed root",
        ),
      );
      expect(fs.existsSync(registryFile)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("revalidates the custom gateway process before bulk cleanup (#11831)", async () => {
    const home = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-bulk-process-"));
    try {
      const gatewayStateDir = path.join(home, "custom-gateway-state");
      ensureManagedGatewayStateRoot({
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        stateDir: gatewayStateDir,
      });
      const registryFile = writeFullCleanupState(home, gatewayStateDir);
      writeManagedGatewayRuntimeProof(gatewayStateDir, 8080);
      const calls: string[][] = [];
      const deps = fullCleanupDeps(home, calls, "No sandboxes found.\n");
      const processEnvironment = {
        [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]: gatewayIdForStateDir(gatewayStateDir),
      };
      const readProcessEnvironment = vi
        .fn()
        .mockReturnValueOnce(processEnvironment)
        .mockReturnValueOnce(processEnvironment)
        .mockReturnValue({
          [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]: "replacement-gateway",
        });
      const result = await runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        {
          ...deps,
          env: {
            ...deps.env,
            NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: gatewayStateDir,
          },
          readProcessEnvironment,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(readProcessEnvironment).toHaveBeenCalledTimes(3);
      expect(calls.some((args) => args.join(" ") === "sandbox delete --all")).toBe(false);
      expect(deps.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "package-managed OpenShell gateway service identity cannot be proven",
        ),
      );
      expect(fs.existsSync(registryFile)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("native NVIDIA provider authority after uninstall", () => {
  it.each([
    { scenario: "full removal", hasSibling: false, keepOpenShell: false },
    { scenario: "scoped removal", hasSibling: true, keepOpenShell: false },
    { scenario: "scoped retained gateway", hasSibling: true, keepOpenShell: true },
  ])(
    "onboards native inference after $scenario (#13470)",
    async ({ hasSibling, keepOpenShell }) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-reinstall-"));
      try {
        const registryFile = writeFullCleanupState(home);
        const authority = {
          schemaVersion: 1,
          profileId: "nemoclaw-nvidia-inference-v1",
          providerName: "nemoclaw-nvidia-prod-v1",
          providerId: "removed-provider-id",
        };
        fs.writeFileSync(
          registryFile,
          JSON.stringify({
            defaultSandbox: null,
            defaultSelectionRevision: 3,
            sandboxes: {},
            nativeNvidiaProviderAuthorities: { nemoclaw: authority },
          }),
        );
        const sibling = { name: "sibling", gatewayName: "nemoclaw-9125", gatewayPort: 9125 };
        const initial = JSON.parse(fs.readFileSync(registryFile, "utf8"));
        initial.sandboxes = hasSibling ? { sibling } : {};
        initial.nativeNvidiaProviderAuthorities = {
          ...initial.nativeNvidiaProviderAuthorities,
          ...(hasSibling
            ? { "nemoclaw-9125": { ...authority, providerId: "sibling-provider-id" } }
            : {}),
        };
        fs.writeFileSync(registryFile, JSON.stringify(initial));
        const backup = path.join(home, ".nemoclaw", "backups", "workspace.tar");
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.writeFileSync(backup, "preserved workspace backup");
        const calls: string[][] = [];
        const deps = fullCleanupDeps(home, calls, "No sandboxes found.\n");
        const result = await runUninstallPlan(
          { assumeYes: true, deleteModels: false, destroyUserData: false, keepOpenShell },
          {
            ...deps,
            env: { ...deps.env, OPENSHELL_GATEWAY_ENDPOINT: undefined },
            retainedGatewayPorts: hasSibling ? [9125] : [],
          },
        );
        expect(result.exitCode).toBe(0);
        expect(result.otherGatewayEnvironmentsRemain).toBe(hasSibling);
        const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
        expect(registry.nativeNvidiaProviderAuthorities?.nemoclaw).toEqual(
          keepOpenShell ? authority : undefined,
        );
        expect(
          fs.existsSync(
            path.join(home, ".local", "state", "nemoclaw", resolveGatewayStateDirName(8080)),
          ),
        ).toBe(keepOpenShell);
        expect(calls.some((args) => args[0] === "gateway" && args[1] === "remove")).toBe(true);
        expect(calls.some((args) => args[0] === "provider" && args[1] === "delete")).toBe(
          !hasSibling,
        );
        expect(
          deps.log.mock.calls
            .flat()
            .join("\n")
            .includes("kept shared OpenShell provider registrations"),
        ).toBe(hasSibling);
        expect(registry.sandboxes).toEqual(hasSibling ? { sibling } : {});
        expect(registry.nativeNvidiaProviderAuthorities?.["nemoclaw-9125"]?.providerId).toBe(
          hasSibling ? "sibling-provider-id" : undefined,
        );
        const getProvider = vi
          .fn()
          .mockResolvedValueOnce(
            keepOpenShell
              ? {
                  ok: true,
                  value: {
                    name: authority.providerName,
                    type: authority.profileId,
                    credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
                    configKeys: [],
                    revision: { id: authority.providerId, resourceVersion: 1 },
                  },
                }
              : {
                  ok: false,
                  error: { kind: "command", reason: "not_found", message: "not found" },
                },
          )
          .mockResolvedValue({
            ok: true,
            value: {
              name: authority.providerName,
              type: authority.profileId,
              credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
              configKeys: [],
              revision: {
                id: keepOpenShell ? authority.providerId : "new-provider-id",
                resourceVersion: 1,
              },
            },
          });
        const adapter = {
          getProvider,
          createProvider: vi.fn(async () => ({ ok: true })),
          updateProvider: vi.fn(async () => ({ ok: true })),
          importProviderProfile: vi.fn(async () => ({ ok: true })),
          ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true })),
        } as unknown as import("../../adapters/openshell/provider-adapter").OpenShellProviderAdapter;
        const readRegistry = () => JSON.parse(fs.readFileSync(registryFile, "utf8"));
        const getAuthority = vi.fn((gatewayName: string) =>
          readNativeNvidiaProviderAuthority(readRegistry(), gatewayName),
        );
        const updateSandbox = vi.fn(() => true);
        const verifyOnboardInferenceSmoke = vi.fn(async () => undefined);
        const setupInference = createSetupInference({
          checkGatewayRouteCompatibility: () => ({ ok: true }),
          withSandboxMutationLock: async (_name: string, operation: () => unknown) => operation(),
          withGatewayRouteMutationLock: async (_name: string, operation: () => unknown) =>
            operation(),
          step: vi.fn(),
          getGatewayName: () => "nemoclaw",
          getSandbox: () => null,
          getNativeNvidiaProviderAuthority: getAuthority,
          setNativeNvidiaProviderAuthority: (
            gatewayName: string,
            receipt: Parameters<typeof applyNativeNvidiaProviderAuthority>[2],
          ) => {
            const current = readRegistry();
            expect(applyNativeNvidiaProviderAuthority(current, gatewayName, receipt)).toBe(true);
            fs.writeFileSync(registryFile, JSON.stringify(current));
          },
          providerAdapter: adapter,
          hydrateCredentialEnv: () => "test-credential",
          runOpenshell: () => ok(),
          updateSandbox,
          verifyOnboardInferenceSmoke,
          isNonInteractive: () => true,
          hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
          redact: (value: string) => value,
          compactText: (value: string) => value,
          log: vi.fn(),
          error: vi.fn(),
          exitProcess: (code: number): never => {
            throw new Error(`exit ${code}`);
          },
        } as unknown as SetupInferenceDeps);
        await expect(
          setupInference(
            "reinstalled",
            "nvidia/nemotron-3-super-120b-a12b",
            "nvidia-prod",
            "https://integrate.api.nvidia.com/v1",
            "NVIDIA_INFERENCE_API_KEY",
            null,
            [],
            { revalidateSandboxIdentity: () => undefined },
          ),
        ).resolves.toEqual({ ok: true });
        expect(getAuthority).toHaveBeenCalledWith("nemoclaw");
        expect(vi.mocked(adapter.createProvider).mock.calls).toEqual(
          keepOpenShell
            ? []
            : [
                [
                  expect.objectContaining({
                    target: { kind: "named", gatewayName: "nemoclaw" },
                    name: authority.providerName,
                  }),
                ],
              ],
        );
        expect(readNativeNvidiaProviderAuthority(readRegistry(), "nemoclaw")).toEqual({
          ...authority,
          providerId: keepOpenShell ? authority.providerId : "new-provider-id",
        });
        expect(updateSandbox).toHaveBeenCalledWith(
          "reinstalled",
          expect.objectContaining({
            nativeNvidiaProviderAttachment: {
              ...authority,
              providerId: keepOpenShell ? authority.providerId : "new-provider-id",
            },
          }),
        );
        expect(verifyOnboardInferenceSmoke).toHaveBeenCalledOnce();
        expect(registry.defaultSelectionRevision).toBe(3);
        expect(fs.readFileSync(backup, "utf8")).toBe("preserved workspace backup");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

it.each([
  {
    scenario: "gateway-failure",
    responses: { "gateway remove": { status: 1, stdout: "", stderr: "permission denied" } },
    remove: fs.rmSync,
    keepOpenShell: false,
    expectedExit: 1,
  },
  {
    scenario: "unknown-inventory",
    responses: { "sandbox list": { status: 1, stdout: "", stderr: "connection closed" } },
    remove: fs.rmSync,
    keepOpenShell: false,
    expectedExit: 1,
  },
  {
    scenario: "state-removal-failure",
    responses: {},
    remove: () => undefined,
    keepOpenShell: false,
    expectedExit: 1,
  },
  {
    scenario: "kept-gateway",
    responses: {},
    remove: fs.rmSync,
    keepOpenShell: true,
    expectedExit: 0,
  },
])(
  "retains native authority after $scenario (#13470)",
  async ({ responses, remove, keepOpenShell, expectedExit }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-retain-"));
    try {
      const registryFile = writeFullCleanupState(home);
      const authority = {
        schemaVersion: 1,
        profileId: "nemoclaw-nvidia-inference-v1",
        providerName: "nemoclaw-nvidia-prod-v1",
        providerId: "original-provider",
      };
      fs.writeFileSync(
        registryFile,
        JSON.stringify({
          defaultSandbox: null,
          sandboxes: {},
          nativeNvidiaProviderAuthorities: { nemoclaw: authority },
        }),
      );
      const deps = fullCleanupDeps(home, [], "No sandboxes found.\n");
      const overrides: Record<string, RunResult | undefined> = responses;
      const result = await runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: false, keepOpenShell },
        {
          ...deps,
          run: (command, args, options) =>
            overrides[args.slice(0, 2).join(" ")] ?? deps.run(command, args, options),
          rmSync: remove,
        },
      );
      expect(result.exitCode).toBe(expectedExit);
      expect(
        JSON.parse(fs.readFileSync(registryFile, "utf8")).nativeNvidiaProviderAuthorities.nemoclaw,
      ).toEqual(authority);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);

it("retains a changed same-name registration before scoped pruning (#13470)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-row-change-"));
  try {
    const registryFile = writeFullCleanupState(home);
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    registry.sandboxes.sibling = {
      name: "sibling",
      gatewayName: "nemoclaw-9125",
      gatewayPort: 9125,
    };
    registry.nativeNvidiaProviderAuthorities = {
      nemoclaw: {
        schemaVersion: 1,
        profileId: "nemoclaw-nvidia-inference-v1",
        providerName: "nemoclaw-nvidia-prod-v1",
        providerId: "original-provider",
      },
    };
    fs.writeFileSync(registryFile, JSON.stringify(registry));
    const deps = fullCleanupDeps(home, [], "No sandboxes found.\n");
    const overrides: Record<string, (() => RunResult) | undefined> = {
      "sandbox list": () => ok("[]"),
      "sandbox delete": () => {
        const changed = JSON.parse(fs.readFileSync(registryFile, "utf8"));
        changed.sandboxes["my-assistant"].gpuEnabled = true;
        fs.writeFileSync(registryFile, JSON.stringify(changed));
        return ok();
      },
    };
    const result = await runUninstallPlan(
      { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
      {
        ...deps,
        env: { ...deps.env, OPENSHELL_GATEWAY_ENDPOINT: undefined },
        retainedGatewayPorts: [9125],
        run: (command, args, options) =>
          overrides[args.slice(0, 2).join(" ")]?.() ?? deps.run(command, args, options),
      },
    );
    expect(result.otherGatewayEnvironmentsRemain).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(deps.error.mock.calls.flat().join("\n")).toContain(
      "Could not safely update the sandbox registry",
    );
    const retained = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    expect(retained.sandboxes["my-assistant"].gpuEnabled).toBe(true);
    expect(retained.nativeNvidiaProviderAuthorities.nemoclaw.providerId).toBe("original-provider");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it("stops uninstall safely when provider authority preparation fails (#13470)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-authority-prepare-"));
  const preparation = vi.spyOn(gatewayRegistry, "prepareGatewayProviderAuthorityRetirement");
  try {
    const registryFile = writeFullCleanupState(home);
    fs.writeFileSync(
      registryFile,
      JSON.stringify({
        defaultSandbox: null,
        sandboxes: {},
        nativeNvidiaProviderAuthorities: { nemoclaw: { providerId: "retained-provider" } },
      }),
    );
    const before = fs.readFileSync(registryFile, "utf8");
    preparation.mockImplementationOnce(() => {
      throw new Error("Sandbox registry lock is held by a live process");
    });
    const calls: string[][] = [];
    const deps = fullCleanupDeps(home, calls, "No sandboxes found.\n");
    await expect(
      runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: false, keepOpenShell: false },
        deps,
      ),
    ).resolves.toMatchObject({ exitCode: 1 });
    expect(preparation).toHaveBeenCalledOnce();
    expect(deps.error.mock.calls.flat().join("\n")).toContain("Sandbox registry lock is held");
    expect(calls.some((args) => args[1] === "delete" || args[1] === "remove")).toBe(false);
    expect(fs.readFileSync(registryFile, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(home, ".local", "state", "nemoclaw"))).toBe(true);
  } finally {
    preparation.mockRestore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
