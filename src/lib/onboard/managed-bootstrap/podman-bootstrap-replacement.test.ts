// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContainerEngineCommandResult } from "../../adapters/container-engine";
import {
  createFilePodmanBootstrapJournalStore,
  type PodmanBootstrapJournalStore,
} from "./podman-bootstrap-journal";
import {
  type AuthorityBoundPodmanBootstrapEngine,
  PODMAN_BOOTSTRAP_IDENTITY_LABEL,
  PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION,
  PODMAN_BOOTSTRAP_STATE_DIRECTORY,
  PODMAN_BOOTSTRAP_STATE_VOLUME_LABEL,
  type PodmanBootstrapPreparedReplacement,
  type PodmanBootstrapReplacementPlan,
  prepareStoppedPodmanBootstrapReplacement,
  rollbackPodmanBootstrapBeforeCommit,
  stopExactPodmanBootstrapOriginal,
} from "./podman-bootstrap-replacement";
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_OPENSHELL_MANAGED_BY_LABEL,
  PODMAN_OPENSHELL_MANAGED_BY_VALUE,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
  type PodmanHeldWorkloadObservation,
} from "./podman-held-workload";
import {
  PODMAN_WATCHER_LEASE_SCHEMA_VERSION,
  type PodmanGatewayWatcherLease,
} from "./podman-watcher-lease";

