// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CLI,
  execTimeout,
  run,
  runWithEnv,
  testTimeoutOptions,
  writeSandboxRegistry,
} from "./helpers";

describe("CLI dispatch", () => {
  it("config get validates flags and values before dispatch", async () => {
    const sandboxConfigModule = await import("../../src/lib/sandbox/config.js");
    const { parseConfigGetArgs } = sandboxConfigModule as {
      parseConfigGetArgs: (
        args: string[],
      ) =>
        | { ok: true; opts: { key: string | null; format: string } }
        | { ok: false; errors: string[] };
    };

    const missingKey = parseConfigGetArgs(["--key"]);
    expect(missingKey.ok).toBe(false);
    expect(missingKey).toEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining("--key requires a value")]),
      }),
    );

    const missingFormat = parseConfigGetArgs(["--format"]);
    expect(missingFormat.ok).toBe(false);
    expect(missingFormat).toEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining("--format requires a value")]),
      }),
    );

    const badFormat = parseConfigGetArgs(["--format", "xml"]);
    expect(badFormat.ok).toBe(false);
    expect(badFormat).toEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining("Unknown format: xml")]),
      }),
    );

    const unknownFlag = parseConfigGetArgs(["--bogus"]);
    expect(unknownFlag.ok).toBe(false);
    expect(unknownFlag).toEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining("Unknown flag: --bogus")]),
      }),
    );

    expect(parseConfigGetArgs(["--key", "gateway.auth", "--format", "yaml"])).toEqual({
      ok: true,
      opts: { key: "gateway.auth", format: "yaml" },
    });
  });

  it(
    "start does not prompt for NVIDIA_INFERENCE_API_KEY before launching local services",
    testTimeoutOptions(35_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-start-no-key-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const markerFile = path.join(home, "start-args");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "bash"),
        [
          "#!/bin/sh",
          `marker_file=${JSON.stringify(markerFile)}`,
          'printf \'%s\\n\' "$@" > "$marker_file"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "start",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
          NVIDIA_INFERENCE_API_KEY: "",
          TELEGRAM_BOT_TOKEN: "",
        },
        30000,
      );

      expect(r.code).toBe(0);
      expect(r.out).not.toContain("NVIDIA API Key required");
      // Services module now runs in-process (no bash shelling)
      expect(r.out).toContain("NemoClaw Services");
    },
  );

  it("help exits 0 and shows sections", () => {
    const r = run("help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Getting Started")).toBeTruthy();
    expect(r.out.includes("Sandbox Management")).toBeTruthy();
    expect(r.out.includes("Policy Presets")).toBeTruthy();
    expect(r.out.includes("Compatibility Commands")).toBeTruthy();
    expect(r.out).toContain("nemoclaw upgrade-sandboxes");
    expect(r.out).toContain("(--check, --auto, --yes|-y)");
    expect(r.out).toContain("nemoclaw update");
    expect(r.out).toContain("(--check, --fresh, --yes|-y)");
    expect(r.out).toContain("nemoclaw gc");
    expect(r.out).toContain("(--yes|-y|--force, --dry-run)");
    expect(r.out).toContain("nemoclaw onboard");
    expect(r.out).toContain(
      "Configure inference endpoint and credentials (--agent to choose runtime)",
    );
    expect(r.out).toContain("nemoclaw agents list");
    expect(r.out).toContain("List available agent runtimes for onboard --agent");
    expect(r.out).toContain("nemoclaw onboard --from");
    expect(r.out).toContain("Use a custom Dockerfile for the sandbox image");
  });

  it("onboard help lists installed agent runtime names in the --agent description", () => {
    const r = run("onboard --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "Agent runtime to onboard (openclaw, hermes, langchain-deepagents-code;",
    );
    expect(r.out).toContain("aliases: nemohermes → hermes;");
    expect(r.out).toContain("nemo-deepagents/dcode/deepagents/deepagents-code/langchain →");
    expect(r.out).toContain("langchain-deepagents-code)");
  });

  it("agents parent shows command help instead of sandbox lookup", () => {
    const r = run("agents");
    expect(r.code).toBe(0);
    expect(r.out).toContain("nemoclaw agents list");
    expect(r.out).not.toContain("Sandbox 'agents' does not exist");
  });

  it("agents list exits 0 and lists global agent runtimes", () => {
    const r = run("agents list");
    expect(r.code).toBe(0);
    expect(r.out).toContain("openclaw");
    expect(r.out).toContain("hermes");
    expect(r.out).toContain("langchain-deepagents-code");
  });

  it("exits 0 for --help", () => {
    expect(run("--help").code).toBe(0);
  });

  it("version exits 0", () => {
    const r = run("version");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^nemoclaw v/);
  });

  it("exits 0 for -h", () => {
    expect(run("-h").code).toBe(0);
  });

  it("no args exits 0 (shows help)", () => {
    const r = run("");
    expect(r.code).toBe(0);
    expect(r.out.includes("nemoclaw")).toBeTruthy();
  });

  it("bare unknown name surfaces sandbox-not-found (#2164)", testTimeoutOptions(35_000), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-unknown-sandbox-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(path.join(localBin, "openshell"), "#!/usr/bin/env bash\nexit 1\n", {
      mode: 0o755,
    });

    const r = runWithEnv(
      "boguscmd",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      execTimeout(30_000),
    );
    expect(r.code).toBe(1);
    expect(r.out.includes("Sandbox 'boguscmd' does not exist")).toBeTruthy();
  });

  it("unknown command with non-sandbox action exits 1", () => {
    const r = run("boguscmd boguscmd2");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown command")).toBeTruthy();
  });

  it("routes a missing-sandbox inference action through name validation, not Unknown action (#5977)", () => {
    // `inference` is a known sandbox action token, so a missing sandbox name
    // must surface the sandbox-not-found path — never the NemoClaw-owned
    // `Unknown action: inference` reporter that originally broke the workflow.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-inference-missing-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      ["#!/usr/bin/env bash", "exit 1"].join("\n"),
      { mode: 0o755 },
    );

    try {
      const r = runWithEnv(
        "missing-sb inference get",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
          NEMOCLAW_HEALTH_POLL_COUNT: "0",
        },
        execTimeout(30_000),
      );
      expect(r.code).toBe(1);
      expect(r.out).toContain("Sandbox 'missing-sb' does not exist");
      expect(r.out).not.toContain("Unknown action: inference");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("lists inference among Valid actions when reporting an unknown sandbox action (#5977)", () => {
    // The reporter-facing action list is derived from registered sandbox
    // commands; the new sandbox-scoped inference route must appear there so
    // users discover it instead of hitting the old dead end.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-inference-valid-actions-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      ["#!/usr/bin/env bash", "exit 1"].join("\n"),
      { mode: 0o755 },
    );
    writeSandboxRegistry(home, "alpha");

    try {
      const r = runWithEnv(
        "alpha bogus-action-5977",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
          NEMOCLAW_HEALTH_POLL_COUNT: "0",
        },
        execTimeout(30_000),
      );
      expect(r.code).toBe(1);
      expect(r.out).toContain("Unknown action: bogus-action-5977");
      expect(r.out).toMatch(/Valid actions:.*\binference\b/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("points OpenShell-only commands at openshell instead of sandbox connect (#3388)", () => {
    const term = run("term");
    expect(term.code).toBe(1);
    expect(term.out).toContain("Unknown nemoclaw command: term");
    expect(term.out).toContain("Run: openshell term");
    expect(term.out).not.toContain("Try: nemoclaw <sandbox-name> connect");

    const policy = run("policy set");
    expect(policy.code).toBe(1);
    expect(policy.out).toContain("Unknown nemoclaw command: policy set");
    expect(policy.out).toContain(
      "Run: openshell policy set --policy <policy-file> --wait <sandbox-name>",
    );
    expect(policy.out).toContain("nemoclaw <sandbox-name> policy-add <preset>");
    expect(policy.out).not.toContain("Try: nemoclaw <sandbox-name> connect");

    const gateway = run("gateway stop");
    expect(gateway.code).toBe(1);
    expect(gateway.out).toContain("Unknown nemoclaw command: gateway stop");
    expect(gateway.out).toContain("Run: openshell gateway stop -g nemoclaw");
    expect(gateway.out).not.toContain("Try: nemoclaw <sandbox-name> connect");
  });

  it("suggests list for a mistyped list command", () => {
    // Isolate from any real openshell gateway on the host so recovery
    // doesn't intercept the typo suggestion.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-typo-suggest-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      ["#!/usr/bin/env bash", "exit 1"].join("\n"),
      { mode: 0o755 },
    );

    try {
      const r = runWithEnv("liost", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
        NEMOCLAW_HEALTH_POLL_COUNT: "0",
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain("Unknown command: liost");
      expect(r.out).toContain("Did you mean: nemoclaw list?");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("recovers a live sandbox before suggesting a bare command typo", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-recover-typo-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$HOME/openshell-calls.log"',
        'case "$*" in',
        '  "status") printf "Status: Connected\\nGateway: nemoclaw\\n"; exit 0 ;;',
        '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
        '  "sandbox list") echo "liost Ready"; exit 0 ;;',
        '  "sandbox get liost") printf "Name: liost\\nPhase: Ready\\nPolicy:\\n"; exit 0 ;;',
        '  "policy get --full liost") exit 1 ;;',
        '  "inference get") exit 1 ;;',
        '  "sandbox connect liost") echo "CONNECTED_LIOST"; exit 0 ;;',
        "  *) exit 0 ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("liost", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NEMOCLAW_CONNECT_TIMEOUT: "1",
      NEMOCLAW_NO_CONNECT_HINT: "1",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("CONNECTED_LIOST");
    expect(r.out).not.toContain("Unknown command: liost");
  });

  it("fails fast on gated NEMOCLAW_VLLM_MODEL without HF token before sandbox side effects", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-vllm-preflight-"));
    try {
      const localBin = path.join(home, "bin");
      fs.mkdirSync(localBin, { recursive: true });
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          `printf "%s\\n" "$*" >> ${JSON.stringify(openshellLog)}`,
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const childEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) childEnv[key] = value;
      }
      delete childEnv.HF_TOKEN;
      delete childEnv.HUGGING_FACE_HUB_TOKEN;
      childEnv.HOME = home;
      childEnv.PATH = `${localBin}:${process.env.PATH || ""}`;
      childEnv.NEMOCLAW_HEALTH_POLL_COUNT = "1";
      childEnv.NEMOCLAW_HEALTH_POLL_INTERVAL = "0";
      childEnv.NEMOCLAW_VLLM_MODEL = "deepseek-r1-distill-70b";

      let code = 0;
      let out = "";
      try {
        execSync(`node "${CLI}" alpha connect 2>&1`, {
          encoding: "utf-8",
          stdio: "pipe",
          timeout: execTimeout(),
          env: childEnv,
        });
      } catch (err) {
        const e = err as {
          status?: number;
          stdout?: string | Buffer;
          stderr?: string | Buffer;
        };
        code = typeof e.status === "number" ? e.status : 1;
        out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }

      expect(code).toBe(1);
      expect(out).toMatch(/gated on Hugging Face/);
      expect(out).toMatch(/HF_TOKEN/);
      expect(out).toMatch(/HUGGING_FACE_HUB_TOKEN/);
      expect(out).toContain("NEMOCLAW_VLLM_MODEL is consumed by the managed-vLLM install path");
      const calls = fs.existsSync(openshellLog) ? fs.readFileSync(openshellLog, "utf8") : "";
      expect(calls).not.toMatch(/\bsandbox\s+(get|connect|list)\b/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("explains sandbox connect command order when the sandbox name is last", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-order-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      ["#!/usr/bin/env bash", "exit 1"].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("hermes connect alpha", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("Sandbox 'hermes' does not exist");
    expect(r.out).toContain("Command order is: nemoclaw <sandbox-name> connect");
    expect(r.out).toContain("Did you mean: nemoclaw alpha connect?");
  });

  it("suggests the closest registered sandbox name for a mistyped sandbox action", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-typo-action-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "my-assistant");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      ["#!/usr/bin/env bash", "exit 1"].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("my-assitant status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("Sandbox 'my-assitant' does not exist");
    expect(r.out).toContain("Did you mean: nemoclaw my-assistant status?");
    expect(r.out).toContain("Registered sandboxes: my-assistant");
  });

  it("suggests the closest registered sandbox name when a bare typo lacks a known action", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-typo-bare-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "my-assistant");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      ["#!/usr/bin/env bash", "exit 1"].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("my-assitant unknownaction", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("Unknown command: my-assitant");
    expect(r.out).toContain("Did you mean: nemoclaw my-assistant connect?");
    expect(r.out).toContain("Registered sandboxes: my-assistant");
  });

  it("omits the did-you-mean hint when no registered sandbox is within edit-distance threshold", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-typo-miss-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      ["#!/usr/bin/env bash", "exit 1"].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("zulu-quebec status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("Sandbox 'zulu-quebec' does not exist");
    expect(r.out).not.toContain("Did you mean: nemoclaw alpha");
    expect(r.out).toContain("Registered sandboxes: alpha");
  });
});
