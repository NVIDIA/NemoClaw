// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "../../..", "scripts", "nemoclaw-start.sh");

describe("nemoclaw-start sealed restart", () => {
  it("preserves the sealed gateway token during non-root startup with Shields up (#8112)", () => {
    const script = [
      "set -euo pipefail",
      `eval "$(sed -n '/^needs_gateway_token_for_current_command() {$/,/^}$/p' "$1")"`,
      `eval "$(sed -n '/^prepare_gateway_token_for_current_command() {$/,/^}$/p' "$1")"`,
      "id() { echo 998; }",
      "openclaw_config_dir_owner() { echo root; }",
      "_read_gateway_token() { echo sealed-token; }",
      'ensure_gateway_token() { echo "SHOULD_NOT_ROTATE"; exit 75; }',
      'ensure_gateway_token_if_missing() { echo "SHOULD_NOT_ENSURE"; exit 76; }',
      "NEMOCLAW_CMD=()",
      "prepare_gateway_token_for_current_command",
    ].join("\n");

    const result = spawnSync("bash", ["-s", "--", START_SCRIPT], {
      input: script,
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("SHOULD_NOT");
    expect(result.stderr).toContain(
      "Shields are up; preserving the sealed gateway token for startup",
    );
    expect(result.stderr).not.toContain("sealed-token");
  });

  it("refuses non-root startup when the sealed config has no gateway token (#8112)", () => {
    const script = [
      "set -euo pipefail",
      `eval "$(sed -n '/^needs_gateway_token_for_current_command() {$/,/^}$/p' "$1")"`,
      `eval "$(sed -n '/^prepare_gateway_token_for_current_command() {$/,/^}$/p' "$1")"`,
      "id() { echo 998; }",
      "openclaw_config_dir_owner() { echo root; }",
      "_read_gateway_token() { :; }",
      'ensure_gateway_token() { echo "SHOULD_NOT_ROTATE"; exit 75; }',
      'ensure_gateway_token_if_missing() { echo "SHOULD_NOT_ENSURE"; exit 76; }',
      "NEMOCLAW_CMD=()",
      "prepare_gateway_token_for_current_command",
    ].join("\n");

    const result = spawnSync("bash", ["-s", "--", START_SCRIPT], {
      input: script,
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("SHOULD_NOT");
    expect(result.stderr).toContain(
      "Shields are up but the sealed OpenClaw config has no gateway token",
    );
  });

  it("preserves an unreadable sealed auth profile during non-root startup (#8112)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sealed-auth-test-"));
    const authPath = path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
    const before = JSON.stringify({
      "openai:manual": {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", id: "NVIDIA_INFERENCE_API_KEY" },
        profileId: "openai:manual",
      },
    });
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, before, { mode: 0o600 });
    const authFd = fs.openSync(authPath, "r");
    const authInode = fs.fstatSync(authFd).ino;
    fs.fchmodSync(authFd, 0o000);
    const script = [
      "set -euo pipefail",
      `eval "$(sed -n '/^write_auth_profile() {$/,/^}$/p' "$1")"`,
      "id() { echo 998; }",
      "openclaw_config_dir_owner() { echo root; }",
      "write_auth_profile",
    ].join("\n");

    try {
      const result = spawnSync("bash", ["-s", "--", START_SCRIPT], {
        input: script,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          NVIDIA_INFERENCE_API_KEY: "secret",
          NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
        },
        encoding: "utf-8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("preserving the sealed OpenClaw auth profile");
      expect(fs.fstatSync(authFd).mode & 0o777).toBe(0o000);
      expect(fs.lstatSync(authPath).ino).toBe(authInode);
      expect(fs.readFileSync(authFd, "utf-8")).toBe(before);
    } finally {
      fs.closeSync(authFd);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses a missing sealed auth profile during non-root startup (#8112)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-missing-sealed-auth-test-"));
    const script = [
      "set -euo pipefail",
      `eval "$(sed -n '/^write_auth_profile() {$/,/^}$/p' "$1")"`,
      "id() { echo 998; }",
      "openclaw_config_dir_owner() { echo root; }",
      "write_auth_profile",
    ].join("\n");

    try {
      const result = spawnSync("bash", ["-s", "--", START_SCRIPT], {
        input: script,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          NVIDIA_INFERENCE_API_KEY: "secret",
          NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
        },
        encoding: "utf-8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("sealed OpenClaw auth profile is unavailable");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
