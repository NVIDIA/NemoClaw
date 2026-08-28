// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  capturePortableNetworkAuthority,
  preparePortableRegistryRecovery,
} from "./hermes-portable-ollama-authority";

const NETWORK_ID = "6".repeat(64);
const REGISTRY_ID = "7".repeat(64);
const FOREIGN_REGISTRY_ID = "8".repeat(64);

function createRegistryHarness(initiallyRunning: boolean) {
  const calls: string[][] = [];
  let running = initiallyRunning;
  let status = initiallyRunning ? "running" : "exited";
  let registryId = REGISTRY_ID;
  let registryName = "nemoclaw-portable-registry";
  let registryLabel = "1";
  let registryNetworkId = NETWORK_ID;
  let registryIp = initiallyRunning ? "10.87.0.3" : "";
  let registryCopies = 1;
  let registryPresent = true;
  let startStatus = 0;
  let startError: Error | undefined;
  let startLabel: string | undefined;
  let startChangesState = true;
  const engine = {
    capture: vi.fn((args: readonly string[]) => {
      calls.push([...args]);
      switch (args[0]) {
        case "network":
          expect(args[1]).toBe("inspect");
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: NETWORK_ID,
                name: "openshell-docker",
                driver: "bridge",
                internal: false,
                ipv6_enabled: false,
                dns_enabled: true,
                network_interface: "podman9",
                subnets: [{ subnet: "10.87.0.0/24", gateway: "10.87.0.1" }],
                labels: {},
                ipam_options: {},
                options: {},
              },
            ]),
            stderr: "",
          };
        case "container": {
          expect(args[1]).toBe("inspect");
          const referenceMatches =
            args[2] === "nemoclaw-portable-registry" || args[2] === registryId;
          const row = {
            Id: registryId,
            Name: registryName,
            Config: { Labels: { "com.nvidia.nemoclaw.portable": registryLabel } },
            State: { Running: running, Status: status },
            NetworkSettings: {
              Networks: {
                "openshell-docker": {
                  NetworkID: registryNetworkId,
                  IPAddress: registryIp,
                },
              },
            },
          };
          return registryPresent && referenceMatches
            ? {
                status: 0,
                stdout: JSON.stringify(Array.from({ length: registryCopies }, () => row)),
                stderr: "",
              }
            : { status: 1, stdout: "", stderr: "not found" };
        }
        case "start":
          expect(args[1]).toBe(REGISTRY_ID);
          running = startChangesState ? true : running;
          status = startChangesState ? "running" : status;
          registryIp = startChangesState ? "10.87.0.3" : registryIp;
          registryLabel = startLabel ?? registryLabel;
          return {
            status: startStatus,
            stdout: REGISTRY_ID,
            stderr: "",
            ...(startError ? { error: startError } : {}),
          };
        case "stop":
          expect(args.at(-1)).toBe(REGISTRY_ID);
          running = false;
          status = "exited";
          registryIp = "";
          return { status: 0, stdout: REGISTRY_ID, stderr: "" };
        default:
          throw new Error(`Unexpected registry test command: ${args.join(" ")}`);
      }
    }),
  };
  const expectedAuthoritySha256 = (() => {
    const priorRunning = running;
    const priorStatus = status;
    const priorIp = registryIp;
    running = true;
    status = "running";
    registryIp = "10.87.0.3";
    const value = capturePortableNetworkAuthority(engine as never).authoritySha256;
    running = priorRunning;
    status = priorStatus;
    registryIp = priorIp;
    calls.length = 0;
    engine.capture.mockClear();
    return value;
  })();
  return {
    calls,
    engine,
    expectedAuthoritySha256,
    isRunning: () => running,
    setCopies: (value: number) => {
      registryCopies = value;
    },
    setIdentity: (value: string) => {
      registryId = value;
    },
    setLabel: (value: string) => {
      registryLabel = value;
    },
    setName: (value: string) => {
      registryName = value;
    },
    setNetworkId: (value: string) => {
      registryNetworkId = value;
    },
    setPresent: (value: boolean) => {
      registryPresent = value;
    },
    setStartOutcome: (value: { readonly status: number; readonly changesState: boolean }) => {
      startStatus = value.status;
      startChangesState = value.changesState;
    },
    setStartError: (code: string, changesState: boolean) => {
      startStatus = 1;
      startError = Object.assign(new Error("spawnSync podman failed"), { code });
      startChangesState = changesState;
    },
    setStartLabel: (value: string) => {
      startLabel = value;
    },
    setStartTimeout: (changesState: boolean) => {
      startStatus = 1;
      startError = Object.assign(new Error("spawnSync podman ETIMEDOUT"), {
        code: "ETIMEDOUT",
      });
      startChangesState = changesState;
    },
  };
}

type RegistryHarness = ReturnType<typeof createRegistryHarness>;

const rejectionCases: ReadonlyArray<{
  readonly label: string;
  readonly mutate: (harness: RegistryHarness) => void;
  readonly digestOverride?: string;
}> = [
  { label: "wrong digest", mutate: () => undefined, digestOverride: "9".repeat(64) },
  { label: "ambiguous name", mutate: (harness) => harness.setCopies(2) },
  { label: "foreign name", mutate: (harness) => harness.setName("other") },
  { label: "foreign label", mutate: (harness) => harness.setLabel("0") },
  { label: "foreign network", mutate: (harness) => harness.setNetworkId("8".repeat(64)) },
  { label: "missing registry", mutate: (harness) => harness.setPresent(false) },
];

