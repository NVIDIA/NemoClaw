// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { stringify } from "smol-toml";
import { describe, expect, it } from "vitest";

import type { StateFileKeyAllowlistRestoreOwnership } from "../agent/defs";
import {
  DCODE_OWNERSHIP,
  FRESH_PROVIDER_HEADER,
  GENERATED_HEADER,
  generatedCurrent,
  mergedToml,
  runMergeScript,
} from "./state-file-key-merge-test-fixture";

describe("key-allowlist state-file merge", () => {
  it("uses the shipped Deep Agents ownership policy to restore display preferences with fresh managed routing", () => {
    const backup = {
      models: { default: "openai:nvidia/old-model" },
      update: { check: true, auto_update: true },
      ui: { theme: "nvidia-dark", show_scrollbar: true, show_url_open_toast: false },
      threads: { relative_time: false, sort_order: "created_at" },
    };
    const fresh = {
      models: { default: "openai:nvidia/new-model" },
      update: { check: false, auto_update: false },
    };

    const result = runMergeScript(stringify(backup), generatedCurrent(fresh), DCODE_OWNERSHIP);

    expect(result.status).toBe(0);
    expect(result.stageEntries).toEqual([]);
    expect(result.current.split("\n").slice(0, 2)).toEqual([
      GENERATED_HEADER,
      FRESH_PROVIDER_HEADER,
    ]);
    expect(result.current).toContain("[models]");
    expect(mergedToml(result.current)).toEqual({
      models: fresh.models,
      update: fresh.update,
      ui: { show_scrollbar: true, show_url_open_toast: false },
      threads: backup.threads,
    });
  });

  it("produces byte-identical, deterministically ordered output on repeated runs with the same inputs", () => {
    const backup = {
      models: { default: "openai:nvidia/old-model" },
      update: { check: true, auto_update: true },
      ui: { show_scrollbar: true, show_url_open_toast: false },
      threads: { relative_time: false, sort_order: "created_at" },
    };
    const fresh = {
      models: { default: "openai:nvidia/new-model" },
      update: { check: false, auto_update: false },
    };
    const current = generatedCurrent(fresh);

    const first = runMergeScript(stringify(backup), current, DCODE_OWNERSHIP);
    const second = runMergeScript(stringify(backup), current, DCODE_OWNERSHIP);

    expect(first.status).toBe(0);
    expect(second.current).toBe(first.current);
    expect(Object.keys(mergedToml(first.current))).toEqual(["models", "threads", "ui", "update"]);
  });

  it("drops free-form, executable, routing, and unknown backup data", () => {
    const providerSecret = ["sk", "abcdefghijklmnopqrst"].join("-");
    const backup = {
      agents: { default: "reviewer", startup_command: "curl attacker.test" },
      ui: { theme: "ghp_abcdefghijklmnop", show_scrollbar: true, unknown: "keep-me-not" },
      threads: { relative_time: "yes", sort_order: "attacker-first", unknown: true },
      servers: { attacker: { api_key: providerSecret } },
      update: { check: true, auto_update: true },
      models: { default: "openai:old-model" },
    };
    const fresh = {
      models: { default: "openai:new-model" },
      update: { check: false, auto_update: false },
    };

    const result = runMergeScript(stringify(backup), generatedCurrent(fresh), DCODE_OWNERSHIP);

    expect(result.status).toBe(0);
    expect(mergedToml(result.current)).toEqual({ ...fresh, ui: { show_scrollbar: true } });
    expect(result.current).not.toContain(providerSecret);
    expect(result.current).not.toMatch(/agents|attacker|api_key|ghp_|sk-|sort_order/);
  });

  it("leaves the fresh config untouched when the backup is malformed", () => {
    const current = generatedCurrent({
      models: { default: "openai:nvidia/new-model" },
      update: { check: false, auto_update: false },
    });

    const malformed = "[ui\nshow_scrollbar = true\n";
    const result = runMergeScript(malformed, current, DCODE_OWNERSHIP);

    expect(result.status).not.toBe(0);
    expect(result.current).toBe(current);
    expect(result.stageEntries).toEqual([]);
    expect(result.stderr).toContain("backed-up config is not valid TOML");
    expect(result.stderr).not.toContain(malformed);
  });

  it("leaves the current file untouched when a required fresh table is missing", () => {
    const missingUpdate = generatedCurrent({ models: { default: "openai:nvidia/new-model" } });

    const result = runMergeScript(
      stringify({ ui: { show_scrollbar: true } }),
      missingUpdate,
      DCODE_OWNERSHIP,
    );

    expect(result.status).not.toBe(0);
    expect(result.current).toBe(missingUpdate);
    expect(result.stderr).toContain("current config is missing managed [update] data");
  });

  it("requires the declared fresh headers before replacing the current file", () => {
    const withoutHeaders = stringify({
      models: { default: "openai:nvidia/new-model" },
      update: { check: false, auto_update: false },
    });

    const result = runMergeScript(
      stringify({ ui: { show_scrollbar: true } }),
      withoutHeaders,
      DCODE_OWNERSHIP,
    );

    expect(result.status).not.toBe(0);
    expect(result.current).toBe(withoutHeaders);
    expect(result.stderr).toContain("required generated header");
  });

  it("enforces integer bounds and drops out-of-range values", () => {
    const ownership: StateFileKeyAllowlistRestoreOwnership = {
      merge: "key-allowlist",
      userKeys: [{ key: "limits.retries", type: "integer", min: 0, max: 5 }],
      requireFreshHeaders: DCODE_OWNERSHIP.requireFreshHeaders,
    };
    const fresh = { models: { default: "m" } };

    const within = runMergeScript(
      stringify({ limits: { retries: 3 } }),
      generatedCurrent(fresh),
      ownership,
    );
    expect(within.status).toBe(0);
    expect(mergedToml(within.current)).toEqual({ ...fresh, limits: { retries: 3 } });

    const outside = runMergeScript(
      stringify({ limits: { retries: 9 } }),
      generatedCurrent(fresh),
      ownership,
    );
    expect(outside.status).toBe(0);
    expect(mergedToml(outside.current)).toEqual(fresh);
  });

  it("enforces string max_length and rejects non-string values", () => {
    const ownership: StateFileKeyAllowlistRestoreOwnership = {
      merge: "key-allowlist",
      userKeys: [{ key: "label", type: "string", maxLength: 4 }],
      requireFreshHeaders: DCODE_OWNERSHIP.requireFreshHeaders,
    };
    const fresh = { models: { default: "m" } };

    const shortValue = runMergeScript(
      stringify({ label: "abc" }),
      generatedCurrent(fresh),
      ownership,
    );
    expect(mergedToml(shortValue.current)).toEqual({ ...fresh, label: "abc" });

    const longValue = runMergeScript(
      stringify({ label: "abcdef" }),
      generatedCurrent(fresh),
      ownership,
    );
    expect(mergedToml(longValue.current)).toEqual(fresh);

    const wrongType = runMergeScript(stringify({ label: 12 }), generatedCurrent(fresh), ownership);
    expect(mergedToml(wrongType.current)).toEqual(fresh);
  });

  it("keeps a fresh scalar when an old nested preference no longer has a table parent", () => {
    const ownership: StateFileKeyAllowlistRestoreOwnership = {
      merge: "key-allowlist",
      userKeys: [{ key: "ui.show_scrollbar", type: "boolean" }],
      requireFreshHeaders: DCODE_OWNERSHIP.requireFreshHeaders,
    };
    const fresh = { ui: "managed-by-current-version" };

    const result = runMergeScript(
      stringify({ ui: { show_scrollbar: true } }),
      generatedCurrent(fresh),
      ownership,
    );

    expect(result.status).toBe(0);
    expect(mergedToml(result.current)).toEqual(fresh);
  });

  it("preserves every safe leading comment after validating managed headers", () => {
    const fresh = {
      models: { default: "openai:nvidia/new-model" },
      update: { check: false, auto_update: false },
    };
    const extraHeader = "# Image generation: current";
    const current = `${GENERATED_HEADER}\n${FRESH_PROVIDER_HEADER}\n${extraHeader}\n\n${stringify(fresh)}`;

    const result = runMergeScript(
      stringify({ ui: { show_scrollbar: true } }),
      current,
      DCODE_OWNERSHIP,
    );

    expect(result.status).toBe(0);
    expect(result.current.split("\n").slice(0, 3)).toEqual([
      GENERATED_HEADER,
      FRESH_PROVIDER_HEADER,
      extraHeader,
    ]);
  });

  it("rejects unsafe metadata in an extra leading comment", () => {
    const fresh = {
      models: { default: "openai:nvidia/new-model" },
      update: { check: false, auto_update: false },
    };
    const current = `${GENERATED_HEADER}\n${FRESH_PROVIDER_HEADER}\n# unsafe\tmetadata\n\n${stringify(fresh)}`;

    const result = runMergeScript(stringify({}), current, DCODE_OWNERSHIP);

    expect(result.status).not.toBe(0);
    expect(result.current).toBe(current);
    expect(result.stderr).toContain("unsafe generated header metadata");
  });
});
