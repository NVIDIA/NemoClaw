// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

function run(args) {
  return runWithEnv(args);
}

function runWithEnv(args, env = {}, timeout = 10000) {
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      timeout,
      env: { ...process.env, HOME: "/tmp/nemoclaw-cli-test-" + Date.now(), ...env },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: (err.stdout || "") + (err.stderr || "") };
  }
}

describe("CLI dispatch", () => {
  it("help exits 0 and shows sections", () => {
    const r = run("help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Getting Started")).toBeTruthy();
    expect(r.out.includes("Sandbox Management")).toBeTruthy();
    expect(r.out.includes("Policy Presets")).toBeTruthy();
  });

  it("--help exits 0", () => {
    expect(run("--help").code).toBe(0);
  });

  it("-h exits 0", () => {
    expect(run("-h").code).toBe(0);
  });

  it("no args exits 0 (shows help)", () => {
    const r = run("");
    expect(r.code).toBe(0);
    expect(r.out.includes("nemoclaw")).toBeTruthy();
  });

  it("unknown command exits 1", () => {
    const r = run("boguscmd");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown command")).toBeTruthy();
  });

  it("list exits 0", () => {
    const r = run("list");
    expect(r.code).toBe(0);
    // With empty HOME, should say no sandboxes
    expect(r.out.includes("No sandboxes")).toBeTruthy();
  });

  it("unknown onboard option exits 1", () => {
    const r = run("onboard --non-interactiv");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown onboard option")).toBeTruthy();
  });

  it("accepts onboard --resume in CLI parsing", () => {
    const r = run("onboard --resume --non-interactiv");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown onboard option(s): --non-interactiv")).toBeTruthy();
  });

  it("debug --help exits 0 and shows usage", () => {
    const r = run("debug --help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Collect NemoClaw diagnostic information")).toBeTruthy();
    expect(r.out.includes("--quick")).toBeTruthy();
    expect(r.out.includes("--output")).toBeTruthy();
  });

  it("debug --quick exits 0 and produces diagnostic output", { timeout: 15000 }, () => {
    const r = run("debug --quick");
    expect(r.code).toBe(0);
    expect(r.out.includes("Collecting diagnostics")).toBeTruthy();
    expect(r.out.includes("System")).toBeTruthy();
    expect(r.out.includes("Onboard Session")).toBeTruthy();
    expect(r.out.includes("Done")).toBeTruthy();
  });

  it("debug exits 1 on unknown option", () => {
    const r = run("debug --quik");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown option")).toBeTruthy();
  });

  it("help mentions debug command", () => {
    const r = run("help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Troubleshooting")).toBeTruthy();
    expect(r.out.includes("nemoclaw debug")).toBeTruthy();
  });

  it("passes --follow through to openshell logs", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-logs-follow-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "logs-args");
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
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        "printf '%s ' \"$@\" > \"$marker_file\"",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );

    const r = runWithEnv("alpha logs --follow", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(markerFile, "utf8")).toContain("logs alpha --follow");
  });

  it("connect does not pre-start a duplicate port forward", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-forward-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "openshell-calls");
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
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        "printf '%s\\n' \"$*\" >> \"$marker_file\"",
        "if [ \"$1\" = \"sandbox\" ] && [ \"$2\" = \"get\" ] && [ \"$3\" = \"alpha\" ]; then",
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"sandbox\" ] && [ \"$2\" = \"connect\" ] && [ \"$3\" = \"alpha\" ]; then",
        "  exit 0",
        "fi",
        "exit 0",
        ].join("\n"),
      { mode: 0o755 }
    );

    const r = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls).toContain("sandbox connect alpha");
    expect(calls.some((call) => call.startsWith("forward start --background 18789"))).toBe(false);
  });

  it("removes stale registry entries when connect targets a missing live sandbox", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-stale-connect-"));
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
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"sandbox\" ] && [ \"$2\" = \"get\" ] && [ \"$3\" = \"alpha\" ]; then",
        "  echo 'Error: status: NotFound, message: \"sandbox not found\"' >&2",
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );

    const r = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out.includes("Removed stale local registry entry")).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeUndefined();
  });

  it("keeps registry entries when status hits a gateway-level transport error", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-gateway-error-"));
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
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"sandbox\" ] && [ \"$2\" = \"get\" ] && [ \"$3\" = \"alpha\" ]; then",
        "  echo 'Error: transport error: handshake verification failed' >&2",
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    }, 25000);

    expect(r.code).toBe(0);
    expect(r.out.includes("Could not verify sandbox 'alpha'")).toBeTruthy();
    expect(r.out.includes("gateway identity drift after restart")).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeTruthy();
  }, 25000);

  it("recovers status after gateway runtime is reattached", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-recover-status-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const stateFile = path.join(home, "sandbox-get-count");
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
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `state_file=${JSON.stringify(stateFile)}`,
        "count=$(cat \"$state_file\" 2>/dev/null || echo 0)",
        "if [ \"$1\" = \"sandbox\" ] && [ \"$2\" = \"get\" ] && [ \"$3\" = \"alpha\" ]; then",
        "  count=$((count + 1))",
        "  echo \"$count\" > \"$state_file\"",
        "  if [ \"$count\" -eq 1 ]; then",
        "    echo 'Error: transport error: Connection refused' >&2",
        "    exit 1",
        "  fi",
        "  echo 'Sandbox: alpha'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"status\" ]; then",
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"gateway\" ] && [ \"$2\" = \"info\" ] && [ \"$3\" = \"-g\" ] && [ \"$4\" = \"nemoclaw\" ]; then",
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out.includes("Recovered NemoClaw gateway runtime")).toBeTruthy();
    expect(r.out.includes("Sandbox: alpha")).toBeTruthy();
  });

  it("does not treat a different connected gateway as a healthy nemoclaw gateway", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-mixed-gateway-"));
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
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"sandbox\" ] && [ \"$2\" = \"get\" ] && [ \"$3\" = \"alpha\" ]; then",
        "  echo 'Error: transport error: Connection refused' >&2",
        "  exit 1",
        "fi",
        "if [ \"$1\" = \"status\" ]; then",
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: openshell'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"gateway\" ] && [ \"$2\" = \"info\" ] && [ \"$3\" = \"-g\" ] && [ \"$4\" = \"nemoclaw\" ]; then",
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"gateway\" ] && [ \"$2\" = \"select\" ] && [ \"$3\" = \"nemoclaw\" ]; then",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"gateway\" ] && [ \"$2\" = \"start\" ] && [ \"$3\" = \"--name\" ] && [ \"$4\" = \"nemoclaw\" ]; then",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"inference\" ] && [ \"$2\" = \"get\" ]; then",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    }, 25000);

    expect(r.code).toBe(0);
    expect(r.out.includes("Recovered NemoClaw gateway runtime")).toBeFalsy();
    expect(r.out.includes("Could not verify sandbox 'alpha'")).toBeTruthy();
    expect(r.out.includes("verify the active gateway")).toBeTruthy();
  }, 25000);

  it("matches ANSI-decorated gateway transport errors when printing lifecycle hints", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-ansi-transport-hint-"));
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
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"sandbox\" ] && [ \"$2\" = \"get\" ] && [ \"$3\" = \"alpha\" ]; then",
        "  printf '\\033[31mError: trans\\033[0mport error: Connec\\033[33mtion refused\\033[0m\\n' >&2",
        "  exit 1",
        "fi",
        "if [ \"$1\" = \"status\" ]; then",
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: openshell'",
        "  echo '  Status: Disconnected'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"gateway\" ] && [ \"$2\" = \"info\" ] && [ \"$3\" = \"-g\" ] && [ \"$4\" = \"nemoclaw\" ]; then",
        "  printf 'Gateway Info\\n\\n  Gateway: openshell\\n'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"gateway\" ] && [ \"$2\" = \"select\" ] && [ \"$3\" = \"nemoclaw\" ]; then",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    }, 25000);

    expect(r.code).toBe(0);
    expect(r.out.includes("current gateway/runtime is not reachable")).toBeTruthy();
  }, 25000);

  it("matches ANSI-decorated gateway auth errors when printing lifecycle hints", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-ansi-auth-hint-"));
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
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"sandbox\" ] && [ \"$2\" = \"get\" ] && [ \"$3\" = \"alpha\" ]; then",
        "  printf '\\033[31mMissing gateway auth\\033[0m token\\n' >&2",
        "  exit 1",
        "fi",
        "if [ \"$1\" = \"status\" ]; then",
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: openshell'",
        "  echo '  Status: Disconnected'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"gateway\" ] && [ \"$2\" = \"info\" ] && [ \"$3\" = \"-g\" ] && [ \"$4\" = \"nemoclaw\" ]; then",
        "  printf 'Gateway Info\\n\\n  Gateway: openshell\\n'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"gateway\" ] && [ \"$2\" = \"select\" ] && [ \"$3\" = \"nemoclaw\" ]; then",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    }, 25000);

    expect(r.code).toBe(0);
    expect(r.out.includes("Verify the active gateway and retry after re-establishing the runtime.")).toBeTruthy();
  }, 25000);

  it("explains unrecoverable gateway trust rotation after restart", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-identity-drift-"));
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
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"sandbox\" ] && [ \"$2\" = \"get\" ] && [ \"$3\" = \"alpha\" ]; then",
        "  echo 'Error: transport error: handshake verification failed' >&2",
        "  exit 1",
        "fi",
        "if [ \"$1\" = \"status\" ]; then",
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"gateway\" ] && [ \"$2\" = \"info\" ] && [ \"$3\" = \"-g\" ] && [ \"$4\" = \"nemoclaw\" ]; then",
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );

    const statusResult = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    }, 25000);
    expect(statusResult.code).toBe(0);
    expect(statusResult.out.includes("gateway trust material rotated after restart")).toBeTruthy();
    expect(statusResult.out.includes("cannot be reattached safely")).toBeTruthy();

    const connectResult = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });
    expect(connectResult.code).toBe(1);
    expect(connectResult.out.includes("gateway trust material rotated after restart")).toBeTruthy();
    expect(connectResult.out.includes("Recreate this sandbox")).toBeTruthy();
  });

  it("explains when gateway metadata exists but the restarted API is still refusing connections", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-gateway-unreachable-"));
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
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"sandbox\" ] && [ \"$2\" = \"get\" ] && [ \"$3\" = \"alpha\" ]; then",
        "  echo 'Error: transport error: Connection refused' >&2",
        "  exit 1",
        "fi",
        "if [ \"$1\" = \"status\" ]; then",
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Server: https://127.0.0.1:8080'",
        "  echo 'Error: client error (Connect)' >&2",
        "  echo 'Connection refused (os error 111)' >&2",
        "  exit 1",
        "fi",
        "if [ \"$1\" = \"gateway\" ] && [ \"$2\" = \"info\" ] && [ \"$3\" = \"-g\" ] && [ \"$4\" = \"nemoclaw\" ]; then",
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"gateway\" ] && [ \"$2\" = \"select\" ] && [ \"$3\" = \"nemoclaw\" ]; then",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"gateway\" ] && [ \"$2\" = \"start\" ] && [ \"$3\" = \"--name\" ] && [ \"$4\" = \"nemoclaw\" ]; then",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );

    const statusResult = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    }, 25000);
    expect(statusResult.code).toBe(0);
    expect(statusResult.out.includes("gateway is still refusing connections after restart")).toBeTruthy();
    expect(statusResult.out.includes("Retry `openshell gateway start --name nemoclaw`")).toBeTruthy();

    const connectResult = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });
    expect(connectResult.code).toBe(1);
    expect(connectResult.out.includes("gateway is still refusing connections after restart")).toBeTruthy();
    expect(connectResult.out.includes("If the gateway never becomes healthy")).toBeTruthy();
  }, 25000);

  it("explains when the named gateway is no longer configured after restart or rebuild", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-gateway-missing-"));
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
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"sandbox\" ] && [ \"$2\" = \"get\" ] && [ \"$3\" = \"alpha\" ]; then",
        "  echo 'Error: transport error: Connection refused' >&2",
        "  exit 1",
        "fi",
        "if [ \"$1\" = \"status\" ]; then",
        "  echo 'Gateway Status'",
        "  echo",
        "  echo '  Status: No gateway configured.'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"gateway\" ] && [ \"$2\" = \"info\" ] && [ \"$3\" = \"-g\" ] && [ \"$4\" = \"nemoclaw\" ]; then",
        "  exit 1",
        "fi",
        "if [ \"$1\" = \"gateway\" ] && [ \"$2\" = \"select\" ] && [ \"$3\" = \"nemoclaw\" ]; then",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"gateway\" ] && [ \"$2\" = \"start\" ] && [ \"$3\" = \"--name\" ] && [ \"$4\" = \"nemoclaw\" ]; then",
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );

    const statusResult = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    }, 25000);
    expect(statusResult.code).toBe(0);
    expect(statusResult.out.includes("gateway is no longer configured after restart/rebuild")).toBeTruthy();
    expect(statusResult.out.includes("Start the gateway again")).toBeTruthy();
  }, 25000);
});

