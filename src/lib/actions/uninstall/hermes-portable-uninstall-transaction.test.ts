// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHermesPortableUninstallJournalStore } from "../../state/hermes-portable-uninstall/journal";
import {
  hermesPortableUninstallJournalPath,
  inspectHermesPortableUninstallJournal,
  runHermesPortableUninstallTransaction,
  type HermesPortableUninstallAuthority,
  type HermesPortableUninstallPhase,
  type HermesPortableUninstallTransactionDeps,
} from "./hermes-portable-uninstall-transaction";

const temporaryDirectories: string[] = [];
const SHA = "a".repeat(64);
const ACTION_PHASES = [
  "prepared",
  "sandboxes-retired",
  "providers-retired",
  "inference-retired",
  "resources-absent",
  "registry-retired",
  "receipts-retired",
] as const;

function authority(): HermesPortableUninstallAuthority {
  return {
    registryPathSha256: "1".repeat(64),
    statePathSha256: "2".repeat(64),
    targets: [
      {
        sandboxName: "portable-hermes",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-1",
        registryRowSha256: "3".repeat(64),
        lifecycleReceiptSha256: "4".repeat(64),
        lifecycleDirectorySha256: "5".repeat(64),
        runtimeAuthoritySha256: "6".repeat(64),
        openshellExecutableAuthoritySha256: "7".repeat(64),
        podmanExecutableAuthoritySha256: "8".repeat(64),
        socketAuthoritySha256: "9".repeat(64),
        sandboxId: "sandbox-id-1",
        sandboxContainerId: SHA,
        sandboxContainerName: "openshell-default--portable-hermes-sandbox-id-1",
        sandboxContainerLabelsSha256: "b".repeat(64),
        provider: {
          disposition: "remove",
          id: "portable-ollama-provider",
          resourceVersion: 1,
          journalSha256: "c".repeat(64),
          sharingAuthoritySha256: "d".repeat(64),
        },
        inference: {
          disposition: "remove",
          providerId: "podman",
          receiptSha256: "3".repeat(64),
          sharingAuthoritySha256: "e".repeat(64),
          directorySha256: "f".repeat(64),
          runtimeId: "0".repeat(64),
          containerName: "nemoclaw-portable-ollama-1234567890abcdef",
          networkId: "1".repeat(64),
          networkAuthoritySha256: "2".repeat(64),
        },
      },
    ],
  };
}

function stateDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-uninstall-transaction-"));
  temporaryDirectories.push(root);
  const state = path.join(root, ".nemoclaw");
  fs.mkdirSync(state, { mode: 0o700 });
  return state;
}

