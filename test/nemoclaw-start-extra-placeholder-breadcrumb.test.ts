// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// The extra-placeholder canonicalization + accepted-keys breadcrumb contract is
// asserted end-to-end only in the live messaging-providers E2E (cases X4a/X4b
// on the canonical resolve placeholders and X5 on the accepted-extras
// breadcrumb). That lane runs on an ephemeral Brev instance and never gates PR
// CI, so this mocked shell-unit pins the same three properties against the real
// `refresh_openclaw_provider_placeholders` body extracted from
// scripts/nemoclaw-start.sh:
//   X4a/X4b — each accepted extra key becomes a canonical
//     openshell:resolve:env:<KEY> placeholder, and distinct extra keys resolve
//     to distinct placeholders.
//   X5     — the startup breadcrumb "[config] NEMOCLAW_EXTRA_PLACEHOLDER_KEYS
//     accepted N entry(ies): …" lists only the accepted keys and omits any
//     refused key (e.g. GITHUB_TOKEN).
// The host-side TS mirror (src/lib/onboard/extra-placeholder-keys.ts) is unit-
// tested separately; the openshell:resolve:env:<KEY> literal and the
// accepted-keys summary string live solely in the shell function, so they need
// a shell-unit here. (#4251)

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

describe("extra-placeholder canonicalization + accepted-extras breadcrumb (X4a/X4b/X5)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  // Heredoc-aware extractor. The reconcile harness's naive /^}/m regex stops at
  // the first column-0 "}", which for refresh_openclaw_provider_placeholders is
  // the closing brace of a Python dict comprehension inside a <<'PY…' heredoc,
  // not the function's real close. Skip heredoc bodies so we capture the whole
  // function.
  function extractShellFunction(name: string): string {
    const lines = src.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
    if (start < 0) throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
    let heredocTerminator: string | null = null;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (heredocTerminator !== null) {
        if (line === heredocTerminator) heredocTerminator = null;
        continue;
      }
      const opener = line.match(/<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?/);
      if (opener) {
        heredocTerminator = opener[1];
        continue;
      }
      if (line === "}") return lines.slice(start, i + 1).join("\n");
    }
    throw new Error(`Expected a top-level close for ${name} in scripts/nemoclaw-start.sh`);
  }

  interface RunResult {
    result: SpawnSyncReturns<string>;
    config: any;
  }

  function runRefresh(config: unknown, env: Record<string, string> = {}): RunResult {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-extra-placeholder-"));
    const openclawDir = path.join(root, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    const configPath = path.join(openclawDir, "openclaw.json");
    const hashPath = path.join(openclawDir, ".config-hash");
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    fs.writeFileSync(hashPath, "oldhash\n");

    const fn = extractShellFunction("refresh_openclaw_provider_placeholders").replaceAll(
      "/sandbox/.openclaw",
      openclawDir,
    );
    // Stub the config-mutability guards and the dir-owner probe so the helper
    // runs on a mutable temp dir without touching real sandbox ownership. This
    // isolates the extras-validation + placeholder-rewrite path under test.
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -eu",
      "openclaw_config_dir_owner() { echo sandbox; }",
      "prepare_openclaw_config_for_write() { :; }",
      "restore_openclaw_config_after_write() { :; }",
      fn,
      "refresh_openclaw_provider_placeholders",
    ].join("\n");
    const script = path.join(root, "run.sh");
    fs.writeFileSync(script, wrapper, { mode: 0o700 });
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH || "", ...env },
      timeout: 5000,
    });
    const updated = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    fs.rmSync(root, { recursive: true, force: true });
    return { result, config: updated };
  }

  // Mirror the messaging-runtime plan the entrypoint forwards so the in-
  // container parser discovers TELEGRAM_BOT_TOKEN as a canonical provider
  // envKey; per-profile TELEGRAM_BOT_TOKEN_AGENT_* names then read as valid
  // extensions rather than colliding with a canonical base key.
  function placeholderPlan(envKeys: string[]): string {
    return Buffer.from(
      JSON.stringify({
        credentialBindings: envKeys.map((envKey) => ({ providerEnvKey: envKey })),
      }),
    ).toString("base64");
  }

  it("resolves distinct accepted extra keys to distinct canonical openshell:resolve:env placeholders (X4a/X4b)", () => {
    // openclaw.json carries the baked canonical placeholders for two per-profile
    // extension keys; the runtime env stages a canonical (non-revision)
    // OpenShell resolve placeholder for each. Both must be accepted and each
    // profile must end up carrying its own canonical openshell:resolve:env:<KEY>
    // placeholder — the X4a/X4b assertions.
    const canonicalA = "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_A";
    const canonicalB = "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_B";
    const run = runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              a: { botToken: canonicalA },
              b: { botToken: canonicalB },
            },
          },
        },
      },
      {
        NEMOCLAW_MESSAGING_PLAN_B64: placeholderPlan(["TELEGRAM_BOT_TOKEN"]),
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: "TELEGRAM_BOT_TOKEN_AGENT_A TELEGRAM_BOT_TOKEN_AGENT_B",
        TELEGRAM_BOT_TOKEN_AGENT_A: canonicalA,
        TELEGRAM_BOT_TOKEN_AGENT_B: canonicalB,
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    const tokenA = run.config.channels.telegram.accounts.a.botToken;
    const tokenB = run.config.channels.telegram.accounts.b.botToken;
    // X4a / X4b: each accepted extra key is a canonical OpenShell resolve
    // placeholder for exactly its own env key.
    expect(tokenA).toBe(canonicalA);
    expect(tokenB).toBe(canonicalB);
    expect(tokenA.startsWith("openshell:resolve:env:")).toBe(true);
    expect(tokenB.startsWith("openshell:resolve:env:")).toBe(true);
    // X4b: distinct extension keys must resolve to distinct placeholders — the
    // grammar-aware exact-token rewrite must never collapse AGENT_B onto
    // AGENT_A's placeholder.
    expect(tokenA).not.toBe(tokenB);
  });

  it("names accepted extra keys in the breadcrumb and omits a co-submitted refused GITHUB_TOKEN (X5)", () => {
    // The operator submits one accepted per-profile extension plus a refused
    // arbitrary host secret (GITHUB_TOKEN) in the same control env. The X5
    // breadcrumb must list the accepted key and MUST NOT name the refused key,
    // proving a refused host secret cannot ride the accepted-extras summary into
    // the sandbox provider gateway.
    const run = runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              a: { botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_A" },
            },
          },
        },
      },
      {
        NEMOCLAW_MESSAGING_PLAN_B64: placeholderPlan(["TELEGRAM_BOT_TOKEN"]),
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: "GITHUB_TOKEN TELEGRAM_BOT_TOKEN_AGENT_A",
        GITHUB_TOKEN: "ghp-host-secret-would-leak",
        TELEGRAM_BOT_TOKEN_AGENT_A: "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_A",
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    const breadcrumb = run.result.stderr
      .split("\n")
      .find((line) => line.includes("NEMOCLAW_EXTRA_PLACEHOLDER_KEYS accepted"));
    expect(breadcrumb, run.result.stderr).toBeDefined();
    // X5: exactly one accepted entry, named, and the refused key absent from the
    // accepted summary line.
    expect(breadcrumb).toMatch(
      /^\[config\] NEMOCLAW_EXTRA_PLACEHOLDER_KEYS accepted 1 entry\(ies\): TELEGRAM_BOT_TOKEN_AGENT_A$/,
    );
    expect(breadcrumb).not.toContain("GITHUB_TOKEN");
    // The refused key is reported only on its own ignore line, never as an
    // accepted entry, and its staged value never leaks into any output.
    expect(run.result.stderr).toContain(
      "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry 'GITHUB_TOKEN' — must extend a discovered provider envKey such as TELEGRAM_BOT_TOKEN_<suffix>",
    );
    expect(run.result.stderr).not.toContain("ghp-host-secret-would-leak");
    expect(JSON.stringify(run.config)).not.toContain("ghp-host-secret-would-leak");
  });
});
