// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendResourceFlags,
  getHardwareResources,
  loadResourceProfiles,
  printHardwareResources,
  resolveProfile,
  resolveResourceValue,
} from "../../dist/lib/resources-cmd.js";

const tempDirs: string[] = [];

function makeExecutable(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resources-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, "openshell-fake");
  fs.writeFileSync(file, contents, { mode: 0o755 });
  return file;
}

describe("resources-cmd", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves percentage and absolute resource values", () => {
    expect(resolveResourceValue("25%", 16, "cpu")).toBe("4");
    expect(resolveResourceValue("25%", 3.5, "cpu")).toBe("875m");
    expect(resolveResourceValue("50%", 8192, "memory")).toBe("4Gi");
    expect(resolveResourceValue("10%", 1024, "memory")).toBe("128Mi");
    expect(resolveResourceValue("750m", 16, "cpu")).toBe("750m");
    expect(resolveResourceValue("8Gi", 8192, "memory")).toBe("8Gi");
  });

  it("rejects malformed percentages before they reach OpenShell", () => {
    expect(() => resolveResourceValue("0%", 16, "cpu")).toThrow("integer between 1% and 100%");
    expect(() => resolveResourceValue("101%", 16, "cpu")).toThrow("integer between 1% and 100%");
    expect(() => resolveResourceValue("12.5%", 16, "cpu")).toThrow("integer between 1% and 100%");
  });

  it("resolves profiles against Kubernetes allocatable capacity when available", () => {
    const resolved = resolveProfile(
      {
        cpu: "50%",
        memory: "25%",
      },
      {
        cpu: { cores: 16, model: "test-cpu", allocatable: "7500m" },
        memory: { totalMB: 32768, swapMB: 0, allocatableMB: 16384 },
        gpu: null,
        profiles: null,
      },
    );

    expect(resolved).toEqual({
      cpu: "3750m",
      memory: "4Gi",
    });
  });

  it("loads resource profiles from the blueprint", () => {
    const profiles = loadResourceProfiles();

    expect(profiles.developer).toEqual({
      cpu: "75%",
      memory: "75%",
    });
    expect(profiles["game-developer"].cpu).toBe("60%");
  });

  it("returns hardware resources and includes parsed blueprint profiles", () => {
    const hw = getHardwareResources();

    expect(hw.cpu.cores).toBeGreaterThan(0);
    expect(hw.cpu.model).toEqual(expect.any(String));
    expect(hw.memory.totalMB).toBeGreaterThan(0);
    expect(hw.profiles?.creator.cpu).toBe("50%");
  });

  it("prints JSON and returns the hardware object in JSON mode", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const hw = printHardwareResources(true);
      expect(hw.memory.totalMB).toBeGreaterThan(0);
      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('"memory"'));
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("appends resolved OpenShell CPU and memory flags when supported", () => {
    const openshell = makeExecutable("#!/usr/bin/env sh\necho '--cpu --memory'\n");
    const args = ["sandbox", "create"];

    const applied = appendResourceFlags(args, { cpu: "4", memory: "2Gi" }, openshell);

    expect(applied).toBe(true);
    expect(args).toEqual(["sandbox", "create", "--cpu", "4", "--memory", "2Gi"]);
  });

  it("does not use old request/limit resource flags", () => {
    const openshell = makeExecutable(
      "#!/usr/bin/env sh\necho '--cpu-request --cpu-limit --memory-request --memory-limit'\n",
    );
    const args = ["sandbox", "create"];

    expect(appendResourceFlags(args, { cpu: "4", memory: "2Gi" }, openshell)).toBe(false);
    expect(args).toEqual(["sandbox", "create"]);
  });

  it("gracefully skips resource flags when OpenShell does not support them", () => {
    const openshell = makeExecutable("#!/usr/bin/env sh\necho 'usage: openshell sandbox create'\n");
    const args = ["sandbox", "create"];

    expect(appendResourceFlags(args, { cpu: "25%", memory: "25%" }, openshell)).toBe(false);
    expect(args).toEqual(["sandbox", "create"]);
  });

  it("gracefully skips resource flags when profile resolution fails", () => {
    const openshell = makeExecutable("#!/usr/bin/env sh\necho '--cpu --memory'\n");
    const args = ["sandbox", "create"];

    expect(appendResourceFlags(args, { cpu: "bogus%", memory: "25%" }, openshell)).toBe(false);
    expect(args).toEqual(["sandbox", "create"]);
  });
});
