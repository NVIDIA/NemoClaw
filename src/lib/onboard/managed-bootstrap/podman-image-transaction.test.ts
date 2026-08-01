// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { ContainerEngineCommandResult } from "../../adapters/container-engine";
import {
  encodeManagedStartupProfile,
  MANAGED_STARTUP_AGENTS,
  type ManagedStartupAgent,
} from "../managed-startup/profile";
import { createManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import {
  parseManagedBootstrapEnvelope,
  serializeManagedBootstrapImageCompletion,
} from "./envelope";
import {
  awaitPodmanBootstrapImageTransaction,
  startPodmanBootstrapImageTransaction,
} from "./podman-image-transaction";
import type { PodmanGatewayWatcherLease } from "./podman-watcher-lease";

const RUNTIME_ID = "1".repeat(64);
const IMAGE_ID = `sha256:${"2".repeat(64)}`;
const BOOTSTRAP_IDENTITY = "3".repeat(64);
const AUTHORITY_ID = `podman-sha256:${"4".repeat(64)}`;
const LEASE_ID = "01234567-89ab-4cde-8fab-0123456789ab";

function requestFor(agent: ManagedStartupAgent) {
  return createManagedStartupRootApplyRequest({
    agent,
    encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile(agent, false, false)),
  });
}

function result(
  overrides: Partial<ContainerEngineCommandResult> = {},
): ContainerEngineCommandResult {
  return { status: 0, stdout: "", stderr: "", ...overrides };
}

function watcherLease(): PodmanGatewayWatcherLease {
  return {
    record: {
      schemaVersion: 1,
      leaseId: LEASE_ID,
      phase: "stopped",
      gatewayName: "gateway",
      gatewayPort: 8080,
      launchIdentity: "launch-1",
      ownerIdentity: "owner-1",
      ownerKind: "managed-service",
      pid: 42,
      processStartIdentity: "pid-start-1",
    },
    assertStillStopped: vi.fn(),
    resumeAndProve: vi.fn(),
  };
}

interface HarnessOptions {
  readonly completionAgent?: ManagedStartupAgent;
  readonly completionMode?: number;
  readonly completionUnavailableCount?: number;
  readonly inspectImage?: string;
  readonly inspectRuntimeId?: string;
  readonly startsRunning?: boolean;
}

function harness(agent: ManagedStartupAgent, options: HarnessOptions = {}) {
  const request = requestFor(agent);
  const commands: string[][] = [];
  const timeouts: number[] = [];
  let running = options.startsRunning ?? false;
  let completionAttempts = 0;
  let stagedEnvelope = "";
  const inspect = (): ContainerEngineCommandResult =>
    result({
      stdout: JSON.stringify([
        {
          Id: options.inspectRuntimeId ?? RUNTIME_ID,
          Image: options.inspectImage ?? IMAGE_ID,
          State: { Dead: false, Paused: false, Restarting: false, Running: running },
        },
      ]),
    });
  const start = (): ContainerEngineCommandResult => {
    running = true;
    return result({ stdout: RUNTIME_ID });
  };
  const stageEnvelope = (source: string): ContainerEngineCommandResult => {
    stagedEnvelope = fs.readFileSync(source, "utf8");
    return result();
  };
  const publishCompletion = (destination: string): ContainerEngineCommandResult => {
    fs.writeFileSync(
      destination,
      serializeManagedBootstrapImageCompletion({
        agent: options.completionAgent ?? agent,
        bootstrapIdentity: BOOTSTRAP_IDENTITY,
        profileFingerprint: request.profileFingerprint,
        transactionPending: true,
      }),
      { flag: "wx", mode: options.completionMode ?? 0o444 },
    );
    fs.chmodSync(destination, options.completionMode ?? 0o444);
    return result();
  };
  const copyCompletion = (destination: string): ContainerEngineCommandResult => {
    completionAttempts += 1;
    return completionAttempts <= (options.completionUnavailableCount ?? 0)
      ? result({ status: 1, stderr: "completion not found" })
      : publishCompletion(destination);
  };
  const copy = (args: readonly string[]): ContainerEngineCommandResult => {
    const source = args[2] as string;
    const destination = args[3] as string;
    return source.startsWith(`${RUNTIME_ID}:`)
      ? copyCompletion(destination)
      : stageEnvelope(source);
  };
  const handlers: Readonly<
    Record<string, (args: readonly string[]) => ContainerEngineCommandResult>
  > = {
    "container cp": copy,
    "container inspect": inspect,
    "container start": start,
  };
  const capture = vi.fn(
    (args: readonly string[], timeoutMs = 15_000): ContainerEngineCommandResult => {
      commands.push([...args]);
      timeouts.push(timeoutMs);
      return (
        handlers[`${args[0] ?? ""} ${args[1] ?? ""}`]?.(args) ??
        result({ status: 127, stderr: "unexpected command" })
      );
    },
  );
  const engine = {
    operation: "managed-bootstrap" as const,
    engineId: "podman",
    displayName: "Podman",
    authorityId: AUTHORITY_ID,
    capture,
    captureHost: vi.fn(),
  };
  const watcher = watcherLease();
  return {
    commands,
    completionAttempts: () => completionAttempts,
    engine,
    request,
    stagedEnvelope: () => stagedEnvelope,
    timeouts,
    watcher,
  };
}

