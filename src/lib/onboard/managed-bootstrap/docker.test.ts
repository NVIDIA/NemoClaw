// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assert, describe, expect, it, vi } from "vitest";

import {
  MANAGED_BOOTSTRAP_IDENTITY_ENV,
  ManagedBootstrapDurableCommitCleanupPendingError,
  ManagedBootstrapOwnerCleanupRequiredError,
} from "./adapter";
import { createDockerManagedBootstrapAdapter } from "./docker";
import {
  normalizeDockerManagedBootstrapLaunchSpec,
  parseDockerManagedBootstrapLaunchSpec,
} from "./docker-spec";
import {
  authority,
  completion,
  durablePreparation,
  fixture,
  heldArgv,
  IDENTITY,
  NEW_ID,
  OLD_ID,
  parseFixtureDockerUlimits,
  SUPPORTED_AGENTS,
} from "./docker-test-fixture";

function expectEventBefore(events: readonly string[], before: string, after: string): void {
  expect(events).toContain(before);
  expect(events).toContain(after);
  expect(events.indexOf(before)).toBeLessThan(events.indexOf(after));
}

describe("Docker managed bootstrap adapter", () => {
  it("parses signed Docker ulimits only before the image boundary", () => {
    expect(
      parseFixtureDockerUlimits(
        ["create", "--ulimit", "memlock=-1:-1", "image", "--ulimit", "workload=1:2"],
        3,
      ),
    ).toEqual([{ Name: "memlock", Soft: -1, Hard: -1 }]);
  });

  it("captures the live OpenShell idle supervisor with a separately persisted bootstrap identity", async () => {
    const fake = fixture();
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle } = authority();
    const discovered = await adapter.discoverHeldWorkload({
      sandbox: handle.sandbox,
      bootstrapIdentity: handle.bootstrapIdentity,
      expectedImage: handle.plan.image,
      metadata: handle.plan.metadata,
    });

    await expect(adapter.inspectHeldWorkload({ handle, discovered })).resolves.toMatchObject({
      bootstrapIdentity: handle.bootstrapIdentity,
      runtimeId: OLD_ID,
    });
  });

  it("accepts the immutable image ID recorded by the OpenShell Docker driver", async () => {
    const fake = fixture();
    fake.original!.Config!.Image = fake.original!.Image;
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle } = authority();
    const discovered = await adapter.discoverHeldWorkload({
      sandbox: handle.sandbox,
      bootstrapIdentity: handle.bootstrapIdentity,
      expectedImage: handle.plan.image,
      metadata: handle.plan.metadata,
    });

    await expect(adapter.inspectHeldWorkload({ handle, discovered })).resolves.toMatchObject({
      runtimeId: OLD_ID,
    });
  });

  it("rejects a configured image outside the reviewed manifest identity", async () => {
    const fake = fixture();
    fake.original!.Config!.Image = `sha256:${"9".repeat(64)}`;
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle } = authority();

    await expect(
      adapter.discoverHeldWorkload({
        sandbox: handle.sandbox,
        bootstrapIdentity: handle.bootstrapIdentity,
        expectedImage: handle.plan.image,
        metadata: handle.plan.metadata,
      }),
    ).rejects.toThrow(
      "Managed bootstrap Docker configured image is neither the exact repository@manifestDigest nor its immutable runtime content ID.",
    );
  });

  it("stages Docker-derived console and protected-path defaults before cutover", async () => {
    const fake = fixture();
    Object.assign(fake.original!.HostConfig!, {
      ConsoleSize: [0, 0],
      MaskedPaths: ["/proc/kcore", "/sys/firmware"],
      ReadonlyPaths: ["/proc/sys", "/proc/sysrq-trigger"],
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request } = authority();
    const discovered = await adapter.discoverHeldWorkload({
      sandbox: handle.sandbox,
      bootstrapIdentity: handle.bootstrapIdentity,
      expectedImage: handle.plan.image,
      metadata: handle.plan.metadata,
    });
    const snapshot = await adapter.inspectHeldWorkload({ handle, discovered });

    await expect(
      adapter.prepareBootstrapReplacement({
        handle,
        snapshot,
        request,
        replacementOptions: { values: {} },
      }),
    ).resolves.toMatchObject({ preparedRuntimeId: NEW_ID });
    expect(fake.replacement?.HostConfig).toMatchObject({
      ConsoleSize: [0, 0],
      MaskedPaths: ["/proc/kcore", "/sys/firmware"],
      ReadonlyPaths: ["/proc/sys", "/proc/sysrq-trigger"],
    });
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
  });

  it("accepts Docker-reordered environment bindings before cutover", async () => {
    const fake = fixture({
      replacementEnvironment: (environment) => [...environment].reverse(),
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request } = authority();
    const discovered = await adapter.discoverHeldWorkload({
      sandbox: handle.sandbox,
      bootstrapIdentity: handle.bootstrapIdentity,
      expectedImage: handle.plan.image,
      metadata: handle.plan.metadata,
    });
    const snapshot = await adapter.inspectHeldWorkload({ handle, discovered });

    await expect(
      adapter.prepareBootstrapReplacement({
        handle,
        snapshot,
        request,
        replacementOptions: { values: {} },
      }),
    ).resolves.toMatchObject({ preparedRuntimeId: NEW_ID });
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
  });

  it("accepts only the reviewed OCI-user omission before cutover (#8662)", async () => {
    const fake = fixture();
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request } = authority();
    const discovered = await adapter.discoverHeldWorkload({
      sandbox: handle.sandbox,
      bootstrapIdentity: handle.bootstrapIdentity,
      expectedImage: handle.plan.image,
      metadata: handle.plan.metadata,
    });
    const snapshot = await adapter.inspectHeldWorkload({ handle, discovered });

    await expect(
      adapter.prepareBootstrapReplacement({
        handle,
        snapshot,
        request,
        replacementOptions: { values: {} },
      }),
    ).resolves.toMatchObject({ preparedRuntimeId: NEW_ID });
    expect(fake.original?.Config?.Env).toContain("OPENSHELL_OCI_IMAGE_USER=root");
    expect(fake.replacement?.Config?.Env).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^OPENSHELL_OCI_IMAGE_USER=/u)]),
    );
    expect(fake.replacement?.Config?.Env).toEqual(
      expect.arrayContaining(["OPENSHELL_SANDBOX_UID=", "OPENSHELL_SANDBOX_GID="]),
    );
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
  });

  it("preserves signed and accepts Docker-normalized required ulimits before cutover", async () => {
    const fake = fixture();
    fake.original!.HostConfig!.Ulimits = [
      { Name: "RLIMIT_NOFILE", Soft: 65_536, Hard: 65_536 },
      { Name: "memlock", Soft: -1, Hard: -1 },
    ];
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request } = authority();
    const discovered = await adapter.discoverHeldWorkload({
      sandbox: handle.sandbox,
      bootstrapIdentity: handle.bootstrapIdentity,
      expectedImage: handle.plan.image,
      metadata: handle.plan.metadata,
    });
    const snapshot = await adapter.inspectHeldWorkload({ handle, discovered });

    await expect(
      adapter.prepareBootstrapReplacement({
        handle,
        snapshot,
        request,
        replacementOptions: {
          values: {
            requiredUlimits: ["nproc=512:512", "nofile=65536:65536"],
          },
        },
      }),
    ).resolves.toMatchObject({ preparedRuntimeId: NEW_ID });
    expect(fake.replacement?.HostConfig?.Ulimits).toEqual([
      { Name: "nofile", Soft: 65_536, Hard: 65_536 },
      { Name: "memlock", Soft: -1, Hard: -1 },
      { Name: "nproc", Soft: 512, Hard: 512 },
    ]);
  });

  it("accepts equivalent Engine API and Docker CLI create metadata before cutover", async () => {
    const fake = fixture({ dockerCliSerializationDefaults: true });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request } = authority();
    const discovered = await adapter.discoverHeldWorkload({
      sandbox: handle.sandbox,
      bootstrapIdentity: handle.bootstrapIdentity,
      expectedImage: handle.plan.image,
      metadata: handle.plan.metadata,
    });
    const snapshot = await adapter.inspectHeldWorkload({ handle, discovered });

    await expect(
      adapter.prepareBootstrapReplacement({
        handle,
        snapshot,
        request,
        replacementOptions: { values: {} },
      }),
    ).resolves.toMatchObject({ preparedRuntimeId: NEW_ID });
    expect(fake.replacement?.Config).toMatchObject({
      AttachStdout: true,
      AttachStderr: true,
    });
    expect(fake.replacement?.HostConfig).toMatchObject({ PortBindings: {} });
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
  });

  it("rejects replacement environment value drift before cutover", async () => {
    const fake = fixture({
      replacementEnvironment: (environment) =>
        environment.map((entry) => (entry === "A=1" ? "A=changed" : entry)),
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request } = authority();
    const discovered = await adapter.discoverHeldWorkload({
      sandbox: handle.sandbox,
      bootstrapIdentity: handle.bootstrapIdentity,
      expectedImage: handle.plan.image,
      metadata: handle.plan.metadata,
    });
    const snapshot = await adapter.inspectHeldWorkload({ handle, discovered });

    await expect(
      adapter.prepareBootstrapReplacement({
        handle,
        snapshot,
        request,
        replacementOptions: { values: {} },
      }),
    ).rejects.toThrow("replacement environment changed outside declared deltas");
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
  });

  it("rejects a replacement that restores the omitted OCI-user marker (#8662)", async () => {
    const fake = fixture({
      replacementEnvironment: (environment) => [...environment, "OPENSHELL_OCI_IMAGE_USER=root"],
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request } = authority();
    const discovered = await adapter.discoverHeldWorkload({
      sandbox: handle.sandbox,
      bootstrapIdentity: handle.bootstrapIdentity,
      expectedImage: handle.plan.image,
      metadata: handle.plan.metadata,
    });
    const snapshot = await adapter.inspectHeldWorkload({ handle, discovered });

    await expect(
      adapter.prepareBootstrapReplacement({
        handle,
        snapshot,
        request,
        replacementOptions: { values: {} },
      }),
    ).rejects.toThrow("replacement environment changed outside declared deltas");
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
  });

  it("rejects a live OpenShell workload whose persisted bootstrap identity drifted", async () => {
    const fake = fixture();
    const environment = fake.original?.Config?.Env;
    assert(environment, "fixture environment is required");
    const index = environment.findIndex((entry) =>
      entry.startsWith(`${MANAGED_BOOTSTRAP_IDENTITY_ENV}=`),
    );
    assert(index >= 0, "fixture bootstrap identity is required");
    environment[index] = `${MANAGED_BOOTSTRAP_IDENTITY_ENV}=${"9".repeat(64)}`;
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle } = authority();

    await expect(
      adapter.discoverHeldWorkload({
        sandbox: handle.sandbox,
        bootstrapIdentity: handle.bootstrapIdentity,
        expectedImage: handle.plan.image,
        metadata: handle.plan.metadata,
      }),
    ).rejects.toThrow("one exact persisted bootstrap identity");
    expect(fake.replacement).toBeNull();
    expect(fake.journal).toBeNull();
    expect(fake.events).not.toContain("create:replacement");
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
  });

  it("publishes durable commit authority before deleting the rollback backup after lost acknowledgements", async () => {
    const fake = fixture({
      lostAcknowledgements: [
        "container:create",
        "container:remove",
        "container:rename",
        "container:start",
        "container:stop",
        "journal:create",
        "journal:cutover",
        "journal:completion",
        "journal:remove",
        "journal:shared-state-committed",
      ],
      sharedState: "pending",
    });
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
    const reorderedDurable = {
      recordedAt: durable.recordedAt,
      recordId: durable.recordId,
      authorityFingerprint: durable.authorityFingerprint,
      bootstrapIdentity: durable.bootstrapIdentity,
      sandbox: {
        driverId: durable.sandbox.driverId,
        sandboxId: durable.sandbox.sandboxId,
        sandboxName: durable.sandbox.sandboxName,
      },
      schemaVersion: durable.schemaVersion,
    } satisfies typeof durable;
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: reorderedDurable,
    });
    const order = fake.events;
    expectEventBefore(order, "authority:recorded", "journal:staged");
    expectEventBefore(order, "journal:cutover", `stop:${OLD_ID}`);
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
    const reorderedCommitReceipt = {
      completedAt: commitReceipt.completedAt,
      transactionPending: commitReceipt.transactionPending,
      bootstrapIdentity: commitReceipt.bootstrapIdentity,
      profileFingerprint: commitReceipt.profileFingerprint,
      replacementSpecHash: commitReceipt.replacementSpecHash,
      originalSpecHash: commitReceipt.originalSpecHash,
      runtimeImageContentId: commitReceipt.runtimeImageContentId,
      image: {
        manifestDigest: commitReceipt.image.manifestDigest,
        repository: commitReceipt.image.repository,
      },
      runtimeId: commitReceipt.runtimeId,
      sandbox: {
        driverId: commitReceipt.sandbox.driverId,
        sandboxId: commitReceipt.sandbox.sandboxId,
        sandboxName: commitReceipt.sandbox.sandboxName,
      },
      schemaVersion: commitReceipt.schemaVersion,
    } satisfies typeof commitReceipt;
    expect(fake.events).toContain("journal:completion");
    expect(fake.events).toContain(`start:${NEW_ID}`);
    expect(fake.events.indexOf("journal:completion")).toBeGreaterThan(
      fake.events.indexOf(`start:${NEW_ID}`),
    );
    const finalized = await adapter.finalizeBootstrap({
      outcome: "commit",
      handle,
      snapshot,
      prepared,
      durablePreparation: reorderedDurable,
      replacement,
      completion: reorderedCommitReceipt,
    });
    expect(finalized).toMatchObject({ outcome: "committed" });
    expectEventBefore(fake.events, "journal:shared-state-committed", `rm:${OLD_ID}`);
    expectEventBefore(fake.events, "finalization:committed", "journal:removed");
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
        durablePreparation: reorderedDurable,
        replacement,
        completion: reorderedCommitReceipt,
      }),
    ).resolves.toEqual(finalized);
    expect(fake.events).toHaveLength(eventCount);
    expect(fake.events).toContain("journal:shared-state-committed");
    expect(fake.events).toContain(`rm:${OLD_ID}`);
    expect(fake.events.indexOf("journal:shared-state-committed")).toBeLessThan(
      fake.events.indexOf(`rm:${OLD_ID}`),
    );
    expect(fake.journal).toBeNull();
    expect(fake.sharedState).toBe("none");
    expect(fake.replacement?.Id).toBe(NEW_ID);

    await expect(
      createDockerManagedBootstrapAdapter(fake.deps).finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        prepared,
        durablePreparation: reorderedDurable,
        replacement,
        completion: null,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapDurableCommitCleanupPendingError);
    expect(fake.events).toHaveLength(eventCount);
    expect(fake.finalization).toMatchObject({ phase: "committed", commitReceipt });
  });

  it("uses the Docker-GPU reconnect minimum instead of the shorter create timeout", async () => {
    const fake = fixture();
    fake.deps.sleep = vi.fn();
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request, snapshot } = authority();
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    const dateNow = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(2_000);
    vi.mocked(fake.deps.runOpenshell!)
      .mockImplementationOnce(() => ({ status: 1 }))
      .mockReturnValue({ status: 0 });

    await expect(
      adapter.awaitBootstrap({
        handle,
        snapshot,
        replacement,
        timeoutSecs: 1,
      }),
    ).resolves.toMatchObject({ runtimeId: NEW_ID });

    expect(fake.deps.runOpenshell).toHaveBeenCalledTimes(2);
    expect(fake.deps.sleep).toHaveBeenCalledWith(2);
    dateNow.mockRestore();
  });

  it("preserves redacted replacement evidence before reconnect rollback", async () => {
    const fake = fixture();
    const secret = "diagnostic-secret-canary";
    fake.deps.errorPhaseDebouncePolls = 1;
    fake.deps.runOpenshell = vi.fn(() => {
      assert(fake.replacement?.State);
      Object.assign(fake.replacement.State, {
        Status: "exited",
        Running: false,
        ExitCode: 137,
        OOMKilled: true,
        Error: "startup terminated",
      });
      return { status: 1 };
    });
    fake.deps.runCaptureOpenshell = vi.fn(() => "alpha Error");
    fake.deps.dockerLogs = vi.fn((id, options) => {
      expect(id).toBe(NEW_ID);
      expect(options).toEqual({ tail: 120, timeout: 2_000 });
      return `${"oversized diagnostic context ".repeat(60)}managed startup failed with NVIDIA_API_KEY=${secret}`;
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request, snapshot } = authority();
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    const failure = await adapter
      .awaitBootstrap({ handle, snapshot, replacement, timeoutSecs: 1 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "Replacement state: status=exited running=false exit_code=137 oom_killed=true error=startup terminated",
    );
    expect((failure as Error).message).toContain(
      "managed startup failed with NVIDIA_API_KEY=<REDACTED>",
    );
    expect((failure as Error).message).not.toContain(secret);
    const redactedLogTail = (failure as Error).message.split("Redacted replacement log tail:\n")[1];
    expect(redactedLogTail).toBeDefined();
    expect(redactedLogTail!.length).toBeLessThanOrEqual(1_200);
  });

  it("reports an exited replacement through exact authorized cleanup (#9465)", async () => {
    const fake = fixture({ agent: "openclaw" });
    const secret = "replacement-diagnostic-secret";
    fake.deps.dockerLogs = vi.fn((id, options) => {
      expect(id).toBe(NEW_ID);
      expect(options).toEqual({ tail: 120, timeout: 2_000 });
      return `managed startup rejected SLACK_BOT_TOKEN=${secret}`;
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request, snapshot } = authority("openclaw");
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    assert(fake.replacement?.State);
    Object.assign(fake.replacement.State, {
      Status: "exited",
      Running: false,
      ExitCode: 23,
      FinishedAt: "2026-08-18T12:00:00.000Z",
    });

    const failure = await adapter
      .awaitBootstrap({ handle, snapshot, replacement, timeoutSecs: 1 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(`Replacement runtime ID: ${NEW_ID}.`);
    expect((failure as Error).message).toContain(
      "Replacement state: status=exited running=false exit_code=23 finished_at=2026-08-18T12:00:00.000Z.",
    );
    expect((failure as Error).message).toContain(
      "managed startup rejected SLACK_BOT_TOKEN=<REDACTED>",
    );
    expect((failure as Error).message).not.toContain(secret);

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
    ).rejects.toMatchObject({
      name: "ManagedBootstrapOwnerCleanupRequiredError",
      runtimeId: OLD_ID,
    });
    expect(fake.replacement).toBeNull();
    expect(fake.original).toMatchObject({
      Id: OLD_ID,
      Name: "/openshell-alpha",
      State: { Running: false },
    });

    fake.removeOriginalExternally();
    await expect(adapter.recoverUnfinishedTransactions()).resolves.toMatchObject({
      receipts: [
        {
          bootstrapIdentity: IDENTITY,
          sourcePhase: "owner-cleanup-required",
          outcome: "rolled-back",
        },
      ],
      failures: [],
    });
    expect(fake.original).toBeNull();
    expect(fake.replacement).toBeNull();
    expect(fake.journal).toBeNull();
    expect(fake.finalization?.phase).toBe("rolled-back");
  });

  it("preserves commit validation failure details when the replacement cannot be quiesced", async () => {
    const fake = fixture({
      sharedState: "pending",
      sharedStateCommitResult: { status: 1, stderr: "injected commit failure" },
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request, snapshot } = authority();
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    const commitReceipt = await adapter.awaitBootstrap({
      handle,
      snapshot,
      replacement,
      timeoutSecs: 1,
    });
    vi.mocked(fake.deps.dockerStop!).mockReturnValue({
      status: 1,
      stderr: "injected quiesce failure",
    });

    await expect(
      adapter.finalizeBootstrap({
        outcome: "commit",
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
        replacement,
        completion: commitReceipt,
      }),
    ).rejects.toThrow(
      /logical commit validation failed: Managed-startup shared-state commit helper failed.*injected commit failure.*new workload could not be quiesced.*injected quiesce failure/u,
    );
    expect(fake.events).not.toContain("shared:rollback");
  });

  it("removes only the exact replacement after Hermes metadata restoration fails (#9486)", async () => {
    const metadataFailure =
      "Managed startup shared-state transaction failed: managed directory metadata was not restored exactly: /sandbox/.hermes";
    const fake = fixture({
      sharedState: "pending",
      sharedStateCommitResult: { status: 1, stderr: "injected commit failure" },
      sharedStateRollbackResult: { status: 1, stderr: metadataFailure },
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request, snapshot } = authority("hermes");
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    const commitReceipt = await adapter.awaitBootstrap({
      handle,
      snapshot,
      replacement,
      timeoutSecs: 1,
    });

    const failure = (await adapter
      .finalizeBootstrap({
        outcome: "commit",
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
        replacement,
        completion: commitReceipt,
      })
      .catch((error: unknown) => error)) as Error & {
      managedBootstrapRollbackError?: unknown;
    };

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain(metadataFailure);
    expect(failure.managedBootstrapRollbackError).toBeInstanceOf(
      ManagedBootstrapOwnerCleanupRequiredError,
    );
    expect(failure.managedBootstrapRollbackError).toMatchObject({ runtimeId: OLD_ID });
    expect(vi.mocked(fake.deps.dockerRm!)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fake.deps.dockerRm!)).toHaveBeenCalledWith(NEW_ID, expect.any(Object));
    expect(fake.replacement).toBeNull();
    expect(fake.original).toMatchObject({
      Id: OLD_ID,
      Name: "/openshell-alpha",
      State: { Running: false },
    });
    expect(fake.events).not.toContain(`rm:${OLD_ID}`);
    expect(fake.events).not.toContain(`start:${OLD_ID}`);
    expectEventBefore(fake.events, "journal:rollback-authorized", `rm:${NEW_ID}`);
    expectEventBefore(fake.events, `rm:${NEW_ID}`, `rename:${OLD_ID}:openshell-alpha`);
    expectEventBefore(
      fake.events,
      `rename:${OLD_ID}:openshell-alpha`,
      "journal:owner-cleanup-required",
    );
    expect(fake.journal).toMatchObject({
      phase: "owner-cleanup-required",
      originalRuntimeId: OLD_ID,
      replacementRuntimeId: NEW_ID,
    });
    expect(fake.finalization).toBeNull();
  });

  it("reports a retryable restart recovery failure after exact Hermes restoration-failure cleanup (#9486)", async () => {
    const metadataFailure =
      "Managed startup shared-state transaction failed: managed directory metadata was not restored exactly: /sandbox/.hermes";
    const fake = fixture({
      agent: "hermes",
      sharedState: "pending",
      sharedStateRollbackResult: { status: 1, stderr: metadataFailure },
    });
    const first = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request, snapshot } = authority("hermes");
    const prepared = await first.prepareBootstrapReplacement({
      handle,
      snapshot,
      request,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    await first.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });

    const recovered = await createDockerManagedBootstrapAdapter(
      fake.deps,
    ).recoverUnfinishedTransactions();

    expect(recovered.receipts).toEqual([]);
    expect(recovered.failures).toEqual([
      expect.objectContaining({
        bootstrapIdentity: IDENTITY,
        sourcePhase: "owner-cleanup-required",
        code: "provider-recovery-failed",
        retryable: true,
        detail: expect.stringContaining(metadataFailure),
      }),
    ]);
    expect(vi.mocked(fake.deps.dockerRm!)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fake.deps.dockerRm!)).toHaveBeenCalledWith(NEW_ID, expect.any(Object));
    expect(fake.replacement).toBeNull();
    expect(fake.original).toMatchObject({
      Id: OLD_ID,
      Name: "/openshell-alpha",
      State: { Running: false },
    });
    expect(fake.events).not.toContain(`rm:${OLD_ID}`);
    expect(fake.events).not.toContain(`start:${OLD_ID}`);
    expectEventBefore(fake.events, "journal:rollback-authorized", "shared:rollback");
    expectEventBefore(fake.events, "shared:rollback", `rm:${NEW_ID}`);
    expectEventBefore(fake.events, `rm:${NEW_ID}`, `rename:${OLD_ID}:openshell-alpha`);
    expectEventBefore(
      fake.events,
      `rename:${OLD_ID}:openshell-alpha`,
      "journal:owner-cleanup-required",
    );
    expect(fake.journal).toMatchObject({
      phase: "owner-cleanup-required",
      originalRuntimeId: OLD_ID,
      replacementRuntimeId: NEW_ID,
    });
    expect(fake.finalization).toBeNull();
  });

  it.each([
    {
      driftedRuntime: "original",
      drift: (fake: ReturnType<typeof fixture>) => {
        fake.original!.Config!.Env = [...(fake.original!.Config!.Env ?? []), "DRIFTED=1"];
      },
    },
    {
      driftedRuntime: "replacement",
      drift: (fake: ReturnType<typeof fixture>) => {
        fake.replacement!.Name = "/unowned-replacement";
      },
    },
  ])(
    "retains both containers when the exact $driftedRuntime identity changes before restoration-failure cleanup (#9486)",
    async ({ drift }) => {
      const fake = fixture({
        sharedState: "pending",
        sharedStateCommitResult: { status: 1, stderr: "injected commit failure" },
        sharedStateRollbackResult: {
          status: 1,
          stderr: "managed directory metadata was not restored exactly: /sandbox/.hermes",
        },
      });
      const adapter = createDockerManagedBootstrapAdapter(fake.deps);
      const { handle, request, snapshot } = authority("hermes");
      const prepared = await adapter.prepareBootstrapReplacement({
        handle,
        snapshot,
        request,
        replacementOptions: { values: {} },
      });
      const durable = durablePreparation(handle, snapshot, prepared);
      const replacement = await adapter.activateBootstrapReplacement({
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
      });
      const commitReceipt = await adapter.awaitBootstrap({
        handle,
        snapshot,
        replacement,
        timeoutSecs: 1,
      });
      drift(fake);

      const failure = (await adapter
        .finalizeBootstrap({
          outcome: "commit",
          handle,
          snapshot,
          prepared,
          durablePreparation: durable,
          replacement,
          completion: commitReceipt,
        })
        .catch((error: unknown) => error)) as Error & {
        managedBootstrapRollbackError?: Error;
      };

      expect(failure.message).toContain(
        "managed directory metadata was not restored exactly: /sandbox/.hermes",
      );
      expect(failure.managedBootstrapRollbackError?.message).toMatch(
        /exact original launch spec changed|replacement container has an unexpected transaction name/u,
      );
      expect(fake.journal?.phase).toBe("rollback-authorized");
      expect(fake.original).not.toBeNull();
      expect(fake.replacement).not.toBeNull();
      expect(fake.events).not.toContain(`rm:${OLD_ID}`);
      expect(fake.events).not.toContain(`rm:${NEW_ID}`);
      expect(fake.events).not.toContain(`rename:${OLD_ID}:openshell-alpha`);
      expect(fake.events).not.toContain(`start:${OLD_ID}`);
    },
  );

  it("publishes durable rollback authority before deleting the replacement after restart", async () => {
    const fake = fixture();
    const secret = "post-start-provider-secret";
    fake.deps.dockerLogs = vi.fn((id, options) => {
      expect(id).toBe(NEW_ID);
      expect(options).toEqual({ tail: 120, timeout: 2_000 });
      return `startup failed with NVIDIA_API_KEY=${secret}`;
    });
    const dockerStarts: Record<string, () => { status: number; stdout?: string; stderr: string }> =
      {
        [NEW_ID]: () => {
          assert(fake.replacement?.State);
          Object.assign(fake.replacement.State, {
            Status: "exited",
            Running: false,
            ExitCode: 31,
            FinishedAt: "2026-08-18T12:30:00.000Z",
          });
          return { status: 1, stderr: "injected start failure" };
        },
        [OLD_ID]: () => {
          assert(fake.original?.State);
          Object.assign(fake.original.State, { Running: true });
          return { status: 0, stdout: "", stderr: "" };
        },
      };
    fake.deps.dockerStart = vi.fn((id) => dockerStarts[id]!());
    const first = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request: rootRequest, snapshot } = authority();
    const prepared = await first.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    const activationFailure = await first
      .activateBootstrapReplacement({
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
      })
      .catch((error: unknown) => error);
    expect(activationFailure).toBeInstanceOf(Error);
    expect((activationFailure as Error).message).toContain(
      "replacement after Docker start is not stably running",
    );
    expect((activationFailure as Error).message).toContain(`Replacement runtime ID: ${NEW_ID}.`);
    expect((activationFailure as Error).message).toContain(
      "Replacement state: status=exited running=false exit_code=31 finished_at=2026-08-18T12:30:00.000Z.",
    );
    expect((activationFailure as Error).message).toContain(
      "startup failed with NVIDIA_API_KEY=<REDACTED>",
    );
    expect((activationFailure as Error).message).not.toContain(secret);
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
    expectEventBefore(fake.events, "journal:rollback-authorized", `rm:${NEW_ID}`);
    expectEventBefore(fake.events, `rm:${NEW_ID}`, "journal:owner-cleanup-required");
    expect(fake.finalization).toBeNull();
    expect(fake.journal?.phase).toBe("owner-cleanup-required");
    expect(fake.replacement).toBeNull();
    expect(fake.original).not.toBeNull();
    expect(fake.original?.Name).toBe("/openshell-alpha");
    expect(fake.original?.State?.Running).toBe(false);
  });

  it("recovers the pre-stop cutover crash state after adapter restart", async () => {
    const fake = fixture({
      journalTransitionFailures: {
        cutover: new Error("injected crash after durable cutover fence"),
      },
    });
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
    expectEventBefore(fake.events, "journal:rollback-authorized", `rm:${NEW_ID}`);
    expectEventBefore(fake.events, `rm:${NEW_ID}`, "journal:owner-cleanup-required");
    expect(fake.finalization).toBeNull();
    expect(fake.journal?.phase).toBe("owner-cleanup-required");
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

  it("rejects a divergent snapshot image before creating durable recovery state", async () => {
    const fake = fixture();
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request: rootRequest, snapshot } = authority();

    await expect(
      adapter.prepareBootstrapReplacement({
        handle,
        snapshot: {
          ...snapshot,
          image: {
            ...snapshot.image,
            repository: "registry.example/nemoclaw/divergent",
          },
        },
        request: rootRequest,
        replacementOptions: { values: {} },
      }),
    ).rejects.toThrow("replacement snapshot image does not match its plan");
    expect(fake.replacement).toBeNull();
    expect(fake.journal).toBeNull();
    expect(fake.events).not.toContain("create:replacement");
    expect(fake.events).not.toContain("journal:staged");
  });

  it.each(SUPPORTED_AGENTS)(
    "prepares, activates, and exactly rolls back the %s agent without a central switch",
    async (agent) => {
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
      expect(fake.journal?.phase).toBe("owner-cleanup-required");
      expect(fake.finalization).toBeNull();
      expect(fake.replacement).toBeNull();
      expect(fake.original?.State?.Running).toBe(false);
      expectEventBefore(fake.events, "shared:rollback", `rm:${NEW_ID}`);
      expectEventBefore(fake.events, `rm:${NEW_ID}`, "journal:owner-cleanup-required");
      expect(
        vi.mocked(fake.deps.dockerRun!).mock.calls.some(([args]) => {
          const agentIndex = args.indexOf("--agent");
          return (
            args.includes("--shared-state-transaction-status") &&
            agentIndex >= 0 &&
            args[agentIndex + 1] === agent
          );
        }),
      ).toBe(true);
    },
  );

  it("exactly rolls back an identity-bound replacement in Docker's restart loop", async () => {
    const fake = fixture({ sharedState: "pending" });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request, snapshot } = authority();
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    Object.assign(fake.replacement!.State!, {
      Running: true,
      Paused: false,
      Restarting: true,
      Dead: false,
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
    expect(fake.replacement).toBeNull();
    expect(fake.original).not.toBeNull();
    expectEventBefore(fake.events, "journal:rollback-authorized", `stop:${NEW_ID}`);
    expectEventBefore(fake.events, `stop:${NEW_ID}`, "shared:rollback");
    expectEventBefore(fake.events, "shared:rollback", `rm:${NEW_ID}`);
    expectEventBefore(fake.events, `rm:${NEW_ID}`, `rename:${OLD_ID}:openshell-alpha`);
    expectEventBefore(fake.events, `rename:${OLD_ID}:openshell-alpha`, `start:${OLD_ID}`);
  });

  it("retains exact rollback authority when a restarting replacement cannot be quiesced", async () => {
    const fake = fixture({ sharedState: "pending" });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request, snapshot } = authority();
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    Object.assign(fake.replacement!.State!, {
      Running: true,
      Paused: false,
      Restarting: true,
      Dead: false,
    });
    vi.mocked(fake.deps.dockerStop!).mockReturnValue({
      status: 1,
      stderr: "injected restart-loop stop failure",
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
    ).rejects.toThrow("injected restart-loop stop failure");
    expect(fake.journal?.phase).toBe("rollback-authorized");
    expect(fake.replacement).not.toBeNull();
    expect(fake.original).not.toBeNull();
    expect(fake.deps.dockerStop).toHaveBeenCalledWith(NEW_ID, expect.any(Object));
    expect(fake.events).not.toContain(`rm:${NEW_ID}`);
    expect(fake.events).not.toContain(`rename:${OLD_ID}:openshell-alpha`);
    expect(fake.events).not.toContain(`start:${OLD_ID}`);
  });

  it("rejects an empty intended workload argv with a precise boundary error", async () => {
    const fake = fixture();
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request, snapshot } = authority();
    const plan = { ...handle.plan, intendedWorkloadArgv: [] };
    const emptyArgvHandle = { ...handle, intendedWorkloadArgv: [], plan };
    await expect(
      adapter.prepareBootstrapReplacement({
        handle: emptyArgvHandle,
        snapshot,
        request,
        replacementOptions: { values: {} },
      }),
    ).rejects.toThrow(
      "Managed bootstrap Docker replacement requires one bounded intended workload argv.",
    );
    expect(fake.events).toContain("create:replacement");
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
  });

  it.each(["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "BASH_ENV"])(
    "rejects hostile %s from the launch snapshot before replacement creation",
    async (key) => {
      const fake = fixture();
      const adapter = createDockerManagedBootstrapAdapter(fake.deps);
      const { handle, request, snapshot } = authority();
      const parsed = parseDockerManagedBootstrapLaunchSpec(snapshot.specCanonicalJson);
      const hostileInspect = structuredClone(parsed.inspect);
      hostileInspect.Config!.Env = [...(hostileInspect.Config!.Env ?? []), `${key}=/tmp/hostile`];
      const hostileSpec = normalizeDockerManagedBootstrapLaunchSpec(hostileInspect);

      await expect(
        adapter.prepareBootstrapReplacement({
          handle,
          snapshot: {
            ...snapshot,
            specHash: hostileSpec.hash,
            specCanonicalJson: hostileSpec.canonicalJson,
          },
          request,
          replacementOptions: { values: {} },
        }),
      ).rejects.toThrow(`Managed bootstrap refuses root-process injection environment '${key}'.`);
      expect(fake.events).not.toContain("create:replacement");
      expect(fake.replacement).toBeNull();
    },
  );

  it("quiesces and retains an exact incomplete create when its mutable name is reused", async () => {
    const fake = fixture({ ownerId: "sandbox-alpha-recreated" });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, plan } = authority();
    await expect(
      adapter.cleanupIncompleteCreate({
        plan,
        bootstrapIdentity: IDENTITY,
        heldWorkloadArgv: heldArgv,
        createReceipt: handle.createReceipt,
      }),
    ).rejects.toMatchObject({
      name: "ManagedBootstrapOwnerCleanupRequiredError",
      sandboxId: "sandbox-alpha",
      runtimeId: OLD_ID,
    });
    expect(fake.original).not.toBeNull();
    expect(fake.original?.State?.Running).toBe(false);
    expect(fake.events).not.toContain(`rm:${OLD_ID}`);
    expect(vi.mocked(fake.deps.runOpenshell!)).not.toHaveBeenCalled();
  });

  it("retains a same-name workload that differs from the validated create receipt", async () => {
    const replacementSandboxId = "sandbox-alpha-recreated";
    const fake = fixture({ ownerId: replacementSandboxId });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, plan } = authority();
    expect(fake.original).not.toBeNull();
    const labels = fake.original?.Config?.Labels;
    assert(labels, "fixture labels are required");
    labels["openshell.ai/sandbox-id"] = replacementSandboxId;

    await expect(
      adapter.cleanupIncompleteCreate({
        plan,
        bootstrapIdentity: IDENTITY,
        heldWorkloadArgv: heldArgv,
        createReceipt: handle.createReceipt,
      }),
    ).rejects.toThrow(/does not match the exact validated create receipt/u);
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
    expect(fake.events).not.toContain(`rm:${OLD_ID}`);
  });
});
