// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dockerRunCommandBetween, runDockerShell } from "./helpers/hermes-dockerfile-run";

const ROOT = path.resolve(import.meta.dirname, "..");
const HERMES_DOCKERFILE = path.join(ROOT, "agents", "hermes", "Dockerfile");

type LegacyDataFixture = false | "content" | "directory-symlink" | "entry-symlink";
type OpenClawFixture = false | "directory" | "symlink";

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

function runFinalLayout({
  baseImage = "nemoclaw-hermes-base-local",
  legacyData = false,
  openclaw = false,
}: {
  baseImage?: string;
  legacyData?: LegacyDataFixture;
  openclaw?: OpenClawFixture;
} = {}) {
  const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-final-layout-"));
  const sandboxRoot = path.join(tmp, "sandbox");
  const hermesDir = path.join(sandboxRoot, ".hermes");
  const legacyDataDir = path.join(sandboxRoot, ".hermes-data");
  const legacyTarget = path.join(tmp, "legacy-target");
  const openclawDir = path.join(sandboxRoot, ".openclaw");
  const openclawTarget = path.join(tmp, "openclaw-target");

  fs.mkdirSync(hermesDir, { recursive: true });
  fs.writeFileSync(path.join(hermesDir, "config.yaml"), "model: test\n");
  fs.writeFileSync(path.join(hermesDir, ".env"), "TOKEN=test\n");

  if (legacyData === "content") {
    fs.mkdirSync(path.join(legacyDataDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(legacyDataDir, "sessions", "legacy.json"), "{}\n");
    fs.writeFileSync(path.join(legacyDataDir, "legacy.txt"), "legacy\n");
    fs.symlinkSync(path.join(legacyDataDir, "sessions"), path.join(hermesDir, "sessions"));
    fs.symlinkSync(path.join(legacyDataDir, "legacy.txt"), path.join(hermesDir, "legacy.txt"));
    fs.mkdirSync(path.join(hermesDir, "profiles"), { recursive: true });
    fs.symlinkSync(
      path.join(legacyDataDir, "sessions"),
      path.join(hermesDir, "profiles", "legacy-sessions"),
    );
  } else if (legacyData === "directory-symlink") {
    fs.mkdirSync(legacyTarget, { recursive: true });
    fs.writeFileSync(path.join(legacyTarget, "sentinel"), "keep\n");
    fs.symlinkSync(legacyTarget, legacyDataDir, "dir");
  } else if (legacyData === "entry-symlink") {
    fs.mkdirSync(legacyDataDir, { recursive: true });
    fs.writeFileSync(legacyTarget, "keep\n");
    fs.symlinkSync(legacyTarget, path.join(legacyDataDir, "linked-entry"));
  }

  if (openclaw === "directory") {
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
  } else if (openclaw === "symlink") {
    fs.mkdirSync(openclawTarget, { recursive: true });
    fs.writeFileSync(path.join(openclawTarget, "sentinel"), "keep\n");
    fs.symlinkSync(openclawTarget, openclawDir, "dir");
  }

  const layoutCommand = dockerRunCommandBetween(
    dockerfile,
    "# Flatten stale published base images",
    "# Pin config hash at build time",
  ).replaceAll("/root/.cache/pip", path.join(tmp, "root-cache", "pip"));
  const { result } = runDockerShell(
    `BASE_IMAGE=${JSON.stringify(baseImage)}; ${layoutCommand}`,
    sandboxRoot,
  );
  return { hermesDir, legacyTarget, openclawTarget, result, sandboxRoot, tmp };
}

describe("Hermes final image layout", () => {
  it("rejects mutable official base references", () => {
    const run = runFinalLayout({
      baseImage: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest",
    });
    try {
      expect(run.result.status).toBe(1);
      expect(run.result.stderr).toContain("must use an immutable sha256 digest");
    } finally {
      fs.rmSync(run.tmp, { recursive: true, force: true });
    }
  });

  it.each([
    "directory",
    "symlink",
  ] as const)("rejects retired OpenClaw state represented as a %s", (openclaw) => {
    const run = runFinalLayout({ openclaw });
    try {
      expect(run.result.status).toBe(1);
      expect(run.result.stderr).toContain("contains retired OpenClaw state");
      if (openclaw === "symlink") {
        expect(readText(path.join(run.openclawTarget, "sentinel"))).toBe("keep\n");
      }
    } finally {
      fs.rmSync(run.tmp, { recursive: true, force: true });
    }
  });

  it("migrates legacy data into the current state directory", () => {
    const run = runFinalLayout({ legacyData: "content" });
    try {
      expect(run.result.status).toBe(0);
      expect(fs.existsSync(path.join(run.sandboxRoot, ".hermes-data"))).toBe(false);
      expect(fs.lstatSync(path.join(run.hermesDir, "sessions")).isDirectory()).toBe(true);
      expect(readText(path.join(run.hermesDir, "sessions", "legacy.json"))).toBe("{}\n");
      expect(fs.lstatSync(path.join(run.hermesDir, "legacy.txt")).isSymbolicLink()).toBe(false);
      expect(readText(path.join(run.hermesDir, "legacy.txt"))).toBe("legacy\n");
      const nested = path.join(run.hermesDir, "profiles", "legacy-sessions");
      expect(fs.lstatSync(nested).isDirectory()).toBe(true);
      expect(readText(path.join(nested, "legacy.json"))).toBe("{}\n");
    } finally {
      fs.rmSync(run.tmp, { recursive: true, force: true });
    }
  });

  it.each([
    "directory-symlink",
    "entry-symlink",
  ] as const)("refuses a legacy data %s before migration", (legacyData) => {
    const run = runFinalLayout({ legacyData });
    try {
      expect(run.result.status).toBe(1);
      expect(run.result.stderr).toContain("refusing legacy layout cleanup");
      const sentinel =
        legacyData === "directory-symlink"
          ? path.join(run.legacyTarget, "sentinel")
          : run.legacyTarget;
      expect(readText(sentinel)).toBe("keep\n");
    } finally {
      fs.rmSync(run.tmp, { recursive: true, force: true });
    }
  });
});
