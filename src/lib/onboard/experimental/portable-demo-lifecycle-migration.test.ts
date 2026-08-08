// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PodmanSocketAuthorityDeps } from "../../adapters/podman";
import {
  portableDemoLifecycleInternals,
  recoverPortableDemoSandboxLifecycle,
  resolvePortableDemoPrivilegedExecTarget,
} from "./portable-demo-lifecycle";

const CONTAINER_ID = "a".repeat(64);
const SANDBOX_ID = "sandbox-id-alpha";
const SOCKET_PATH = "/run/user/1001/podman/podman.sock";
const temporaryDirectories: string[] = [];
const originalHome = process.env.HOME;

function legacyStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-migration-"));
  temporaryDirectories.push(stateDir);
  const receiptPath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(
    receiptPath,
    `${JSON.stringify({
      schemaVersion: 2,
      sandboxName: "alpha",
      sandboxId: SANDBOX_ID,
      containerId: CONTAINER_ID,
      dashboardPort: 18789,
    })}\n`,
    { mode: 0o600 },
  );
  return stateDir;
}

function socketAuthorityDeps(): PodmanSocketAuthorityDeps {
  const inodes = new Map<string, bigint>();
  return {
    uid: 1001,
    lstat: (filePath) => {
      const socket = filePath === SOCKET_PATH;
      const ino = inodes.get(filePath) ?? BigInt(7000 + inodes.size);
      inodes.set(filePath, ino);
      return {
        dev: 8n,
        ino,
        mode: socket ? 0o660n : filePath === path.dirname(SOCKET_PATH) ? 0o700n : 0o755n,
        uid: socket ? 1001n : filePath.startsWith("/run/user/1001") ? 1001n : 0n,
        isDirectory: () => !socket,
        isSocket: () => socket,
      };
    },
  };
}

function createPodman(matches = [CONTAINER_ID]) {
  return vi.fn((args: readonly string[]) => {
    const command = args[0] === "--url" ? args.slice(2) : args;
    const handlers = {
      info: () => ({ status: 0, stdout: `${SOCKET_PATH}\n` }),
      inspect: () => ({
        status: 0,
        stdout: JSON.stringify([
          {
            Id: CONTAINER_ID,
            Name: "openshell-sandbox-alpha",
            Config: {
              Labels: {
                "openshell.managed": "true",
                "openshell.sandbox-id": SANDBOX_ID,
                "openshell.sandbox-name": "alpha",
              },
            },
            State: { Running: true },
          },
        ]),
      }),
      ps: () => ({ status: 0, stdout: `${matches.join("\n")}\n` }),
    };
    return handlers[command[0] as keyof typeof handlers]();
  });
}

function migrationDeps(
  stateDir: string,
  podman: ReturnType<typeof createPodman>,
  backfill: (generation: string) => boolean,
) {
  return {
    backfillRegistryGeneration: backfill,
    hardenSocketDirectory: vi.fn(),
    platform: "linux" as const,
    podman,
    podmanSocketAuthorityDeps: socketAuthorityDeps(),
    stateDir,
  };
}