const BOOTSTRAP_IDENTITY = "1".repeat(64);
const ORIGINAL_RUNTIME_ID = "2".repeat(64);
const REPLACEMENT_RUNTIME_ID = "3".repeat(64);
const EXTRA_RUNTIME_ID = "4".repeat(64);
const ORIGINAL_IMAGE_ID = `sha256:${"5".repeat(64)}`;
const REPLACEMENT_IMAGE_ID = `sha256:${"6".repeat(64)}`;
const ENGINE_AUTHORITY_ID = `podman-sha256:${"7".repeat(64)}`;
const SANDBOX_NAME = "alpha";
const SANDBOX_ID = "sandbox-alpha";
const ORIGINAL_NAME = `${PODMAN_SANDBOX_CONTAINER_PREFIX}${SANDBOX_NAME}-${SANDBOX_ID}`;
const STAGING_NAME = `${ORIGINAL_NAME}-nemoclaw-bootstrap-111111111111`;
const STATE_VOLUME_NAME = `${ORIGINAL_NAME}-nemoclaw-state-111111111111`;
const STATE_VOLUME_MOUNTPOINT = `/var/lib/containers/storage/volumes/${STATE_VOLUME_NAME}/_data`;
const SUPERVISOR_ARGV = ["/opt/openshell/bin/supervisor", "--config", "/etc/openshell.toml"];
const ENTRYPOINT_ARGV = ["/usr/local/bin/nemoclaw-managed-bootstrap"];
const COMMAND_ARGV = ["--apply-root", "--agent", "hermes"];
const ENVIRONMENT = [
  "OPENSHELL_SANDBOX_COMMAND=/usr/local/bin/nemoclaw-start",
  "LOW_ENTROPY_PASSWORD=do-not-put-this-in-process-argv",
];
const LABELS = Object.freeze({
  [PODMAN_MANAGED_LABEL]: "true",
  [PODMAN_SANDBOX_ID_LABEL]: SANDBOX_ID,
  [PODMAN_SANDBOX_NAME_LABEL]: SANDBOX_NAME,
  [PODMAN_SANDBOX_NAMESPACE_LABEL]: "",
  [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
});
const REPLACEMENT_LABELS = Object.freeze({
  ...LABELS,
  [PODMAN_OPENSHELL_MANAGED_BY_LABEL]: PODMAN_OPENSHELL_MANAGED_BY_VALUE,
});
const STATE_VOLUME_LABELS = Object.freeze({
  [PODMAN_BOOTSTRAP_IDENTITY_LABEL]: BOOTSTRAP_IDENTITY,
  [PODMAN_BOOTSTRAP_STATE_VOLUME_LABEL]: "true",
  [PODMAN_SANDBOX_ID_LABEL]: SANDBOX_ID,
  [PODMAN_SANDBOX_NAME_LABEL]: SANDBOX_NAME,
});

const heldWorkload = Object.freeze({
  containerName: ORIGINAL_NAME,
  heldWorkloadArgv: [
    "/usr/local/bin/nemoclaw-managed-hold",
    "--bootstrap-identity",
    BOOTSTRAP_IDENTITY,
  ],
  imageContentId: ORIGINAL_IMAGE_ID,
  labels: LABELS,
  runtimeId: ORIGINAL_RUNTIME_ID,
  running: true,
  sandboxId: SANDBOX_ID,
  sandboxName: SANDBOX_NAME,
  supervisorArgv: SUPERVISOR_ARGV,
} satisfies PodmanHeldWorkloadObservation);

const plan = Object.freeze({
  schemaVersion: PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION,
  bootstrapIdentity: BOOTSTRAP_IDENTITY,
  heldWorkload,
  runtimeArgs: ["--network", "network-id", "--mount", "type=volume,source=workspace,dst=/sandbox"],
  environment: ENVIRONMENT,
  entrypointArgv: ENTRYPOINT_ARGV,
  commandArgv: COMMAND_ARGV,
  replacementImageContentId: REPLACEMENT_IMAGE_ID,
} satisfies PodmanBootstrapReplacementPlan);

interface ContainerState {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly entrypoint: readonly string[];
  readonly command: readonly string[];
  readonly environment: readonly string[];
  readonly mounts: readonly Record<string, unknown>[];
  running: boolean;
}

interface StateVolume {
  readonly name: string;
  readonly mountpoint: string;
  readonly labels: Readonly<Record<string, string>>;
}

class PodmanHarness {
  public readonly calls: string[][] = [];
  public readonly engine: AuthorityBoundPodmanBootstrapEngine;
  public original: ContainerState = {
    id: ORIGINAL_RUNTIME_ID,
    name: ORIGINAL_NAME,
    image: ORIGINAL_IMAGE_ID,
    labels: LABELS,
    entrypoint: [SUPERVISOR_ARGV[0] as string],
    command: SUPERVISOR_ARGV.slice(1),
    environment: [],
    mounts: [],
    running: true,
  };
  public replacement: ContainerState | null = null;
  public stateVolume: StateVolume | null = null;
  public extraStagingIds: string[] = [];
  public createResult: ContainerEngineCommandResult | null = null;
  public replacementStartsOnCreate = false;
  public failReplacementInspectOnce = false;
  public replacementEnvironment: readonly string[] = ENVIRONMENT;
  public stateVolumeMountMode = "z";
  public capturedEnvironmentFile: string | null = null;
  public capturedEnvironmentContents: string | null = null;
  public capturedEnvironmentMode: number | null = null;

  public constructor(authorityId = ENGINE_AUTHORITY_ID) {
    this.engine = {
      operation: "managed-bootstrap",
      engineId: "podman",
      displayName: "Podman",
      authorityId,
      capture: (args) => this.capture(args),
      captureHost: vi.fn(),
    };
  }

  private result(
    stdout = "",
    overrides: Partial<ContainerEngineCommandResult> = {},
  ): ContainerEngineCommandResult {
    return { status: 0, stdout, stderr: "", ...overrides };
  }

  private inspectOutput(container: ContainerState): string {
    return JSON.stringify([
      {
        Id: container.id,
        Image: container.image,
        Name: container.name,
        Config: {
          Cmd: container.command,
          Entrypoint: container.entrypoint,
          Env: container.environment,
          Labels: container.labels,
        },
        State: {
          Dead: false,
          Paused: false,
          Restarting: false,
          Running: container.running,
        },
        Mounts: container.mounts,
      },
    ]);
  }

  private volumeInspectOutput(volume: StateVolume): string {
    return JSON.stringify([
      {
        Anonymous: false,
        Driver: "local",
        Labels: volume.labels,
        Mountpoint: volume.mountpoint,
        Name: volume.name,
        Options: {},
        Scope: "local",
      },
    ]);
  }

  private capture(args: readonly string[]): ContainerEngineCommandResult {
    this.calls.push([...args]);
    switch (`${String(args[0])}:${String(args[1])}`) {
      case "volume:exists":
        return this.result("", { status: args[2] === this.stateVolume?.name ? 0 : 1 });
      case "volume:create":
        return this.createStateVolume();
      case "volume:inspect":
        return args[2] === this.stateVolume?.name
          ? this.result(this.volumeInspectOutput(this.stateVolume))
          : this.result("", { status: 125 });
      case "volume:rm":
        return this.removeStateVolume(args);
      case "container:create":
        return this.createContainer(args);
      case "container:inspect":
        return this.inspectContainer(args);
      case "container:stop":
        expect(args[2]).toBe(this.original.id);
        this.original.running = false;
        return this.result(this.original.id);
      case "container:start":
        expect(args[2]).toBe(this.original.id);
        this.original.running = true;
        return this.result(this.original.id);
      case "container:rm":
        expect(args[2]).toBe(this.replacement?.id);
        this.replacement = null;
        return this.result();
      case "container:exists": {
        const exists = args[2] === this.original.id || args[2] === this.replacement?.id;
        return this.result("", { status: exists ? 0 : 1 });
      }
      case "container:ls": {
        const ids = [...(this.replacement ? [this.replacement.id] : []), ...this.extraStagingIds];
        return this.result(JSON.stringify(ids.map((Id) => ({ Id }))));
      }
      default:
        throw new Error(`Unexpected Podman command: ${args.join(" ")}`);
    }
  }

  private createStateVolume(): ContainerEngineCommandResult {
    switch (this.stateVolume) {
      case null:
        this.stateVolume = {
          name: STATE_VOLUME_NAME,
          mountpoint: STATE_VOLUME_MOUNTPOINT,
          labels: STATE_VOLUME_LABELS,
        };
        return this.result(`${STATE_VOLUME_NAME}\n`);
      default:
        return this.result("", { status: 125 });
    }
  }

  private removeStateVolume(args: readonly string[]): ContainerEngineCommandResult {
    const removable = args[2] === this.stateVolume?.name && this.replacement === null;
    switch (removable) {
      case true:
        this.stateVolume = null;
        return this.result();
      default:
        return this.result("", { status: 125 });
    }
  }

  private createContainer(args: readonly string[]): ContainerEngineCommandResult {
    const environmentFileIndex = args.indexOf("--env-file") + 1;
    const environmentFile = args[environmentFileIndex] as string;
    this.capturedEnvironmentFile = environmentFile;
    this.capturedEnvironmentContents = fs.readFileSync(environmentFile, "utf8");
    this.capturedEnvironmentMode = fs.statSync(environmentFile).mode & 0o777;
    const configuredResult = this.createResult;
    const labels = Object.fromEntries(
      args
        .map((argument, index) => ({ argument, label: args[index + 1] ?? "" }))
        .filter(({ argument }) => argument === "--label")
        .map(({ label }) => ({ label, separator: label.indexOf("=") }))
        .filter(({ separator }) => separator > 0)
        .map(({ label, separator }) => [label.slice(0, separator), label.slice(separator + 1)]),
    );
    switch (configuredResult) {
      case null:
        this.replacement = {
          id: REPLACEMENT_RUNTIME_ID,
          name: STAGING_NAME,
          image: REPLACEMENT_IMAGE_ID,
          labels,
          entrypoint: ENTRYPOINT_ARGV,
          command: COMMAND_ARGV,
          environment: this.replacementEnvironment,
          mounts: [
            {
              Destination: PODMAN_BOOTSTRAP_STATE_DIRECTORY,
              Driver: "local",
              Mode: this.stateVolumeMountMode,
              Name: STATE_VOLUME_NAME,
              Options: ["rw"],
              Propagation: "",
              RW: true,
              Source: STATE_VOLUME_MOUNTPOINT,
              Type: "volume",
            },
          ],
          running: this.replacementStartsOnCreate,
        };
        return this.result(`${REPLACEMENT_RUNTIME_ID}\n`);
      default:
        return configuredResult;
    }
  }

  private inspectContainer(args: readonly string[]): ContainerEngineCommandResult {
    const runtimeId = args[2];
    const failOnce = runtimeId === this.replacement?.id && this.failReplacementInspectOnce;
    switch (failOnce) {
      case true:
        this.failReplacementInspectOnce = false;
        return this.result("", { status: 125, error: new Error("inspect interrupted") });
    }
    const container =
      runtimeId === this.original.id
        ? this.original
        : runtimeId === this.replacement?.id
          ? this.replacement
          : null;
    return container
      ? this.result(this.inspectOutput(container))
      : this.result("", { status: 125, error: new Error("container absent") });
  }
}

const roots: string[] = [];

function journalStore(): PodmanBootstrapJournalStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-replacement-test-"));
  roots.push(root);
  return createFilePodmanBootstrapJournalStore(root);
}

