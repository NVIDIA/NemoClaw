// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { restorationScript } from "../live/openclaw-restoration.ts";

const LIVE_ROOT = path.join(import.meta.dirname, "..", "live");

function liveSource(name: string): string {
  return fs.readFileSync(path.join(LIVE_ROOT, name), "utf8");
}

describe("native lifecycle E2E migration contracts", () => {
  it("runs scheduled inference through native OpenClaw cron", () => {
    const source = liveSource("cron-preflight-inference-local.test.ts");

    expect(source).toMatch(/"openclaw",\s*"cron",\s*"add"/u);
    expect(source).toContain('["openclaw", "cron", "run", cronId]');
    expect(source).toContain('["openclaw", "cron", "remove", cronId]');
    expect(source).not.toContain("preflightCronModelProvider");
  });

  it.each([
    [
      "rebuild-openclaw.test.ts",
      /const DASHBOARD_PORT = 18_792[\s\S]*\$\{String\(DASHBOARD_PORT\)\}\/health/u,
      "/sandbox/.openclaw/workspace",
    ],
    ["rebuild-hermes.test.ts", /127\.0\.0\.1:8642\/health/u, "/sandbox/.hermes/memories"],
  ])("reduces %s to state restoration and native readiness", (file, readiness, statePath) => {
    const source = liveSource(file);

    expect(source).toContain('"rebuild", "--yes", "--verbose"');
    expect(source).toContain(statePath);
    expect(source).toMatch(readiness);
    expect(source).toContain("sandbox.cleanupSandbox");
    expect(source).not.toMatch(/Dockerfile\.base|repair controller|respawn|quarantine/iu);
  });
});

const RESTORED_MARKERS = [
  ".openclaw/workspace/.rebuild-state-marker",
  ".rebuild-unknown-marker",
  ".openclaw/hooks/.rebuild-hook-marker",
  ".openclaw/cron/.rebuild-cron-marker",
  ".local/share/e2e-package/.rebuild-package-marker",
];
const LOADED_PLUGIN = JSON.stringify({ plugin: { id: "e2e-rebuild-plugin", status: "loaded" } });

describe("OpenClaw rebuild restoration verification", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "rebuild restoration'-"));
    for (const marker of RESTORED_MARKERS) {
      const filename = path.join(directory, marker);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, "expected-marker\n");
    }
    fs.writeFileSync(
      path.join(directory, "openclaw"),
      `#!/bin/sh
if [ "$#" -eq 4 ] && [ "$*" = "config get agents.defaults.timeoutSeconds --json" ]; then
  printf '119\\n'
  exit "$CONFIG_EXIT"
fi
if [ "$#" -eq 5 ] && [ "$*" = "plugins inspect e2e-rebuild-plugin --runtime --json" ]; then
  printf '%s\\n' "$PLUGIN_JSON"
  exit "$PLUGIN_EXIT"
fi
exit 2
`,
      { mode: 0o700 },
    );
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function restorationCommand(): string {
    return restorationScript({
      home: directory,
      openclaw: path.join(directory, "openclaw"),
      node: process.execPath,
    });
  }

  function runRestoration(overrides: Record<string, string> = {}, script = restorationCommand()) {
    const result = spawnSync("/bin/sh", ["-lc", script], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: directory,
        CONFIG_EXIT: "0",
        PLUGIN_EXIT: "0",
        PLUGIN_JSON: LOADED_PLUGIN,
        ...overrides,
      },
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, stdout: result.stdout };
  }

  it("accepts restored state and a loaded plugin", () => {
    expect(runRestoration()).toEqual({ status: 0, stdout: "expected-marker\n119\n" });
  });

  it.each([
    [
      "wrong plugin ID",
      "plugins inspect e2e-rebuild-plugin --runtime --json",
      "plugins inspect other --runtime --json",
    ],
    [
      "missing runtime inspection",
      "plugins inspect e2e-rebuild-plugin --runtime --json",
      "plugins inspect e2e-rebuild-plugin --json",
    ],
    [
      "extra plugin argument",
      "plugins inspect e2e-rebuild-plugin --runtime --json",
      "plugins inspect e2e-rebuild-plugin --runtime --json extra",
    ],
    [
      "wrong config key",
      "config get agents.defaults.timeoutSeconds --json",
      "config get other --json",
    ],
    [
      "missing config JSON flag",
      "config get agents.defaults.timeoutSeconds --json",
      "config get agents.defaults.timeoutSeconds",
    ],
  ])("rejects %s in the restoration command", (_name, command, replacement) => {
    const script = restorationCommand().replace(command, replacement);
    expect(runRestoration({}, script)).toEqual({ status: 2, stdout: "" });
  });

  it.each(RESTORED_MARKERS)("rejects a missing %s", (marker) => {
    fs.rmSync(path.join(directory, marker));
    expect(runRestoration()).toEqual({ status: 1, stdout: "" });
  });

  describe("empty restored markers", () => {
    beforeEach(() => {
      for (const marker of RESTORED_MARKERS) {
        fs.writeFileSync(path.join(directory, marker), "");
      }
    });

    it("accepts matching empty markers", () => {
      expect(runRestoration()).toEqual({ status: 0, stdout: "\n119\n" });
    });

    it("rejects an unreadable target even when the expected marker is empty", () => {
      fs.rmSync(path.join(directory, RESTORED_MARKERS[1]));
      expect(runRestoration()).toEqual({ status: 1, stdout: "" });
    });
  });

  it.each(RESTORED_MARKERS.slice(1))("rejects a mismatched %s", (marker) => {
    fs.writeFileSync(path.join(directory, marker), "wrong");
    expect(runRestoration()).toEqual({ status: 1, stdout: "" });
  });

  it.each(["CONFIG_EXIT", "PLUGIN_EXIT"])("preserves a command failure from %s", (command) => {
    expect(runRestoration({ [command]: "42" })).toEqual({ status: 42, stdout: "" });
  });

  it.each([
    ["error status", JSON.stringify({ plugin: { id: "e2e-rebuild-plugin", status: "error" } })],
    [
      "disabled status",
      JSON.stringify({ plugin: { id: "e2e-rebuild-plugin", status: "disabled" } }),
    ],
    ["wrong ID", JSON.stringify({ plugin: { id: "other", status: "loaded" } })],
    ["missing report", "{}"],
    ["malformed JSON", "{"],
  ])("rejects plugin %s despite command success", (_name, pluginJson) => {
    expect(runRestoration({ PLUGIN_JSON: pluginJson })).toEqual({ status: 1, stdout: "" });
  });
});
