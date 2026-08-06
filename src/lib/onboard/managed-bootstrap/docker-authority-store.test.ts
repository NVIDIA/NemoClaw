// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createManagedBootstrapPreparedAuthority } from "./adapter";
import { createDockerManagedBootstrapAdapter } from "./docker";
import { createDockerManagedBootstrapAuthorityStore } from "./docker-authority-store";
import { authority, fixture, IDENTITY, NEW_ID } from "./docker-test-fixture";

async function preparedFixture(options: Parameters<typeof fixture>[0] = {}) {
  const fake = fixture(options);
  const adapter = createDockerManagedBootstrapAdapter(fake.deps);
  const { handle, request, snapshot } = authority();
  const prepared = await adapter.prepareBootstrapReplacement({
    handle,
    snapshot,
    request,
    replacementOptions: { values: {} },
  });
  return {
    adapter,
    fake,
    handle,
    prepared,
    preparedAuthority: createManagedBootstrapPreparedAuthority({ handle, snapshot, prepared }),
    snapshot,
  };
}

describe("Docker managed bootstrap authority store", () => {
  it("persists exact prepared authority before the adapter crosses the cutover boundary", async () => {
    const prepared = await preparedFixture();
    const store = createDockerManagedBootstrapAuthorityStore("unused", {
      journalStore: prepared.fake.deps.journalStore,
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });

    const receipt = await store.recordPreparedAuthority(prepared.preparedAuthority);

    expect(receipt).toMatchObject({
      bootstrapIdentity: IDENTITY,
      recordId: `docker-managed-bootstrap/${IDENTITY}`,
      recordedAt: "2026-08-04T12:00:00.000Z",
    });
    expect(prepared.fake.journal).toMatchObject({
      phase: "staged",
      preparationReceipt: receipt,
    });

    await expect(
      prepared.adapter.activateBootstrapReplacement({
        handle: prepared.handle,
        snapshot: prepared.snapshot,
        prepared: prepared.prepared,
        durablePreparation: receipt,
      }),
    ).resolves.toMatchObject({ replacementRuntimeId: NEW_ID });
    expect(prepared.fake.journal).toMatchObject({ phase: "cutover" });
  });

  it("recovers only an exact lost acknowledgement", async () => {
    const prepared = await preparedFixture({ lostAcknowledgements: ["journal:create"] });
    const store = createDockerManagedBootstrapAuthorityStore("unused", {
      journalStore: prepared.fake.deps.journalStore,
    });

    await expect(store.recordPreparedAuthority(prepared.preparedAuthority)).resolves.toMatchObject({
      bootstrapIdentity: IDENTITY,
    });
    expect(prepared.fake.journal).toMatchObject({ phase: "staged" });
  });

  it("returns the original durable receipt when recording is retried", async () => {
    const prepared = await preparedFixture();
    const journalStore = prepared.fake.deps.journalStore;
    expect(journalStore).toBeDefined();
    const create = vi.fn(journalStore!.create.bind(journalStore));
    const strictJournalStore = { ...journalStore!, create };
    const times = [new Date("2026-08-04T12:00:00.000Z"), new Date("2026-08-04T12:00:01.000Z")];
    const now = vi.fn(() => times.shift() ?? new Date("2026-08-04T12:00:02.000Z"));
    const store = createDockerManagedBootstrapAuthorityStore("unused", {
      journalStore: strictJournalStore,
      now,
    });

    const first = await store.recordPreparedAuthority(prepared.preparedAuthority);
    const retried = await store.recordPreparedAuthority(prepared.preparedAuthority);

    expect(retried).toEqual(first);
    expect(retried.recordedAt).toBe("2026-08-04T12:00:00.000Z");
    expect(create).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledOnce();
  });

  it("does not reinterpret an ordinary persistence failure as an acknowledgement loss", async () => {
    const prepared = await preparedFixture({
      journalCreateFailures: [new Error("injected fsync failure")],
    });
    const store = createDockerManagedBootstrapAuthorityStore("unused", {
      journalStore: prepared.fake.deps.journalStore,
    });

    await expect(store.recordPreparedAuthority(prepared.preparedAuthority)).rejects.toThrow(
      "injected fsync failure",
    );
  });

  it("rejects prepared authority that does not match its provider journal", async () => {
    const prepared = await preparedFixture();
    const store = createDockerManagedBootstrapAuthorityStore("unused", {
      journalStore: prepared.fake.deps.journalStore,
    });
    const changedAuthority = {
      ...prepared.preparedAuthority,
      preparedRuntimeId: "9".repeat(64),
    };

    await expect(store.recordPreparedAuthority(changedAuthority)).rejects.toThrow(
      "does not match its journal",
    );
    expect(prepared.fake.journal).toBeNull();
  });
});