function watcherLease() {
  const assertStillStopped = vi.fn();
  const resumeAndProve = vi.fn();
  const resumeForObservationAndProve = vi.fn();
  const requiesceAndProve = vi.fn();
  const lease: PodmanGatewayWatcherLease = {
    record: {
      schemaVersion: PODMAN_WATCHER_LEASE_SCHEMA_VERSION,
      holder: { pid: 9_100, processStartIdentity: "holder-start-100" },
      leaseId: "123e4567-e89b-42d3-a456-426614174000",
      phase: "stopped",
      gatewayName: "default",
      gatewayPort: 8080,
      launchIdentity: "launch-default",
      ownerIdentity: "owner-default",
      ownerKind: "managed-service",
      pid: 1234,
      processStartIdentity: "pid-start-1234",
    },
    assertStillHeld: assertStillStopped,
    assertStillStopped,
    resumeForObservationAndProve,
    requiesceAndProve,
    resumeAndProve,
  };
  return { assertStillStopped, lease, resumeAndProve };
}

function prepare(
  harness: PodmanHarness,
  store: PodmanBootstrapJournalStore,
  lease: PodmanGatewayWatcherLease,
): PodmanBootstrapPreparedReplacement {
  return prepareStoppedPodmanBootstrapReplacement({
    engine: harness.engine,
    journalStore: store,
    watcherLease: lease,
    plan,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("Podman bootstrap stopped replacement", () => {
  it("journals authority before creating one exact stopped final-labelled replacement", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    const prepared = prepare(harness, store, watcher.lease);

    expect(prepared.replacementRuntimeId).toBe(REPLACEMENT_RUNTIME_ID);
    expect(prepared.replacementStagingName).toBe(STAGING_NAME);
    expect(prepared.replacementStateVolumeName).toBe(STATE_VOLUME_NAME);
    expect(prepared.replacementStateVolumeMountpoint).toBe(STATE_VOLUME_MOUNTPOINT);
    expect(prepared.journal.phase).toBe("replacement-created");
    expect(prepared.journal.engineAuthorityId).toBe(ENGINE_AUTHORITY_ID);
    expect(prepared.journal.watcherLeaseId).toBe(watcher.lease.record.leaseId);
    expect(harness.replacement).toMatchObject({
      id: REPLACEMENT_RUNTIME_ID,
      name: STAGING_NAME,
      image: REPLACEMENT_IMAGE_ID,
      labels: REPLACEMENT_LABELS,
      running: false,
    });
    expect(harness.stateVolume).toEqual({
      name: STATE_VOLUME_NAME,
      mountpoint: STATE_VOLUME_MOUNTPOINT,
      labels: STATE_VOLUME_LABELS,
    });
    expect(harness.calls).toContainEqual([
      "volume",
      "create",
      "--driver",
      "local",
      "--label",
      `${PODMAN_BOOTSTRAP_IDENTITY_LABEL}=${BOOTSTRAP_IDENTITY}`,
      "--label",
      `${PODMAN_BOOTSTRAP_STATE_VOLUME_LABEL}=true`,
      "--label",
      `${PODMAN_SANDBOX_ID_LABEL}=${SANDBOX_ID}`,
      "--label",
      `${PODMAN_SANDBOX_NAME_LABEL}=${SANDBOX_NAME}`,
      STATE_VOLUME_NAME,
    ]);
    expect(harness.calls).toContainEqual(
      expect.arrayContaining([
        "--volume",
        `${STATE_VOLUME_NAME}:${PODMAN_BOOTSTRAP_STATE_DIRECTORY}:rw,z,copy`,
      ]),
    );
    expect(harness.capturedEnvironmentMode).toBe(0o600);
    expect(harness.capturedEnvironmentContents).toBe(`${ENVIRONMENT.join("\n")}\n`);
    expect(fs.existsSync(harness.capturedEnvironmentFile as string)).toBe(false);
    expect(harness.calls.flat().join("\u0000")).not.toContain(ENVIRONMENT[1]);
    expect(JSON.stringify(prepared.journal)).not.toContain("do-not-put-this-in-process-argv");
    expect(watcher.assertStillStopped.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(watcher.resumeAndProve).not.toHaveBeenCalled();
  });

  it("rejects a held workload outside NemoClaw's default OpenShell workspace", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    expect(() =>
      prepareStoppedPodmanBootstrapReplacement({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        plan: {
          ...plan,
          heldWorkload: {
            ...heldWorkload,
            labels: { ...LABELS, [PODMAN_SANDBOX_WORKSPACE_LABEL]: "another-workspace" },
          },
        },
      }),
    ).toThrow("exact OpenShell ownership");
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it("rejects a held workload whose name does not encode its exact OpenShell identity", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    expect(() =>
      prepareStoppedPodmanBootstrapReplacement({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        plan: {
          ...plan,
          heldWorkload: { ...heldWorkload, containerName: `openshell-sandbox-${SANDBOX_NAME}` },
        },
      }),
    ).toThrow("container name does not match exact OpenShell ownership");
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it("accepts a stable Podman inspect with reordered environment entries", () => {
    const harness = new PodmanHarness();
    harness.replacementEnvironment = [...ENVIRONMENT].reverse();
    const store = journalStore();
    const watcher = watcherLease();

    const prepared = prepare(harness, store, watcher.lease);

    expect(prepared.journal.phase).toBe("replacement-created");
    expect(harness.replacement?.environment).toEqual([...ENVIRONMENT].reverse());
  });

  it("accepts an empty non-authoritative Podman volume mount mode", () => {
    const harness = new PodmanHarness();
    harness.stateVolumeMountMode = "";
    const store = journalStore();
    const watcher = watcherLease();

    const prepared = prepare(harness, store, watcher.lease);

    expect(prepared.journal.phase).toBe("replacement-created");
    expect(harness.replacement?.mounts[0]?.Mode).toBe("");
  });

  it("keeps pre-create authority when Podman create fails without exposing command output", () => {
    const harness = new PodmanHarness();
    harness.createResult = {
      status: 125,
      stdout: "credential-in-stdout",
      stderr: "credential-in-stderr",
      error: new Error("socket interrupted"),
    };
    const store = journalStore();
    const watcher = watcherLease();

    expect(() => prepare(harness, store, watcher.lease)).toThrowError(
      /^(?![\s\S]*(?:credential-in-stdout|credential-in-stderr))[\s\S]*failed with status 125: socket interrupted/u,
    );
    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("state-volume-created");
  });

  it("rejects identity flags supplied through provider runtime arguments", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    expect(() =>
      prepareStoppedPodmanBootstrapReplacement({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        plan: { ...plan, runtimeArgs: ["--name=attacker-selected"] },
      }),
    ).toThrow("cannot set '--name'");
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it.each(["-eSECRET=1", "-lcom.nvidia.nemoclaw.override=true", "-d=true"])(
    "rejects attached protected shorthand %s before invoking Podman",
    (argument) => {
      const harness = new PodmanHarness();
      const store = journalStore();
      const watcher = watcherLease();

      expect(() =>
        prepareStoppedPodmanBootstrapReplacement({
          engine: harness.engine,
          journalStore: store,
          watcherLease: watcher.lease,
          plan: { ...plan, runtimeArgs: [argument] },
        }),
      ).toThrow("cannot set");
      expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
      expect(harness.calls).toEqual([]);
    },
  );

  it("does not confuse supported long options with protected shorthand", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();
    const runtimeArgs = [
      ...plan.runtimeArgs,
      "--device",
      "nvidia.com/gpu=all",
      "--log-driver",
      "journald",
      "--expose",
      "8080",
    ];

    const prepared = prepareStoppedPodmanBootstrapReplacement({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      plan: { ...plan, runtimeArgs },
    });

    expect(prepared.journal.phase).toBe("replacement-created");
    expect(harness.calls).toContainEqual(
      expect.arrayContaining(["container", "create", ...runtimeArgs]),
    );
  });

  it("rejects runtime mounts that could shadow image transaction state", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    expect(() =>
      prepareStoppedPodmanBootstrapReplacement({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        plan: {
          ...plan,
          runtimeArgs: [
            "--mount",
            "type=volume,source=attacker,destination=/var/lib/nemoclaw/managed-startup",
          ],
        },
      }),
    ).toThrow("cannot shadow /var/lib/nemoclaw");
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it("recognizes the Podman dest alias without truncating its value", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    const prepared = prepareStoppedPodmanBootstrapReplacement({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      plan: {
        ...plan,
        runtimeArgs: [
          "--mount",
          `type=volume,source=workspace,dest=${PODMAN_BOOTSTRAP_STATE_DIRECTORY}=cache`,
        ],
      },
    });

    expect(prepared.journal.phase).toBe("replacement-created");
  });

  it("rejects a Podman mount specification without a destination", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    expect(() =>
      prepareStoppedPodmanBootstrapReplacement({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        plan: { ...plan, runtimeArgs: ["--mount", "type=volume,source=workspace"] },
      }),
    ).toThrow("requires one destination");
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it("checks every recognized Podman mount destination before rejecting ambiguity", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();

    expect(() =>
      prepareStoppedPodmanBootstrapReplacement({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        plan: {
          ...plan,
          runtimeArgs: [
            "--mount",
            "type=volume,source=workspace,destination=/sandbox,dest=/var/lib/nemoclaw",
          ],
        },
      }),
    ).toThrow("cannot shadow /var/lib/nemoclaw");
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it("fails before journaling when the deterministic state-volume name is occupied", () => {
    const harness = new PodmanHarness();
    harness.stateVolume = {
      name: STATE_VOLUME_NAME,
      mountpoint: STATE_VOLUME_MOUNTPOINT,
      labels: STATE_VOLUME_LABELS,
    };
    const store = journalStore();
    const watcher = watcherLease();

    expect(() => prepare(harness, store, watcher.lease)).toThrow(
      "state-volume name is already in use",
    );
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.replacement).toBeNull();
  });

  it("rejects a replacement that starts before the image-owned transaction owns it", () => {
    const harness = new PodmanHarness();
    harness.replacementStartsOnCreate = true;
    const store = journalStore();
    const watcher = watcherLease();

    expect(() => prepare(harness, store, watcher.lease)).toThrow(
      "identity or state changed after it was pinned",
    );
    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("state-volume-created");
  });

  it("stops only the exact original after the stopped replacement remains stable", () => {
    const harness = new PodmanHarness();
    const capture = vi.spyOn(harness.engine, "capture");
    const store = journalStore();
    const watcher = watcherLease();
    const prepared = prepare(harness, store, watcher.lease);

    const stopped = stopExactPodmanBootstrapOriginal({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      prepared,
      heldWorkload,
    });

    expect(stopped.journal.phase).toBe("original-stopped");
    expect(harness.original.running).toBe(false);
    expect(harness.replacement?.running).toBe(false);
    expect(harness.calls).toContainEqual(["container", "stop", ORIGINAL_RUNTIME_ID]);
    expect(capture).toHaveBeenCalledWith(["container", "stop", ORIGINAL_RUNTIME_ID], 60_000);
    expect(watcher.resumeAndProve).not.toHaveBeenCalled();
  });

  it.each([
    [
      "state-volume mountpoint",
      (prepared: PodmanBootstrapPreparedReplacement) => ({
        ...prepared,
        replacementStateVolumeMountpoint: "/different/state-volume/mountpoint",
      }),
    ],
    [
      "replacement fingerprint",
      (prepared: PodmanBootstrapPreparedReplacement) => ({
        ...prepared,
        replacementSpecFingerprint: "f".repeat(64),
      }),
    ],
  ])("rejects a prepared replacement with a changed %s", (_label, mutate) => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();
    const prepared = prepare(harness, store, watcher.lease);

    expect(() =>
      stopExactPodmanBootstrapOriginal({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        prepared: mutate(prepared),
        heldWorkload,
      }),
    ).toThrow("does not match the durable journal");
    expect(harness.original.running).toBe(true);
    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("replacement-created");
  });

  it("rolls back an exact stopped replacement and restarts the exact original", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();
    const prepared = prepare(harness, store, watcher.lease);
    stopExactPodmanBootstrapOriginal({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      prepared,
      heldWorkload,
    });

    const receipt = rollbackPodmanBootstrapBeforeCommit({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      bootstrapIdentity: BOOTSTRAP_IDENTITY,
      heldWorkload,
    });

    expect(receipt).toEqual({
      bootstrapIdentity: BOOTSTRAP_IDENTITY,
      originalRuntimeId: ORIGINAL_RUNTIME_ID,
      originalStarted: true,
      replacementRemoved: true,
      replacementStateVolumeRemoved: true,
    });
    expect(harness.original.running).toBe(true);
    expect(harness.replacement).toBeNull();
    expect(harness.stateVolume).toBeNull();
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toContainEqual(["container", "rm", REPLACEMENT_RUNTIME_ID]);
    expect(harness.calls).toContainEqual(["volume", "rm", STATE_VOLUME_NAME]);
    expect(harness.calls).toContainEqual(["container", "start", ORIGINAL_RUNTIME_ID]);
    expect(watcher.resumeAndProve).not.toHaveBeenCalled();
  });

  it("reconciles and removes a replacement after its create acknowledgement is lost", () => {
    const harness = new PodmanHarness();
    harness.failReplacementInspectOnce = true;
    const store = journalStore();
    const watcher = watcherLease();
    expect(() => prepare(harness, store, watcher.lease)).toThrow("inspect interrupted");
    expect(store.load(BOOTSTRAP_IDENTITY)).toMatchObject({
      phase: "state-volume-created",
      replacementRuntimeId: null,
    });
    expect(harness.replacement?.id).toBe(REPLACEMENT_RUNTIME_ID);

    const receipt = rollbackPodmanBootstrapBeforeCommit({
      engine: harness.engine,
      journalStore: store,
      watcherLease: watcher.lease,
      bootstrapIdentity: BOOTSTRAP_IDENTITY,
      heldWorkload,
    });

    expect(receipt.originalStarted).toBe(false);
    expect(receipt.replacementRemoved).toBe(true);
    expect(receipt.replacementStateVolumeRemoved).toBe(true);
    expect(harness.original.running).toBe(true);
    expect(harness.replacement).toBeNull();
    expect(harness.stateVolume).toBeNull();
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
  });

  it("fails closed when a recorded state volume disappears before rollback", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();
    prepare(harness, store, watcher.lease);
    harness.stateVolume = null;

    expect(() =>
      rollbackPodmanBootstrapBeforeCommit({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        bootstrapIdentity: BOOTSTRAP_IDENTITY,
        heldWorkload,
      }),
    ).toThrow("recorded state volume disappeared before rollback");
    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("rollback-authorized");
    expect(harness.original.running).toBe(true);
  });

  it("fails closed when rollback discovery finds two staging identities", () => {
    const harness = new PodmanHarness();
    harness.failReplacementInspectOnce = true;
    const store = journalStore();
    const watcher = watcherLease();
    expect(() => prepare(harness, store, watcher.lease)).toThrow("inspect interrupted");
    harness.extraStagingIds = [EXTRA_RUNTIME_ID];

    expect(() =>
      rollbackPodmanBootstrapBeforeCommit({
        engine: harness.engine,
        journalStore: store,
        watcherLease: watcher.lease,
        bootstrapIdentity: BOOTSTRAP_IDENTITY,
        heldWorkload,
      }),
    ).toThrow("ambiguous replacement identities");
    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("rollback-authorized");
    expect(harness.replacement?.id).toBe(REPLACEMENT_RUNTIME_ID);
  });

  it("rejects a different engine authority before a stopped original can be changed", () => {
    const harness = new PodmanHarness();
    const store = journalStore();
    const watcher = watcherLease();
    const prepared = prepare(harness, store, watcher.lease);
    const otherEngine = new PodmanHarness(`podman-sha256:${"8".repeat(64)}`).engine;

    expect(() =>
      stopExactPodmanBootstrapOriginal({
        engine: otherEngine,
        journalStore: store,
        watcherLease: watcher.lease,
        prepared,
        heldWorkload,
      }),
    ).toThrow("does not match the active engine");
    expect(harness.original.running).toBe(true);
    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("replacement-created");
  });
});
