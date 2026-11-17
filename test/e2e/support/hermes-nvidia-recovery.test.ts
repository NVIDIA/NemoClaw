// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  openSync,
  fstatSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { applyHermesManagedRoute } from "../../../src/lib/hermes-managed-route.ts";
import type { ConfigObject } from "../../../src/lib/security/credential-filter.ts";
import { hermesNvidiaRecoveryProbe } from "../fixtures/hermes-nvidia-recovery.ts";

const homes: string[] = [];
const sentinel = "[STRIPPED_BY_MIGRATION]";
const handle = "openshell:resolve:env:v8_NVIDIA_INFERENCE_API_KEY";

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "hermes-recovery-fixture-"));
  homes.push(home);
  const config: ConfigObject = {
    display: { show_reasoning: false },
    discord: { require_mention: true },
  };
  applyHermesManagedRoute(config, {
    upstreamProvider: "nvidia-prod",
    model: "nvidia/test-model",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    inferenceApi: "openai-completions",
    nativeCredentialHandle: handle,
  });
  Object.assign(config.model, { temperature: 0.25 });
  const path = join(home, "config.yaml");
  const save = (value: unknown = config) =>
    writeFileSync(path, YAML.stringify(value), { mode: 0o640 });
  save();
  const run = (phase: "seed" | "verify") =>
    spawnSync("python3", ["-I", ...hermesNvidiaRecoveryProbe(phase, home).slice(1)], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 128 * 1024,
    });
  const read = () => {
    const fd = openSync(path, "r");
    try {
      return { mode: fstatSync(fd).mode, config: YAML.parse(readFileSync(fd, "utf8")) };
    } finally {
      closeSync(fd);
    }
  };
  return { home, path, config, save, run, read };
}

describe.skipIf(process.platform === "win32")("Hermes NVIDIA damaged-state fixture", () => {
  it("seeds only three exact sentinels and fingerprints retained settings (#14094)", () => {
    const f = fixture();
    const before = structuredClone(f.config);
    const beforeMode = f.read().mode;
    const seeded = f.run("seed");
    expect(seeded.status, seeded.stderr).toBe(0);
    const evidence = JSON.parse(seeded.stdout);
    expect(evidence).toEqual({
      state: "stripped",
      credentials: [true, true, true],
      configFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      userState: true,
    });
    const { mode, config: damaged } = f.read();
    const expected = structuredClone(before);
    expected.model.api_key = sentinel;
    expected.providers["nvidia-prod"]!.api_key = sentinel;
    expected.custom_providers[0]!.api_key = sentinel;
    expect(damaged).toEqual(expected);
    expect(mode).toBe(beforeMode);
    expect(f.run("verify").status).toBe(1);
    // This support test checks the fixture; the live test owns actual guarded recovery.
    f.save(before);
    const recovered = f.run("verify");
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout)).toEqual({ ...evidence, state: "recovered" });
    expect(seeded.stdout + recovered.stdout).not.toContain(handle);
    rmSync(join(f.home, "e2e-nvidia-recovery-user-state.txt"));
    expect(f.run("verify").status).toBe(1);
  });

  it("preserves a user alias to the managed providers mapping (#14094)", () => {
    const f = fixture();
    f.config.user_provider_options = f.config.providers;
    const userSettings = structuredClone(f.config.providers);
    f.save();
    const seeded = f.run("seed");
    expect(seeded.status, seeded.stderr).toBe(0);
    const damaged = YAML.parse(readFileSync(f.path, "utf8"));
    expect(damaged.user_provider_options).toEqual(userSettings);
    expect(damaged.providers["nvidia-prod"].api_key).toBe(sentinel);
  });

  it.each<{ name: string; damage: (f: ReturnType<typeof fixture>) => void }>([
    {
      name: "partial",
      damage: (f) => {
        f.config.model.api_key = sentinel;
        f.save();
      },
    },
    {
      name: "raw",
      damage: (f) => {
        f.config.model.api_key = "synthetic-secret-never-log";
        f.save();
      },
    },
    {
      name: "endpoint",
      damage: (f) => {
        f.config.model.base_url = "https://foreign.invalid/v1";
        f.save();
      },
    },
    {
      name: "duplicate",
      damage: (f) => {
        f.config.custom_providers.push({ ...f.config.custom_providers[0]! });
        f.save();
      },
    },
    {
      name: "metadata",
      damage: (f) => {
        Reflect.deleteProperty(f.config, "_nemoclaw_upstream");
        f.save();
      },
    },
    { name: "oversize", damage: (f) => writeFileSync(f.path, "x".repeat(1024 * 1024 + 1)) },
    {
      name: "symlink",
      damage: (f) => {
        const target = join(f.home, "other.yaml");
        writeFileSync(target, readFileSync(f.path));
        rmSync(f.path);
        symlinkSync(target, f.path);
      },
    },
    { name: "hardlink", damage: (f) => linkSync(f.path, join(f.home, "other.yaml")) },
    {
      name: "existing marker",
      damage: (f) => writeFileSync(join(f.home, "e2e-nvidia-recovery-user-state.txt"), "retain"),
    },
  ])(
    "refuses $name state without altering the config or exposing values (#14094)",
    ({ damage }) => {
      const f = fixture();
      damage(f);
      const before = readFileSync(f.path);
      const result = f.run("seed");
      expect(result.status).toBe(1);
      expect(readFileSync(f.path)).toEqual(before);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Hermes NVIDIA recovery fixture refused unexpected state\n");
    },
  );
});