function startInput(agent: ManagedStartupAgent, fake: ReturnType<typeof harness>) {
  return {
    agent,
    bootstrapIdentity: BOOTSTRAP_IDENTITY,
    engine: fake.engine,
    profileFingerprint: fake.request.profileFingerprint,
    replacementImageContentId: IMAGE_ID,
    replacementRuntimeId: RUNTIME_ID,
    request: fake.request,
    watcherLease: fake.watcher,
  } as const;
}

describe("Podman image-owned bootstrap transaction", () => {
  it.each(
    MANAGED_STARTUP_AGENTS,
  )("stages, starts, and authenticates one protected %s completion without exec", (agent) => {
    const fake = harness(agent);
    const transaction = startPodmanBootstrapImageTransaction(startInput(agent, fake), {
      now: () => new Date("2026-08-01T12:00:00.000Z"),
    });
    const completion = awaitPodmanBootstrapImageTransaction(
      {
        engine: fake.engine,
        watcherLease: fake.watcher,
        transaction,
        timeoutSecs: 30,
      },
      { now: () => new Date("2026-08-01T12:00:01.000Z") },
    );

    expect(parseManagedBootstrapEnvelope(fake.stagedEnvelope())).toEqual({
      schemaVersion: 1,
      bootstrapIdentity: BOOTSTRAP_IDENTITY,
      rootApplyRequest: fake.request,
    });
    expect(transaction).toMatchObject({
      agent,
      bootstrapIdentity: BOOTSTRAP_IDENTITY,
      engineAuthorityId: AUTHORITY_ID,
      replacementRuntimeId: RUNTIME_ID,
      replacementImageContentId: IMAGE_ID,
      watcherLeaseId: LEASE_ID,
    });
    expect(completion).toMatchObject({
      agent,
      bootstrapIdentity: BOOTSTRAP_IDENTITY,
      engineAuthorityId: AUTHORITY_ID,
      profileFingerprint: fake.request.profileFingerprint,
      replacementRuntimeId: RUNTIME_ID,
      replacementImageContentId: IMAGE_ID,
      transactionPending: true,
      watcherLeaseId: LEASE_ID,
    });
    expect(fake.commands).toContainEqual(["container", "start", RUNTIME_ID]);
    expect(fake.commands).toContainEqual([
      "container",
      "cp",
      `${RUNTIME_ID}:/run/nemoclaw/managed-bootstrap-completion.json`,
      expect.any(String),
    ]);
    expect(fake.commands.every((command) => !command.includes("exec"))).toBe(true);
    expect(fake.commands.every((command) => !command.includes("--user"))).toBe(true);
    expect(fake.watcher.assertStillStopped).toHaveBeenCalled();
  });

  it("retries an unpublished completion while retaining the stopped watcher lease", () => {
    const fake = harness("openclaw", { completionUnavailableCount: 1 });
    const transaction = startPodmanBootstrapImageTransaction(startInput("openclaw", fake));
    let milliseconds = 0;
    const completion = awaitPodmanBootstrapImageTransaction(
      {
        engine: fake.engine,
        watcherLease: fake.watcher,
        transaction,
        timeoutSecs: 1,
      },
      {
        now: () => new Date(milliseconds),
        pollIntervalMs: 25,
        sleep: (duration) => {
          milliseconds += duration;
        },
      },
    );

    expect(completion.agent).toBe("openclaw");
    expect(fake.completionAttempts()).toBe(2);
  });

  it("rejects a root request belonging to another agent before any container mutation", () => {
    const fake = harness("openclaw");

    expect(() =>
      startPodmanBootstrapImageTransaction({
        ...startInput("openclaw", fake),
        request: requestFor("hermes"),
      }),
    ).toThrow("root request does not match");
    expect(fake.commands).toEqual([]);
  });

  it("rejects a replacement that was already running before request staging", () => {
    const fake = harness("hermes", { startsRunning: true });

    expect(() => startPodmanBootstrapImageTransaction(startInput("hermes", fake))).toThrow(
      "not stably stopped",
    );
    expect(fake.commands.some((command) => command[1] === "cp")).toBe(false);
  });

  it("rejects runtime and image drift before request staging", () => {
    const runtimeDrift = harness("openclaw", { inspectRuntimeId: "5".repeat(64) });
    const imageDrift = harness("openclaw", { inspectImage: `sha256:${"6".repeat(64)}` });

    expect(() =>
      startPodmanBootstrapImageTransaction(startInput("openclaw", runtimeDrift)),
    ).toThrow("runtime or image identity changed");
    expect(() => startPodmanBootstrapImageTransaction(startInput("openclaw", imageDrift))).toThrow(
      "runtime or image identity changed",
    );
  });

  it("rejects a copied completion that is not protected mode 0444", () => {
    const fake = harness("langchain-deepagents-code", { completionMode: 0o600 });
    const transaction = startPodmanBootstrapImageTransaction(
      startInput("langchain-deepagents-code", fake),
    );

    expect(() =>
      awaitPodmanBootstrapImageTransaction({
        engine: fake.engine,
        watcherLease: fake.watcher,
        transaction,
        timeoutSecs: 1,
      }),
    ).toThrow("protected bounded 0444 file");
  });

  it("rejects completion from another agent", () => {
    const fake = harness("openclaw", { completionAgent: "hermes" });
    const transaction = startPodmanBootstrapImageTransaction(startInput("openclaw", fake));

    expect(() =>
      awaitPodmanBootstrapImageTransaction({
        engine: fake.engine,
        watcherLease: fake.watcher,
        transaction,
        timeoutSecs: 1,
      }),
    ).toThrow("does not match its exact transaction authority");
  });

  it("rejects endpoint-authority or watcher-lease drift before polling", () => {
    const fake = harness("openclaw");
    const transaction = startPodmanBootstrapImageTransaction(startInput("openclaw", fake));
    const commandsBefore = fake.commands.length;
    const differentEngine = {
      ...fake.engine,
      authorityId: `podman-sha256:${"7".repeat(64)}`,
    };

    expect(() =>
      awaitPodmanBootstrapImageTransaction({
        engine: differentEngine,
        watcherLease: fake.watcher,
        transaction,
        timeoutSecs: 1,
      }),
    ).toThrow("exact Podman managed-bootstrap engine authority");
    expect(fake.commands).toHaveLength(commandsBefore);

    const differentLease = watcherLease();
    Object.defineProperty(differentLease.record, "leaseId", {
      configurable: true,
      value: "fedcba98-7654-4abc-9def-fedcba987654",
    });
    expect(() =>
      awaitPodmanBootstrapImageTransaction({
        engine: fake.engine,
        watcherLease: differentLease,
        transaction,
        timeoutSecs: 1,
      }),
    ).toThrow("exact stopped OpenShell watcher lease");
  });

  it("times out deterministically when the protected completion never appears", () => {
    const fake = harness("hermes", { completionUnavailableCount: 100 });
    const transaction = startPodmanBootstrapImageTransaction(startInput("hermes", fake));
    let milliseconds = 0;

    expect(() =>
      awaitPodmanBootstrapImageTransaction(
        {
          engine: fake.engine,
          watcherLease: fake.watcher,
          transaction,
          timeoutSecs: 1,
        },
        {
          now: () => new Date(milliseconds),
          pollIntervalMs: 500,
          sleep: (duration) => {
            milliseconds += duration;
          },
        },
      ),
    ).toThrow("not published before timeout");
    expect(fake.completionAttempts()).toBe(3);
  });
});
