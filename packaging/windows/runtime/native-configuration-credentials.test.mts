// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  withNativeCredentialTransaction,
  type CredentialChange,
} from "./native-configuration-credentials.mts";

const changes: CredentialChange[] = [
  { provider: "nvidia", binding: "a".repeat(64), value: "new-inference" },
  { provider: "tavily", binding: "b".repeat(64), value: "new-service" },
  { provider: "brave", binding: "c".repeat(64), value: "" },
];

for (const failure of ["snapshot", "first-write", "second-write", "commit", "none"]) {
  test(`credential transaction ${failure} preserves the prior vault or commits under the lease`, async () => {
    const original = new Map([
      [changes[0].binding, "old-inference"],
      [changes[2].binding, "old-service"],
    ]);
    const vault = new Map(original);
    const events: string[] = [];
    let held = false;
    let writes = 0;
    let committed = false;
    const pending = () =>
      withNativeCredentialTransaction(
        "launcher",
        changes,
        () => {
          assert(held);
          events.push("held");
        },
        async () => {
          assert(held);
          assert.equal(vault.get(changes[0].binding), "new-inference");
          assert.equal(vault.get(changes[1].binding), "new-service");
          assert(!vault.has(changes[2].binding));
          if (failure === "commit") throw new Error("private failure detail");
          committed = true;
          return "saved";
        },
        {
          read: async (_launcher, change) => {
            assert(held);
            events.push("read");
            if (failure === "snapshot") throw new Error("private vault failure");
            return vault.get(change.binding) ?? "";
          },
          write: async (_launcher, change) => {
            assert(held);
            events.push("write");
            writes++;
            if (change.value) vault.set(change.binding, change.value);
            else vault.delete(change.binding);
            // A failing helper can already have changed the vault.
            if (
              (failure === "first-write" && writes === 1) ||
              (failure === "second-write" && writes === 2)
            )
              throw new Error("private helper failure");
          },
        },
      );
    held = true;
    if (failure === "none") {
      assert.equal(await pending(), "saved");
      assert(committed);
      assert.equal(events.filter((event) => event === "write").length, 3);
    } else {
      await assert.rejects(
        pending(),
        /^Error: Native setup failed; previous credentials were preserved\.$/,
      );
      assert.deepEqual(vault, original);
      assert(!committed);
    }
    if (failure !== "snapshot") assert.equal(events.indexOf("write"), 7);
  });
}

test("rollback tries all prior bindings and reports incomplete recovery without secret details", async () => {
  let writes = 0;
  await assert.rejects(
    withNativeCredentialTransaction(
      "launcher",
      changes,
      () => {},
      async () => {
        throw new Error("secret");
      },
      {
        read: async () => "prior-secret",
        write: async () => {
          if (++writes > 3) throw new Error("prior-secret");
        },
      },
    ),
    /^Error: Native setup failed and credential recovery is incomplete\. Reopen Setup before launching\.$/,
  );
  assert.equal(writes, 6);
});

test("lost lease prevents credential writes and configuration publication", async () => {
  let writes = 0;
  await assert.rejects(
    withNativeCredentialTransaction(
      "launcher",
      changes,
      () => {
        throw new Error("lost");
      },
      async () => assert.fail("must not publish"),
      {
        read: async () => assert.fail("must not read"),
        write: async () => {
          writes++;
        },
      },
    ),
  );
  assert.equal(writes, 0);
});
