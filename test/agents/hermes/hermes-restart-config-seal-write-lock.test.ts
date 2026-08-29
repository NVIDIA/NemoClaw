// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createRestartFixture,
  mode,
  RUNTIME_CONFIG_GUARD,
  runGuard,
  runWriteConfig,
  strictHashIsValid,
  writeMutationLock,
} from "../../helpers/hermes-restart-config-seal-fixture";

describe.skipIf(process.platform === "win32")("Hermes mutable restart input seal", () => {
  it("atomically binds a host config write to the bytes that were read and refreshes both hashes", () => {
    const fixture = createRestartFixture();
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");
    const updatedConfig = "model:\n  default: trusted-model-v2\n";

    try {
      const updated = runWriteConfig(fixture, expectedDigest, updatedConfig);

      expect(updated.status, updated.stderr).toBe(0);
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(updatedConfig);
      expect(fs.readFileSync(fixture.hashPath, "utf-8")).toBe(
        fs.readFileSync(fixture.compatHashPath, "utf-8"),
      );
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(mode(fixture.sandboxDir)).toBe(0o770);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(mode(fixture.envPath)).toBe(0o600);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("accepts exactly 16 MiB at the size guard before validating filesystem state", () => {
    const fixture = createRestartFixture();
    const configAtLimit = "a".repeat(16 * 1024 * 1024);
    fs.rmSync(fixture.root, { recursive: true, force: true });

    const updated = runWriteConfig(fixture, "0".repeat(64), configAtLimit);

    expect(updated.status).not.toBe(0);
    expect(updated.stderr).not.toContain("refusing oversized Hermes config input");
    expect(updated.stderr).toContain("No such file or directory");
  });

  it("rejects Hermes configuration input larger than 16 MiB without creating restart state", () => {
    const fixture = createRestartFixture();
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");
    const oversizedConfig = "a".repeat(16 * 1024 * 1024 + 1);

    try {
      const updated = runWriteConfig(fixture, expectedDigest, oversizedConfig);

      expect(updated.status).not.toBe(0);
      expect(updated.stderr).toContain("refusing oversized Hermes config input");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses to launder a stale host read and leaves the trusted config unchanged", () => {
    const fixture = createRestartFixture();
    const staleDigest = createHash("sha256").update("attacker-controlled read\n").digest("hex");

    try {
      const updated = runWriteConfig(
        fixture,
        staleDigest,
        "model:\n  default: attacker-derived-model\n",
      );

      expect(updated.status).not.toBe(0);
      expect(updated.stderr).toContain("config changed after the host read");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses host config writes while shields are up and restores the locked posture", () => {
    const fixture = createRestartFixture();
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");
    fs.chmodSync(fixture.sandboxDir, 0o755);
    fs.chmodSync(fixture.hermesDir, 0o755);
    fs.chmodSync(fixture.configPath, 0o444);
    fs.chmodSync(fixture.envPath, 0o444);
    fs.chmodSync(fixture.compatHashPath, 0o444);

    try {
      const updated = runWriteConfig(
        fixture,
        expectedDigest,
        "model:\n  default: must-not-apply\n",
      );

      expect(updated.status).not.toBe(0);
      expect(updated.stderr).toContain("config writes are unavailable while shields are up");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(mode(fixture.sandboxDir)).toBe(0o755);
      expect(mode(fixture.hermesDir)).toBe(0o755);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(mode(fixture.envPath)).toBe(0o444);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("serializes restart sealing against a host-held shields mutation lock", () => {
    const fixture = createRestartFixture();
    const token = randomBytes(32).toString("hex");

    try {
      const lockPath = writeMutationLock(fixture, token);

      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status).not.toBe(0);
      expect(sealed.stderr).toContain("config mutation is already in progress");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(mode(fixture.sandboxDir)).toBe(0o770);

      fs.unlinkSync(lockPath);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("recovers a dead mutation lock published before seal state creation", () => {
    const fixture = createRestartFixture();
    const token = randomBytes(32).toString("hex");
    try {
      const lockPath = writeMutationLock(fixture, token);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      const recovered = spawnSync(
        "python3",
        [
          RUNTIME_CONFIG_GUARD,
          "recover-prestate-lock",
          "--hermes-dir",
          fixture.hermesDir,
          "--state-file",
          fixture.statePath,
          "--startup-owner",
        ],
        { encoding: "utf-8", timeout: 5000 },
      );
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(recovered.stdout.trim()).toBe("recovered=1");
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a host config transaction while another Hermes mutation owns the lock", () => {
    const fixture = createRestartFixture();
    const token = randomBytes(32).toString("hex");
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");

    try {
      const lockPath = writeMutationLock(fixture, token);

      const updated = runWriteConfig(
        fixture,
        expectedDigest,
        "model:\n  default: should-not-commit\n",
      );
      expect(updated.status).not.toBe(0);
      expect(updated.stderr).toContain("config mutation is already in progress");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(strictHashIsValid(fixture)).toBe(true);

      fs.unlinkSync(lockPath);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rolls back a config-write phase killed after rename but before strict hash refresh", () => {
    const fixture = createRestartFixture();

    try {
      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status, sealed.stderr).toBe(0);

      const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
      state.phase = "config-write-prepared";
      state.config_write = {
        original_base64: Buffer.from(fixture.trustedConfig).toString("base64"),
        original_sha256: createHash("sha256").update(fixture.trustedConfig).digest("hex"),
      };
      fs.writeFileSync(fixture.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      fs.chmodSync(fixture.statePath, 0o600);

      const replacement = path.join(fixture.hermesDir, ".config.crash-test");
      fs.writeFileSync(replacement, "model:\n  default: interrupted-write\n", { mode: 0o444 });
      fs.chmodSync(replacement, 0o444);
      fs.renameSync(replacement, fixture.configPath);
      expect(strictHashIsValid(fixture)).toBe(false);

      const recovered = runGuard("unseal-restart", fixture);
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(mode(fixture.sandboxDir)).toBe(0o770);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
