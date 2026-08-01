// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { DockerContainerInspect } from "../docker-gpu-patch-types";
import { encodeManagedStartupProfile, type ManagedStartupAgent } from "../managed-startup/profile";
import { createManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import {
  createManagedBootstrapPreparedAuthority,
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  type ManagedBootstrapDurablePreparationReceipt,
  type ManagedBootstrapHeldWorkloadHandle,
  type ManagedBootstrapObservedSnapshot,
  ManagedBootstrapOwnerCleanupRequiredError,
  type ManagedBootstrapPreparedReplacementHandle,
} from "./adapter";
import { createDockerManagedBootstrapAdapter, type DockerManagedBootstrapDeps } from "./docker";
import type {
  DockerManagedBootstrapFinalizationRecord,
  DockerManagedBootstrapJournal,
  DockerManagedBootstrapJournalStore,
} from "./docker-journal";
import { DockerManagedBootstrapJournalAcknowledgementLostError } from "./docker-journal";
import { normalizeDockerManagedBootstrapLaunchSpec } from "./docker-spec";
import {
  MANAGED_BOOTSTRAP_COMPLETION_FILE,
  parseManagedBootstrapEnvelope,
  serializeManagedBootstrapImageCompletion,
} from "./envelope";

const IDENTITY = "1".repeat(64);
const OLD_ID = "2".repeat(64);
const NEW_ID = "3".repeat(64);
const CONFIG_ID = `sha256:${"4".repeat(64)}`;
const MANIFEST = `sha256:${"5".repeat(64)}` as const;
const REPOSITORY = "registry.example/nemoclaw/hermes";
const IMAGE = `${REPOSITORY}@${MANIFEST}`;
const SUPERVISOR = ["/opt/openshell/bin/openshell-sandbox", "supervise"] as const;
const SUPPORTED_AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;

function agentInputs(agent: ManagedStartupAgent = "hermes") {
  const request = createManagedStartupRootApplyRequest({
    agent,
    encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile(agent, false, false)),
  });
  const heldArgv = [
    "env",
    "A=1",
    "/usr/local/bin/nemoclaw-managed-startup-hold",
    "--agent",
    agent,
    "--profile-fingerprint",
    request.profileFingerprint,
    "--bootstrap-identity",
    IDENTITY,
  ] as const;
  return {
    request,
    heldArgv,
    metadata: { "nemoclaw.ai/managed-profile": request.profileFingerprint },
  };
}

const { heldArgv } = agentInputs();
const sandbox = { sandboxName: "alpha", sandboxId: "sandbox-alpha", driverId: "docker" };

function shellArgv(argv: readonly string[]): string {
  return argv.join(" ");
}

function originalInspect(inputs = agentInputs()): DockerContainerInspect {
  return {
    Id: OLD_ID,
    Image: CONFIG_ID,
    Name: "/openshell-alpha",
    Config: {
      Image: IMAGE,
      Env: ["A=1", `OPENSHELL_SANDBOX_COMMAND=${shellArgv(inputs.heldArgv)}`],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
        "openshell.ai/sandbox-id": "sandbox-alpha",
        ...inputs.metadata,
      },
      Entrypoint: [SUPERVISOR[0]],
      Cmd: SUPERVISOR.slice(1),
      User: "root",
      WorkingDir: "/sandbox",
      Hostname: "alpha",
    },
    State: { Running: true, Paused: false, Restarting: false, Dead: false },
    HostConfig: {
      Binds: ["/host/workspace:/sandbox:rw"],
      NetworkMode: "openshell",
      RestartPolicy: { Name: "unless-stopped" },
      CapDrop: ["NET_RAW"],
      SecurityOpt: ["no-new-privileges"],
      Ulimits: [{ Name: "nofile", Soft: 65_536, Hard: 65_536 }],
    },
    NetworkSettings: { Networks: { openshell: { Aliases: ["openshell-alpha"] } } },
  };
}

