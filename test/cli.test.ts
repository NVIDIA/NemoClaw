// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CLI,
  HERMES_CLI,
  createCloudflaredServiceDir,
  createDoctorTestSetup,
  execTimeout,
  isCliErrorCandidate,
  readBufferOrStringProperty,
  readCliErrorOutput,
  run,
  runWithEnv,
  testTimeoutOptions,
  writeSandboxRegistry,
} from "./cli/helpers";

describe("CLI dispatch", () => {
  it("config get validates flags and values before dispatch", async () => {
    const sandboxConfigModule = await import("../dist/lib/sandbox/config.js");
    const { parseConfigGetArgs } = (sandboxConfigModule.default ?? sandboxConfigModule) as {
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
    expect(r.out).toContain("(--check, --yes|-y)");
    expect(r.out).toContain("nemoclaw gc");
    expect(r.out).toContain("(--yes|-y|--force, --dry-run)");
    expect(r.out).toContain("nemoclaw onboard");
    expect(r.out).toContain("Configure inference endpoint and credentials");
    expect(r.out).toContain("nemoclaw onboard --from");
    expect(r.out).toContain("Use a custom Dockerfile for the sandbox image");
  });

  it("--help exits 0", () => {
    expect(run("--help").code).toBe(0);
  });

  it("version exits 0", () => {
    const r = run("version");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^nemoclaw v/);
  });

  it("-h exits 0", () => {
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

  it("points OpenShell-only commands at openshell instead of sandbox connect (#3388)", () => {
    const term = run("term");
    expect(term.code).toBe(1);
    expect(term.out).toContain("Unknown nemoclaw command: term");
    expect(term.out).toContain("Run: openshell term");
    expect(term.out).not.toContain("Try: nemoclaw <sandbox-name> connect");

    const policy = run("policy set");
    expect(policy.code).toBe(1);
    expect(policy.out).toContain("Unknown nemoclaw command: policy set");
    expect(policy.out).toContain("Run: openshell policy set --policy <policy-file> <sandbox-name>");
    expect(policy.out).toContain("nemoclaw <sandbox-name> policy-add <preset>");
    expect(policy.out).not.toContain("Try: nemoclaw <sandbox-name> connect");

    const gateway = run("gateway stop");
    expect(gateway.code).toBe(1);
    expect(gateway.out).toContain("Unknown nemoclaw command: gateway stop");
    expect(gateway.out).toContain("Run: openshell gateway stop -g nemoclaw");
    expect(gateway.out).not.toContain("Try: nemoclaw <sandbox-name> connect");
  });

  it("redirects `inference set` to openshell when provider or model is missing", () => {
    for (const argv of [
      "inference set 2>&1",
      "inference set --provider nvidia-prod 2>&1",
      "inference set --model nvidia/model 2>&1",
    ]) {
      const r = run(argv);
      expect(r.code, `nemoclaw ${argv}`).toBe(1);
      expect(r.out, `nemoclaw ${argv}`).toContain("Unknown nemoclaw command: inference set");
      expect(r.out, `nemoclaw ${argv}`).toContain("This operation belongs to OpenShell.");
      expect(r.out, `nemoclaw ${argv}`).toContain(
        "Run: openshell inference set -g nemoclaw --model <model> --provider <provider>",
      );
      expect(r.out, `nemoclaw ${argv}`).not.toContain("Missing required flag");
      expect(r.out, `nemoclaw ${argv}`).not.toContain("FailedFlagValidationError");
      expect(r.out, `nemoclaw ${argv}`).not.toContain("node_modules/@oclif/core");
    }

    let hermesOut = "";
    let hermesCode = 0;
    try {
      hermesOut = execSync(`node "${HERMES_CLI}" inference set 2>&1`, {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: execTimeout(),
        env: {
          ...process.env,
          HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-test-")),
        },
      });
    } catch (err) {
      const result = readCliErrorOutput(
        isCliErrorCandidate(err)
          ? {
              status: typeof err.status === "number" ? err.status : undefined,
              stdout: readBufferOrStringProperty(err, "stdout"),
              stderr: readBufferOrStringProperty(err, "stderr"),
            }
          : String(err),
      );
      hermesOut = result.out;
      hermesCode = result.code;
    }
    expect(hermesCode).toBe(1);
    expect(hermesOut).toContain("Unknown nemohermes command: inference set");
    expect(hermesOut).toContain("This operation belongs to OpenShell.");
    expect(hermesOut).toContain(
      "Run: openshell inference set -g nemoclaw --model <model> --provider <provider>",
    );
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
      expect(out).toContain(
        "NEMOCLAW_VLLM_MODEL is consumed by the managed-vLLM install path",
      );
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

  it("list exits 0", () => {
    const r = run("list");
    expect(r.code).toBe(0);
    // With empty HOME, should say no sandboxes
    expect(r.out.includes("No sandboxes")).toBeTruthy();
  });

  it("list --help exits 0 and shows list usage", () => {
    const r = run("list --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("list [--json]");
    expect(r.out).toContain("List all sandboxes");
  });

  it("nemohermes list --help uses alias branding", () => {
    const out = execSync(`node "${HERMES_CLI}" list --help`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: execTimeout(),
      env: {
        ...process.env,
        HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-test-")),
      },
    });
    expect(out).toContain("$ nemohermes list [--json]");
    expect(out).not.toContain("$ nemoclaw list [--json]");
  });

  it("nemohermes inference set --help uses alias branding and agent-aware wording", () => {
    const out = execSync(`node "${HERMES_CLI}" inference set --help`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: execTimeout(),
      env: {
        ...process.env,
        HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-test-")),
      },
    });
    expect(out).toContain("$ nemohermes inference set --provider <provider> --model <model>");
    expect(out).toContain("[--sandbox <name>] [--no-verify]");
    expect(out).toMatch(/OpenClaw or Hermes\s+sandbox config/);
  });

  it("inference set rejects empty provider values during oclif parsing", () => {
    const result = run("inference set --provider '' --model nvidia/model");
    expect(result.code).toBe(1);
    expect(result.out).toContain("Parsing --provider");
    expect(result.out).toContain("OpenShell inference provider name cannot be empty");
  });

  it("inference get reports the live NemoClaw gateway route", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-inference-get-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
        "  echo 'Gateway inference:'",
        "  echo '  Provider: nvidia-prod'",
        "  echo '  Model: nvidia/nemotron-3-super-120b-a12b'",
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const text = runWithEnv("inference get", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(text.code).toBe(0);
      expect(text.out).toContain("Provider: nvidia-prod");
      expect(text.out).toContain("Model:    nvidia/nemotron-3-super-120b-a12b");

      const json = runWithEnv("inference get --json", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(json.code).toBe(0);
      expect(JSON.parse(json.out)).toEqual({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("list --json emits structured empty inventory", () => {
    const r = run("list --json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      schemaVersion: 1,
      defaultSandbox: null,
      recovery: {
        recoveredFromSession: false,
        recoveredFromGateway: 0,
      },
      lastOnboardedSandbox: null,
      sandboxes: [],
    });
  });

  it("list --json emits structured sandbox details", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-json-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "configured-model",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: ["pypi"],
            agent: "openclaw",
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "ps"),
      ["#!/bin/sh", "echo '123 ssh openshell-alpha'", "exit 0"].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      schemaVersion: 1,
      defaultSandbox: "alpha",
      recovery: {
        recoveredFromSession: false,
        recoveredFromGateway: 0,
      },
      lastOnboardedSandbox: null,
      sandboxes: [
        {
          name: "alpha",
          model: "configured-model",
          provider: "configured-provider",
          gpuEnabled: true,
          policies: ["pypi"],
          agent: "openclaw",
          isDefault: true,
          activeSessionCount: 1,
          connected: true,
          hostGpuDetected: false,
          sandboxGpuEnabled: true,
          sandboxGpuMode: null,
          sandboxGpuDevice: null,
          openshellDriver: null,
          openshellVersion: null,
        },
      ],
    });
  });

  it("list forwards oclif parse errors for unknown options", () => {
    const r = run("list --bogus");
    expect(r.code).toBe(2);
    expect(r.out.includes("Nonexistent flag: --bogus")).toBeTruthy();
    expect(r.out.includes("See more help with --help")).toBeTruthy();
  });

  it("gateway-token help uses native oclif usage", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-token-help-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha gateway-token --help", { HOME: home });

    expect(r.code).toBe(0);
    expect(r.out).toContain("$ nemoclaw sandbox gateway token <name> [--quiet|-q]");
    expect(r.out).toContain("Print the OpenClaw gateway auth token");
  });

  it("doctor fails a present sandbox that is not Ready", () => {
    const setup = createDoctorTestSetup("nemoclaw-cli-doctor-not-ready-", [
      'case "$*" in',
      '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  "sandbox list") printf "NAME STATUS\\nalpha Creating\\n"; exit 0 ;;',
      '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
      "esac",
    ]);

    const r = setup.runDoctor();

    expect(r.code).toBe(1);
    const report = JSON.parse(r.out) as {
      checks: Array<{ label: string; status: string; detail: string }>;
    };
    const liveSandbox = report.checks.find((check) => check.label === "Live sandbox");
    expect(liveSandbox).toEqual(
      expect.objectContaining({
        status: "fail",
        detail: expect.stringContaining("Creating"),
      }),
    );
  });

  it("doctor does not inspect the legacy k3s gateway container in Docker-driver mode", () => {
    const setup = createDoctorTestSetup("nemoclaw-cli-doctor-docker-driver-", [
      'case "$*" in',
      '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  "sandbox list") printf "NAME STATUS\\nalpha Ready\\n"; exit 0 ;;',
      '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
      "esac",
    ]);
    // Docker-driver sandbox: no legacy `openshell-cluster-*` container exists.
    writeSandboxRegistry(setup.home, "alpha", { openshellDriver: "docker" });
    // Record docker argv and make `docker inspect` fail like an absent legacy
    // container would. The doctor must not even attempt the inspect, so this
    // should never produce a failure — and we assert the call was skipped, not
    // merely that its failure was tolerated.
    const dockerCalls = path.join(setup.home, "docker-calls");
    fs.writeFileSync(
      path.join(setup.localBin, "docker"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(dockerCalls)}`,
        'if [ "$1" = "info" ]; then echo "24.0.0"; exit 0; fi',
        'if [ "$1" = "inspect" ]; then echo "Error: No such object: $3" >&2; exit 1; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    // Healthy curl so the unrelated provider-health probe does not fail the
    // report and mask the gateway-only assertions below.
    fs.writeFileSync(
      path.join(setup.localBin, "curl"),
      ["#!/usr/bin/env bash", 'echo "{}"', "exit 0"].join("\n"),
      { mode: 0o755 },
    );

    const r = setup.runDoctor("alpha doctor --json");

    expect(r.out).not.toContain("openshell-cluster");
    const report = JSON.parse(r.out) as {
      status: string;
      checks: Array<{ group: string; label: string; status: string; detail: string }>;
    };
    expect(report.checks.find((check) => check.label === "Docker container")).toBeUndefined();
    // Core contract: the legacy k3s container inspect must be skipped entirely,
    // not attempted-and-ignored.
    const recordedDockerCalls = fs.existsSync(dockerCalls)
      ? fs.readFileSync(dockerCalls, "utf8")
      : "";
    expect(recordedDockerCalls).not.toMatch(/\binspect\b/);
    const openshellStatus = report.checks.find((check) => check.label === "OpenShell status");
    expect(openshellStatus).toEqual(
      expect.objectContaining({ group: "Gateway", status: "ok", detail: "connected to nemoclaw" }),
    );
    // The Docker-driver gateway is healthy, so no Gateway check should fail.
    expect(report.checks.filter((c) => c.group === "Gateway" && c.status === "fail")).toEqual([]);
    expect(report.status).toBe("ok");
    expect(r.code).toBe(0);
  });

  it("doctor still inspects the legacy k3s gateway container for the kubernetes driver", () => {
    const setup = createDoctorTestSetup("nemoclaw-cli-doctor-k8s-driver-", [
      'case "$*" in',
      '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  "sandbox list") printf "NAME STATUS\\nalpha Ready\\n"; exit 0 ;;',
      '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
      "esac",
    ]);
    writeSandboxRegistry(setup.home, "alpha", { openshellDriver: "kubernetes" });

    const r = setup.runDoctor("alpha doctor --json");

    const report = JSON.parse(r.out) as {
      checks: Array<{ group: string; label: string; status: string; detail: string }>;
    };
    const dockerContainer = report.checks.find((check) => check.label === "Docker container");
    expect(dockerContainer).toEqual(
      expect.objectContaining({
        group: "Gateway",
        status: "ok",
        detail: expect.stringContaining("openshell-cluster-nemoclaw"),
      }),
    );
  });

  it(
    "doctor reports fresh shields state as not configured instead of down",
    testTimeoutOptions(30_000),
    () => {
      const setup = createDoctorTestSetup("nemoclaw-cli-doctor-shields-default-", [
        'case "$*" in',
        '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
        '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
        '  "sandbox list") printf "NAME STATUS\\nalpha Ready\\n"; exit 0 ;;',
        '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
        "esac",
      ]);

      const r = setup.runDoctor("alpha doctor --json");

      const report = JSON.parse(r.out) as {
        checks: Array<{ label: string; status: string; detail: string; hint?: string }>;
      };
      const shields = report.checks.find((check) => check.label === "Shields");
      expect(shields).toEqual(
        expect.objectContaining({
          status: "info",
          detail: "not configured (default mutable state)",
        }),
      );
      expect(shields?.detail).not.toBe("down");
    },
  );

  it("doctor does not query sandbox state from a different active gateway", () => {
    const setup = createDoctorTestSetup("nemoclaw-cli-doctor-wrong-gateway-", [
      'case "$*" in',
      '  "status") printf "Server Status\\n\\n  Gateway: other\\n  Status: Connected\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  "gateway select nemoclaw") exit 1 ;;',
      '  "gateway start --name nemoclaw --port 8080") exit 1 ;;',
      '  "sandbox list") echo "queried wrong gateway sandbox list" >> "$marker_file"; exit 0 ;;',
      "esac",
    ]);

    const r = setup.runDoctor("alpha doctor");

    expect(r.code).toBe(1);
    expect(r.out).toContain("OpenShell status");
    expect(r.out).toContain("Gateway: other");
    expect(setup.readCalls().some((call) => /^sandbox list(\s|$)/.test(call))).toBe(false);
  });

  it("doctor treats a live non-cloudflared PID as stale", () => {
    const { sandboxName, serviceDir } = createCloudflaredServiceDir("doctorpid-");
    const setup = createDoctorTestSetup(
      "nemoclaw-cli-doctor-wrong-cloudflared-pid-",
      [
        'case "$*" in',
        '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
        '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
        `  "sandbox list") printf "NAME STATUS\\n${sandboxName} Ready\\n"; exit 0 ;;`,
        '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
        "esac",
      ],
      sandboxName,
    );
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    const sleeperPid = sleeper.pid;
    if (typeof sleeperPid !== "number") {
      throw new Error("expected spawned helper process to have a PID");
    }

    try {
      fs.writeFileSync(path.join(serviceDir, "cloudflared.pid"), String(sleeperPid));
      const r = setup.runDoctor(`${sandboxName} doctor --json`);

      const report = JSON.parse(r.out) as {
        checks: Array<{ label: string; status: string; detail: string }>;
      };
      const cloudflared = report.checks.find((check) => check.label === "cloudflared");
      expect(cloudflared).toEqual(
        expect.objectContaining({
          status: "warn",
          detail: `stale PID ${sleeperPid}`,
        }),
      );
    } finally {
      sleeper.kill();
      fs.rmSync(serviceDir, { recursive: true, force: true });
    }
  });

  it("doctor accepts a live cloudflared PID", testTimeoutOptions(35_000), () => {
    const { sandboxName, serviceDir } = createCloudflaredServiceDir("doctorcloudflared-");
    const setup = createDoctorTestSetup(
      "nemoclaw-cli-doctor-cloudflared-pid-",
      [
        'case "$*" in',
        '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
        '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
        `  "sandbox list") printf "NAME STATUS\\n${sandboxName} Ready\\n"; exit 0 ;;`,
        '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
        "esac",
      ],
      sandboxName,
    );
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloudflared-shim-"));
    const cloudflaredBin = path.join(shimDir, "cloudflared");
    fs.symlinkSync(process.execPath, cloudflaredBin);
    const sleeper = spawn(cloudflaredBin, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    const sleeperPid = sleeper.pid;
    if (typeof sleeperPid !== "number") {
      throw new Error("expected spawned helper process to have a PID");
    }

    try {
      fs.writeFileSync(path.join(serviceDir, "cloudflared.pid"), String(sleeperPid));
      const r = setup.runDoctor(`${sandboxName} doctor --json`);

      const report = JSON.parse(r.out) as {
        checks: Array<{ label: string; status: string; detail: string }>;
      };
      const cloudflared = report.checks.find((check) => check.label === "cloudflared");
      expect(cloudflared).toEqual(
        expect.objectContaining({
          status: "ok",
          detail: `running (PID ${sleeperPid})`,
        }),
      );
    } finally {
      sleeper.kill();
      fs.rmSync(serviceDir, { recursive: true, force: true });
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("preserves the gateway runtime by default when the last sandbox is destroyed (#2166)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-last-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
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
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy -y", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const openshellOutput = fs.readFileSync(openshellLog, "utf8");
    expect(openshellOutput).toContain("sandbox delete alpha");
    expect(openshellOutput).toContain("NAME STATUS");
    // Gateway preservation is now the default. `--yes` confirms only the
    // sandbox; the shared NemoClaw gateway must stay up so the next
    // `nemoclaw onboard` reuses it.
    expect(openshellOutput).not.toContain("forward stop 18789");
    expect(openshellOutput).not.toContain("gateway destroy -g nemoclaw");
    expect(openshellOutput).not.toContain("gateway remove nemoclaw");
    expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
  });

  it("tears down the gateway runtime when --cleanup-gateway is passed (#2166)", testTimeoutOptions(30_000), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-last-cleanup-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
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
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(localBin, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(localBin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const r = runWithEnv(
      "alpha destroy -y --cleanup-gateway",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      30_000,
    );

    expect(r.code, r.out).toBe(0);
    const openshellOutput = fs.readFileSync(openshellLog, "utf8");
    expect(openshellOutput).toContain("sandbox delete alpha");
    expect(openshellOutput).toContain("forward stop 18789");
    expect(openshellOutput).toContain(
      process.platform === "linux" ? "gateway remove nemoclaw" : "gateway destroy -g nemoclaw",
    );
    expect(fs.readFileSync(bashLog, "utf8")).toContain("volume ls -q --filter");
  });

  it("honours NEMOCLAW_CLEANUP_GATEWAY=1 as the env-driven opt-in (#2166)", testTimeoutOptions(30_000), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-last-env-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
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
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(localBin, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(localBin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const r = runWithEnv(
      "alpha destroy -y",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
        NEMOCLAW_CLEANUP_GATEWAY: "1",
      },
      30_000,
    );

    expect(r.code, r.out).toBe(0);
    const openshellOutput = fs.readFileSync(openshellLog, "utf8");
    expect(openshellOutput).toContain("forward stop 18789");
    expect(openshellOutput).toContain(
      process.platform === "linux" ? "gateway remove nemoclaw" : "gateway destroy -g nemoclaw",
    );
  });

  it("keeps the gateway runtime when other sandboxes still exist", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-shared-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
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
          beta: {
            name: "beta",
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
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\nbeta Ready\\n" >> "$log_file"',
        '  printf "NAME STATUS\\nbeta Ready\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway remove nemoclaw");
    if (fs.existsSync(bashLog)) {
      expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
    }
  });

  it("keeps the gateway runtime when the live gateway still reports sandboxes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-live-shared-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
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
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\nbeta Ready\\n" >> "$log_file"',
        '  printf "NAME STATUS\\nbeta Ready\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("beta Ready");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway remove nemoclaw");
    if (fs.existsSync(bashLog)) {
      expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
    }
  });

  it("fails destroy when openshell sandbox delete returns a real error", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-failure-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
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
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
        '  echo "transport error: gateway unavailable" >&2',
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("transport error: gateway unavailable");
    expect(r.out).toContain("Failed to destroy sandbox 'alpha'.");
    expect(r.out).not.toContain("Sandbox 'alpha' destroyed");

    const registryAfter = JSON.parse(
      fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"),
    );
    expect(registryAfter.sandboxes.alpha).toBeTruthy();
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway remove nemoclaw");
  });

  it("treats an already-missing sandbox as destroyed and clears the stale registry entry", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-missing-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
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
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
        '  printf \'%s\\n\' "$*" >> "$log_file"',
        '  echo "Error: status: Not Found, message: \\"sandbox not found\\"" >&2',
        "  exit 1",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        '  printf "NAME STATUS\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("already absent from the live gateway");
    expect(r.out).toContain("Sandbox 'alpha' destroyed");

    const registryAfter = JSON.parse(
      fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"),
    );
    expect(registryAfter.sandboxes.alpha).toBeFalsy();
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
  });

  it("deletes messaging providers when destroying a sandbox", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-providers-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
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
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const log = fs.readFileSync(openshellLog, "utf8");
    expect(log).toContain("provider delete alpha-telegram-bridge");
    expect(log).toContain("provider delete alpha-discord-bridge");
    expect(log).toContain("provider delete alpha-slack-bridge");
    expect(log).toContain("provider delete alpha-slack-app");
  });
});
