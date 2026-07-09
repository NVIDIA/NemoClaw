// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  advanceToReplacement,
  cleanupRebuildTransactionTests,
  deletedReceipts,
  expectCode,
  FP_D,
  intent,
  makeStore,
  preparedReceipts,
  replacementReceipts,
  SANDBOX,
} from "../../../test/helpers/rebuild-transaction-store";
import { fingerprintRebuildReplacement, fingerprintRebuildValue } from "../rebuild-correlation";
import { registeredRebuildReplacementMatches } from "./rebuild-transaction-receipts";
import type { SandboxEntry } from "./registry";
import * as registry from "./registry";

afterEach(cleanupRebuildTransactionTests);

describe("RebuildTransactionStore replacement receipt refresh", () => {
  it("requires an active replacement-created transaction", async () => {
    const { store } = makeStore();
    await expectCode(
      () => store.refreshReplacementReceipt(SANDBOX, 1, replacementReceipts().replacement!),
      "NOT_FOUND",
    );
    const prepared = await store.create(intent(), preparedReceipts());
    await expectCode(
      () =>
        store.refreshReplacementReceipt(
          SANDBOX,
          prepared.revision,
          replacementReceipts().replacement!,
        ),
      "INVALID_TRANSITION",
    );
  });

  it("replaces only the missing replacement's receipt before completion", async () => {
    const { store } = makeStore();
    const replacement = await advanceToReplacement(store);
    const refreshed = await store.refreshReplacementReceipt(SANDBOX, replacement.revision, {
      identityFingerprint: FP_D,
      observedAt: "2026-07-08T00:03:00.000Z",
    });

    expect(refreshed).toMatchObject({
      phase: "replacement_created",
      revision: replacement.revision + 1,
      receipts: {
        backup: replacement.receipts.backup,
        oldSandboxDeletion: replacement.receipts.oldSandboxDeletion,
        replacement: { identityFingerprint: FP_D },
      },
    });
    await expectCode(
      () =>
        store.refreshReplacementReceipt(
          SANDBOX,
          replacement.revision,
          refreshed.receipts.replacement!,
        ),
      "REVISION_CONFLICT",
    );
    await expect(store.complete(SANDBOX, refreshed.revision)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("refuses a compensated receipt that does not match the durable target intent", async () => {
    const replacementIdentityMatches = vi.fn(
      (_sandboxName, _identityFingerprint, transaction) =>
        transaction.intent.target.provider === "ollama-local",
    );
    const { store } = makeStore(undefined, replacementIdentityMatches);
    const replacement = await advanceToReplacement(store);

    await expectCode(
      () =>
        store.refreshReplacementReceipt(
          SANDBOX,
          replacement.revision,
          replacementReceipts().replacement!,
        ),
      "INVALID_TRANSITION",
    );
    expect(replacementIdentityMatches).toHaveBeenCalledWith(
      SANDBOX,
      replacementReceipts().replacement?.identityFingerprint,
      expect.objectContaining({ intent: expect.objectContaining({ target: intent().target }) }),
    );
  });

  it("refuses credentialEnv drift through the default replacement verifier", async () => {
    const registered = {
      name: SANDBOX,
      agent: "openclaw",
      provider: "nvidia",
      model: "nvidia/test-model",
      credentialEnv: "OTHER_API_KEY",
      gatewayName: "nemoclaw",
      gatewayPort: 18000,
      toolDisclosure: "progressive",
      observabilityEnabled: false,
    } satisfies SandboxEntry;
    const target = {
      ...intent().target,
      endpointFingerprint: null,
      configurationFingerprint: fingerprintRebuildValue({
        fromDockerfile: null,
        preferredInferenceApi: null,
        compatibleEndpointReasoning: null,
        policyTier: null,
      }),
    };
    const { store } = makeStore(undefined, null);
    const prepared = await store.create(intent({ target }), preparedReceipts());
    const deleted = await store.transition(
      SANDBOX,
      prepared.revision,
      "old_deleted",
      deletedReceipts(),
    );
    const replacement = await store.transition(
      SANDBOX,
      deleted.revision,
      "replacement_created",
      replacementReceipts(),
    );
    const exact = { ...registered, credentialEnv: target.credentialEnv };
    const getSandbox = vi.spyOn(registry, "getSandbox").mockReturnValue(exact);
    expect(
      registeredRebuildReplacementMatches(
        SANDBOX,
        fingerprintRebuildReplacement(exact),
        replacement,
      ),
    ).toBe(true);
    getSandbox.mockReturnValue(registered);

    await expectCode(
      () =>
        store.refreshReplacementReceipt(SANDBOX, replacement.revision, {
          identityFingerprint: fingerprintRebuildReplacement(registered),
          observedAt: "2026-07-08T00:03:00.000Z",
        }),
      "INVALID_TRANSITION",
    );
  });
});
