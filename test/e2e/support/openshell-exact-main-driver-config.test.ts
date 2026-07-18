// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenShellDriverConfigTestWrapper } from "../live/openshell-driver-config-test-wrapper.ts";
import {
  EXACT_MAIN_DRIVER_CONFIG_JSON,
  EXACT_MAIN_DRIVER_CONFIG_PROOF_ENV,
  EXACT_MAIN_TMPFS_MOUNT,
  prepareExactMainDriverConfigProof,
} from "../live/openshell-exact-main-driver-config.ts";

const originalProofEnv = process.env[EXACT_MAIN_DRIVER_CONFIG_PROOF_ENV];
const restoreProofEnv =
  originalProofEnv === undefined
    ? () => Reflect.deleteProperty(process.env, EXACT_MAIN_DRIVER_CONFIG_PROOF_ENV)
    : () => Reflect.set(process.env, EXACT_MAIN_DRIVER_CONFIG_PROOF_ENV, originalProofEnv);

afterEach(() => {
  restoreProofEnv();
});

describe("exact-main selected-driver config proof boundary", () => {
  it("does not inject driver config outside the explicit candidate-main lane", async () => {
    delete process.env[EXACT_MAIN_DRIVER_CONFIG_PROOF_ENV];
    const add = vi.fn();

    const proof = prepareExactMainDriverConfigProof({ cleanup: { add } } as never, "inactive");
    expect(proof).toMatchObject({ active: false, envOverlay: {} });
    await expect(proof.assertAfterOnboard()).resolves.toBeUndefined();
    await expect(proof.assertAfterRebuild()).resolves.toBeUndefined();
    expect(add).not.toHaveBeenCalled();
  });

  it("injects only the reviewed structured tmpfs config on sandbox create", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exact-main-driver-wrapper-"));
    const delegate = path.join(fixture, "openshell-real");
    fs.writeFileSync(delegate, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", {
      encoding: "utf8",
      mode: 0o700,
    });
    const wrapper = createOpenShellDriverConfigTestWrapper({
      driverConfigJson: EXACT_MAIN_DRIVER_CONFIG_JSON,
      label: "exact-main-driver-config",
      realOpenshellPath: delegate,
    });
    try {
      expect(JSON.parse(EXACT_MAIN_DRIVER_CONFIG_JSON)).toEqual({
        docker: { mounts: [EXACT_MAIN_TMPFS_MOUNT] },
        podman: { mounts: [EXACT_MAIN_TMPFS_MOUNT] },
      });
      expect(EXACT_MAIN_TMPFS_MOUNT).toEqual({
        type: "tmpfs",
        target: "/tmp/nemoclaw-exact-main-driver-config",
        options: ["noexec"],
        size_bytes: 16_777_216,
        mode: 0o1777,
      });
      expect(EXACT_MAIN_DRIVER_CONFIG_JSON).not.toContain("selinux_label");
      expect(EXACT_MAIN_DRIVER_CONFIG_JSON).not.toContain('"type":"bind"');

      const create = spawnSync(wrapper.executable, ["sandbox", "create", "--name", "candidate"], {
        encoding: "utf8",
      });
      expect(create.status, create.stderr).toBe(0);
      expect(create.stdout.trimEnd().split("\n")).toEqual([
        "sandbox",
        "create",
        "--driver-config-json",
        EXACT_MAIN_DRIVER_CONFIG_JSON,
        "--name",
        "candidate",
      ]);

      const list = spawnSync(wrapper.executable, ["sandbox", "list"], {
        encoding: "utf8",
      });
      expect(list.status, list.stderr).toBe(0);
      expect(list.stdout.trimEnd().split("\n")).toEqual(["sandbox", "list"]);

      const duplicate = spawnSync(
        wrapper.executable,
        ["sandbox", "create", "--driver-config-json", "{}"],
        { encoding: "utf8" },
      );
      expect(duplicate.status).toBe(64);
      expect(duplicate.stderr).toContain("refusing duplicate --driver-config-json");
    } finally {
      wrapper.remove();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("expects graceful gateway recovery to remount tmpfs while retaining durable state", () => {
    const source = fs.readFileSync(
      path.join("test", "e2e", "live", "openshell-exact-main-driver-config.ts"),
      "utf8",
    );
    const restart = source.match(
      /export async function restartAndAssertExactMainDriverConfig[\s\S]*?(?=\nexport async function assertExactMainDriverConfigAfterRebuild)/u,
    )?.[0];

    expect(restart).toBeDefined();
    expect(restart).toContain('tmpfsMarker: "absent"');
    expect(restart).not.toContain('tmpfsMarker: "present"');
    expect(restart).toContain("baseline.containerId");
    expect(restart).toContain("baseline.config.configSha256");
    expect(restart).toContain("durableMarkerValue: options.proof.durableMarkerValue!");
    expect(restart).toContain('"same-container-tmpfs-remounted-and-durable-state-retained"');
  });
});
