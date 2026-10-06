// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withSuccessfulPreUninstallBackup } from "../../../../test/support/uninstall-managed-gateway-test-support";
import { writeCompleteDockerDriverGatewayLocalTlsBundle } from "../../onboard/__test-helpers__/docker-driver-gateway-local-tls";
import { getDockerDriverGatewayLocalTlsBundle } from "../../onboard/docker-driver-gateway-local-tls";
import { resolveGatewayStateDirName } from "../../onboard/gateway-binding";
import { type RunResult, runUninstallPlanProduction } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

async function failDockerCleanupOnce(
  keepOpenShell = false,
  legacyGateway = false,
  prepareRegistry?: (registryFile: string) => void,
  failureStep: "docker" | "model" = "docker",
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bulk-cleanup-retry-"));
  const gatewayStateDir = path.join(
    home,
    ".local",
    "state",
    "nemoclaw",
    resolveGatewayStateDirName(8080),
  );
  writeCompleteDockerDriverGatewayLocalTlsBundle(gatewayStateDir);
  const clientKeyPath = getDockerDriverGatewayLocalTlsBundle(gatewayStateDir).clientKeyPath;
  const registryFile = path.join(home, ".nemoclaw", "sandboxes.json");
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(
    registryFile,
    JSON.stringify({
      defaultSandbox: "assistant",
      sandboxes: {
        assistant: {
          name: "assistant",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          openshellDriver: "docker",
        },
      },
    }),
  );
  prepareRegistry?.(registryFile);
  const originalRegistry = fs.existsSync(registryFile)
    ? fs.readFileSync(registryFile, "utf8")
    : null;
  let gatewayRegistered = true;
  let gatewayVolumePresent = true;
  let volumeRemovalAttempts = 0;
  let modelInventoryAttempts = 0;
  let deleteSubmissions = 0;
  let inventory = "";
  let rejectDeletion = false;
  let unknownGatewayInventory = false;
  let selectedGatewayInventoryFailure: RunResult | null = null;
  const failure = { status: 1, stdout: "", stderr: "Unknown gateway 'nemoclaw'" };
  const execute = () =>
    runUninstallPlanProduction(
      {
        assumeYes: true,
        deleteModels: failureStep === "model",
        destroyUserData: true,
        keepOpenShell,
        forceFreshReset: true,
      },
      withSuccessfulPreUninstallBackup({
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
        commandExists: () => true,
        env: { HOME: home },
        error: () => undefined,
        log: () => undefined,
        existsSync: (target) => target.startsWith(home) && fs.existsSync(target),
        hasPortableRuntimeCleanup: () => false,
        isTty: false,
        kill: () => true,
        rmSync: fs.rmSync,
        run: (command, args, options) => {
          switch (`${command} ${args.join(" ")}`) {
            case "openshell gateway list":
            case "openshell gateway list -o json": {
              const selectedFailure =
                options?.env?.OPENSHELL_WORKSPACE === "default"
                  ? selectedGatewayInventoryFailure
                  : null;
              return (
                selectedFailure ??
                (unknownGatewayInventory
                  ? { status: 1, stdout: "", stderr: "gateway inventory unavailable" }
                  : ok(JSON.stringify(gatewayRegistered ? [{ name: "nemoclaw" }] : [])))
              );
            }
            case "openshell gateway remove nemoclaw":
              switch (legacyGateway) {
                case true:
                  return {
                    status: 2,
                    stdout: "",
                    stderr: "error: unrecognized subcommand 'remove'",
                  };
                default:
                  gatewayRegistered = false;
                  return ok();
              }
            case "openshell gateway destroy -g nemoclaw":
              gatewayRegistered = false;
              return ok();
            case "openshell sandbox delete --all":
              deleteSubmissions += 1;
              return gatewayRegistered && !rejectDeletion ? ok() : failure;
            case "openshell sandbox list":
              return gatewayRegistered ? ok("No sandboxes found.\n") : failure;
            case "ollama list":
              modelInventoryAttempts += 1;
              return failureStep === "model" && modelInventoryAttempts === 1
                ? { status: 1, stdout: "", stderr: "model inventory unavailable" }
                : ok("NAME ID SIZE MODIFIED\n");
            default:
              return ok();
          }
        },
        runDocker: (args) => {
          switch (args.join(" ")) {
            case "ps -a --format {{.ID}} {{.Image}} {{.Names}}":
              return ok(inventory);
            case "volume inspect openshell-cluster-nemoclaw":
              return gatewayVolumePresent
                ? ok("{}")
                : {
                    status: 1,
                    stdout: "",
                    stderr: "Error: No such volume: openshell-cluster-nemoclaw",
                  };
            case "volume rm -f openshell-cluster-nemoclaw":
              volumeRemovalAttempts += 1;
              switch (`${failureStep}:${String(volumeRemovalAttempts)}`) {
                case "docker:1":
                  return { status: 1, stdout: "", stderr: "volume is busy" };
                default:
                  gatewayVolumePresent = false;
                  return ok();
              }
            default:
              return ok();
          }
        },
      }),
    );
  return {
    initial: await execute(),
    retry: execute,
    registryFile,
    originalRegistry,
    progressFile: path.join(path.dirname(registryFile), "uninstall-bulk-cleanup.json"),
    clientKeyPath,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
    gatewayRegistered: () => gatewayRegistered,
    gatewayVolumePresent: () => gatewayVolumePresent,
    volumeRemovalAttempts: () => volumeRemovalAttempts,
    deleteSubmissions: () => deleteSubmissions,
    restoreGateway: () => {
      gatewayRegistered = true;
      rejectDeletion = true;
    },
    makeGatewayInventoryUnknown: () => {
      unknownGatewayInventory = true;
    },
    failSelectedGatewayInventory: (result: RunResult) => {
      selectedGatewayInventoryFailure = result;
    },
    restoreGatewayInventory: () => {
      unknownGatewayInventory = false;
      selectedGatewayInventoryFailure = null;
    },
    addUnverifiedContainer: () => {
      inventory = "unverified supervisor:test openshell-default--assistant-id\n";
    },
  };
}

