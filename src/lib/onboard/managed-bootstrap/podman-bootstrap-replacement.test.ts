// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import {
  createFilePodmanBootstrapJournalStore,
  type PodmanBootstrapJournalStore,
} from "./podman-bootstrap-journal";
import {
  type PodmanHeldWorkloadObservation,
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
} from "./podman-held-workload";
import {
  type AuthorityBoundPodmanBootstrapEngine,
  type PodmanBootstrapPreparedReplacement,
  type PodmanBootstrapReplacementPlan,
  PODMAN_BOOTSTRAP_REPLACEMENT_SCHEMA_VERSION,
  prepareStoppedPodmanBootstrapReplacement,
  rollbackPodmanBootstrapBeforeCommit,
  stopExactPodmanBootstrapOriginal,
} from "./podman-bootstrap-replacement";
import {
  type PodmanGatewayWatcherLease,
  PODMAN_WATCHER_LEASE_SCHEMA_VERSION,
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
const ORIGINAL_NAME = `openshell-sandbox-${SANDBOX_NAME}`;
const STAGING_NAME = `${ORIGINAL_NAME}-nemoclaw-bootstrap-${BOOTSTRAP_IDENTITY.slice(0, 12)}`;
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
  running: boolean;
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
    running: true,
  };
  public replacement: ContainerState | null = null;
  public extraStagingIds: string[] = [];
  public createResult: ContainerEngineCommandResult | null = null;
  public replacementStartsOnCreate = false;
  public failReplacementInspectOnce = false;
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
      },
    ]);
  }

  private capture(args: readonly string[]): ContainerEngineCommandResult {
    this.calls.push([...args]);
    if (args[0] !== "container") throw new Error(`Unexpected Podman command: ${args.join(" ")}`);
    if (args[1] === "create") {
      const environmentFileIndex = args.indexOf("--env-file") + 1;
      const environmentFile = args[environmentFileIndex] as string;
      this.capturedEnvironmentFile = environmentFile;
      this.capturedEnvironmentContents = fs.readFileSync(environmentFile, "utf8");
      this.capturedEnvironmentMode = fs.statSync(environmentFile).mode & 0o777;
      if (this.createResult) return this.createResult;
      this.replacement = {
        id: REPLACEMENT_RUNTIME_ID,
        name: STAGING_NAME,
        image: REPLACEMENT_IMAGE_ID,
        labels: LABELS,
        entrypoint: ENTRYPOINT_ARGV,
        command: COMMAND_ARGV,
        environment: ENVIRONMENT,
        running: this.replacementStartsOnCreate,
      };
      return this.result(`${REPLACEMENT_RUNTIME_ID}\n`);
    }
    if (args[1] === "inspect") {
      const runtimeId = args[2];
      if (runtimeId === this.replacement?.id && this.failReplacementInspectOnce) {
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
    if (args[1] === "stop" && args[2] === this.original.id) {
      this.original.running = false;
      return this.result(this.original.id);
    }
    if (args[1] === "start" && args[2] === this.original.id) {
      this.original.running = true;
      return this.result(this.original.id);
    }
    if (args[1] === "rm" && args[2] === this.replacement?.id) {
      this.replacement = null;
      return this.result();
    }
    if (args[1] === "exists") {
      const exists = args[2] === this.original.id || args[2] === this.replacement?.id;
      return this.result("", { status: exists ? 0 : 1 });
    }
    if (args[1] === "ls") {
      const ids = [
        ...(this.replacement ? [this.replacement.id] : []),
        ...this.extraStagingIds,
      ];
      return this.result(JSON.stringify(ids.map((Id) => ({ Id }))));
    }
    throw new Error(`Unexpected Podman command: ${args.join(" ")}`);
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
  const lease: PodmanGatewayWatcherLease = {
    record: {
      schemaVersion: PODMAN_WATCHER_LEASE_SCHEMA_VERSION,
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
    assertStillStopped,
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
    expect(prepared.journal.phase).toBe("replacement-created");
    expect(prepared.journal.engineAuthorityId).toBe(ENGINE_AUTHORITY_ID);
    expect(prepared.journal.watcherLeaseId).toBe(watcher.lease.record.leaseId);
    expect(harness.replacement).toMatchObject({
      id: REPLACEMENT_RUNTIME_ID,
      name: STAGING_NAME,
      image: REPLACEMENT_IMAGE_ID,
      labels: LABELS,
      running: false,
    });
    expect(harness.capturedEnvironmentMode).toBe(0o600);
    expect(harness.capturedEnvironmentContents).toBe(`${ENVIRONMENT.join("\n")}\n`);
    expect(fs.existsSync(harness.capturedEnvironmentFile as string)).toBe(false);
    expect(harness.calls[0]).not.toContain(ENVIRONMENT[1]);
    expect(JSON.stringify(prepared.journal)).not.toContain("do-not-put-this-in-process-argv");
    expect(watcher.assertStillStopped.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(watcher.resumeAndProve).not.toHaveBeenCalled();
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
      /failed with status 125: socket interrupted/u,
    );
    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("preparing-replacement");
    try {
      prepare(harness, store, watcher.lease);
    } catch (error) {
      expect(String(error)).not.toContain("credential-in-stdout");
      expect(String(error)).not.toContain("credential-in-stderr");
    }
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

  it("rejects a replacement that starts before the image-owned transaction owns it", () => {
    const harness = new PodmanHarness();
    harness.replacementStartsOnCreate = true;
    const store = journalStore();
    const watcher = watcherLease();

    expect(() => prepare(harness, store, watcher.lease)).toThrow(
      "identity or state changed after it was pinned",
    );
    expect(store.load(BOOTSTRAP_IDENTITY)?.phase).toBe("preparing-replacement");
  });

  it("stops only the exact original after the stopped replacement remains stable", () => {
    const harness = new PodmanHarness();
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
    expect(watcher.resumeAndProve).not.toHaveBeenCalled();
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
    });
    expect(harness.original.running).toBe(true);
    expect(harness.replacement).toBeNull();
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
    expect(harness.calls).toContainEqual(["container", "rm", REPLACEMENT_RUNTIME_ID]);
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
      phase: "preparing-replacement",
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
    expect(harness.original.running).toBe(true);
    expect(harness.replacement).toBeNull();
    expect(store.load(BOOTSTRAP_IDENTITY)).toBeNull();
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
