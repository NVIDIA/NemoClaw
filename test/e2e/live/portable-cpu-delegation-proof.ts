// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  inspectPortableCpuDelegation,
  type CpuDelegationPreflight,
} from "../../../src/lib/onboard/experimental/portable-cpu-delegation-preflight.ts";
import { preparePortableExperimentalHost } from "../../../src/lib/onboard/experimental/portable-host-preparation.ts";

type ExpectedState = "missing" | "delegated";

function expectedState(value: string | undefined): ExpectedState {
  if (value === "missing" || value === "delegated") return value;
  throw new Error("CPU delegation proof requires the missing or delegated state.");
}

function artifactDirectory(): string {
  const value = process.env.E2E_ARTIFACT_DIR;
  assert.ok(value, "E2E_ARTIFACT_DIR is required");
  const resolved = path.resolve(value);
  assert.equal(value, resolved, "E2E_ARTIFACT_DIR must be a normalized absolute path");
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}

function sourceRevision(): string {
  const value = process.env.E2E_SOURCE_REVISION;
  assert.match(value ?? "", /^[a-f0-9]{40}$/u, "E2E_SOURCE_REVISION must be a commit SHA");
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

function main(): void {
  assert.equal(process.platform, "linux", "CPU delegation proof requires Linux");
  assert.notEqual(process.getuid?.(), 0, "CPU delegation proof requires a non-root user");
  const state = expectedState(process.argv[2]);
  const preflight = inspectPortableCpuDelegation();
  if (state === "missing") {
    proveFailureBeforeEffects(preflight);
  } else {
    assert.equal(preflight.ok, true, preflight.detail);
    assert.equal(preflight.failure, undefined);
  }
  fs.writeFileSync(
    path.join(artifactDirectory(), `${state}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      sourceRevision: sourceRevision(),
      state,
      ok: preflight.ok,
      failure: preflight.failure ?? null,
      detail: preflight.detail,
      effectsBeforeAdmission: 0,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

main();
