// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findSelectionConfigPath,
  getSelectionDrift,
  readOpenClawSelectionConfig,
  readSandboxSelectionConfig,
} from "./selection-drift";

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

  it("reads only the native OpenClaw model scalar without downloading its config", () => {
    const root = tmpRoot();
    const runOpenshell = vi.fn(() => ({ status: 1 }));
    const runCaptureOpenshell = vi.fn(() => JSON.stringify("inference/model-a"));

    expect(
      readOpenClawSelectionConfig("alpha", {
        runOpenshell,
        runCaptureOpenshell,
        tmpDir: root,
      }),
    ).toEqual({ provider: "inference", model: "model-a" });
    expect(runCaptureOpenshell).toHaveBeenCalledExactlyOnceWith(
      [
        "sandbox",
        "exec",
        "--name",
        "alpha",
        "--",
        "/usr/bin/env",
        "HOME=/sandbox",
        "/usr/local/bin/openclaw",
        "config",
        "get",
        "agents.defaults.model.primary",
        "--json",
      ],
      { ignoreError: true, timeout: 30_000 },
    );
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("rejects terminal controls from sandbox-owned selection state", () => {
    const runOpenshell = vi.fn(() => ({ status: 1 }));

    expect(
      readOpenClawSelectionConfig("alpha", {
        runOpenshell,
        runCaptureOpenshell: () => JSON.stringify("inference/model-a\u001b]52;c;attack\u0007"),
      }),
    ).toBeNull();
  });

  it("reports unknown drift when no readable selection config exists", () => {
    expect(
      getSelectionDrift(
        "alpha",
        "compatible-endpoint",
        "model-a",
        "openclaw",
        { providerKey: "inference", primaryModelRef: "inference/model-a" },
        {
          runOpenshell: () => ({ status: 1 }),
          runCaptureOpenshell: () => "",
        },
      ),
    ).toEqual({
      changed: true,
      providerChanged: false,
      modelChanged: false,
      existingProvider: null,
      existingModel: null,
      requestedProvider: "inference",
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

    expect(
      getSelectionDrift("alpha", "new-provider", "new-model", "hermes", null, { runOpenshell }),
    ).toEqual({
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

  it("uses a matching native OpenClaw selection instead of stale NemoClaw state", () => {
    const runOpenshell = vi.fn(() => ({ status: 1 }));
    const runCaptureOpenshell = vi.fn(() => JSON.stringify("inference/model-a"));

    expect(
      getSelectionDrift(
        "alpha",
        "compatible-endpoint",
        "model-a",
        "openclaw",
        { providerKey: "inference", primaryModelRef: "inference/model-a" },
        { runOpenshell, runCaptureOpenshell },
      ),
    ).toEqual({
      changed: false,
      providerChanged: false,
      modelChanged: false,
      existingProvider: "inference",
      existingModel: "model-a",
      requestedProvider: "inference",
      requestedModel: "model-a",
      unknown: false,
    });
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("reports drift when the native OpenClaw selection differs", () => {
    const runOpenshell = vi.fn(() => ({ status: 1 }));
    const runCaptureOpenshell = vi.fn(() => JSON.stringify("inference/model-b"));

    expect(
      getSelectionDrift(
        "alpha",
        "compatible-endpoint",
        "model-a",
        "openclaw",
        { providerKey: "inference", primaryModelRef: "inference/model-a" },
        { runOpenshell, runCaptureOpenshell },
      ),
    ).toEqual({
      changed: true,
      providerChanged: false,
      modelChanged: true,
      existingProvider: "inference",
      existingModel: "model-b",
      requestedProvider: "inference",
      requestedModel: "model-a",
      unknown: false,
    });
  });
});
