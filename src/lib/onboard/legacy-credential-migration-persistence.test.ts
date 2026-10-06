// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, type Session } from "../state/onboard-session";
import { legacyValueHash } from "../security/credential-hash";
import { createLegacyCredentialMigrationPersistence } from "./credential-provider-registration";

afterEach(() => vi.restoreAllMocks());

describe("legacy credential migration persistence", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [" abc ", "3eaf1941003943dfaa935adecffcaaa217e290def6fb0181141ced6c9daabaad"],
  ])("keeps the SHA-256 digest for public fixture %j", (value, digest) => {
    expect(legacyValueHash(value)).toBe(digest);
  });

  it("records only migrated keys with staged values and returns the same session", () => {
    const session = createSession({ migratedLegacyValueHashes: { STALE: "obsolete" } });
    const updateSession = vi.fn(
      (mutator: (current: Session) => Session | void) => mutator(session) as Session,
    );
    const persist = createLegacyCredentialMigrationPersistence({
      stagedLegacyValues: new Map([
        ["MIGRATED", "abc"],
        ["UNMIGRATED", "abc"],
        ["EMPTY", ""],
      ]),
      migratedLegacyKeys: new Set(["MIGRATED", "MISSING", "EMPTY"]),
      updateSession,
    });

    expect(persist()).toBeUndefined();

    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(updateSession.mock.results[0]?.value).toBe(session);
    expect(session.migratedLegacyValueHashes).toEqual({
      MIGRATED: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      EMPTY: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
  });

  it("sees later map, set, and updater changes without retaining removed receipts", () => {
    const session = createSession({ migratedLegacyValueHashes: {} });
    const firstUpdate = vi.fn(
      (mutator: (current: Session) => Session | void) => mutator(session) as Session,
    );
    const stagedLegacyValues = new Map([
      ["FIRST", "abc"],
      ["SECOND", ""],
    ]);
    const migratedLegacyKeys = new Set(["FIRST"]);
    const deps = { stagedLegacyValues, migratedLegacyKeys, updateSession: firstUpdate };
    const persist = createLegacyCredentialMigrationPersistence(deps);
    persist();
    expect(session.migratedLegacyValueHashes).toEqual({
      FIRST: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });

    stagedLegacyValues.set("SECOND", "abc");
    migratedLegacyKeys.delete("FIRST");
    migratedLegacyKeys.add("SECOND");
    const secondUpdate = vi.fn(
      (mutator: (current: Session) => Session | void) => mutator(session) as Session,
    );
    deps.updateSession = secondUpdate;
    persist();

    expect(firstUpdate).toHaveBeenCalledTimes(1);
    expect(secondUpdate).toHaveBeenCalledTimes(1);
    expect(secondUpdate.mock.results[0]?.value).toBe(session);
    expect(session.migratedLegacyValueHashes).toEqual({
      SECOND: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });

    migratedLegacyKeys.delete("SECOND");
    persist();
    expect(secondUpdate).toHaveBeenCalledTimes(2);
    expect(session.migratedLegacyValueHashes).toEqual({});
  });

  it("keeps an updater failure best-effort without logging staged values", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stagedLegacyValues = new Map([["MIGRATED", "public-fixture-value"]]);
    const migratedLegacyKeys = new Set(["MIGRATED"]);
    const updateSession = vi.fn((): Session => {
      throw new Error("write failed for public-fixture-value");
    });
    const persist = createLegacyCredentialMigrationPersistence({
      stagedLegacyValues,
      migratedLegacyKeys,
      updateSession,
    });

    expect(persist()).toBeUndefined();

    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(stagedLegacyValues).toEqual(new Map([["MIGRATED", "public-fixture-value"]]));
    expect(migratedLegacyKeys).toEqual(new Set(["MIGRATED"]));
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