describe("Hermes Portable registry recovery", () => {
  it("starts and rolls back only the pinned full stopped registry ID", () => {
    const harness = createRegistryHarness(false);
    const prepared = preparePortableRegistryRecovery(
      harness.engine as never,
      harness.expectedAuthoritySha256,
      vi.fn(),
      vi.fn(),
    );

    expect(prepared.started).toBe(true);
    expect(harness.isRunning()).toBe(true);
    expect(harness.calls).toContainEqual(["start", REGISTRY_ID]);
    prepared.assertCurrent();
    prepared.rollback();
    expect(harness.isRunning()).toBe(false);
    expect(harness.calls).toContainEqual(["stop", "--time", "10", REGISTRY_ID]);
  });

  it("leaves an already running exact registry verification-only", () => {
    const harness = createRegistryHarness(true);
    const prepared = preparePortableRegistryRecovery(
      harness.engine as never,
      harness.expectedAuthoritySha256,
      vi.fn(),
      vi.fn(),
    );

    expect(prepared.started).toBe(false);
    prepared.assertCurrent();
    prepared.release();
    expect(harness.calls.some((args) => args[0] === "start" || args[0] === "stop")).toBe(false);
  });

  it.each(rejectionCases)(
    "rejects $label before registry mutation",
    ({ mutate, digestOverride }) => {
      const harness = createRegistryHarness(false);
      mutate(harness);

      expect(() =>
        preparePortableRegistryRecovery(
          harness.engine as never,
          digestOverride ?? harness.expectedAuthoritySha256,
          vi.fn(),
          vi.fn(),
        ),
      ).toThrow();
      expect(harness.calls.some((args) => args[0] === "start" || args[0] === "stop")).toBe(false);
    },
  );

  it("rejects a same-name replacement before starting it", () => {
    const harness = createRegistryHarness(false);
    harness.setIdentity(FOREIGN_REGISTRY_ID);

    expect(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    ).toThrow("differs from receipt");
    expect(harness.calls.some((args) => args[0] === "start")).toBe(false);
  });

  it("restores the exact stopped state when start reports failure after mutation", () => {
    const harness = createRegistryHarness(false);
    harness.setStartOutcome({ status: 125, changesState: true });

    expect(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    ).toThrow("could not start its exact registry authority");
    expect(harness.isRunning()).toBe(false);
    expect(harness.calls).toContainEqual(["stop", "--time", "10", REGISTRY_ID]);
  });

  it("accepts an exact running registry after the pinned start times out", () => {
    const harness = createRegistryHarness(false);
    harness.setStartTimeout(true);

    const prepared = preparePortableRegistryRecovery(
      harness.engine as never,
      harness.expectedAuthoritySha256,
      vi.fn(),
      vi.fn(),
    );

    expect(prepared.started).toBe(true);
    expect(harness.isRunning()).toBe(true);
    expect(harness.calls).toContainEqual(["start", REGISTRY_ID]);
    expect(harness.calls.some((args) => args[0] === "stop")).toBe(false);
  });

  it("keeps a timed-out start terminal when the pinned registry remains stopped", () => {
    const harness = createRegistryHarness(false);
    harness.setStartTimeout(false);

    expect(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    ).toThrow("could not start its exact registry authority");
    expect(harness.isRunning()).toBe(false);
  });

  it("rejects a timed-out start when the running registry authority changed", () => {
    const harness = createRegistryHarness(false);
    harness.setStartTimeout(true);
    harness.setStartLabel("changed");

    expect(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    ).toThrow();
    expect(harness.isRunning()).toBe(false);
  });

  it("rolls back an exact running registry after an ordinary spawn error", () => {
    const harness = createRegistryHarness(false);
    harness.setStartError("EIO", true);

    expect(() =>
      preparePortableRegistryRecovery(
        harness.engine as never,
        harness.expectedAuthoritySha256,
        vi.fn(),
        vi.fn(),
      ),
    ).toThrow("could not start its exact registry authority");
    expect(harness.isRunning()).toBe(false);
    expect(harness.calls).toContainEqual(["stop", "--time", "10", REGISTRY_ID]);
  });

  it("rejects authority drift after accepting a timed-out exact start", () => {
    const harness = createRegistryHarness(false);
    harness.setStartTimeout(true);
    const prepared = preparePortableRegistryRecovery(
      harness.engine as never,
      harness.expectedAuthoritySha256,
      vi.fn(),
      vi.fn(),
    );
    harness.setLabel("changed");

    expect(() => prepared.assertCurrent()).toThrow();
    expect(() => prepared.rollback()).toThrow();
    expect(harness.isRunning()).toBe(false);
  });

  it("stops the pinned registry before reporting post-start authority drift", () => {
    const harness = createRegistryHarness(false);
    const prepared = preparePortableRegistryRecovery(
      harness.engine as never,
      harness.expectedAuthoritySha256,
      vi.fn(),
      vi.fn(),
    );
    harness.setLabel("changed");

    expect(() => prepared.rollback()).toThrow();
    expect(harness.isRunning()).toBe(false);
    expect(harness.calls).toContainEqual(["stop", "--time", "10", REGISTRY_ID]);
  });
});