describe("list shows live gateway inference", () => {
  it("prefers live inference model/provider over stale registry values", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-live-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    // Registry has no model/provider (mimics post-onboard before inference setup)
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          test: {
            name: "test",
            model: null,
            provider: null,
            gpuEnabled: true,
            policies: ["pypi", "npm"],
          },
        },
        defaultSandbox: "test",
      }),
      { mode: 0o600 }
    );
    // Stub openshell: inference get returns live provider/model
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"inference\" ] && [ \"$2\" = \"get\" ]; then",
        "  echo 'Gateway inference:'",
        "  echo '  Provider: nvidia-prod'",
        "  echo '  Model: nvidia/nemotron-3-super-120b-a12b'",
        "  echo '  Version: 1'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("nvidia/nemotron-3-super-120b-a12b");
    expect(r.out).toContain("nvidia-prod");
    expect(r.out).not.toContain("unknown");
  });

  it("falls back to registry values when openshell inference get fails", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-fallback-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          test: {
            name: "test",
            model: "llama3.2:1b",
            provider: "ollama-local",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "test",
      }),
      { mode: 0o600 }
    );
    // Stub openshell: inference get fails
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"inference\" ] && [ \"$2\" = \"get\" ]; then",
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("llama3.2:1b");
    expect(r.out).toContain("ollama-local");
  });
});
