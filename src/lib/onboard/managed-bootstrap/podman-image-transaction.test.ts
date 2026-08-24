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
import type { PodmanBootstrapJournal } from "./podman-bootstrap-journal";
import {
  PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION,
  PODMAN_BOOTSTRAP_STATE_DIRECTORY,
  type PodmanBootstrapPreparedReplacement,
} from "./podman-bootstrap-replacement";
import {
  awaitPodmanBootstrapImageTransaction,
  startPodmanBootstrapImageTransaction,
} from "./podman-image-transaction";
import {
  PODMAN_WATCHER_LEASE_SCHEMA_VERSION,
  type PodmanGatewayWatcherLease,
} from "./podman-watcher-lease";

const RUNTIME_ID = "1".repeat(64);
const ORIGINAL_RUNTIME_ID = "0".repeat(64);
const IMAGE_ID = `sha256:${"2".repeat(64)}`;
const BOOTSTRAP_IDENTITY = "3".repeat(64);
const AUTHORITY_ID = `podman-sha256:${"4".repeat(64)}`;
const LEASE_ID = "01234567-89ab-4cde-8fab-0123456789ab";
const SPEC_FINGERPRINT = "5".repeat(64);
const STAGING_NAME = "sandbox-nemoclaw-bootstrap-333333333333";
const STATE_VOLUME_NAME = "sandbox-nemoclaw-state-333333333333";
const STATE_VOLUME_MOUNTPOINT = "/var/lib/containers/storage/volumes/state/_data";

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
      schemaVersion: PODMAN_WATCHER_LEASE_SCHEMA_VERSION,
      holder: { pid: 9_100, processStartIdentity: "holder-start-100" },
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
    assertStillHeld: vi.fn(),
    assertStillStopped: vi.fn(),
    resumeForObservationAndProve: vi.fn(),
    requiesceAndProve: vi.fn(),
    resumeAndProve: vi.fn(),
  };
}

function journal(overrides: Partial<PodmanBootstrapJournal> = {}): PodmanBootstrapJournal {
  return {
    schemaVersion: 1,
    phase: "original-stopped",
    bootstrapIdentity: BOOTSTRAP_IDENTITY,
    engineAuthorityId: AUTHORITY_ID,
    watcherLeaseId: LEASE_ID,
    sandboxName: "sandbox",
    sandboxId: "sandbox-id",
    originalRuntimeId: ORIGINAL_RUNTIME_ID,
    originalContainerName: "sandbox-original",
    originalImageContentId: `sha256:${"6".repeat(64)}`,
    originalSpecFingerprint: "7".repeat(64),
    replacementStateVolumeName: STATE_VOLUME_NAME,
    replacementStateVolumeMountpoint: STATE_VOLUME_MOUNTPOINT,
    replacementRuntimeId: RUNTIME_ID,
    replacementStagingName: STAGING_NAME,
    replacementImageContentId: IMAGE_ID,
    replacementSpecFingerprint: SPEC_FINGERPRINT,
    ...overrides,
  };
}

function preparedReplacement(
  durableJournal: PodmanBootstrapJournal = journal(),
): PodmanBootstrapPreparedReplacement {
  return {
    schemaVersion: PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION,
    bootstrapIdentity: durableJournal.bootstrapIdentity,
    originalRuntimeId: durableJournal.originalRuntimeId,
    replacementRuntimeId: durableJournal.replacementRuntimeId as string,
    replacementStagingName: durableJournal.replacementStagingName,
    replacementStateVolumeName: durableJournal.replacementStateVolumeName,
    replacementStateVolumeMountpoint: durableJournal.replacementStateVolumeMountpoint as string,
    replacementImageContentId: durableJournal.replacementImageContentId,
    replacementSpecFingerprint: durableJournal.replacementSpecFingerprint,
    journal: durableJournal,
  };
}

