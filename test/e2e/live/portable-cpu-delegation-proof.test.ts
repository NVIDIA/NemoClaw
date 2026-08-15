// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  inspectPortableCpuDelegation,
  type CpuDelegationPreflight,
} from "../../../src/lib/onboard/experimental/portable-cpu-delegation-preflight.ts";
import { preparePortableExperimentalHost } from "../../../src/lib/onboard/experimental/portable-host-preparation.ts";
import { test } from "../fixtures/e2e-test.ts";

type ExpectedState = "missing" | "delegated";

function expectedState(value: string | undefined): ExpectedState {
  if (value === "missing" || value === "delegated") return value;
  throw new Error("CPU delegation proof requires the missing or delegated state.");
}

function sourceRevision(): string {
  const value = process.env.E2E_SOURCE_REVISION;
  assert.match(value ?? "", /^[a-f0-9]{40}$/u, "E2E_SOURCE_REVISION must be a commit SHA");
  const checkoutRevision = execFileSync(
    "git",
    ["-c", `safe.directory=${process.cwd()}`, "rev-parse", "HEAD"],
    { encoding: "utf8", killSignal: "SIGKILL", timeout: 10_000 },
  ).trim();
  assert.equal(value, checkoutRevision, "CPU delegation proof must run the requested commit");
  return value!;
}

function proveFailureBeforeEffects(preflight: CpuDelegationPreflight): void {
  assert.equal(preflight.ok, false);
  assert.equal(preflight.failure, "systemd-user-delegation-missing");
  const effects: string[] = [];
  const effect = (name: string): never => {
    effects.push(name);
    throw new Error(`Portable host preparation reached ${name} after failed CPU delegation.`);
  };
  assert.throws(
    () =>
      preparePortableExperimentalHost(
        { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        {
          platform: "linux",
          validateConfigAuthority: () => effect("config authority validation"),
          systemctl: () => effect("systemd mutation"),
          podman: () => effect("Podman mutation"),
          docker: () => effect("Docker-compatible mutation"),
        },
      ),
    /Portable CPU-delegation preflight failed/u,
  );
  assert.deepEqual(effects, []);
}

const proof = process.env.E2E_TARGET_ID === "portable-cpu-delegation" ? test : test.skip;

proof(
  "portable CPU delegation admits only the delegated current-user hierarchy",
  {
    timeout: 30_000,
    meta: {
      e2ePhases: [
        "inspect the current user CPU delegation boundary",
        "record the CPU delegation admission result",
      ],
    },
  },
  async ({ artifacts, progress }) => {
    assert.equal(process.platform, "linux", "CPU delegation proof requires Linux");
    assert.notEqual(process.getuid?.(), 0, "CPU delegation proof requires a non-root user");
    const state = expectedState(process.env.E2E_CPU_DELEGATION_EXPECTED_STATE);
    const revision = sourceRevision();

    progress.phase("inspect the current user CPU delegation boundary");
    const preflight = inspectPortableCpuDelegation();
    if (state === "missing") {
      proveFailureBeforeEffects(preflight);
    } else {
      assert.equal(preflight.ok, true, preflight.detail);
      assert.equal(preflight.failure, undefined);
    }

    progress.phase("record the CPU delegation admission result");
    await artifacts.writeJson(`${state}.json`, {
      schemaVersion: 1,
      sourceRevision: revision,
      state,
      ok: preflight.ok,
      failure: preflight.failure ?? null,
      detail: preflight.detail,
      effectsBeforeAdmission: 0,
    });
  },
);