function authority(agent: ManagedStartupAgent = "hermes") {
  const inputs = agentInputs(agent);
  const inspect = originalInspect(inputs);
  const normalized = normalizeDockerManagedBootstrapLaunchSpec(inspect);
  const plan = {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandboxName: "alpha",
    driverId: "docker",
    image: { repository: REPOSITORY, manifestDigest: MANIFEST },
    profile: { agent, fingerprint: inputs.request.profileFingerprint },
    agentIdentity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
    intendedWorkloadArgv: ["env", "A=1", "nemoclaw-start"],
    expectedSupervisorArgv: SUPERVISOR,
    metadata: inputs.metadata,
  };
  const handle: ManagedBootstrapHeldWorkloadHandle = {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox,
    bootstrapIdentity: IDENTITY,
    heldWorkloadArgv: inputs.heldArgv,
    intendedWorkloadArgv: plan.intendedWorkloadArgv,
    plan,
    createReceipt: { sandbox, ready: true, readyAt: "2026-07-31T12:00:00.000Z" },
  };
  const snapshot: ManagedBootstrapObservedSnapshot = {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox,
    runtimeId: OLD_ID,
    bootstrapIdentity: IDENTITY,
    image: plan.image,
    runtimeImageContentId: CONFIG_ID,
    specHash: normalized.hash,
    specCanonicalJson: normalized.canonicalJson,
    agentIdentity: plan.agentIdentity,
    supervisorArgv: SUPERVISOR,
    heldWorkloadArgv: inputs.heldArgv,
    metadata: inputs.metadata,
  };
  return { handle, plan, request: inputs.request, snapshot };
}

type FixtureOptions = {
  agent?: ManagedStartupAgent;
  failAfterCutoverFence?: boolean;
  failAfterRollbackFence?: boolean;
  failAfterSharedCommitFence?: boolean;
  failAfterStagedFence?: boolean;
  failJournalRemoveOnce?: boolean;
  failRemoveOnce?: boolean;
  failStart?: boolean;
  lostAcks?: boolean;
  ownerId?: string;
  sharedState?: "committed" | "none" | "pending";
};

function failFixture(message: string): never {
  throw new Error(message);
}

