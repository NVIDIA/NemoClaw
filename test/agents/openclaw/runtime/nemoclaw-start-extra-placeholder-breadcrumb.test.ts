// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  placeholderPlan,
  runRefresh,
} from "./nemoclaw-start-extra-placeholder-breadcrumb-helpers.ts";

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

describe("extra-placeholder canonicalization + accepted-extras breadcrumb (X4a/X4b/X5)", () => {
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
