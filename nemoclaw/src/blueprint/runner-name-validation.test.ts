// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Integration tests for the runner's fail-closed name validation. Kept in a
// focused file so runner.test.ts stays under the test-file-size budget. The
// mocks mirror runner.test.ts so these exercise the real apply/rollback paths.

import type fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRunnerFsStore,
  createStdoutCapture,
  FAKE_HOME,
  FIXED_RUN_UUID,
  inMemoryFsMethods,
  resolvedEndpointFor,
} from "./runner-mock-fixtures.js";
import {
  minimalBlueprint,
  resultWithBlueprintPolicy,
  successResult,
  TEST_SANDBOX_POLICY,
  TEST_SANDBOX_POLICY_PATH,
} from "./runner-test-fixtures.js";

const { store, addFile, addDir } = createRunnerFsStore();

vi.mock("node:os", () => ({
  homedir: () => FAKE_HOME,
}));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => FIXED_RUN_UUID,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  const memory = inMemoryFsMethods(store, { spy: vi.fn });
  return {
    ...original,
    existsSync: memory.existsSync,
    closeSync: memory.closeSync,
    fsyncSync: memory.fsyncSync,
    mkdirSync: memory.mkdirSync,
    openSync: memory.openSync,
    readFileSync: memory.readFileSync,
    renameSync: memory.renameSync,
    unlinkSync: memory.unlinkSync,
    writeFileSync: memory.writeFileSync,
    readdirSync: memory.readdirSync,
  };
});

const mockExeca = vi.fn();
vi.mock("execa", () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));

vi.mock("./ssrf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ssrf.js")>();
  return {
    ...actual,
    validateEndpointUrl: vi.fn(async (url: string) => resolvedEndpointFor(url)),
  };
});

const { actionApply, actionRollback } = await import("./runner.js");

const stdout = createStdoutCapture();

function createCalls(): unknown[] {
  return mockExeca.mock.calls.filter(
    (c) => Array.isArray(c[1]) && c[1][0] === "sandbox" && c[1][1] === "create",
  );
}

type BlueprintComponents = {
  sandbox: { name: string };
  inference: { profiles: { default: { provider_name: string } } };
};

/** Each case corrupts one identifier so the table stays branch-free. */
const INVALID_NAME_CASES: ReadonlyArray<
  readonly [string, (components: BlueprintComponents) => void, RegExp]
> = [
  [
    "sandbox name",
    // "--help" would be consumed as a flag by `openshell sandbox create`.
    (components) => {
      components.sandbox.name = "--help";
    },
    /Invalid sandbox name/,
  ],
  [
    "provider name",
    (components) => {
      components.inference.profiles.default.provider_name = "$(id)";
    },
    /Invalid provider name/,
  ],
  [
    "provider name containing a line feed",
    (components) => {
      components.inference.profiles.default.provider_name = "provider\n::error::forged";
    },
    /Invalid provider name/,
  ],
  [
    "over-length provider name",
    (components) => {
      components.inference.profiles.default.provider_name = `a${"b".repeat(128)}`;
    },
    /Invalid provider name/,
  ],
];

const VALID_PROVIDER_NAMES = ["Provider_1.prod", `a${"b".repeat(127)}`] as const;

describe("blueprint name validation (fail-closed integration)", () => {
  const RUNS_DIR = `${FAKE_HOME}/.nemoclaw/state/runs`;

  beforeEach(() => {
    store.clear();
    addFile(TEST_SANDBOX_POLICY_PATH, TEST_SANDBOX_POLICY);
    vi.stubEnv("OPENSHELL_SANDBOX_POLICY", TEST_SANDBOX_POLICY_PATH);
    stdout.reset();
    vi.clearAllMocks();
    vi.spyOn(process.stdout, "write").mockImplementation(stdout.write);
    mockExeca.mockImplementation(async (_command: string, args: string[]) =>
      resultWithBlueprintPolicy(args, successResult()),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(INVALID_NAME_CASES)(
    "apply rejects a malformed %s and creates no sandbox",
    async (_label, corrupt, expected) => {
      const bp = minimalBlueprint();
      corrupt(bp.components as BlueprintComponents);

      await expect(actionApply("default", bp)).rejects.toThrow(expected);
      // Validation runs before any command, so no provider or sandbox command
      // may have executed — not merely no sandbox create.
      expect(mockExeca).not.toHaveBeenCalled();
      expect(createCalls()).toEqual([]);
    },
  );

  it.each(VALID_PROVIDER_NAMES)(
    "apply accepts the supported provider name '%s'",
    async (providerName) => {
      const bp = minimalBlueprint();
      const components = bp.components as BlueprintComponents;
      components.inference.profiles.default.provider_name = providerName;

      await expect(actionApply("default", bp)).resolves.toBeUndefined();
      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        expect.arrayContaining(["provider", "create", "--name", providerName]),
        expect.any(Object),
      );
    },
  );

  it("rollback rejects a plan whose sandbox_name is not OpenShell-compatible", async () => {
    const runDir = `${RUNS_DIR}/nc-run-1`;
    addDir(runDir);
    // "--rm" would be consumed as a flag by `openshell sandbox stop/remove`.
    addFile(`${runDir}/plan.json`, JSON.stringify({ sandbox_name: "--rm" }));

    await expect(actionRollback("nc-run-1")).rejects.toThrow(/Invalid sandbox name/);
    expect(mockExeca).not.toHaveBeenCalled();
    expect(store.has(`${runDir}/rolled_back`)).toBe(false);
  });
});