function fixture(options: FixtureOptions = {}) {
  let original = originalInspect(agentInputs(options.agent));
  let replacement: DockerContainerInspect | null = null;
  let journal: DockerManagedBootstrapJournal | null = null;
  let finalization: DockerManagedBootstrapFinalizationRecord | null = null;
  let sharedState: "committed" | "none" | "pending" = options.sharedState ?? "none";
  const events: string[] = [];
  const lostTransitions = new Set(["cutover", "shared-state-committed"]);
  let loseCreateAck = options.lostAcks === true;
  let loseRemoveAck = options.lostAcks === true;
  let failJournalRemoveOnce = options.failJournalRemoveOnce === true;
  let failRemoveOnce = options.failRemoveOnce === true;
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const copyJournal = () => (journal ? structuredClone(journal) : null);
  const store: DockerManagedBootstrapJournalStore = {
    create(value) {
      journal = structuredClone(value);
      events.push("journal:staged");
      switch (true) {
        case options.failAfterStagedFence === true:
          throw new Error("injected crash after durable staged fence");
        case loseCreateAck:
          loseCreateAck = false;
          throw new DockerManagedBootstrapJournalAcknowledgementLostError(
            "lost journal create acknowledgement",
          );
      }
    },
    load: () => copyJournal(),
    listUnfinished: () => (journal ? [structuredClone(journal)] : []),
    transition(_identity, expected, next) {
      const current =
        journal !== null && journal.phase === expected
          ? journal
          : failFixture("stale journal transition");
      journal = { ...current, phase: next };
      events.push(`journal:${next}`);
      switch (true) {
        case next === "cutover" && options.failAfterCutoverFence === true:
          throw new Error("injected crash after durable cutover fence");
        case next === "rollback-authorized" && options.failAfterRollbackFence === true:
          throw new Error("injected crash after durable rollback fence");
        case next === "shared-state-committed" && options.failAfterSharedCommitFence === true:
          throw new Error("injected crash after durable shared-state commit fence");
        case options.lostAcks === true && lostTransitions.delete(next):
          throw new DockerManagedBootstrapJournalAcknowledgementLostError(
            "lost journal transition acknowledgement",
          );
        default:
          return structuredClone(journal);
      }
    },
    recordCompletion(_identity, receipt) {
      if (!journal || journal.phase !== "cutover") {
        throw new Error("completion requires cutover journal");
      }
      if (
        journal.commitReceipt !== null &&
        JSON.stringify(journal.commitReceipt) !== JSON.stringify(receipt)
      ) {
        throw new Error("completion changed");
      }
      journal = { ...journal, commitReceipt: structuredClone(receipt) };
      events.push("journal:completion");
      return structuredClone(journal);
    },
    remove(_identity, expected) {
      const current = journal;
      void (current !== null && expected.includes(current.phase)
        ? current
        : failFixture("stale journal remove"));
      switch (true) {
        case failJournalRemoveOnce:
          failJournalRemoveOnce = false;
          throw new Error("injected crash before terminal journal removal");
      }
      journal = null;
      events.push("journal:removed");
      switch (loseRemoveAck) {
        case true:
          loseRemoveAck = false;
          throw new DockerManagedBootstrapJournalAcknowledgementLostError(
            "lost journal remove acknowledgement",
          );
      }
    },
    recordFinalization(value) {
      if (finalization && JSON.stringify(finalization) !== JSON.stringify(value)) {
        throw new Error("finalization changed");
      }
      finalization = structuredClone(value);
      events.push(`finalization:${value.phase}`);
    },
    loadFinalization: () => (finalization ? structuredClone(finalization) : null),
  };
  const inspect = (reference: string): DockerContainerInspect => {
    const candidates = [original, replacement].filter(
      (value): value is DockerContainerInspect => value !== null,
    );
    const found = candidates.find(
      (value) =>
        value.Id === reference || String(value.Name ?? "").replace(/^\/+/u, "") === reference,
    );
    return found ? structuredClone(found) : failFixture(`No such container: ${reference}`);
  };
  const dockerCapture: NonNullable<DockerManagedBootstrapDeps["dockerCapture"]> = vi.fn((args) => {
    switch (args[0]) {
      case "image":
        return JSON.stringify([{ Id: CONFIG_ID, RepoDigests: [IMAGE] }]);
      default:
        return JSON.stringify([inspect(String(args[3] ?? ""))]);
    }
  });
  const dockerRun: NonNullable<DockerManagedBootstrapDeps["dockerRun"]> = vi.fn(
    (args: readonly string[]) => {
      switch (args[0]) {
        case "create": {
          events.push("create:replacement");
          const name = String(args[args.indexOf("--name") + 1] ?? "");
          const entrypoint = String(args[args.indexOf("--entrypoint") + 1] ?? "");
          const imageIndex = args.indexOf(IMAGE);
          const env = args.flatMap((value, index) =>
            value === "--env" ? [String(args[index + 1] ?? "")] : [],
          );
          replacement = {
            ...structuredClone(original),
            Id: NEW_ID,
            Name: `/${name}`,
            Config: {
              ...structuredClone(original.Config),
              Image: IMAGE,
              Env: env,
              Entrypoint: [entrypoint],
              Cmd: args.slice(imageIndex + 1),
            },
            State: { Running: false, Paused: false, Restarting: false, Dead: false },
          };
          return options.lostAcks
            ? { status: 1, stdout: "", stderr: "lost create acknowledgement" }
            : ok(NEW_ID);
        }
        case "ps":
          return ok(original ? OLD_ID : "");
        case "inspect": {
          const id = String(args[3] ?? "");
          try {
            inspect(id);
            return ok(`[{"Id":"${id}"}]`);
          } catch {
            return { status: 1, stderr: `Error response from daemon: No such container: ${id}` };
          }
        }
        case "cp": {
          const sourceIndex = args[1] === "-a" ? 2 : 1;
          const source = String(args[sourceIndex] ?? "");
          const destination = String(args[sourceIndex + 1] ?? "");
          const copyIntoContainer = () => {
            events.push("stage:envelope");
            expect(fs.statSync(source).mode & 0o777).toBe(0o400);
            expect(
              parseManagedBootstrapEnvelope(fs.readFileSync(source, "utf8")).bootstrapIdentity,
            ).toBe(IDENTITY);
            return ok();
          };
          const copyFromContainer = () => {
            if (source === `${NEW_ID}:${MANAGED_BOOTSTRAP_COMPLETION_FILE}`) {
              fs.writeFileSync(
                destination,
                serializeManagedBootstrapImageCompletion({
                  bootstrapIdentity: IDENTITY,
                  agent: options.agent ?? "hermes",
                  profileFingerprint: agentInputs(options.agent).request.profileFingerprint,
                  transactionPending: sharedState === "pending",
                }),
                { mode: 0o444 },
              );
              fs.chmodSync(destination, 0o444);
              return ok();
            }
            const receipt = source.split(":")[1];
            const expected = receipt?.includes("shared-state-commit") ? "committed" : "pending";
            return sharedState === expected
              ? (() => {
                  fs.mkdirSync(destination, { recursive: true });
                  return ok();
                })()
              : {
                  status: 1,
                  stderr: `Error response from daemon: Could not find the file ${receipt} in container ${NEW_ID}`,
                };
          };
          return source.includes(":") ? copyFromContainer() : copyIntoContainer();
        }
        case "run":
          switch (true) {
            case args.includes("--shared-state-transaction-status"):
              return ok(`${sharedState}\n`);
            case args.includes("--rollback-shared-state-transaction"):
              sharedState = "none";
              events.push("shared:rollback");
              return ok();
          }
          break;
        case "exec":
          switch (true) {
            case args.includes("--commit-shared-state-transaction"):
              sharedState = "committed";
              events.push("shared:commit");
              return ok();
            case args.includes("--clear-shared-state-commit-receipt"):
              sharedState = "none";
              events.push("shared:clear");
              return ok();
          }
          break;
      }
      throw new Error(`unexpected Docker command: ${args.join(" ")}`);
    },
  );
  const deps: DockerManagedBootstrapDeps = {
    journalStore: store,
    dockerCapture,
    dockerRun,
    dockerStop: vi.fn((id) => {
      events.push(`stop:${id}`);
      const target = id === OLD_ID ? original : replacement;
      [target]
        .filter((value): value is DockerContainerInspect => value?.State !== undefined)
        .forEach((value) => {
          value.State = { ...value.State, Running: false };
        });
      return options.lostAcks ? { status: 1, stderr: "lost stop acknowledgement" } : ok();
    }),
    dockerRename: vi.fn((id, name) => {
      events.push(`rename:${id}:${name}`);
      const target = id === OLD_ID ? original : replacement;
      [target]
        .filter((value): value is DockerContainerInspect => value !== null)
        .forEach((value) => {
          value.Name = `/${name}`;
        });
      return options.lostAcks ? { status: 1, stderr: "lost rename acknowledgement" } : ok();
    }),
    dockerStart: vi.fn((id) => {
      events.push(`start:${id}`);
      const target = id === OLD_ID ? original : replacement;
      [target]
        .filter(
          (value): value is DockerContainerInspect =>
            value?.State !== undefined && !(id === NEW_ID && options.failStart),
        )
        .forEach((value) => {
          value.State = { ...value.State, Running: true };
        });
      return id === NEW_ID && options.failStart
        ? { status: 1, stderr: "injected start failure" }
        : options.lostAcks
          ? { status: 1, stderr: "lost start acknowledgement" }
          : ok();
    }),
    dockerRm: vi.fn((id) => {
      events.push(`rm:${id}`);
      switch (true) {
        case failRemoveOnce:
          failRemoveOnce = false;
          throw new Error("injected crash before exact Docker removal");
      }
      switch (id) {
        case OLD_ID:
          original = null as unknown as DockerContainerInspect;
          break;
        case NEW_ID:
          replacement = null;
          break;
      }
      return options.lostAcks ? { status: 1, stderr: "lost rm acknowledgement" } : ok();
    }),
    runCaptureOpenshell: vi.fn(() => `Name: alpha\nID: ${options.ownerId ?? "sandbox-alpha"}\n`),
    runOpenshell: vi.fn(() => ok()),
    now: () => new Date("2026-07-31T12:30:00.000Z"),
  };
  return {
    deps,
    events,
    get journal() {
      return journal;
    },
    get finalization() {
      return finalization;
    },
    get original() {
      return original;
    },
    get replacement() {
      return replacement;
    },
    get sharedState() {
      return sharedState;
    },
  };
}

