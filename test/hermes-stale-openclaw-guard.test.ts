// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dockerRunCommandContaining,
  hermesStaleOpenclawBaseDigest,
  runDockerShell,
} from "./helpers/hermes-dockerfile-run";

const ROOT = path.resolve(import.meta.dirname, "..");
const HERMES_DOCKERFILE = path.join(ROOT, "agents", "hermes", "Dockerfile");
const VERIFY_SCRIPT = path.join(ROOT, "scripts", "verify-hermes-stale-openclaw-image.sh");
const STALE_DIGEST = hermesStaleOpenclawBaseDigest();
const DIFFERENT_DIGEST = `sha256:${"0".repeat(64)}`;
const STALE_CLEANUP_SIGNATURE = 'stale_base_digest="${NEMOCLAW_STALE_OPENCLAW_BASE_DIGEST:?}"';

describe("Hermes stale OpenClaw guardrails", () => {
  it("Hermes stale cleanup digest guard fails when the default pinned GHCR base digest changes", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const cleanupCommand = dockerRunCommandContaining(dockerfile, STALE_CLEANUP_SIGNATURE);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-stale-digest-"));
    const sandboxRoot = path.join(tmp, "sandbox");
    fs.mkdirSync(sandboxRoot, { recursive: true });

    try {
      const { result } = runDockerShell(
        [
          `BASE_IMAGE=${JSON.stringify(`ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${DIFFERENT_DIGEST}`)}`,
          `NEMOCLAW_STALE_OPENCLAW_BASE_DIGEST=${JSON.stringify(STALE_DIGEST)}`,
          cleanupCommand,
        ].join("; "),
        sandboxRoot,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("remove stale Hermes .openclaw cleanup or update");
      expect(result.stderr).toContain(DIFFERENT_DIGEST);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("Hermes stale cleanup rejects unsupported non-GHCR base images", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const cleanupCommand = dockerRunCommandContaining(dockerfile, STALE_CLEANUP_SIGNATURE);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-stale-unsupported-base-"));
    const sandboxRoot = path.join(tmp, "sandbox");
    fs.mkdirSync(sandboxRoot, { recursive: true });

    try {
      const { result } = runDockerShell(
        `BASE_IMAGE=localhost:5000/evil/hermes-base:latest; ${cleanupCommand}`,
        sandboxRoot,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "unsupported Hermes BASE_IMAGE while stale .openclaw cleanup is present",
      );
      expect(result.stderr).toContain("localhost:5000/evil/hermes-base:latest");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("Hermes stale cleanup succeeds for a non-symlink stale OpenClaw directory", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-stale-success-"));
    const cleanupCommand = dockerRunCommandContaining(
      dockerfile,
      STALE_CLEANUP_SIGNATURE,
    ).replaceAll("/root/.cache/pip", path.join(tmp, "root-cache", "pip"));
    const sandboxRoot = path.join(tmp, "sandbox");
    const hermesDir = path.join(sandboxRoot, ".hermes");
    const legacyDataDir = path.join(sandboxRoot, ".hermes-data");
    const openclawDir = path.join(sandboxRoot, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.mkdirSync(hermesDir, { recursive: true });
    fs.mkdirSync(path.join(legacyDataDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
    fs.writeFileSync(path.join(legacyDataDir, "sessions", "legacy.json"), "{}\n");
    fs.writeFileSync(path.join(legacyDataDir, "legacy.txt"), "legacy\n");
    fs.writeFileSync(path.join(hermesDir, "config.yaml"), "model: test\n", { mode: 0o600 });
    fs.writeFileSync(path.join(hermesDir, ".env"), "TOKEN=test\n", { mode: 0o600 });
    fs.symlinkSync(path.join(legacyDataDir, "sessions"), path.join(hermesDir, "sessions"));
    fs.symlinkSync(path.join(legacyDataDir, "legacy.txt"), path.join(hermesDir, "legacy.txt"));

    try {
      const { result } = runDockerShell(cleanupCommand, sandboxRoot);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(fs.existsSync(openclawDir)).toBe(false);
      expect(fs.existsSync(legacyDataDir)).toBe(false);
      expect(fs.lstatSync(path.join(hermesDir, "sessions")).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(hermesDir, "sessions", "legacy.json"), "utf-8")).toBe(
        "{}\n",
      );
      expect(fs.lstatSync(path.join(hermesDir, "legacy.txt")).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(hermesDir, "legacy.txt"), "utf-8")).toBe("legacy\n");
      expect(fs.lstatSync(path.join(hermesDir, "gateway_state.json")).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(path.join(hermesDir, "gateway_state.json"))).toBe(
        "runtime/gateway_state.json",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("Hermes stale OpenClaw verifier allows local verifier base refs without docker", () => {
    const allowedRefs = [
      "nemoclaw-hermes-base-local",
      "nemoclaw-hermes-stale-openclaw-dir-base:test",
      "nemoclaw-hermes-stale-openclaw-link-base:test",
    ];

    for (const ref of allowedRefs) {
      const result = spawnSync("bash", [VERIFY_SCRIPT, "--validate-ref-only", ref], {
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(result.status, `${ref}\n${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Hermes base image ref is allowed");
    }
  });

  it("Hermes stale OpenClaw verifier rejects unsafe base image refs before docker build", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-ref-guard-"));
    const fakeBin = path.join(tmp, "bin");
    const dockerLog = path.join(tmp, "docker-called.log");
    const unsafeRefs = [
      "",
      "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base @sha256:bad",
      'ghcr.io/nvidia/nemoclaw/hermes-sandbox-base"bad',
      "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base`id`",
      "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base;bad",
      "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base\\bad",
      "localhost:5000/evil",
      "malicious:tag",
      "ghcr.io/evil/image@sha256:deadbeef",
      "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:invalid",
      "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest",
    ];
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      '#!/usr/bin/env bash\nprintf \'docker %s\\n\' "$*" >> "$NEMOCLAW_FAKE_DOCKER_LOG"\nexit 99\n',
      { mode: 0o700 },
    );

    try {
      for (const [index, ref] of unsafeRefs.entries()) {
        fs.rmSync(dockerLog, { force: true });
        // Prepend a fake docker binary so this validation-only test fails if docker is reached.
        const result = spawnSync("bash", [VERIFY_SCRIPT], {
          encoding: "utf-8",
          env: {
            ...process.env,
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
            HERMES_BASE_IMAGE: "",
            NEMOCLAW_FAKE_DOCKER_LOG: dockerLog,
            NEMOCLAW_HERMES_BASE_IMAGE: ref,
            NEMOCLAW_HERMES_STALE_OPENCLAW_IMAGE_LOG: path.join(tmp, `script-${index}.log`),
          },
          timeout: 5000,
        });
        expect(result.status, ref).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`, ref).toMatch(
          /Hermes base image ref|set NEMOCLAW_HERMES_BASE_IMAGE/,
        );
        expect(fs.existsSync(dockerLog), ref).toBe(false);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