describe("bulk cleanup recovery after gateway removal", () => {
  it.each([
    { keepOpenShell: false, legacyGateway: false },
    { keepOpenShell: true, legacyGateway: false },
    { keepOpenShell: false, legacyGateway: true },
    { keepOpenShell: true, legacyGateway: true },
  ])(
    "resumes Docker cleanup with $keepOpenShell and legacy gateway $legacyGateway (#11831)",
    async ({ keepOpenShell, legacyGateway }) => {
      const state = await failDockerCleanupOnce(keepOpenShell, legacyGateway);
      try {
        expect(state.initial.exitCode).toBe(1);
        expect(state.gatewayRegistered()).toBe(false);
        expect(state.volumeRemovalAttempts()).toBe(1);
        expect(fs.readFileSync(state.registryFile, "utf8")).toBe(state.originalRegistry);
        expect((await state.retry()).exitCode).toBe(0);
        expect(state.gatewayVolumePresent()).toBe(false);
        expect(state.volumeRemovalAttempts()).toBe(2);
        expect(state.deleteSubmissions()).toBe(1);
        expect(fs.existsSync(state.registryFile)).toBe(false);
        expect(fs.existsSync(state.progressFile)).toBe(false);
      } finally {
        state.cleanup();
      }
    },
  );

  it("rechecks sandbox deletion when the gateway is registered again (#11831)", async () => {
    const state = await failDockerCleanupOnce();
    try {
      state.restoreGateway();
      expect((await state.retry()).exitCode).toBe(1);
      expect(state.deleteSubmissions()).toBe(2);
      expect(state.volumeRemovalAttempts()).toBe(1);
      expect(state.gatewayVolumePresent()).toBe(true);
      expect(fs.existsSync(state.progressFile)).toBe(false);
    } finally {
      state.cleanup();
    }
  });

  it("preserves retry progress when model cleanup fails after Docker cleanup (#11831)", async () => {
    const state = await failDockerCleanupOnce(false, false, undefined, "model");
    try {
      expect(state.initial.exitCode).toBe(1);
      expect(state.gatewayRegistered()).toBe(false);
      expect(state.gatewayVolumePresent()).toBe(false);
      expect(fs.readFileSync(state.registryFile, "utf8")).toBe(state.originalRegistry);
      expect(fs.existsSync(state.progressFile)).toBe(true);

      expect((await state.retry()).exitCode).toBe(0);
      expect(state.deleteSubmissions()).toBe(1);
      expect(fs.existsSync(state.registryFile)).toBe(false);
      expect(fs.existsSync(state.progressFile)).toBe(false);
    } finally {
      state.cleanup();
    }
  });

  it.each(["missing-progress", "changed-registration", "corrupt-progress", "symlink-progress"])(
    "does not resume with %s (#11831)",
    async (change) => {
      const state = await failDockerCleanupOnce();
      try {
        const registry = JSON.parse(fs.readFileSync(state.registryFile, "utf8"));
        switch (change) {
          case "missing-progress":
            fs.rmSync(state.progressFile);
            break;
          case "corrupt-progress":
            fs.writeFileSync(state.progressFile, "invalid");
            break;
          case "symlink-progress":
            fs.rmSync(state.progressFile);
            fs.symlinkSync(state.registryFile, state.progressFile);
            break;
          default:
            registry.sandboxes.assistant.agent = "hermes";
        }
        fs.writeFileSync(state.registryFile, JSON.stringify(registry));
        expect((await state.retry()).exitCode).toBe(1);
        expect(state.volumeRemovalAttempts()).toBe(1);
        expect(state.gatewayVolumePresent()).toBe(true);
      } finally {
        state.cleanup();
      }
    },
  );

  it("resumes leftover Docker volume cleanup without registered sandboxes (#11831)", async () => {
    const state = await failDockerCleanupOnce(false, false, (registryFile) => {
      fs.rmSync(registryFile);
    });
    try {
      expect(state.initial.exitCode).toBe(1);
      expect((await state.retry()).exitCode).toBe(0);
      expect(state.volumeRemovalAttempts()).toBe(2);
      expect(state.gatewayVolumePresent()).toBe(false);
      expect(state.deleteSubmissions()).toBe(1);
    } finally {
      state.cleanup();
    }
  });

  it("preserves state when gateway absence cannot be verified on retry (#11831)", async () => {
    const state = await failDockerCleanupOnce();
    try {
      state.makeGatewayInventoryUnknown();
      expect((await state.retry()).exitCode).toBe(1);
      expect(state.volumeRemovalAttempts()).toBe(1);
      expect(state.gatewayVolumePresent()).toBe(true);
      expect(fs.readFileSync(state.registryFile, "utf8")).toBe(state.originalRegistry);
      expect(fs.existsSync(state.progressFile)).toBe(true);
      state.restoreGatewayInventory();
      expect((await state.retry()).exitCode).toBe(0);
      expect(state.gatewayVolumePresent()).toBe(false);
    } finally {
      state.cleanup();
    }
  });

  it.each([
    { keepOpenShell: false, legacyGateway: false },
    { keepOpenShell: true, legacyGateway: false },
    { keepOpenShell: false, legacyGateway: true },
    { keepOpenShell: true, legacyGateway: true },
  ])(
    "preserves retry progress after selected gateway inventory fails with keepOpenShell=$keepOpenShell and legacyGateway=$legacyGateway (#11831)",
    async ({ keepOpenShell, legacyGateway }) => {
      const state = await failDockerCleanupOnce(keepOpenShell, legacyGateway);
      try {
        expect(state.initial.exitCode).toBe(1);
        expect(state.gatewayRegistered()).toBe(false);
        const progress = fs.readFileSync(state.progressFile, "utf8");
        // Earlier discovery succeeds; only the later recovery query fails.
        state.failSelectedGatewayInventory({
          status: 1,
          stdout: "",
          stderr: "gateway inventory unavailable",
        });
        expect((await state.retry()).exitCode).toBe(1);
        expect(fs.readFileSync(state.progressFile, "utf8")).toBe(progress);
        expect(fs.readFileSync(state.registryFile, "utf8")).toBe(state.originalRegistry);
        expect(state.deleteSubmissions()).toBe(1);
        expect(state.volumeRemovalAttempts()).toBe(1);
        expect(state.gatewayVolumePresent()).toBe(true);

        state.restoreGatewayInventory();
        expect((await state.retry()).exitCode).toBe(0);
        expect(state.gatewayVolumePresent()).toBe(false);
        expect(state.volumeRemovalAttempts()).toBe(2);
        expect(state.deleteSubmissions()).toBe(1);
        expect(fs.existsSync(state.registryFile)).toBe(false);
        expect(fs.existsSync(state.progressFile)).toBe(false);
      } finally {
        state.cleanup();
      }
    },
  );

  it("preserves retry progress when selected gateway inventory is malformed (#11831)", async () => {
    const state = await failDockerCleanupOnce();
    try {
      const progress = fs.readFileSync(state.progressFile, "utf8");
      state.failSelectedGatewayInventory(ok("invalid inventory"));
      expect((await state.retry()).exitCode).toBe(1);
      expect(fs.readFileSync(state.progressFile, "utf8")).toBe(progress);
      expect(state.deleteSubmissions()).toBe(1);
      expect(state.volumeRemovalAttempts()).toBe(1);

      state.restoreGatewayInventory();
      expect((await state.retry()).exitCode).toBe(0);
      expect(state.gatewayVolumePresent()).toBe(false);
      expect(fs.existsSync(state.progressFile)).toBe(false);
    } finally {
      state.cleanup();
    }
  });

  it.each([
    {
      name: "the TLS client key",
      makeUnreadable: (state: Awaited<ReturnType<typeof failDockerCleanupOnce>>) =>
        fs.chmodSync(state.clientKeyPath, 0o000),
      restore: (state: Awaited<ReturnType<typeof failDockerCleanupOnce>>) =>
        fs.chmodSync(state.clientKeyPath, 0o600),
    },
    {
      name: "the cleanup checkpoint",
      makeUnreadable: (state: Awaited<ReturnType<typeof failDockerCleanupOnce>>) =>
        fs.chmodSync(state.progressFile, 0o000),
      restore: (state: Awaited<ReturnType<typeof failDockerCleanupOnce>>) =>
        fs.chmodSync(state.progressFile, 0o600),
    },
  ])(
    "preserves retry progress while $name is unreadable (#11831)",
    async ({ makeUnreadable, restore }) => {
      const state = await failDockerCleanupOnce();
      try {
        expect(state.initial.exitCode).toBe(1);
        expect(state.gatewayRegistered()).toBe(false);
        makeUnreadable(state);

        expect((await state.retry()).exitCode).toBe(1);
        expect(state.volumeRemovalAttempts()).toBe(1);
        expect(state.gatewayVolumePresent()).toBe(true);
        expect(fs.existsSync(state.progressFile)).toBe(true);

        restore(state);
        expect((await state.retry()).exitCode).toBe(0);
        expect(state.volumeRemovalAttempts()).toBe(2);
        expect(state.gatewayVolumePresent()).toBe(false);
        expect(fs.existsSync(state.progressFile)).toBe(false);
      } finally {
        try {
          fs.chmodSync(state.clientKeyPath, 0o600);
        } catch {
          // A successful retry removes the TLS bundle.
        }
        try {
          fs.chmodSync(state.progressFile, 0o600);
        } catch {
          // A successful retry removes the checkpoint.
        }
        state.cleanup();
      }
    },
  );

  it("preserves state when Docker cannot prove sandbox absence on retry (#11831)", async () => {
    const state = await failDockerCleanupOnce();
    try {
      state.addUnverifiedContainer();
      expect((await state.retry()).exitCode).toBe(1);
      expect(state.volumeRemovalAttempts()).toBe(1);
      expect(state.gatewayVolumePresent()).toBe(true);
      expect(fs.existsSync(state.registryFile)).toBe(true);
    } finally {
      state.cleanup();
    }
  });
});
