// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { DockerGpuPatchDeps } from "../docker-gpu-patch-types";
import {
  clearDockerManagedStartupSharedStateCommitReceipt,
  type DockerManagedBootstrapSharedStateTransaction,
  finalizeDockerManagedStartupSharedState,
} from "./docker-shared-state";
import { authority, fixture, IDENTITY, NEW_ID } from "./docker-test-fixture";

const CLEAN_NODE_COMMAND = [
  "/usr/bin/env",
  "-i",
  "HOME=/root",
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "/usr/local/bin/node",
] as const;
const PRE_ENTRYPOINT_ENV_OVERRIDES = [
  "--env",
  "LD_AUDIT=",
  "--env",
  "LD_LIBRARY_PATH=",
  "--env",
  "LD_PRELOAD=",
  "--env",
  "NODE_OPTIONS=",
  "--env",
  "NODE_PATH=",
] as const;

function sharedStateTransaction(): DockerManagedBootstrapSharedStateTransaction {
  const { handle } = authority("hermes");
  return {
    agent: "hermes",
    bootstrapIdentity: IDENTITY,
    containerId: NEW_ID,
    image: `sha256:${"4".repeat(64)}`,
    profileFingerprint: handle.plan.profile.fingerprint,
  };
}

function nodeHelperCalls(deps: DockerGpuPatchDeps): readonly (readonly string[])[] {
  return vi
    .mocked(deps.dockerRun!)
    .mock.calls.map(([args]) => args)
    .filter((args) => args[0] === "run" || args[0] === "exec")
    .filter((args) => args.includes("/usr/local/bin/node"));
}

function expectPreEntrypointEnvironmentNeutralized(args: readonly string[]): void {
  expect(args).toEqual(expect.arrayContaining([...PRE_ENTRYPOINT_ENV_OVERRIDES]));
  expect(args).not.toContain("BASH_FUNC_*");
}

function expectCleanRunNodeHelper(args: readonly string[]): void {
  expectPreEntrypointEnvironmentNeutralized(args);
  const nodeIndex = args.indexOf("/usr/local/bin/node");
  expect(nodeIndex).toBeGreaterThan(0);
  const entrypointIndex = args.indexOf("--entrypoint");
  expect(args[entrypointIndex + 1]).toBe(CLEAN_NODE_COMMAND[0]);
  expect(args.slice(nodeIndex - CLEAN_NODE_COMMAND.length + 2, nodeIndex + 1)).toEqual(
    CLEAN_NODE_COMMAND.slice(1),
  );
}

function expectCleanExecNodeHelper(args: readonly string[]): void {
  expectPreEntrypointEnvironmentNeutralized(args);
  const nodeIndex = args.indexOf("/usr/local/bin/node");
  expect(nodeIndex).toBeGreaterThan(0);
  expect(args.slice(nodeIndex - CLEAN_NODE_COMMAND.length + 1, nodeIndex + 1)).toEqual(
    CLEAN_NODE_COMMAND,
  );
}

describe("Docker managed-bootstrap shared-state helper environment", () => {
  it("clears arbitrary image and container environment before every verification and commit helper", () => {
    const fake = fixture({ sharedState: "pending" });
    const outcome = finalizeDockerManagedStartupSharedState(
      {
        transaction: sharedStateTransaction(),
        retainContainerAfterRollback: true,
        supervisorReady: true,
      },
      fake.deps,
    );

    expect(outcome).toEqual({ supervisorReady: true, failure: null });
    const helpers = nodeHelperCalls(fake.deps);
    expect(helpers.some((args) => args.includes("--shared-state-transaction-status"))).toBe(true);
    expect(helpers.some((args) => args.includes("--commit-shared-state-transaction"))).toBe(true);
    expect(helpers).not.toHaveLength(0);
    helpers.filter((args) => args[0] === "run").forEach(expectCleanRunNodeHelper);
    helpers.filter((args) => args[0] === "exec").forEach(expectCleanExecNodeHelper);
  });

  it("clears arbitrary image environment before the immutable rollback helper", () => {
    const fake = fixture({ sharedState: "pending" });
    const outcome = finalizeDockerManagedStartupSharedState(
      {
        transaction: sharedStateTransaction(),
        retainContainerAfterRollback: true,
        supervisorReady: false,
      },
      fake.deps,
    );

    expect(outcome).toEqual({ supervisorReady: false, failure: null });
    const helpers = nodeHelperCalls(fake.deps);
    expect(helpers).toHaveLength(1);
    expect(helpers[0]).toContain("--rollback-shared-state-transaction");
    expectCleanRunNodeHelper(helpers[0]!);
  });

  it("clears arbitrary container environment before the durable receipt-clear helper", () => {
    const fake = fixture({ sharedState: "committed" });
    clearDockerManagedStartupSharedStateCommitReceipt(sharedStateTransaction(), fake.deps);

    const helpers = nodeHelperCalls(fake.deps);
    expect(helpers).toHaveLength(1);
    expect(helpers[0]).toContain("--clear-shared-state-commit-receipt");
    expectCleanExecNodeHelper(helpers[0]!);
  });
});