function durablePreparation(
  handle: ManagedBootstrapHeldWorkloadHandle,
  snapshot: ManagedBootstrapObservedSnapshot,
  prepared: ManagedBootstrapPreparedReplacementHandle,
): ManagedBootstrapDurablePreparationReceipt {
  const authority = createManagedBootstrapPreparedAuthority({ handle, snapshot, prepared });
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: handle.sandbox,
    bootstrapIdentity: handle.bootstrapIdentity,
    authorityFingerprint: authority.authorityFingerprint,
    recordId: `test-authority-${handle.plan.profile.agent}`,
    recordedAt: "2026-07-31T12:10:00.000Z",
  };
}

describe("Docker managed bootstrap adapter", () => {
  it("journals both exact identities before cutover and reconciles lost acknowledgements", async () => {
    const fake = fixture({ lostAcks: true, sharedState: "pending" });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request: rootRequest, snapshot } = authority();
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    expect(fake.journal).toBeNull();
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
    fake.events.push("authority:recorded");
    const durable = durablePreparation(handle, snapshot, prepared);
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    const order = fake.events;
    expect(order.indexOf("journal:staged")).toBeGreaterThan(order.indexOf("authority:recorded"));
    expect(order.indexOf("journal:cutover")).toBeLessThan(order.indexOf(`stop:${OLD_ID}`));
    expect(fake.journal).toMatchObject({
      phase: "cutover",
      originalRuntimeId: OLD_ID,
      replacementRuntimeId: NEW_ID,
    });

    const commitReceipt = await adapter.awaitBootstrap({
      handle,
      snapshot,
      replacement,
      timeoutSecs: 1,
    });
    expect(fake.events.indexOf("journal:completion")).toBeGreaterThan(
      fake.events.indexOf(`start:${NEW_ID}`),
    );
    const finalized = await adapter.finalizeBootstrap({
      outcome: "commit",
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
      replacement,
      completion: commitReceipt,
    });
    expect(finalized).toMatchObject({ outcome: "committed" });
    expect(fake.events.indexOf("journal:shared-state-committed")).toBeLessThan(
      fake.events.indexOf(`rm:${OLD_ID}`),
    );
    expect(fake.events.indexOf("finalization:committed")).toBeLessThan(
      fake.events.indexOf("journal:removed"),
    );
    expect(fake.journal).toBeNull();
    expect(fake.finalization).toMatchObject({ phase: "committed", commitReceipt });
    expect(fake.sharedState).toBe("none");
    expect(fake.replacement?.Id).toBe(NEW_ID);

    const eventCount = fake.events.length;
    await expect(
      createDockerManagedBootstrapAdapter(fake.deps).finalizeBootstrap({
        outcome: "commit",
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
        replacement,
        completion: commitReceipt,
      }),
    ).resolves.toEqual(finalized);
    expect(fake.events).toHaveLength(eventCount);
  });

  it("recovers a failed cutover after adapter restart from exact journal authority", async () => {
    const fake = fixture({ failStart: true });
    const first = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request: rootRequest, snapshot } = authority();
    const prepared = await first.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    await expect(
      first.activateBootstrapReplacement({
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
      }),
    ).rejects.toThrow("could not prove its exact replacement running");
    expect(fake.journal?.phase).toBe("cutover");

    const restarted = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(
      restarted.finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
        replacement: null,
        completion: null,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapOwnerCleanupRequiredError);
    expect(fake.events.indexOf("journal:rollback-authorized")).toBeLessThan(
      fake.events.indexOf(`rm:${NEW_ID}`),
    );
    expect(fake.events.indexOf("finalization:rolled-back")).toBeLessThan(
      fake.events.indexOf("journal:removed"),
    );
    expect(fake.journal).toBeNull();
    expect(fake.replacement).toBeNull();
    expect(fake.original.Name).toBe("/openshell-alpha");
    expect(fake.original.State?.Running).toBe(false);
  });

  it.each([
    ["staged", { failAfterStagedFence: true }, "staged"],
    ["cutover", { failAfterCutoverFence: true }, "cutover"],
  ] as const)("reconciles a process restart from the durable %s phase", async (_label, options, phase) => {
    const fake = fixture(options);
    const first = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request: rootRequest, snapshot } = authority();
    const prepared = await first.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    await expect(
      first.activateBootstrapReplacement({
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
      }),
    ).rejects.toThrow(`crash after durable ${phase} fence`);
    expect(fake.journal?.phase).toBe(phase);

    const restarted = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject([
      {
        sourcePhase: phase,
        outcome: "rolled-back",
        finalization: {
          restoredRuntimeId: OLD_ID,
          heldWorkloadRemoved: false,
        },
      },
    ]);
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toEqual([]);
    expect(fake.journal).toBeNull();
    expect(fake.finalization?.phase).toBe("rolled-back");
    expect(fake.replacement).toBeNull();
    expect(fake.original.Name).toBe("/openshell-alpha");
    expect(fake.original.State?.Running).toBe(true);
  });

  it("finishes a rollback-authorized transaction after shared-state rollback is interrupted", async () => {
    const fake = fixture({
      agent: "openclaw",
      failAfterRollbackFence: true,
      sharedState: "pending",
    });
    const first = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request: rootRequest, snapshot } = authority("openclaw");
    const prepared = await first.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    const replacement = await first.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    await expect(
      first.finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
        replacement,
        completion: null,
      }),
    ).rejects.toThrow("crash after durable rollback fence");
    expect(fake.journal?.phase).toBe("rollback-authorized");
    expect(fake.sharedState).toBe("pending");

    const restarted = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject([
      { sourcePhase: "rollback-authorized", outcome: "rolled-back" },
    ]);
    expect(fake.sharedState).toBe("none");
    expect(fake.replacement).toBeNull();
    expect(fake.original.State?.Running).toBe(true);
  });

  it("finishes exact commit cleanup after a process restart at the durable commit fence", async () => {
    const fake = fixture({
      agent: "langchain-deepagents-code",
      failJournalRemoveOnce: true,
      failRemoveOnce: true,
      sharedState: "pending",
    });
    const first = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request: rootRequest, snapshot } = authority("langchain-deepagents-code");
    const prepared = await first.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    const replacement = await first.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    const completion = await first.awaitBootstrap({
      handle,
      snapshot,
      replacement,
      timeoutSecs: 1,
    });
    await expect(
      first.finalizeBootstrap({
        outcome: "commit",
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
        replacement,
        completion,
      }),
    ).rejects.toThrow("crash before exact Docker removal");
    expect(fake.journal?.phase).toBe("shared-state-committed");
    expect(fake.sharedState).toBe("committed");

    const restarted = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(restarted.recoverUnfinishedTransactions()).rejects.toThrow(
      "crash before terminal journal removal",
    );
    expect(fake.journal?.phase).toBe("shared-state-committed");
    expect(fake.finalization?.phase).toBe("committed");

    const resumed = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(resumed.recoverUnfinishedTransactions()).resolves.toMatchObject([
      { sourcePhase: "shared-state-committed", outcome: "committed" },
    ]);
    expect(fake.journal).toBeNull();
    expect(fake.finalization?.phase).toBe("committed");
    expect(fake.sharedState).toBe("none");
    expect(fake.replacement?.State?.Running).toBe(true);
  });

  it("recovers the pre-stop cutover crash state after adapter restart", async () => {
    const fake = fixture({ failAfterCutoverFence: true });
    const { handle, request: rootRequest, snapshot } = authority();
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    await expect(
      adapter.activateBootstrapReplacement({
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
      }),
    ).rejects.toThrow("crash after durable cutover fence");
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
    await expect(
      createDockerManagedBootstrapAdapter(fake.deps).finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
        replacement: null,
        completion: null,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapOwnerCleanupRequiredError);
    expect(fake.events.indexOf("journal:rollback-authorized")).toBeLessThan(
      fake.events.indexOf(`rm:${NEW_ID}`),
    );
    expect(fake.journal).toBeNull();
  });

  it("fences rollback when image-owned shared state is already committed", async () => {
    const fake = fixture({ sharedState: "committed" });
    const { handle, request: rootRequest, snapshot } = authority();
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    const eventCount = fake.events.length;
    await expect(
      adapter.finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
        replacement,
        completion: null,
      }),
    ).rejects.toMatchObject({ name: "ManagedBootstrapDurableCommitCleanupPendingError" });
    expect(fake.journal?.phase).toBe("shared-state-committed");
    expect(fake.events.slice(eventCount)).toEqual(["journal:shared-state-committed"]);
  });

  it("rejects cutover before the exact durable authority receipt", async () => {
    const fake = fixture();
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request: rootRequest, snapshot } = authority();
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    const invalid = {
      ...durablePreparation(handle, snapshot, prepared),
      authorityFingerprint: "f".repeat(64),
    };
    await expect(
      adapter.activateBootstrapReplacement({
        handle,
        snapshot,
        prepared,
        durablePreparation: invalid,
      }),
    ).rejects.toThrow("exact durable prepared-authority receipt");
    expect(fake.journal).toBeNull();
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
    await expect(
      adapter.finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        prepared,
        durablePreparation: null,
        replacement: null,
        completion: null,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapOwnerCleanupRequiredError);
    expect(fake.replacement).toBeNull();
  });

  it.each(
    SUPPORTED_AGENTS,
  )("prepares, activates, and exactly rolls back the %s agent without a central switch", async (agent) => {
    const fake = fixture({ agent, sharedState: "pending" });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request: rootRequest, snapshot } = authority(agent);
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    await expect(
      adapter.finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
        replacement,
        completion: null,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapOwnerCleanupRequiredError);
    expect(fake.journal).toBeNull();
    expect(fake.replacement).toBeNull();
    expect(
      vi.mocked(fake.deps.dockerRun!).mock.calls.some(([args]) => {
        const agentIndex = args.indexOf("--agent");
        return args.includes("--shared-state-transaction-status") && args[agentIndex + 1] === agent;
      }),
    ).toBe(true);
  });

  it("quiesces and retains an exact incomplete create when its mutable name is reused", async () => {
    const fake = fixture({ ownerId: "sandbox-alpha-recreated" });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { plan } = authority();
    await expect(
      adapter.cleanupIncompleteCreate({
        plan,
        bootstrapIdentity: IDENTITY,
        heldWorkloadArgv: heldArgv,
      }),
    ).rejects.toMatchObject({
      name: "ManagedBootstrapOwnerCleanupRequiredError",
      sandboxId: "sandbox-alpha",
      runtimeId: OLD_ID,
    });
    expect(fake.original.State?.Running).toBe(false);
    expect(fake.events).not.toContain(`rm:${OLD_ID}`);
    expect(vi.mocked(fake.deps.runOpenshell!)).not.toHaveBeenCalled();
  });
});
