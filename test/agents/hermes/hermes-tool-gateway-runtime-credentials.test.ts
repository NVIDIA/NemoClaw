// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { RuntimeRefreshCredentialStore } =
  require("../../../agents/hermes/host/runtime-refresh-credentials.ts") as {
    RuntimeRefreshCredentialStore: new (
      hashCredential: (value: string) => string,
    ) => {
      register(state: Record<string, unknown>, refreshToken: string): boolean;
      replace(state: Record<string, unknown>, refreshToken: string): (() => boolean) | null;
      resolve(state: Record<string, unknown>): string | null;
      unregister(sandboxName: string): boolean;
    };
  };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Hermes tool-gateway runtime credentials", () => {
  it("keeps source and destination credentials live and cleans only the destination", () => {
    const sourceToken = "test-only-source-refresh";
    const destinationToken = "test-only-destination-refresh";
    const source = {
      sandbox: "source",
      refresh_token_sha256: sha256(sourceToken),
    };
    const destination = {
      sandbox: "destination",
      refresh_token_sha256: sha256(destinationToken),
    };
    const store = new RuntimeRefreshCredentialStore(sha256);

    expect(store.register(source, sourceToken)).toBe(true);
    expect(store.register(destination, destinationToken)).toBe(true);
    expect(store.resolve(source)).toBe(sourceToken);
    expect(store.resolve(destination)).toBe(destinationToken);

    expect(store.unregister("destination")).toBe(true);
    expect(store.resolve(destination)).toBeNull();
    expect(store.resolve(source)).toBe(sourceToken);
  });

  it("rejects a credential that does not match the destination state hash", () => {
    const store = new RuntimeRefreshCredentialStore(sha256);
    const destination = {
      sandbox: "destination",
      refresh_token_sha256: sha256("expected-refresh"),
    };

    expect(store.register(destination, "wrong-refresh")).toBe(false);
    expect(store.resolve(destination)).toBeNull();
  });

  it("restores the prior credential after a replacement transaction fails", () => {
    const store = new RuntimeRefreshCredentialStore(sha256);
    const priorToken = "test-only-prior-refresh";
    const nextToken = "test-only-next-refresh";
    const priorState = {
      sandbox: "destination",
      refresh_token_sha256: sha256(priorToken),
    };
    const nextState = {
      sandbox: "destination",
      refresh_token_sha256: sha256(nextToken),
    };

    expect(store.register(priorState, priorToken)).toBe(true);
    const restorePrior = store.replace(nextState, nextToken);
    expect(restorePrior).toBeTypeOf("function");
    expect(store.resolve(nextState)).toBe(nextToken);
    expect(restorePrior?.()).toBe(true);
    expect(restorePrior?.()).toBe(false);
    expect(store.resolve(priorState)).toBe(priorToken);
    expect(store.resolve(nextState)).toBeNull();

    const restoreWithoutClobber = store.replace(nextState, nextToken);
    const concurrentToken = "test-only-concurrent-refresh";
    const concurrentState = {
      sandbox: "destination",
      refresh_token_sha256: sha256(concurrentToken),
    };
    expect(store.register(concurrentState, concurrentToken)).toBe(true);
    expect(restoreWithoutClobber?.()).toBe(false);
    expect(store.resolve(concurrentState)).toBe(concurrentToken);

    const restoreSameToken = store.replace(nextState, nextToken);
    expect(store.register(nextState, nextToken)).toBe(true);
    expect(restoreSameToken?.()).toBe(false);
    expect(store.resolve(nextState)).toBe(nextToken);

    const restoreAbsent = store.replace(
      { sandbox: "new-clone", refresh_token_sha256: sha256(nextToken) },
      nextToken,
    );
    expect(restoreAbsent?.()).toBe(true);
    expect(
      store.resolve({ sandbox: "new-clone", refresh_token_sha256: sha256(nextToken) }),
    ).toBeNull();
  });
});