async function legacyRegistryEntry(stateDir: string) {
  process.env.HOME = stateDir;
  vi.resetModules();
  const registry = await import("../../state/registry");
  const { compareAndSetLegacySandboxLifecycleGeneration } = await import(
    "../../state/registry/lifecycle-generation"
  );
  registry.registerSandbox({ name: "alpha", agent: "openclaw", openshellDriver: "docker" });
  const expected = registry.getSandbox("alpha")!;
  return {
    backfill: vi.fn((generation: string) =>
      compareAndSetLegacySandboxLifecycleGeneration(expected, generation),
    ),
    registry,
  };
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable lifecycle legacy generation migration", () => {
  it("claims a schema-2 receipt before privileged cleanup and upgrades it (#8584)", async () => {
    const stateDir = legacyStateDir();
    const { backfill, registry } = await legacyRegistryEntry(stateDir);

    expect(
      resolvePortableDemoPrivilegedExecTarget(
        "alpha",
        migrationDeps(stateDir, createPodman(), backfill),
      ),
    ).toMatchObject({ containerId: CONTAINER_ID, dockerHost: `unix://${SOCKET_PATH}` });
    expect(backfill).toHaveBeenCalledWith(CONTAINER_ID);
    expect(
      JSON.parse(
        fs.readFileSync(portableDemoLifecycleInternals.receiptPath("alpha", stateDir), "utf8"),
      ),
    ).toMatchObject({ schemaVersion: 3, registryGeneration: CONTAINER_ID });
    expect(registry.getSandbox("alpha")?.lifecycleGeneration).toBe(CONTAINER_ID);
  });

  it("claims a schema-2 receipt before retained-sandbox recovery (#8584)", async () => {
    const stateDir = legacyStateDir();
    const { backfill, registry } = await legacyRegistryEntry(stateDir);

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", openshellDriver: "docker" },
        {
          ...migrationDeps(stateDir, createPodman(), backfill),
          captureOpenshell: (args) =>
            args.includes("curl") ? { status: 0, stdout: "200" } : { status: 0 },
        },
      ),
    ).toEqual({ kind: "already-running" });
    expect(backfill).toHaveBeenCalledWith(CONTAINER_ID);
    expect(
      JSON.parse(
        fs.readFileSync(portableDemoLifecycleInternals.receiptPath("alpha", stateDir), "utf8"),
      ),
    ).toMatchObject({ schemaVersion: 3, registryGeneration: CONTAINER_ID });
    expect(registry.getSandbox("alpha")?.lifecycleGeneration).toBe(CONTAINER_ID);
  });

  it("finishes a schema-2 receipt upgrade after its registry claim already committed (#8584)", async () => {
    const stateDir = legacyStateDir();
    const { backfill, registry } = await legacyRegistryEntry(stateDir);
    expect(backfill(CONTAINER_ID)).toBe(true);
    backfill.mockClear();
    const podman = createPodman();

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        {
          agent: "openclaw",
          gatewayName: "nemoclaw",
          lifecycleGeneration: CONTAINER_ID,
          openshellDriver: "docker",
        },
        {
          ...migrationDeps(stateDir, podman, backfill),
          captureOpenshell: (args) =>
            args.includes("curl") ? { status: 0, stdout: "200" } : { status: 0 },
        },
      ),
    ).toEqual({ kind: "already-running" });
    expect(backfill).not.toHaveBeenCalled();
    expect(podman).toHaveBeenCalledWith(
      ["info", "--format", "{{.Host.RemoteSocket.Path}}"],
      expect.any(Object),
    );
    expect(
      JSON.parse(
        fs.readFileSync(portableDemoLifecycleInternals.receiptPath("alpha", stateDir), "utf8"),
      ),
    ).toMatchObject({ schemaVersion: 3, registryGeneration: CONTAINER_ID });
    expect(registry.getSandbox("alpha")?.lifecycleGeneration).toBe(CONTAINER_ID);
  });

  it("does not claim an ambiguous legacy portable identity (#8584)", () => {
    const stateDir = legacyStateDir();
    const backfill = vi.fn(() => true);

    expect(() =>
      resolvePortableDemoPrivilegedExecTarget(
        "alpha",
        migrationDeps(stateDir, createPodman([CONTAINER_ID, "b".repeat(64)]), backfill),
      ),
    ).toThrow("found 2");
    expect(backfill).not.toHaveBeenCalled();
    const receipt = JSON.parse(
      fs.readFileSync(portableDemoLifecycleInternals.receiptPath("alpha", stateDir), "utf8"),
    );
    expect(receipt).toMatchObject({ schemaVersion: 2 });
    expect(receipt).not.toHaveProperty("registryGeneration");
  });

  it("does not upgrade the receipt when the registry row changes before its claim (#8584)", async () => {
    const stateDir = legacyStateDir();
    const { backfill, registry } = await legacyRegistryEntry(stateDir);
    registry.updateSandbox("alpha", { model: "replacement" });

    expect(() =>
      resolvePortableDemoPrivilegedExecTarget(
        "alpha",
        migrationDeps(stateDir, createPodman(), backfill),
      ),
    ).toThrow("could not claim the current registry generation");
    const receipt = JSON.parse(
      fs.readFileSync(portableDemoLifecycleInternals.receiptPath("alpha", stateDir), "utf8"),
    );
    expect(receipt).toMatchObject({ schemaVersion: 2 });
    expect(receipt).not.toHaveProperty("registryGeneration");
  });
});
