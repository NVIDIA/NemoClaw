// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { help } from "../../src/lib/actions/root-help.js";
import { normalizeArgv } from "../../src/lib/cli/argv-normalizer.js";
import { globalCommandTokens } from "../../src/lib/cli/command-registry.js";
import { withDirectPublicDispatch } from "../support/public-dispatch-test-harness.js";

import {
  CLI,
  execTimeout,
  run,
  runWithEnv,
  testTimeoutOptions,
  writeSandboxRegistry,
} from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("help shows registered command sections", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    help();

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Getting Started");
    expect(output).toContain("Sandbox Management");
    expect(output).toContain("Policy Presets");
    expect(output).toContain("Compatibility Commands");
    expect(output).toContain("nemoclaw upgrade-sandboxes");
    expect(output).toContain("(--check, --auto, --yes|-y)");
    expect(output).toContain("nemoclaw update");
    expect(output).toContain("(--check, --fresh, --yes|-y)");
    expect(output).toContain("nemoclaw gc");
    expect(output).toContain("(--yes|-y|--force, --dry-run)");
    expect(output).toContain("nemoclaw onboard");
    expect(output).toContain(
      "Configure inference endpoint and credentials (--agent to choose runtime)",
    );
    expect(output).toContain("nemoclaw agents list");
    expect(output).toContain("List available agent runtimes for onboard --agent");
    expect(output).toContain("nemoclaw onboard --from");
    expect(output).toContain("Use a custom Dockerfile for the sandbox image");
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

  it("exits 0 for --help", async () => {
    const dockerHost = process.env.DOCKER_HOST;

    await withDirectPublicDispatch(
      async ({ dispatchCli, exitSpy, runOclifArgv, runOclifCommandById }) => {
        await dispatchCli(["--help"]);

        expect(runOclifCommandById).toHaveBeenCalledWith(
          "root:help",
          [],
          expect.objectContaining({ rootDir: process.cwd() }),
        );
        expect(runOclifArgv).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
      },
    );

    expect(process.env.DOCKER_HOST).toBe(dockerHost);
  });

  it("version exits 0", async () => {
    await withDirectPublicDispatch(
      async ({ dispatchCli, exitSpy, runOclifArgv, runOclifCommandById }) => {
        await dispatchCli(["version"]);

        expect(runOclifCommandById).toHaveBeenCalledWith(
          "root:version",
          [],
          expect.objectContaining({ rootDir: process.cwd() }),
        );
        expect(runOclifArgv).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
      },
    );
  });

  it("normalizes -h as a root-help alias", () => {
    expect(
      normalizeArgv(["-h"], {
        globalCommands: globalCommandTokens(),
        isSandboxConnectFlag: () => false,
      }),
    ).toEqual({ kind: "rootHelp" });
  });

  it("no args exits 0 (shows help)", () => {
    const result = run("");

    expect(result.code).toBe(0);
    expect(result.out).toContain("nemoclaw");
  });

  it("bare unknown name surfaces sandbox-not-found (#2164)", async () => {
    await withDirectPublicDispatch(
      async ({ dispatchCli, exitSpy, recoverRegistryEntries, stderr }) => {
        await expect(dispatchCli(["boguscmd"])).rejects.toThrow("process.exit:1");

        expect(recoverRegistryEntries).toHaveBeenCalledWith({
          requestedSandboxName: "boguscmd",
        });
        expect(stderr.join("\n")).toContain("Sandbox 'boguscmd' does not exist");
        expect(exitSpy).toHaveBeenCalledWith(1);
      },
    );
  });

  it("unknown command with non-sandbox action exits 1", async () => {
    await withDirectPublicDispatch(async ({ dispatchCli, exitSpy, stderr }) => {
      await expect(dispatchCli(["boguscmd", "boguscmd2"])).rejects.toThrow("process.exit:1");

      expect(stderr.join("\n")).toContain("Unknown command: boguscmd");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  it("routes a missing-sandbox inference action through name validation, not Unknown action (#5977)", async () => {
    // `inference` is a known sandbox action token, so a missing sandbox name
    // must surface the sandbox-not-found path — never the NemoClaw-owned
    // `Unknown action: inference` reporter that originally broke the workflow.
    await withDirectPublicDispatch(
      async ({ dispatchCli, exitSpy, recoverRegistryEntries, stderr }) => {
        await expect(dispatchCli(["missing-sb", "inference", "get"])).rejects.toThrow(
          "process.exit:1",
        );

        const output = stderr.join("\n");
        expect(recoverRegistryEntries).toHaveBeenCalledWith({
          requestedSandboxName: "missing-sb",
        });
        expect(output).toContain("Sandbox 'missing-sb' does not exist");
        expect(output).not.toContain("Unknown action: inference");
        expect(exitSpy).toHaveBeenCalledWith(1);
      },
    );
  });

  it("lists inference among Valid actions when reporting an unknown sandbox action (#5977)", async () => {
    // The reporter-facing action list is derived from registered sandbox
    // commands; the new sandbox-scoped inference route must appear there so
    // users discover it instead of hitting the old dead end.
    await withDirectPublicDispatch(
      async ({ dispatchCli, exitSpy, recoverRegistryEntries, stderr }) => {
        await expect(dispatchCli(["alpha", "bogus-action-5977"])).rejects.toThrow("process.exit:1");

        const output = stderr.join("\n");
        expect(output).toContain("Unknown action: bogus-action-5977");
        expect(output).toMatch(/Valid actions:.*\binference\b/);
        expect(recoverRegistryEntries).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
      },
      { sandboxNames: ["alpha"] },
    );
  });

  it("points OpenShell-only commands at openshell instead of sandbox connect (#3388)", async () => {
    await withDirectPublicDispatch(async ({ dispatchCli, exitSpy, resetObservedCalls, stderr }) => {
      const cases = [
        {
          argv: ["term"],
          entered: "term",
          command: "Run: openshell term",
          notes: [],
        },
        {
          argv: ["policy", "set"],
          entered: "policy set",
          command: "Run: openshell policy set --policy <policy-file> --wait <sandbox-name>",
          notes: ["nemoclaw <sandbox-name> policy-add <preset>"],
        },
        {
          argv: ["gateway", "stop"],
          entered: "gateway stop",
          command: "Run: openshell gateway stop -g nemoclaw",
          notes: [],
        },
      ];

      for (const testCase of cases) {
        resetObservedCalls();

        await expect(dispatchCli(testCase.argv)).rejects.toThrow("process.exit:1");

        const output = stderr.join("\n");
        expect(output).toContain(`Unknown nemoclaw command: ${testCase.entered}`);
        expect(output).toContain(testCase.command);
        for (const note of testCase.notes) expect(output).toContain(note);
        expect(output).not.toContain("Try: nemoclaw <sandbox-name> connect");
        expect(exitSpy).toHaveBeenCalledWith(1);
      }
    });
  });

  it("suggests list for a mistyped list command", async () => {
    await withDirectPublicDispatch(
      async ({ dispatchCli, exitSpy, recoverRegistryEntries, stderr }) => {
        await expect(dispatchCli(["liost"])).rejects.toThrow("process.exit:1");

        const output = stderr.join("\n");
        expect(recoverRegistryEntries).toHaveBeenCalledWith({ requestedSandboxName: "liost" });
        expect(output).toContain("Unknown command: liost");
        expect(output).toContain("Did you mean: nemoclaw list?");
        expect(exitSpy).toHaveBeenCalledWith(1);
      },
    );
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

  it("explains sandbox connect command order when the sandbox name is last", async () => {
    await withDirectPublicDispatch(
      async ({ dispatchCli, exitSpy, recoverRegistryEntries, stderr }) => {
        await expect(dispatchCli(["hermes", "connect", "alpha"])).rejects.toThrow("process.exit:1");

        const output = stderr.join("\n");
        expect(recoverRegistryEntries).toHaveBeenCalledWith({ requestedSandboxName: "hermes" });
        expect(output).toContain("Sandbox 'hermes' does not exist");
        expect(output).toContain("Command order is: nemoclaw <sandbox-name> connect");
        expect(output).toContain("Did you mean: nemoclaw alpha connect?");
        expect(exitSpy).toHaveBeenCalledWith(1);
      },
      { sandboxNames: ["alpha"] },
    );
  });

  it("suggests the closest registered sandbox name for a mistyped sandbox action", async () => {
    await withDirectPublicDispatch(
      async ({ dispatchCli, exitSpy, stderr }) => {
        await expect(dispatchCli(["my-assitant", "status"])).rejects.toThrow("process.exit:1");

        const output = stderr.join("\n");
        expect(output).toContain("Sandbox 'my-assitant' does not exist");
        expect(output).toContain("Did you mean: nemoclaw my-assistant status?");
        expect(output).toContain("Registered sandboxes: my-assistant");
        expect(exitSpy).toHaveBeenCalledWith(1);
      },
      { sandboxNames: ["my-assistant"] },
    );
  });

  it("suggests the closest registered sandbox name when a bare typo lacks a known action", async () => {
    await withDirectPublicDispatch(
      async ({ dispatchCli, exitSpy, stderr }) => {
        await expect(dispatchCli(["my-assitant", "unknownaction"])).rejects.toThrow(
          "process.exit:1",
        );

        const output = stderr.join("\n");
        expect(output).toContain("Unknown command: my-assitant");
        expect(output).toContain("Did you mean: nemoclaw my-assistant connect?");
        expect(output).toContain("Registered sandboxes: my-assistant");
        expect(exitSpy).toHaveBeenCalledWith(1);
      },
      { sandboxNames: ["my-assistant"] },
    );
  });

  it("omits the did-you-mean hint when no registered sandbox is within edit-distance threshold", async () => {
    await withDirectPublicDispatch(
      async ({ dispatchCli, exitSpy, stderr }) => {
        await expect(dispatchCli(["zulu-quebec", "status"])).rejects.toThrow("process.exit:1");

        const output = stderr.join("\n");
        expect(output).toContain("Sandbox 'zulu-quebec' does not exist");
        expect(output).not.toContain("Did you mean: nemoclaw alpha");
        expect(output).toContain("Registered sandboxes: alpha");
        expect(exitSpy).toHaveBeenCalledWith(1);
      },
      { sandboxNames: ["alpha"] },
    );
  });
});