function transactionDeps(
  state: string,
  interrupt?: HermesPortableUninstallPhase,
): {
  readonly deps: HermesPortableUninstallTransactionDeps;
  readonly calls: HermesPortableUninstallPhase[];
  readonly mutations: string[];
  readonly replaceInstallation: () => void;
  readonly setReplacement: (value: boolean) => void;
} {
  const current = {
    sandbox: true,
    provider: true,
    inference: true,
    registry: true,
    receipt: true,
    privateState: true,
    replacement: false,
  };
  let preparedAuthority = authority();
  let replacementInstallation = false;
  const mutations: string[] = [];
  const calls: HermesPortableUninstallPhase[] = [];
  let injected = false;
  const deps: HermesPortableUninstallTransactionDeps = {
    prepare: () => preparedAuthority,
    prepareReplacement: () => {
      const replacement = replacementInstallation ? preparedAuthority : null;
      replacementInstallation = false;
      return replacement;
    },
    revalidateResources: () => {
      switch (current.replacement) {
        case true:
          throw new Error("same-name replacement");
      }
      switch (current.registry && current.receipt && current.privateState) {
        case false:
          throw new Error("durable authority retired before resources");
      }
    },
    reconcileSandboxes: () => {
      calls.push("prepared");
      expect(inspectHermesPortableUninstallJournal(state)?.phase).toBe("prepared");
      const removed = Number(current.sandbox);
      current.sandbox && mutations.push("sandbox");
      current.sandbox = false;
      return removed;
    },
    reconcileProviders: () => {
      calls.push("sandboxes-retired");
      current.provider && mutations.push("provider");
      current.provider = false;
    },
    reconcileInference: () => {
      calls.push("providers-retired");
      current.inference && mutations.push("inference");
      current.inference = false;
    },
    verifyResourcesAbsent: () => {
      calls.push("inference-retired");
      expect(current).toMatchObject({ sandbox: false, provider: false, inference: false });
      mutations.push("verify-resources");
    },
    retireRegistry: () => {
      calls.push("resources-absent");
      current.registry && mutations.push("registry");
      current.registry = false;
    },
    retireLifecycleReceipts: () => {
      calls.push("registry-retired");
      expect(current.registry).toBe(false);
      current.receipt && mutations.push("receipt");
      current.receipt = false;
    },
    retirePrivateInferenceState: () => {
      calls.push("receipts-retired");
      expect(current.registry).toBe(false);
      expect(current.receipt).toBe(false);
      current.privateState && mutations.push("private-state");
      current.privateState = false;
    },
    verifyCompleted: () => {
      expect(current).toMatchObject({
        registry: false,
        receipt: false,
        privateState: false,
      });
    },
    afterPhaseAction: (phase) => {
      const shouldInterrupt = !injected && phase === interrupt;
      injected ||= shouldInterrupt;
      switch (shouldInterrupt) {
        case true:
          throw new Error(`interrupted after ${phase}`);
      }
    },
  };
  return {
    deps,
    calls,
    mutations,
    replaceInstallation: () => {
      Object.assign(current, {
        sandbox: true,
        provider: true,
        inference: true,
        registry: true,
        receipt: true,
        privateState: true,
        replacement: false,
      });
      preparedAuthority = {
        ...authority(),
        targets: [
          {
            ...authority().targets[0]!,
            lifecycleGeneration: "generation-2",
            registryRowSha256: "0".repeat(64),
          },
        ],
      };
      replacementInstallation = true;
    },
    setReplacement: (value) => {
      current.replacement = value;
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("Hermes Portable uninstall transaction", () => {
  it("coordinates phases through the injected journal state store (#9608)", () => {
    const state = stateDir();
    const fixture = transactionDeps(state);
    const persisted = createHermesPortableUninstallJournalStore(state);
    const journalStore = {
      authoritySha256: vi.fn(persisted.authoritySha256),
      read: vi.fn(persisted.read),
      publishPrepared: vi.fn(persisted.publishPrepared),
      replacePrepared: vi.fn(persisted.replacePrepared),
      replacePhase: vi.fn(persisted.replacePhase),
    };

    expect(
      runHermesPortableUninstallTransaction(state, { ...fixture.deps, journalStore }),
    ).toMatchObject({ phase: "completed", targetCount: 1 });
    expect(journalStore.read).toHaveBeenCalledOnce();
    expect(journalStore.publishPrepared).toHaveBeenCalledOnce();
    expect(journalStore.replacePrepared).not.toHaveBeenCalled();
    expect(journalStore.replacePhase).toHaveBeenCalledTimes(7);
  });

  it.each([
    "prepared",
    "sandboxes-retired",
    "providers-retired",
    "inference-retired",
    "resources-absent",
    "registry-retired",
    "receipts-retired",
  ] as const)("reconciles an interruption after the %s action (#9608)", (phase) => {
    const state = stateDir();
    const fixture = transactionDeps(state, phase);

    expect(() => runHermesPortableUninstallTransaction(state, fixture.deps)).toThrow(
      `interrupted after ${phase}`,
    );
    expect(inspectHermesPortableUninstallJournal(state)?.phase).toBe(phase);

    const resumed = runHermesPortableUninstallTransaction(state, fixture.deps);
    expect(resumed.phase).toBe("completed");
    expect(inspectHermesPortableUninstallJournal(state)?.phase).toBe("completed");
    expect(fs.statSync(hermesPortableUninstallJournalPath(state)).mode & 0o777).toBe(0o600);
    expect(fixture.calls).toEqual(
      ACTION_PHASES.flatMap((candidate) =>
        candidate === phase ? [candidate, candidate] : [candidate],
      ),
    );

    const mutations = [...fixture.mutations];
    expect(runHermesPortableUninstallTransaction(state, fixture.deps)).toEqual({
      phase: "completed",
      sandboxContainersRemoved: 0,
      targetCount: 1,
    });
    expect(fixture.mutations).toEqual(mutations);
  });

  it("cleans the phase temporary file when journal replacement fails (#9608)", () => {
    const state = stateDir();
    const fixture = transactionDeps(state, "prepared");
    expect(() => runHermesPortableUninstallTransaction(state, fixture.deps)).toThrow(
      "interrupted after prepared",
    );
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("rename failed");
    });
    try {
      expect(() => runHermesPortableUninstallTransaction(state, fixture.deps)).toThrow(
        "rename failed",
      );
      expect(fs.readdirSync(state).filter((entry) => entry.endsWith(".next"))).toEqual([]);
    } finally {
      rename.mockRestore();
    }
  });

  it("replaces a completed journal when a later install publishes new authority (#9608)", () => {
    const state = stateDir();
    const fixture = transactionDeps(state);

    expect(runHermesPortableUninstallTransaction(state, fixture.deps).phase).toBe("completed");
    fixture.replaceInstallation();
    expect(runHermesPortableUninstallTransaction(state, fixture.deps)).toEqual({
      phase: "completed",
      sandboxContainersRemoved: 1,
      targetCount: 1,
    });
    expect(
      inspectHermesPortableUninstallJournal(state)?.authority.targets[0]?.lifecycleGeneration,
    ).toBe("generation-2");
    expect(fixture.mutations.filter((mutation) => mutation === "sandbox")).toHaveLength(2);
  });

  it("fails closed on a same-name replacement after sandbox deletion (#9608)", () => {
    const state = stateDir();
    const fixture = transactionDeps(state, "prepared");

    expect(() => runHermesPortableUninstallTransaction(state, fixture.deps)).toThrow(
      "interrupted after prepared",
    );
    fixture.setReplacement(true);
    expect(() => runHermesPortableUninstallTransaction(state, fixture.deps)).toThrow(
      "same-name replacement",
    );
    expect(fixture.mutations).toEqual(["sandbox"]);
    expect(inspectHermesPortableUninstallJournal(state)?.phase).toBe("prepared");
  });
});
