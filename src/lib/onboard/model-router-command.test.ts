// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createModelRouterCommandProvisioner } from "./model-router-command";

const GIB = 1024n ** 3n;

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-model-router-command-"));
  tempRoots.push(root);
  return root;
}

type ProvisionerOverrides = {
  availableBytes?: bigint;
  probeOk?: boolean;
  venvSizeBytes?: bigint;
  defaultVenvDir?: string;
  relativeVenvDir?: string;
};

function makeProvisioner(overrides: ProvisionerOverrides = {}) {
  const root = makeTempRoot();
  const routerDir = path.join(root, "router");
  fs.mkdirSync(routerDir, { recursive: true });
  fs.writeFileSync(path.join(routerDir, "pyproject.toml"), '[project]\nname = "router"\n');
  const venvDir = overrides.relativeVenvDir ?? path.join(root, "venv");

  const prepareModelRouterVenv = vi.fn((options: { venvDir: string }) => {
    const binDir = path.join(options.venvDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "model-router"), "#!/bin/sh\n", { mode: 0o755 });
    return path.join(binDir, "python");
  });
  const run = vi.fn(() => ({ status: 0 }));
  const logs: string[] = [];

  const probeStorage = vi.fn((targetPath: string, source: string) =>
    (overrides.probeOk ?? true)
      ? {
          ok: true as const,
          capacity: {
            availableBytes: overrides.availableBytes ?? 100n * GIB,
            path: targetPath,
            source,
          },
        }
      : { ok: false as const, reason: "statfs unavailable" },
  );
  const measureDirectorySize = vi.fn(() => overrides.venvSizeBytes ?? 0n);

  const provisioner = createModelRouterCommandProvisioner(
    {
      rootDir: root,
      routerDir,
      venvDir,
      defaultVenvDir: overrides.defaultVenvDir ?? venvDir,
    },
    {
      run,
      runCapture: vi.fn(() => ""),
      prepareModelRouterVenv,
      packageVersion: () => "0.0.0-test",
      log: (message) => logs.push(message),
      sourceFingerprint: () => "files:test-fingerprint",
      probeStorage,
      measureDirectorySize,
      formatStorageBytes: (bytes) => `${String(bytes / GIB)} GiB`,
    },
  );

  return {
    provisioner,
    prepareModelRouterVenv,
    run,
    logs,
    probeStorage,
    measureDirectorySize,
    venvDir,
    root,
  };
}

describe("model-router venv disk-space gate (#8973)", () => {
  it("refuses the install before creating the venv when free disk space is insufficient", () => {
    const { provisioner, prepareModelRouterVenv, run } = makeProvisioner({
      availableBytes: 1n * GIB,
    });

    expect(() => provisioner.ensureModelRouterCommand()).toThrow(
      /needs at least 3 GiB of free or reclaimable capacity .+ but only 1 GiB is available/,
    );
    expect(prepareModelRouterVenv).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("probes the resolved venv directory and reports it in the refusal message", () => {
    const { provisioner, probeStorage, venvDir } = makeProvisioner({ availableBytes: 0n });

    expect(() => provisioner.ensureModelRouterCommand()).toThrow(venvDir);
    expect(probeStorage).toHaveBeenCalledWith(venvDir, "Model Router venv");
  });

  it("resolves a relative venv directory so the gate still engages", () => {
    const { provisioner, probeStorage } = makeProvisioner({
      availableBytes: 0n,
      relativeVenvDir: "relative-model-router-venv",
    });

    expect(() => provisioner.ensureModelRouterCommand()).toThrow(
      /needs at least 3 GiB of free or reclaimable capacity/,
    );
    expect(probeStorage).toHaveBeenCalledWith(
      path.resolve("relative-model-router-venv"),
      "Model Router venv",
    );
  });

  it("states the exact shortfall when availability rounds to the requirement", () => {
    const { provisioner } = makeProvisioner({ availableBytes: 3n * GIB - 1n });

    expect(() => provisioner.ensureModelRouterCommand()).toThrow(
      /Free at least 1 MiB, then run `nemoclaw onboard --resume`/,
    );
  });

  it("installs when free disk space exactly meets the requirement", () => {
    // Exactly 3 GiB: pins the >= acceptance boundary so a regression to a
    // strict > comparison fails here instead of surviving both bracket tests.
    const { provisioner, prepareModelRouterVenv, run, venvDir } = makeProvisioner({
      availableBytes: 3n * GIB,
    });

    const command = provisioner.ensureModelRouterCommand();

    expect(command).toBe(path.join(venvDir, "bin", "model-router"));
    expect(prepareModelRouterVenv).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("installs on retry after capacity recovers from an earlier refusal", () => {
    const { provisioner, prepareModelRouterVenv, run, probeStorage, venvDir } = makeProvisioner({
      availableBytes: 1n * GIB,
    });

    expect(() => provisioner.ensureModelRouterCommand()).toThrow(
      /needs at least 3 GiB of free or reclaimable capacity/,
    );
    expect(prepareModelRouterVenv).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    probeStorage.mockReturnValueOnce({
      ok: true,
      capacity: {
        availableBytes: 3n * GIB,
        path: venvDir,
        source: "Model Router venv",
      },
    });

    expect(provisioner.ensureModelRouterCommand()).toBe(path.join(venvDir, "bin", "model-router"));
    expect(probeStorage).toHaveBeenCalledTimes(2);
    expect(prepareModelRouterVenv).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("continues with an advisory naming the probe failure when capacity is unreadable", () => {
    const { provisioner, prepareModelRouterVenv, logs } = makeProvisioner({ probeOk: false });

    provisioner.ensureModelRouterCommand();

    expect(prepareModelRouterVenv).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("could not be verified (statfs unavailable)");
  });

  it("credits the footprint of a replaceable existing venv toward the requirement", () => {
    const { provisioner, prepareModelRouterVenv, measureDirectorySize, venvDir } = makeProvisioner({
      availableBytes: 2n * GIB,
      venvSizeBytes: 2n * GIB,
    });
    fs.mkdirSync(venvDir, { recursive: true });

    provisioner.ensureModelRouterCommand();

    expect(measureDirectorySize).toHaveBeenCalledWith(venvDir);
    expect(prepareModelRouterVenv).toHaveBeenCalledTimes(1);
  });

  it("does not credit an existing venv that the install refuses to replace", () => {
    const { provisioner, prepareModelRouterVenv, measureDirectorySize, venvDir } = makeProvisioner({
      availableBytes: 2n * GIB,
      venvSizeBytes: 2n * GIB,
      defaultVenvDir: path.join(os.tmpdir(), "some-other-default-venv"),
    });
    fs.mkdirSync(venvDir, { recursive: true });

    expect(() => provisioner.ensureModelRouterCommand()).toThrow(
      /needs at least 3 GiB of free or reclaimable capacity/,
    );
    expect(measureDirectorySize).not.toHaveBeenCalled();
    expect(prepareModelRouterVenv).not.toHaveBeenCalled();
  });
});
