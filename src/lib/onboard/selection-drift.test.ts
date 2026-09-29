// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findSelectionConfigPath,
  getSelectionDrift,
  readSandboxSelectionConfig,
} from "./selection-drift";
import { requiresSelectionRecreate } from "./dcode-selection-drift";

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-selection-test-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("selection drift helpers", () => {
  it("preserves native OpenClaw model edits when the requested onboarding selection is unchanged", () => {
    const runOpenshell = vi.fn((args: string[]) => {
      fs.writeFileSync(
        path.join(args[4], "config.json"),
        JSON.stringify({ provider: "compatible-endpoint", model: "model-a" }),
      );
      return { status: 0 };
    });
    expect(
      getSelectionDrift("alpha", "compatible-endpoint", "model-a", { runOpenshell }),
    ).toMatchObject({ changed: false, unknown: false });
    expect(runOpenshell).toHaveBeenCalledExactlyOnceWith(
      ["sandbox", "download", "alpha", "/sandbox/.nemoclaw/config.json", expect.any(String)],
      { ignoreError: true, stdio: ["ignore", "ignore", "ignore"] },
    );
  });

  it("finds nested config.json files", () => {
    const root = tmpRoot();
    const nested = path.join(root, "sandbox", ".nemoclaw");
    fs.mkdirSync(nested, { recursive: true });
    const configPath = path.join(nested, "config.json");
    fs.writeFileSync(configPath, "{}", "utf-8");

    expect(findSelectionConfigPath(root)).toBe(configPath);
  });

  it("returns null when the sandbox download fails", () => {
    const runOpenshell = vi.fn((_args: string[]) => ({ status: 1 }));

    expect(readSandboxSelectionConfig("alpha", { runOpenshell })).toBeNull();
    expect(runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "download", "alpha", "/sandbox/.nemoclaw/config.json", expect.any(String)],
      { ignoreError: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    const downloadDir = String(runOpenshell.mock.calls[0]?.[0]?.[4] ?? "");
    expect(path.basename(downloadDir)).toMatch(/^nemoclaw-selection-/);
  });

  it("returns null when the temp directory cannot be created", () => {
    const root = tmpRoot();
    const notDirectory = path.join(root, "not-a-directory");
    fs.writeFileSync(notDirectory, "", "utf-8");
    const runOpenshell = vi.fn(() => ({ status: 0 }));

    expect(readSandboxSelectionConfig("alpha", { runOpenshell, tmpDir: notDirectory })).toBeNull();
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("reads a downloaded selection config and cleans up the temp directory", () => {
    let downloadedParent: string | null = null;
    const runOpenshell = vi.fn((args: string[]) => {
      downloadedParent = args[4];
      const targetDir = path.join(String(downloadedParent), "nested");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, "config.json"),
        JSON.stringify({ provider: "compatible-endpoint", model: "model-a" }),
        "utf-8",
      );
      return { status: 0 };
    });

    expect(readSandboxSelectionConfig("alpha", { runOpenshell })).toEqual({
      provider: "compatible-endpoint",
      model: "model-a",
    });
    expect(downloadedParent).not.toBeNull();
    expect(fs.existsSync(String(downloadedParent))).toBe(false);
  });

  it.each([
    { provider: "inference", model: "model-a\u001b]52;c;attack\u0007" },
    { provider: "inference\nforged-output", model: "model-a" },
    { provider: "inference", model: "a".repeat(513) },
    { provider: "inference", model: "" },
    { provider: "inference", model: 42 },
  ])("rejects unsafe or invalid sandbox-owned selection state: %j", (selection) => {
    const runOpenshell = vi.fn((args: string[]) => {
      fs.writeFileSync(path.join(args[4], "config.json"), JSON.stringify(selection));
      return { status: 0 };
    });

    expect(readSandboxSelectionConfig("alpha", { runOpenshell })).toBeNull();
    expect(fs.existsSync(runOpenshell.mock.calls[0][0][4])).toBe(false);
  });

  it("reports unknown drift when no readable selection config exists", () => {
    expect(
      getSelectionDrift("alpha", "compatible-endpoint", "model-a", {
        runOpenshell: () => ({ status: 1 }),
      }),
    ).toEqual({
      changed: true,
      providerChanged: false,
      modelChanged: false,
      existingProvider: null,
      existingModel: null,
      requestedProvider: "compatible-endpoint",
      requestedModel: "model-a",
      unknown: true,
    });
  });

  it("reports provider and model drift from the downloaded selection config", () => {
    const runOpenshell = vi.fn((args: string[]) => {
      const targetDir = String(args[4]);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, "config.json"),
        JSON.stringify({ provider: "old-provider", model: "old-model" }),
        "utf-8",
      );
      return { status: 0 };
    });

    expect(getSelectionDrift("alpha", "new-provider", "new-model", { runOpenshell })).toEqual({
      changed: true,
      providerChanged: true,
      modelChanged: true,
      existingProvider: "old-provider",
      existingModel: "old-model",
      requestedProvider: "new-provider",
      requestedModel: "new-model",
      unknown: false,
    });
  });

  it.each([
    ["other-provider", "model-a", true, false],
    ["compatible-endpoint", "model-b", false, true],
  ] as const)(
    "requires recreation for an explicit selection change to %s/%s",
    (provider, model, providerChanged, modelChanged) => {
      const drift = getSelectionDrift("alpha", provider, model, {
        runOpenshell: (args) => {
          fs.writeFileSync(
            path.join(args[4], "config.json"),
            JSON.stringify({ provider: "compatible-endpoint", model: "model-a" }),
          );
          return { status: 0 };
        },
      });
      expect(drift).toMatchObject({ changed: true, providerChanged, modelChanged, unknown: false });
      expect(requiresSelectionRecreate(drift, false)).toBe(true);
    },
  );

  it.each(["not json", "{}"])(
    "does not authorize recreation without a readable selection record: %s",
    (record) => {
      const drift = getSelectionDrift("alpha", "compatible-endpoint", "model-a", {
        runOpenshell: (args) => {
          fs.writeFileSync(path.join(args[4], "config.json"), record);
          return { status: 0 };
        },
      });
      expect(drift).toMatchObject({ changed: true, unknown: true });
      expect(requiresSelectionRecreate(drift, false)).toBe(false);
    },
  );
});