interface HarnessOptions {
  readonly bootstrapLog?: string;
  readonly bootstrapStartLog?: string;
  readonly completionAgent?: ManagedStartupAgent;
  readonly completionMissingAfterSuccessfulCopyCount?: number;
  readonly completionMode?: number;
  readonly completionUnavailableCount?: number;
  readonly inspectImage?: string;
  readonly inspectName?: string;
  readonly inspectRuntimeId?: string;
  readonly inspectExitCode?: number;
  readonly inspectError?: string;
  readonly inspectStatus?: string;
  readonly inspectStateVolumeMountpoint?: string;
  readonly inspectStateVolumeMode?: string;
  readonly inspectStateVolumeName?: string;
  readonly journal?: PodmanBootstrapJournal | null;
  readonly startsRunning?: boolean;
  readonly startsRunningAfterStart?: boolean;
}

function harness(agent: ManagedStartupAgent, options: HarnessOptions = {}) {
  const request = requestFor(agent);
  const prepared = preparedReplacement();
  const durableJournal = options.journal === undefined ? prepared.journal : options.journal;
  const commands: string[][] = [];
  const commandInputs: Array<Buffer | undefined> = [];
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
          Name: options.inspectName ?? STAGING_NAME,
          Mounts: [
            {
              Destination: PODMAN_BOOTSTRAP_STATE_DIRECTORY,
              Driver: "local",
              Mode: options.inspectStateVolumeMode ?? "z",
              Name: options.inspectStateVolumeName ?? STATE_VOLUME_NAME,
              Options: ["rw"],
              Propagation: "",
              RW: true,
              Source: options.inspectStateVolumeMountpoint ?? STATE_VOLUME_MOUNTPOINT,
              Type: "volume",
            },
          ],
          State: {
            Dead: false,
            Error: options.inspectError ?? "",
            ExitCode: options.inspectExitCode ?? 0,
            OOMKilled: false,
            Paused: false,
            Restarting: false,
            Running: running,
            Status: options.inspectStatus ?? (running ? "running" : "created"),
          },
        },
      ]),
    });
  const start = (): ContainerEngineCommandResult => {
    running = options.startsRunningAfterStart ?? true;
    return result({ stdout: RUNTIME_ID });
  };
  const stageEnvelope = (archive: Buffer | undefined): ContainerEngineCommandResult => {
    expect(archive).toBeInstanceOf(Buffer);
    const payloadSize = Number.parseInt(archive!.subarray(124, 136).toString("ascii"), 8);
    stagedEnvelope = archive!.subarray(512, 512 + payloadSize).toString("utf8");
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
    const unavailable = options.completionUnavailableCount ?? 0;
    const deferredResults = [
      [unavailable, () => result({ status: 1, stderr: "completion not found" })],
      [unavailable + (options.completionMissingAfterSuccessfulCopyCount ?? 0), () => result()],
    ] as const;
    return (
      deferredResults.find(([throughAttempt]) => completionAttempts <= throughAttempt)?.[1]() ??
      publishCompletion(destination)
    );
  };
  const copy = (args: readonly string[], input?: Buffer): ContainerEngineCommandResult => {
    const source = args[2] as string;
    const destination = args[3] as string;
    const publishStartLog = (): ContainerEngineCommandResult =>
      options.bootstrapStartLog === undefined
        ? result({ status: 1, stderr: "start log unavailable" })
        : (() => {
            fs.writeFileSync(destination, options.bootstrapStartLog, {
              flag: "wx",
              mode: 0o600,
            });
            return result();
          })();
    const copiedSource = new Map<string, () => ContainerEngineCommandResult>([
      [
        `${RUNTIME_ID}:/run/nemoclaw/managed-bootstrap-completion.json`,
        () => copyCompletion(destination),
      ],
      [`${RUNTIME_ID}:/tmp/nemoclaw-start.log`, publishStartLog],
    ]).get(source);
    return copiedSource?.() ?? stageEnvelope(input);
  };
  const handlers: Readonly<
    Record<string, (args: readonly string[], input?: Buffer) => ContainerEngineCommandResult>
  > = {
    "container cp": copy,
    "container inspect": inspect,
    "container logs": () => result({ stderr: options.bootstrapLog ?? "" }),
    "container start": start,
  };
  const capture = vi.fn(
    (args: readonly string[], timeoutMs = 15_000, input?: Buffer): ContainerEngineCommandResult => {
      commands.push([...args]);
      commandInputs.push(input);
      timeouts.push(timeoutMs);
      return (
        handlers[`${args[0] ?? ""} ${args[1] ?? ""}`]?.(args, input) ??
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
  const journalStore = { load: vi.fn(() => durableJournal) };
  const watcher = watcherLease();
  return {
    commands,
    commandInputs,
    completionAttempts: () => completionAttempts,
    engine,
    journalStore,
    prepared,
    request,
    stagedEnvelope: () => stagedEnvelope,
    timeouts,
    watcher,
  };
}

function startInput(agent: ManagedStartupAgent, fake: ReturnType<typeof harness>) {
  return {
    agent,
    engine: fake.engine,
    journalStore: fake.journalStore,
    prepared: fake.prepared,
    profileFingerprint: fake.request.profileFingerprint,
    request: fake.request,
    watcherLease: fake.watcher,
  } as const;
}

describe("Podman image-owned bootstrap transaction", () => {
  it.each(MANAGED_STARTUP_AGENTS.filter((agent) => agent !== "pi"))(
    "stages, starts, and authenticates one protected %s completion without exec",
    (agent) => {
      const fake = harness(agent);
      const transaction = startPodmanBootstrapImageTransaction(startInput(agent, fake), {
        now: () => new Date("2026-08-01T12:00:00.000Z"),
      });
      const completion = awaitPodmanBootstrapImageTransaction(
        {
          engine: fake.engine,
          journalStore: fake.journalStore,
          prepared: fake.prepared,
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
        originalRuntimeId: ORIGINAL_RUNTIME_ID,
        replacementRuntimeId: RUNTIME_ID,
        replacementImageContentId: IMAGE_ID,
        replacementSpecFingerprint: SPEC_FINGERPRINT,
        replacementStagingName: STAGING_NAME,
        replacementStateVolumeMountpoint: STATE_VOLUME_MOUNTPOINT,
        replacementStateVolumeName: STATE_VOLUME_NAME,
        watcherLeaseId: LEASE_ID,
      });
      expect(completion).toMatchObject({
        agent,
        bootstrapIdentity: BOOTSTRAP_IDENTITY,
        engineAuthorityId: AUTHORITY_ID,
        originalRuntimeId: ORIGINAL_RUNTIME_ID,
        profileFingerprint: fake.request.profileFingerprint,
        replacementRuntimeId: RUNTIME_ID,
        replacementImageContentId: IMAGE_ID,
        replacementSpecFingerprint: SPEC_FINGERPRINT,
        replacementStagingName: STAGING_NAME,
        replacementStateVolumeMountpoint: STATE_VOLUME_MOUNTPOINT,
        replacementStateVolumeName: STATE_VOLUME_NAME,
        transactionPending: true,
        watcherLeaseId: LEASE_ID,
      });
      expect(fake.commands).toContainEqual(["container", "start", RUNTIME_ID]);
      expect(fake.commands).toContainEqual(["container", "cp", "-", `${RUNTIME_ID}:/`]);
      expect(
        fake.commandInputs.some(
          (input) => input?.subarray(257, 263).toString("ascii") === "ustar\0",
        ),
      ).toBe(true);
      expect(fake.commands).toContainEqual([
        "container",
        "cp",
        `${RUNTIME_ID}:/run/nemoclaw/managed-bootstrap-completion.json`,
        expect.any(String),
      ]);
      expect(fake.commands.every((command) => !command.includes("exec"))).toBe(true);
      expect(fake.commands.every((command) => !command.includes("--user"))).toBe(true);
      expect(fake.watcher.assertStillHeld).toHaveBeenCalled();
    },
  );

  it("retries an unpublished completion while retaining the stopped watcher lease", () => {
    const fake = harness("openclaw", { completionUnavailableCount: 1 });
    const transaction = startPodmanBootstrapImageTransaction(startInput("openclaw", fake));
    let milliseconds = 0;
    const completion = awaitPodmanBootstrapImageTransaction(
      {
        engine: fake.engine,
        journalStore: fake.journalStore,
        prepared: fake.prepared,
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

  it("retries when Podman reports copy success before publishing the destination", () => {
    const fake = harness("langchain-deepagents-code", {
      completionMissingAfterSuccessfulCopyCount: 1,
    });
    const transaction = startPodmanBootstrapImageTransaction(
      startInput("langchain-deepagents-code", fake),
    );
    let milliseconds = 0;
    const completion = awaitPodmanBootstrapImageTransaction(
      {
        engine: fake.engine,
        journalStore: fake.journalStore,
        prepared: fake.prepared,
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

    expect(completion.agent).toBe("langchain-deepagents-code");
    expect(fake.completionAttempts()).toBe(2);
  });

  it("rejects a durable journal lost after replacement startup", () => {
    const fake = harness("openclaw");
    const transaction = startPodmanBootstrapImageTransaction(startInput("openclaw", fake));
    fake.journalStore.load.mockReturnValue(null);

    expect(() =>
      awaitPodmanBootstrapImageTransaction({
        engine: fake.engine,
        journalStore: fake.journalStore,
        prepared: fake.prepared,
        watcherLease: fake.watcher,
        transaction,
        timeoutSecs: 1,
      }),
    ).toThrow("durable prepared-replacement journal is unavailable");
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

  it("rejects a lost durable replacement journal before request staging", () => {
    const fake = harness("openclaw", { journal: null });

    expect(() => startPodmanBootstrapImageTransaction(startInput("openclaw", fake))).toThrow(
      "durable prepared-replacement journal is unavailable",
    );
    expect(fake.commands).toEqual([]);
  });

  it.each([
    ["phase", { phase: "replacement-created" as const }],
    ["engine authority", { engineAuthorityId: `podman-sha256:${"8".repeat(64)}` }],
    ["watcher lease", { watcherLeaseId: "fedcba98-7654-4abc-9def-fedcba987654" }],
    ["replacement runtime", { replacementRuntimeId: "9".repeat(64) }],
    ["replacement image", { replacementImageContentId: `sha256:${"a".repeat(64)}` }],
    ["replacement name", { replacementStagingName: "different-staging-name" }],
    ["state volume", { replacementStateVolumeName: "different-state-volume" }],
  ])("rejects durable %s drift before request staging", (_label, overrides) => {
    const fake = harness("openclaw", { journal: journal(overrides) });

    expect(() => startPodmanBootstrapImageTransaction(startInput("openclaw", fake))).toThrow(
      "exact original-stopped authority",
    );
    expect(fake.commands).toEqual([]);
  });

  it("rejects a replacement that was already running before request staging", () => {
    const fake = harness("hermes", { startsRunning: true });

    expect(() => startPodmanBootstrapImageTransaction(startInput("hermes", fake))).toThrow(
      "not stably stopped",
    );
    expect(fake.commands.some((command) => command[1] === "cp")).toBe(false);
  });

  it("reports the bounded Podman exit state when a replacement does not stay running", () => {
    const fake = harness("hermes", {
      bootstrapLog: "[SECURITY] Managed bootstrap trampoline: agent identity mismatch",
      inspectError: "bootstrap rejected",
      inspectExitCode: 126,
      inspectStatus: "exited",
      startsRunningAfterStart: false,
    });

    expect(() => startPodmanBootstrapImageTransaction(startInput("hermes", fake))).toThrow(
      "not stably running (status exited; exit 126; oom false; error bootstrap rejected; bootstrap [SECURITY] Managed bootstrap trampoline: agent identity mismatch)",
    );
    expect(fake.commands).toContainEqual(["container", "logs", "--tail", "80", RUNTIME_ID]);
  });

  it("reports the bounded managed startup application failure", () => {
    const fake = harness("hermes", {
      bootstrapLog:
        "Managed startup image application failed: required root-owned directory is missing: /var/lib/nemoclaw/runtime-state-mutation",
      inspectExitCode: 1,
      inspectStatus: "exited",
      startsRunningAfterStart: false,
    });

    expect(() => startPodmanBootstrapImageTransaction(startInput("hermes", fake))).toThrow(
      "not stably running (status exited; exit 1; oom false; bootstrap Managed startup image application failed: required root-owned directory is missing: /var/lib/nemoclaw/runtime-state-mutation)",
    );
  });

  it("reports the bounded managed startup shared-state failure", () => {
    const fake = harness("hermes", {
      bootstrapLog:
        "Managed startup shared-state transaction failed: managed output directory crosses a nested filesystem mount: /sandbox/.hermes",
      inspectExitCode: 1,
      inspectStatus: "exited",
      startsRunningAfterStart: false,
    });

    expect(() => startPodmanBootstrapImageTransaction(startInput("hermes", fake))).toThrow(
      "not stably running (status exited; exit 1; oom false; bootstrap Managed startup shared-state transaction failed: managed output directory crosses a nested filesystem mount: /sandbox/.hermes)",
    );
  });

  it("truncates an allowlisted managed startup failure instead of dropping it", () => {
    const detail = "x".repeat(600);
    const fake = harness("hermes", {
      bootstrapLog: `Managed startup image application failed: ${detail}`,
      inspectExitCode: 1,
      inspectStatus: "exited",
      startsRunningAfterStart: false,
    });

    expect(() => startPodmanBootstrapImageTransaction(startInput("hermes", fake))).toThrow(
      `bootstrap ${`Managed startup image application failed: ${detail}`.slice(0, 400)}`,
    );
  });

  it("reports a bounded Hermes startup refusal after managed profile application", () => {
    const fake = harness("hermes", {
      bootstrapLog:
        "[SECURITY] Refusing Hermes startup because /sandbox/.hermes is not a safe directory",
      inspectExitCode: 1,
      inspectStatus: "exited",
      startsRunningAfterStart: false,
    });

    expect(() => startPodmanBootstrapImageTransaction(startInput("hermes", fake))).toThrow(
      "bootstrap [SECURITY] Refusing Hermes startup because /sandbox/.hermes is not a safe directory",
    );
  });

  it("reports the bounded Hermes runtime-state startup refusal", () => {
    const fake = harness("hermes", {
      bootstrapLog:
        "runtime-state-mutation-startup-gate: held\n[SECURITY] Runtime state mutation startup gate failed.",
      inspectExitCode: 1,
      inspectStatus: "exited",
      startsRunningAfterStart: false,
    });

    expect(() => startPodmanBootstrapImageTransaction(startInput("hermes", fake))).toThrow(
      "not stably running (status exited; exit 1; oom false; bootstrap [SECURITY] Runtime state mutation startup gate failed.)",
    );
  });

  it("reports a bounded startup refusal from the protected temp-file copy fallback", () => {
    const fake = harness("hermes", {
      bootstrapLog: "",
      bootstrapStartLog: "[SECURITY] Required entrypoint env-wrapper normalizer is missing.\n",
      inspectExitCode: 1,
      inspectStatus: "exited",
      startsRunningAfterStart: false,
    });

    expect(() => startPodmanBootstrapImageTransaction(startInput("hermes", fake))).toThrow(
      "not stably running (status exited; exit 1; oom false; bootstrap [SECURITY] Required entrypoint env-wrapper normalizer is missing.)",
    );
    expect(fake.commands).toContainEqual([
      "container",
      "cp",
      `${RUNTIME_ID}:/tmp/nemoclaw-start.log`,
      expect.any(String),
    ]);
  });

  it("does not surface non-bootstrap container output in a replacement failure", () => {
    const fake = harness("hermes", {
      bootstrapLog: "secret-looking application output",
      inspectExitCode: 1,
      inspectStatus: "exited",
      startsRunningAfterStart: false,
    });

    expect(() => startPodmanBootstrapImageTransaction(startInput("hermes", fake))).toThrow(
      "not stably running (status exited; exit 1; oom false)",
    );
  });

  it("rejects runtime and image drift before request staging", () => {
    const runtimeDrift = harness("openclaw", { inspectRuntimeId: "5".repeat(64) });
    const imageDrift = harness("openclaw", { inspectImage: `sha256:${"6".repeat(64)}` });

    expect(() =>
      startPodmanBootstrapImageTransaction(startInput("openclaw", runtimeDrift)),
    ).toThrow("runtime, image, or name identity changed");
    expect(() => startPodmanBootstrapImageTransaction(startInput("openclaw", imageDrift))).toThrow(
      "runtime, image, or name identity changed",
    );
  });

  it.each([
    ["replacement name", { inspectName: "different-staging-name" }],
    ["state-volume name", { inspectStateVolumeName: "different-state-volume" }],
    ["state-volume mountpoint", { inspectStateVolumeMountpoint: "/different/mountpoint" }],
  ])("rejects live %s drift before request staging", (_label, options) => {
    const fake = harness("openclaw", options);

    expect(() => startPodmanBootstrapImageTransaction(startInput("openclaw", fake))).toThrow(
      /replacement (runtime, image, or name identity|state-volume authority) changed/u,
    );
    expect(fake.commands.every((command) => command[1] !== "cp")).toBe(true);
  });

  it("accepts an empty non-authoritative Podman state-volume mount mode", () => {
    const fake = harness("openclaw", { inspectStateVolumeMode: "" });

    const transaction = startPodmanBootstrapImageTransaction(startInput("openclaw", fake));

    expect(transaction.replacementStateVolumeName).toBe(STATE_VOLUME_NAME);
    expect(fake.commands).toContainEqual(["container", "start", RUNTIME_ID]);
  });

  it("rejects a copied completion that is not protected mode 0444", () => {
    const fake = harness("langchain-deepagents-code", { completionMode: 0o600 });
    const transaction = startPodmanBootstrapImageTransaction(
      startInput("langchain-deepagents-code", fake),
    );

    expect(() =>
      awaitPodmanBootstrapImageTransaction({
        engine: fake.engine,
        journalStore: fake.journalStore,
        prepared: fake.prepared,
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
        journalStore: fake.journalStore,
        prepared: fake.prepared,
        watcherLease: fake.watcher,
        transaction,
        timeoutSecs: 1,
      }),
    ).toThrow("does not match its exact transaction authority");
  });

  it("rejects engine-authority or watcher-lease drift before polling", () => {
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
        journalStore: fake.journalStore,
        prepared: fake.prepared,
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
        journalStore: fake.journalStore,
        prepared: fake.prepared,
        watcherLease: differentLease,
        transaction,
        timeoutSecs: 1,
      }),
    ).toThrow("exact OpenShell watcher transaction lease");
  });

  it("times out deterministically when the protected completion never appears", () => {
    const fake = harness("hermes", { completionUnavailableCount: 100 });
    const transaction = startPodmanBootstrapImageTransaction(startInput("hermes", fake));
    let milliseconds = 0;

    expect(() =>
      awaitPodmanBootstrapImageTransaction(
        {
          engine: fake.engine,
          journalStore: fake.journalStore,
          prepared: fake.prepared,
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

  it("does not duplicate managed-agent support policy inside the Podman transaction", () => {
    const fake = harness("pi");

    expect(
      startPodmanBootstrapImageTransaction(startInput("pi", fake), {
        now: () => new Date("2026-08-01T12:00:00.000Z"),
      }),
    ).toMatchObject({ agent: "pi" });
  });
});
