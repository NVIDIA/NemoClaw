// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dockerRunCommandBetween, runDockerShell } from "./helpers/hermes-dockerfile-run";

const ROOT = path.resolve(import.meta.dirname, "..");
const HERMES_DOCKERFILE = path.join(ROOT, "agents", "hermes", "Dockerfile");

describe("Hermes doctor and config hash boundary", () => {
  it("locks trusted gateway recovery preloads as image-owned read-only files", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-preload-lock-"));
    const binDir = path.join(tmp, "usr-local-bin");
    const libDir = path.join(tmp, "usr-local-lib-nemoclaw");
    const preloadsDir = path.join(libDir, "preloads");
    const nestedDir = path.join(preloadsDir, "nested");
    const profileDir = path.join(tmp, "etc-profile.d");
    const bashrcPath = path.join(tmp, "bash.bashrc");
    const chownLogPath = path.join(tmp, "chown.log");
    const mode = (entry: string) => (fs.statSync(entry).mode & 0o777).toString(8);

    try {
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(nestedDir, { recursive: true, mode: 0o777 });
      fs.mkdirSync(profileDir, { recursive: true });
      for (const relativePath of [
        path.join(binDir, "nemoclaw-start"),
        path.join(binDir, "nemoclaw-gateway-control"),
        path.join(libDir, "sandbox-init.sh"),
        path.join(libDir, "gateway-supervisor.sh"),
        path.join(libDir, "validate-hermes-env-secret-boundary.py"),
        path.join(libDir, "seed-hermes-dashboard-config.py"),
        path.join(libDir, "hermes-runtime-config-guard.py"),
        path.join(libDir, "state-dir-guard.py"),
        path.join(libDir, "managed-gateway-control.py"),
        path.join(libDir, "sandbox-rlimits.sh"),
        path.join(preloadsDir, "gateway-safety-net.js"),
        path.join(nestedDir, "ciao-preload.js"),
        bashrcPath,
      ]) {
        fs.mkdirSync(path.dirname(relativePath), { recursive: true });
        fs.writeFileSync(relativePath, "test\n", { mode: 0o666 });
      }

      const lockCommand = dockerRunCommandBetween(
        dockerfile,
        "# Dockerfile.base is the source of truth for rlimit hooks.",
        "# Flatten stale published base images",
      )
        .replaceAll("/usr/local/bin", binDir)
        .replaceAll("/usr/local/lib/nemoclaw", libDir)
        .replaceAll("/etc/profile.d", profileDir)
        .replaceAll("/etc/bash.bashrc", bashrcPath);
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `chown_log=${JSON.stringify(chownLogPath)}`,
        'chown() { printf "%s\\n" "$*" >> "$chown_log"; }',
        lockCommand,
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(fs.readFileSync(chownLogPath, "utf-8")).toBe(
        [
          `root:root ${path.join(binDir, "nemoclaw-gateway-control")} ${path.join(libDir, "gateway-supervisor.sh")} ${path.join(libDir, "state-dir-guard.py")} ${path.join(libDir, "managed-gateway-control.py")}`,
          `-R 0:0 ${preloadsDir}`,
          "",
        ].join("\n"),
      );
      expect(mode(path.join(binDir, "nemoclaw-gateway-control"))).toBe("700");
      expect(mode(path.join(libDir, "gateway-supervisor.sh"))).toBe("444");
      expect(mode(path.join(libDir, "state-dir-guard.py"))).toBe("500");
      expect(mode(path.join(libDir, "managed-gateway-control.py"))).toBe("500");
      expect(mode(preloadsDir)).toBe("755");
      expect(mode(nestedDir)).toBe("755");
      expect(mode(path.join(preloadsDir, "gateway-safety-net.js"))).toBe("444");
      expect(mode(path.join(nestedDir, "ciao-preload.js"))).toBe("444");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps upstream doctor changes out of generated config hash inputs", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-doctor-lock-"));
    const sandboxRoot = path.join(tmp, "sandbox");
    const hermesDir = path.join(sandboxRoot, ".hermes");
    const configPath = path.join(hermesDir, "config.yaml");
    const envPath = path.join(hermesDir, ".env");
    const fakeHermes = path.join(tmp, "hermes");
    const orderLogPath = path.join(tmp, "doctor-generate-order.log");
    const etcDir = path.join(tmp, "etc", "nemoclaw");
    const mode = (entry: string) => (fs.statSync(entry).mode & 0o777).toString(8);
    const fakeGenerateCommand = [
      `printf 'generate\\n' >>${JSON.stringify(orderLogPath)}`,
      `printf 'model: trusted\\ncustom_providers: []\\n' >${JSON.stringify(configPath)}`,
      `printf 'API_SERVER_HOST=127.0.0.1\\nAPI_SERVER_PORT=18642\\n' >${JSON.stringify(envPath)}`,
      `chmod 600 ${JSON.stringify(configPath)} ${JSON.stringify(envPath)}`,
    ].join("; ");
    fs.mkdirSync(hermesDir, { recursive: true });
    fs.writeFileSync(configPath, "model: test\n", { mode: 0o600 });
    fs.writeFileSync(envPath, "TOKEN=test\n", { mode: 0o600 });
    fs.writeFileSync(
      fakeHermes,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `test "\${HERMES_HOME:-}" = ${JSON.stringify(hermesDir)}`,
        'test "${1:-} ${2:-}" = "doctor --fix"',
        `printf 'doctor\\n' >>${JSON.stringify(orderLogPath)}`,
        `printf 'doctor_migrated: true\\n' >>${JSON.stringify(configPath)}; printf 'DOCTOR_MIGRATED=1\\n' >>${JSON.stringify(envPath)}; chmod 666 ${JSON.stringify(configPath)} ${JSON.stringify(envPath)}`,
      ].join("\n"),
      { mode: 0o700 },
    );

    const doctorAndGenerateCommand = dockerRunCommandBetween(
      dockerfile,
      "# Run Hermes' upstream repair",
      "# Install NemoClaw plugin into Hermes",
    )
      .replaceAll("/sandbox", sandboxRoot)
      .replaceAll("/usr/local/bin/hermes", fakeHermes)
      .replaceAll(
        "node --experimental-strip-types /opt/nemoclaw-hermes-config/generate-config.ts",
        fakeGenerateCommand,
      );
    const lockCommand = dockerRunCommandBetween(
      dockerfile,
      "# Flatten stale published base images",
      "# Pin config hash at build time",
    ).replaceAll("/root/.cache/pip", path.join(tmp, "root-cache", "pip"));
    const hashCommand = dockerRunCommandBetween(
      dockerfile,
      "# Pin config hash at build time",
      "# Backward-compatible marker",
    ).replaceAll("/etc/nemoclaw", etcDir);
    const compatHashCommand = dockerRunCommandBetween(
      dockerfile,
      "# Backward-compatible marker",
      "# OpenShell's macOS VM backend",
    );

    try {
      const doctorAndGenerate = spawnSync("bash", ["-c", doctorAndGenerateCommand], {
        encoding: "utf-8",
        cwd: tmp,
        timeout: 5000,
      });
      expect(doctorAndGenerate.status).toBe(0);
      expect(fs.readFileSync(orderLogPath, "utf-8")).toBe("doctor\ngenerate\n");
      expect([mode(configPath), mode(envPath)]).toEqual(["600", "600"]);
      expect(fs.readFileSync(configPath, "utf-8")).not.toContain("doctor_migrated");
      expect(fs.readFileSync(envPath, "utf-8")).not.toContain("DOCTOR_MIGRATED");

      const lock = runDockerShell(lockCommand, sandboxRoot);
      expect(lock.result.status).toBe(0);
      expect(lock.result.stderr).toBe("");
      expect([mode(configPath), mode(envPath)]).toEqual(["640", "640"]);

      const hash = runDockerShell(hashCommand, sandboxRoot);
      expect(hash.result.status).toBe(0);
      expect(hash.result.stderr).toBe("");
      expect(mode(path.join(etcDir, "hermes.config-hash"))).toBe("444");
      const verifyHash = spawnSync("sha256sum", ["-c", path.join(etcDir, "hermes.config-hash")], {
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(verifyHash.status).toBe(0);

      const compatHash = runDockerShell(compatHashCommand, sandboxRoot);
      expect(compatHash.result.status).toBe(0);
      expect(compatHash.result.stderr).toBe("");
      expect(mode(path.join(hermesDir, ".config-hash"))).toBe("640");
      const verifyCompatHash = spawnSync(
        "sha256sum",
        ["-c", path.join(hermesDir, ".config-hash")],
        { encoding: "utf-8", timeout: 5000 },
      );
      expect(verifyCompatHash.status).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
