// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stageOptimizedSandboxBuildContext } from "../dist/lib/sandbox/build-context.js";
import { testTimeoutOptions } from "./helpers/timeouts";

type ShimScalar = string | number | boolean | null | undefined;
type ShimCallable = (...args: readonly string[]) => ShimValue;
type ShimValue = ShimScalar | { [key: string]: ShimValue } | ShimValue[] | ShimCallable;
type ShimFn<TReturn = void> = (...args: ShimValue[]) => TReturn;
type CommandEntry = {
  command: string;
  env?: Record<string, string | undefined>;
  policyContent?: string;
  policyReadError?: string;
  dockerfileContent?: string;
  dockerfileReadError?: string;
};
type ResumeConflict = { field: string; requested: string | null; recorded: string | null };

type OnboardTestInternals = {
  getNavigationChoice: (value?: string | null) => string | null;
  getFutureShellPathHint: (binDir: string, pathValue?: string) => string | null;
  getRequestedModelHint: ShimFn<string | null>;
  getRequestedProviderHint: ShimFn<string | null>;
  getRequestedSandboxNameHint: ShimFn<string | null>;
  getResumeConfigConflicts: ShimFn<ResumeConflict[]>;
  getResumeSandboxConflict: ShimFn<{
    requestedSandboxName: string;
    recordedSandboxName: string;
  } | null>;
  pullAndResolveBaseImageDigest: () => { digest: string | null; ref: string } | null;
  SANDBOX_BASE_IMAGE: string;
};

function parseStdoutJson<T>(stdout: string): T {
  const line = stdout.trim().split("\n").pop();
  assert.ok(line, `expected JSON payload in stdout:\n${stdout}`);
  return JSON.parse(line);
}

type OnboardTestInternalsCandidate = Partial<OnboardTestInternals> | null;

function isOnboardTestInternals(
  value: OnboardTestInternalsCandidate,
): value is OnboardTestInternals {
  return value !== null && typeof value.getNavigationChoice === "function";
}

const loadedOnboardInternals = require("../dist/lib/onboard");
const onboardTestInternals =
  typeof loadedOnboardInternals === "object" && loadedOnboardInternals !== null
    ? loadedOnboardInternals
    : null;
if (!isOnboardTestInternals(onboardTestInternals)) {
  throw new Error("Expected onboard test internals to expose helper functions");
}

const {
  getNavigationChoice,
  getFutureShellPathHint,
  getRequestedModelHint,
  getRequestedProviderHint,
  getRequestedSandboxNameHint,
  getResumeConfigConflicts,
  getResumeSandboxConflict,
  SANDBOX_BASE_IMAGE,
} = onboardTestInternals;

const repoRoot = path.join(import.meta.dirname, "..");
const onboardScriptMocksPath = JSON.stringify(
  path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
);

describe("onboard helpers", () => {
  it("prints doctor logs automatically when gateway fails to start (#1605)", testTimeoutOptions(20_000), () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-diag-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "gateway-diag.cjs");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    // Fake openshell:
    //   gateway start  — emits ANSI color codes + \r\n (mirrors real gateway output), exits 1
    //   doctor logs    — emits ANSI sequences, an OOMKilled message, and a fake nvapi- credential
    //                    to exercise ANSI stripping and redaction in the doctor-log path
    fs.writeFileSync(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [[ "$*" == *"doctor"*"logs"* ]]; then
  printf "\\033[31mERROR\\033[0m k3s cluster crashed: OOMKilled\\r\\n"
  printf "  Container nemoclaw_k3s ran out of memory\\r\\n"
  printf "  Gateway auth token: nvapi-fakecredential-9999\\r\\n"
  exit 0
fi
if [[ "$*" == "gateway --help" ]]; then
  printf "Commands: start destroy\\n"
  exit 0
fi
if [[ "$*" == *"gateway"*"start"* ]]; then
  printf "\\033[33mDeploying\\033[0m gateway nemoclaw...\\r\\n"
  printf "\\r\\nWaiting for gateway health...\\r\\n"
  exit 1
fi
exit 1
`,
      { mode: 0o755 },
    );

    // Script runs in a child process: patching p-retry to be immediate avoids the
    // 10 s + 30 s minTimeout delays, and NEMOCLAW_HEALTH_POLL_COUNT=0 skips the
    // health-poll loop so the function throws "Gateway failed to start" on the
    // first attempt. With exitOnFailure:true the catch block should auto-print
    // doctor logs to stderr and then call process.exit(1).
    const script = `
const mod = require("module");
const origLoad = mod._load;
mod._load = function(req, parent, isMain) {
  if (req === "p-retry") {
    return async (fn, opts) => {
      try {
        return await fn({ attemptNumber: 1, retriesLeft: 0 });
      } catch (e) {
        if (opts && opts.onFailedAttempt) {
          opts.onFailedAttempt(Object.assign(e, { attemptNumber: 1, retriesLeft: 0 }));
        }
        throw e;
      }
    };
  }
  return origLoad.call(this, req, parent, isMain);
};
Object.defineProperty(process, "platform", { value: "freebsd" });
const { startGateway } = require(${onboardPath});
startGateway(null).catch(() => {});
`;
    fs.writeFileSync(scriptPath, script);

    const nodeExec = process.execPath;
    const result = spawnSync(nodeExec, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_HEALTH_POLL_COUNT: "0",
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    // The process exits 1 because startGateway calls process.exit(1) on failure.
    assert.equal(result.status, 1, `unexpected exit code; stderr:\n${result.stderr}`);

    // Fix 3: doctor logs are auto-printed to stderr.
    assert.ok(
      result.stderr.includes("Gateway logs:"),
      `expected "Gateway logs:" header in stderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes("OOMKilled"),
      `expected doctor log output in stderr:\n${result.stderr}`,
    );

    // ANSI sequences must be stripped from both stdout (gateway start output) and
    // stderr (doctor logs). A raw \x1b in the output means the regex failed.
    assert.ok(
      !result.stdout.includes("\x1b"),
      `unexpected ANSI escape in stdout:\n${result.stdout}`,
    );
    assert.ok(
      !result.stderr.includes("\x1b"),
      `unexpected ANSI escape in stderr:\n${result.stderr}`,
    );

    // Credentials in doctor logs must be redacted, never printed verbatim.
    assert.ok(
      !result.stderr.includes("nvapi-fakecredential-9999"),
      `credential leaked verbatim in stderr:\n${result.stderr}`,
    );

    // Fix 2: the \r\n -> \naiting rendering artifact must not appear.
    assert.ok(
      !result.stdout.includes("\naiting"),
      `\\naiting artifact present in stdout:\n${result.stdout}`,
    );

    // Fix 1: gateway start output is printed per-line under the header, not as
    // one collapsed blob. "Deploying" and "Waiting" must appear on separate lines.
    const gatewayLines = result.stdout
      .split("\n")
      .filter((l) => l.includes("Deploying") || l.includes("Waiting"));
    assert.ok(
      gatewayLines.length >= 2,
      `expected "Deploying" and "Waiting" on separate lines in stdout:\n${result.stdout}`,
    );
  });

  it("normalizes sandbox name hints from the environment", () => {
    const previous = process.env.NEMOCLAW_SANDBOX_NAME;
    process.env.NEMOCLAW_SANDBOX_NAME = "  My-Assistant  ";
    try {
      expect(getRequestedSandboxNameHint()).toBe("my-assistant");
    } finally {
      if (previous === undefined) {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      } else {
        process.env.NEMOCLAW_SANDBOX_NAME = previous;
      }
    }
  });

  it("prefers the explicit --name option over NEMOCLAW_SANDBOX_NAME", () => {
    const previous = process.env.NEMOCLAW_SANDBOX_NAME;
    process.env.NEMOCLAW_SANDBOX_NAME = "from-env";
    try {
      expect(getRequestedSandboxNameHint({ sandboxName: "From-Flag" })).toBe("from-flag");
    } finally {
      if (previous === undefined) {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      } else {
        process.env.NEMOCLAW_SANDBOX_NAME = previous;
      }
    }
  });

  it("detects resume conflicts when --name does not match the recorded sandbox", () => {
    expect(
      getResumeConfigConflicts(
        { sandboxName: "my-assistant", steps: { sandbox: { status: "complete" } } },
        { sandboxName: "second-assistant" },
      ),
    ).toEqual([
      {
        field: "sandbox",
        requested: "second-assistant",
        recorded: "my-assistant",
      },
    ]);
  });

  it("detects resume conflicts when a different sandbox is requested", () => {
    expect(
      getResumeSandboxConflict(
        { sandboxName: "my-assistant", steps: { sandbox: { status: "complete" } } },
        { sandboxName: "other-sandbox" },
      ),
    ).toEqual({
      requestedSandboxName: "other-sandbox",
      recordedSandboxName: "my-assistant",
    });
    expect(
      getResumeSandboxConflict(
        { sandboxName: "other-sandbox", steps: { sandbox: { status: "complete" } } },
        { sandboxName: "other-sandbox" },
      ),
    ).toBe(null);
  });

  it("does not fire a resume conflict from NEMOCLAW_SANDBOX_NAME alone", () => {
    // Interactive resume runs never consult the env var (sandbox creation
    // is already complete in the session, so promptOrDefault is skipped).
    // Reading it here would surface a spurious conflict whenever a user
    // happens to export NEMOCLAW_SANDBOX_NAME in their shell rc.
    const previous = process.env.NEMOCLAW_SANDBOX_NAME;
    process.env.NEMOCLAW_SANDBOX_NAME = "other-sandbox";
    try {
      expect(
        getResumeSandboxConflict({
          sandboxName: "my-assistant",
          steps: { sandbox: { status: "complete" } },
        }),
      ).toBe(null);
    } finally {
      if (previous === undefined) {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      } else {
        process.env.NEMOCLAW_SANDBOX_NAME = previous;
      }
    }
  });

  it("#2753: ignores an incomplete session sandbox name when checking resume conflicts", () => {
    // A pre-fix on-disk session may carry sandboxName even though the
    // sandbox step never completed. Treating that as a conflict source
    // would block users from running `--resume --name <new>` to recover.
    expect(
      getResumeSandboxConflict(
        { sandboxName: "interrupt-test", steps: { sandbox: { status: "pending" } } },
        { sandboxName: "fresh-name" },
      ),
    ).toBe(null);
    expect(
      getResumeConfigConflicts(
        { sandboxName: "interrupt-test", steps: { sandbox: { status: "pending" } } },
        { sandboxName: "fresh-name" },
      ),
    ).toEqual([]);
  });

  it("returns provider and model hints only for non-interactive runs", () => {
    const previousProvider = process.env.NEMOCLAW_PROVIDER;
    const previousModel = process.env.NEMOCLAW_MODEL;
    process.env.NEMOCLAW_PROVIDER = "cloud";
    process.env.NEMOCLAW_MODEL = "nvidia/test-model";
    try {
      expect(getRequestedProviderHint(true)).toBe("build");
      expect(getRequestedModelHint(true)).toBe("nvidia/test-model");
      expect(getRequestedProviderHint(false)).toBe(null);
      expect(getRequestedModelHint(false)).toBe(null);
    } finally {
      if (previousProvider === undefined) {
        delete process.env.NEMOCLAW_PROVIDER;
      } else {
        process.env.NEMOCLAW_PROVIDER = previousProvider;
      }
      if (previousModel === undefined) {
        delete process.env.NEMOCLAW_MODEL;
      } else {
        process.env.NEMOCLAW_MODEL = previousModel;
      }
    }
  });

  it("detects resume conflicts for explicit provider and model changes", () => {
    const previousProvider = process.env.NEMOCLAW_PROVIDER;
    const previousModel = process.env.NEMOCLAW_MODEL;
    process.env.NEMOCLAW_PROVIDER = "cloud";
    process.env.NEMOCLAW_MODEL = "nvidia/other-model";
    try {
      // Provider conflict uses a two-stage alias chain in non-interactive mode:
      // "cloud" first resolves to the requested hint, then that hint resolves
      // to the effective provider name "nvidia-prod" for conflict comparison.
      expect(
        getResumeConfigConflicts(
          {
            sandboxName: "my-assistant",
            provider: "nvidia-nim",
            model: "nvidia/nemotron-3-super-120b-a12b",
          },
          { nonInteractive: true },
        ),
      ).toEqual([
        {
          field: "provider",
          requested: "nvidia-prod",
          recorded: "nvidia-nim",
        },
        {
          field: "model",
          requested: "nvidia/other-model",
          recorded: "nvidia/nemotron-3-super-120b-a12b",
        },
      ]);
    } finally {
      if (previousProvider === undefined) {
        delete process.env.NEMOCLAW_PROVIDER;
      } else {
        process.env.NEMOCLAW_PROVIDER = previousProvider;
      }
      if (previousModel === undefined) {
        delete process.env.NEMOCLAW_MODEL;
      } else {
        process.env.NEMOCLAW_MODEL = previousModel;
      }
    }
  });

  it("detects resume conflicts when a different agent is requested", () => {
    expect(
      getResumeConfigConflicts(
        {
          sandboxName: "my-assistant",
          agent: "openclaw",
        },
        { agent: "hermes" },
      ),
    ).toEqual([
      {
        field: "agent",
        requested: "hermes",
        recorded: "openclaw",
      },
    ]);
  });

  it("allows resume when requested agent matches recorded agent", () => {
    expect(
      getResumeConfigConflicts(
        {
          sandboxName: "my-assistant",
          agent: "hermes",
        },
        { agent: "hermes" },
      ),
    ).toEqual([]);
  });

  it("returns a future-shell PATH hint for user-local openshell installs", () => {
    expect(getFutureShellPathHint("/home/test/.local/bin", "/usr/local/bin:/usr/bin")).toBe(
      'export PATH="/home/test/.local/bin:$PATH"',
    );
  });

  it("skips the future-shell PATH hint when the bin dir is already on PATH", () => {
    expect(
      getFutureShellPathHint(
        "/home/test/.local/bin",
        "/home/test/.local/bin:/usr/local/bin:/usr/bin",
      ),
    ).toBe(null);
  });

  it("stages only the files required to build the sandbox image", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-"));

    try {
      const { buildCtx, stagedDockerfile } = stageOptimizedSandboxBuildContext(repoRoot, tmpDir);

      expect(stagedDockerfile).toBe(path.join(buildCtx, "Dockerfile"));
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw", "package-lock.json"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw", "src"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw-blueprint", ".venv"))).toBe(false);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "nemoclaw-start.sh"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "setup.sh"))).toBe(false);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw", "node_modules"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("getNavigationChoice recognizes back and exit commands case-insensitively", () => {
    expect(getNavigationChoice("back")).toBe("back");
    expect(getNavigationChoice("BACK")).toBe("back");
    expect(getNavigationChoice("  Back  ")).toBe("back");
    expect(getNavigationChoice("exit")).toBe("exit");
    expect(getNavigationChoice("quit")).toBe("exit");
    expect(getNavigationChoice("QUIT")).toBe("exit");
    expect(getNavigationChoice("")).toBeNull();
    expect(getNavigationChoice("something")).toBeNull();
    expect(getNavigationChoice(null)).toBeNull();
  });

  it("rejects sandbox names starting with a digit", () => {
    // The validation regex must require names to start with a letter,
    // not a digit — Kubernetes rejects digit-prefixed names downstream.
    const SANDBOX_NAME_REGEX = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

    expect(SANDBOX_NAME_REGEX.test("my-assistant")).toBe(true);
    expect(SANDBOX_NAME_REGEX.test("a")).toBe(true);
    expect(SANDBOX_NAME_REGEX.test("agent-1")).toBe(true);
    expect(SANDBOX_NAME_REGEX.test("test-sandbox-v2")).toBe(true);

    expect(SANDBOX_NAME_REGEX.test("7racii")).toBe(false);
    expect(SANDBOX_NAME_REGEX.test("1sandbox")).toBe(false);
    expect(SANDBOX_NAME_REGEX.test("123")).toBe(false);
    expect(SANDBOX_NAME_REGEX.test("-start-hyphen")).toBe(false);
    expect(SANDBOX_NAME_REGEX.test("end-hyphen-")).toBe(false);
    expect(SANDBOX_NAME_REGEX.test("")).toBe(false);
  });

  it("passes credential names to openshell without embedding secret values in argv", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-inference-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-inference-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "state", "registry.js"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: nvidia-nim",
      "  Model: nvidia/nemotron-3-super-120b-a12b",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.NVIDIA_API_KEY = "nvapi-secret-value";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "nvidia/nemotron-3-super-120b-a12b", "nvidia-nim");
  console.log(JSON.stringify({ commands, nvidiaApiKey: process.env.NVIDIA_API_KEY || null }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    expect(result.status).toBe(0);
    const payload = parseStdoutJson<{ commands: CommandEntry[]; nvidiaApiKey: string | null }>(
      result.stdout,
    );
    const commands = payload.commands;
    assert.equal(commands.length, 4);
    assert.match(commands[0].command, /gateway select nemoclaw/);
    assert.match(commands[1].command, /provider get/);
    assert.match(commands[2].command, /--credential NVIDIA_API_KEY/);
    assert.doesNotMatch(commands[2].command, /nvapi-secret-value/);
    assert.match(commands[2].command, /provider update/);
    assert.match(commands[3].command, /inference set/);
    assert.equal(payload.nvidiaApiKey, "nvapi-secret-value");
  });

  it("reuses a registered Hermes Provider without re-collecting host credentials", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-hermes-reuse-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-hermes-reuse-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: opts.env || null });
  if (normalized.includes("provider get hermes-provider")) {
    return { status: 0, stdout: "Provider: hermes-provider", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: hermes-provider",
      "  Model: moonshotai/kimi-k2.6",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.NOUS_API_KEY = "nous-host-secret";
process.env.OPENAI_API_KEY = "openai-host-secret";
process.env.NEMOCLAW_NON_INTERACTIVE = "1";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "moonshotai/kimi-k2.6", "hermes-provider", "https://inference-api.nousresearch.com/v1", "OPENAI_API_KEY", "oauth");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    expect(result.status).toBe(0);
    const commands = parseStdoutJson<CommandEntry[]>(result.stdout);
    assert.equal(commands.length, 3);
    assert.match(commands[0].command, /gateway select nemoclaw/);
    assert.match(commands[1].command, /provider get hermes-provider/);
    assert.match(commands[2].command, /inference set --no-verify --provider hermes-provider/);
    assert.ok(!commands.some((entry) => /provider (create|update)/.test(entry.command)));
    assert.ok(!commands.some((entry) => entry.env?.NOUS_API_KEY || entry.env?.OPENAI_API_KEY));
    assert.ok(
      !commands.some((entry) => /nous-host-secret|openai-host-secret/.test(entry.command)),
      "host credential values must not appear in argv",
    );
  });

  it("reconciles a registered Hermes Provider when a fresh shell Nous key is selected", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-hermes-update-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-hermes-update-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: opts.env || null });
  if (normalized.includes("provider get hermes-provider")) {
    return { status: 0, stdout: "Provider: hermes-provider", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: hermes-provider",
      "  Model: moonshotai/kimi-k2.6",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.NOUS_API_KEY = "nous-host-secret";
delete process.env.OPENAI_API_KEY;
process.env.NEMOCLAW_NON_INTERACTIVE = "1";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference(
    "test-box",
    "moonshotai/kimi-k2.6",
    "hermes-provider",
    "https://inference-api.nousresearch.com/v1",
    "NOUS_API_KEY",
    "api_key",
  );
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    expect(result.status).toBe(0);
    const commands = parseStdoutJson<CommandEntry[]>(result.stdout);
    const update = commands.find((entry) => /provider update hermes-provider/.test(entry.command));
    assert.ok(update);
    assert.match(update.command, /--credential NOUS_API_KEY/);
    assert.equal(update.env?.NOUS_API_KEY, "nous-host-secret");
    assert.ok(
      !commands.some((entry) => /nous-host-secret/.test(entry.command)),
      "shell credential value must not appear in argv",
    );
    assert.match(
      commands.at(-1)?.command || "",
      /inference set --no-verify --provider hermes-provider/,
    );
  });

  it("does not delete saved OpenAI credentials when configuring local vLLM", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-local-vllm-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-local-vllm-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));
    const localInferencePath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "inference", "local.js"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const credentials = require(${credentialsPath});
const localInference = require(${localInferencePath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");

const commands = [];
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  commands.push({ command: cmd, env: opts.env || null });
  if (cmd.includes("provider get")) return { status: 1, stdout: "", stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  const cmd = _n(command);
  if (cmd.includes("inference") && cmd.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: vllm-local",
      "  Model: meta-llama",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;
localInference.validateLocalProvider = () => ({ ok: true });
localInference.getLocalProviderBaseUrl = () => "http://host.openshell.internal:8000/v1";

credentials.saveCredential("OPENAI_API_KEY", "sk-existing");

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "meta-llama", "vllm-local");
  console.log(JSON.stringify({
    commands,
    savedOpenAiKey: credentials.getCredential("OPENAI_API_KEY"),
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    expect(result.status).toBe(0);
    const payload = parseStdoutJson<{ commands: CommandEntry[]; savedOpenAiKey: string }>(
      result.stdout,
    );
    const providerCommand = payload.commands.find((entry) =>
      entry.command.includes("provider create"),
    );
    assert.ok(providerCommand, "expected local vLLM provider create command");
    assert.match(providerCommand.command, /--credential NEMOCLAW_VLLM_LOCAL_TOKEN/);
    assert.doesNotMatch(providerCommand.command, /--credential OPENAI_API_KEY/);
    assert.equal(providerCommand.env?.NEMOCLAW_VLLM_LOCAL_TOKEN, "dummy");
    assert.equal(payload.savedOpenAiKey, "sk-existing");
  });

  it("detects when the live inference route already matches the requested provider and model", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-inference-ready-"));
    const fakeOpenshell = path.join(tmpDir, "openshell");
    const scriptPath = path.join(tmpDir, "inference-ready-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    fs.writeFileSync(
      fakeOpenshell,
      `#!/usr/bin/env bash
if [ "$1" = "inference" ] && [ "$2" = "get" ]; then
  cat <<'EOF'
Gateway inference:

  Route: inference.local
  Provider: nvidia-prod
  Model: nvidia/nemotron-3-super-120b-a12b
  Version: 1
EOF
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );

    fs.writeFileSync(
      scriptPath,
      `
const { isInferenceRouteReady } = require(${onboardPath});
console.log(JSON.stringify({
  same: isInferenceRouteReady("nvidia-prod", "nvidia/nemotron-3-super-120b-a12b"),
  otherModel: isInferenceRouteReady("nvidia-prod", "nvidia/other-model"),
  otherProvider: isInferenceRouteReady("openai-api", "nvidia/nemotron-3-super-120b-a12b"),
}));
`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${tmpDir}:${process.env.PATH || ""}`,
      },
    });

    try {
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        same: true,
        otherModel: false,
        otherProvider: false,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects when OpenClaw is already configured inside the sandbox", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-ready-"));
    const fakeOpenshell = path.join(tmpDir, "openshell");
    const scriptPath = path.join(tmpDir, "openclaw-ready-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    fs.writeFileSync(
      fakeOpenshell,
      `#!/usr/bin/env bash
if [ "$1" = "sandbox" ] && [ "$2" = "download" ]; then
  dest="\${@: -1}"
  mkdir -p "$dest/sandbox/.openclaw"
  cat > "$dest/sandbox/.openclaw/openclaw.json" <<'EOF'
{"gateway":{"auth":{"token":"test-token"}}}
EOF
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );

    fs.writeFileSync(
      scriptPath,
      `
const { isOpenclawReady } = require(${onboardPath});
console.log(JSON.stringify({
  ready: isOpenclawReady("my-assistant"),
}));
`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${tmpDir}:${process.env.PATH || ""}`,
      },
    });

    try {
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ ready: true });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects when recorded policy presets are already applied", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-ready-"));
    const registryDir = path.join(tmpDir, ".nemoclaw");
    const registryFile = path.join(registryDir, "sandboxes.json");
    const scriptPath = path.join(tmpDir, "policy-ready-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      registryFile,
      JSON.stringify(
        {
          sandboxes: {
            "my-assistant": {
              name: "my-assistant",
              policies: ["pypi", "npm"],
            },
          },
          defaultSandbox: "my-assistant",
        },
        null,
        2,
      ),
    );

    fs.writeFileSync(
      scriptPath,
      `
const { arePolicyPresetsApplied } = require(${onboardPath});
console.log(JSON.stringify({
  ready: arePolicyPresetsApplied("my-assistant", ["pypi", "npm"]),
  missing: arePolicyPresetsApplied("my-assistant", ["pypi", "slack"]),
  empty: arePolicyPresetsApplied("my-assistant", []),
}));
`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
      },
    });

    try {
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      expect(payload).toEqual({
        ready: true,
        missing: false,
        empty: false,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses native Anthropic provider creation without embedding the secret in argv", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-anthropic-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-anthropic-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  // provider-get returns not-found so we exercise the create path
  if (_n(command).includes("provider get")) return { status: 1 };
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: anthropic-prod",
      "  Model: claude-sonnet-4-5",
      "  Version: 1",
    ].join("\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.ANTHROPIC_API_KEY = "sk-ant-secret-value";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "claude-sonnet-4-5", "anthropic-prod", "https://api.anthropic.com", "ANTHROPIC_API_KEY");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = parseStdoutJson<CommandEntry[]>(result.stdout);
    assert.equal(commands.length, 4);
    assert.match(commands[0].command, /gateway select nemoclaw/);
    assert.match(commands[1].command, /provider get/);
    assert.match(commands[2].command, /--type anthropic/);
    assert.match(commands[2].command, /--credential ANTHROPIC_API_KEY/);
    assert.doesNotMatch(commands[2].command, /sk-ant-secret-value/);
    assert.match(commands[3].command, /--provider anthropic-prod/);
  });

  it("updates OpenAI-compatible providers without passing an unsupported --type flag", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-openai-update-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-openai-update-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
    ].join("\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.OPENAI_API_KEY = "sk-secret-value";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = parseStdoutJson<CommandEntry[]>(result.stdout);
    assert.equal(commands.length, 4);
    assert.match(commands[0].command, /gateway select nemoclaw/);
    assert.match(commands[1].command, /provider get/);
    assert.match(commands[2].command, /provider update openai-api/);
    assert.doesNotMatch(commands[2].command, /--type/);
    assert.match(commands[3].command, /inference set --no-verify/);
  });

  it("re-prompts for credentials when openshell inference set fails with authorization errors", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-apply-auth-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-inference-auth-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const credentials = require(${credentialsPath});

const commands = [];
const answers = ["retry", "sk-good"];
let inferenceSetCalls = 0;

credentials.prompt = async () => answers.shift() || "";
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  if (_n(command).includes("inference set")) {
    inferenceSetCalls += 1;
    if (inferenceSetCalls === 1) {
      return { status: 1, stdout: "", stderr: "HTTP 403: forbidden" };
    }
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.OPENAI_API_KEY = "sk-bad";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify({ commands, key: process.env.OPENAI_API_KEY, inferenceSetCalls }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      key: string;
      inferenceSetCalls: number;
      commands: CommandEntry[];
    }>(result.stdout);
    assert.equal(payload.key, "sk-good");
    assert.equal(payload.inferenceSetCalls, 2);
    const providerEnvs = payload.commands
      .filter((entry: CommandEntry) => entry.command.includes("provider"))
      .map((entry: CommandEntry) => entry.env && entry.env.OPENAI_API_KEY)
      .filter(Boolean);
    assert.deepEqual(providerEnvs, ["sk-bad", "sk-good"]);
  });

  it("returns control to provider selection when inference apply recovery chooses back", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-apply-back-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-inference-apply-back-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const credentials = require(${credentialsPath});

const commands = [];
credentials.prompt = async () => "back";
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  if (_n(command).includes("inference set")) {
    return { status: 1, stdout: "", stderr: "HTTP 404: model not found" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = () => "";
registry.updateSandbox = () => true;

process.env.OPENAI_API_KEY = "sk-secret-value";

const { setupInference } = require(${onboardPath});

(async () => {
  const result = await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify({ result, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      result: { retry: "selection" };
      commands: CommandEntry[];
    }>(result.stdout);
    assert.deepEqual(payload.result, { retry: "selection" });
    assert.equal(
      payload.commands.filter((entry: CommandEntry) => entry.command.includes("inference set"))
        .length,
      1,
    );
  });

  it("re-establishes the agent dashboard forward after agent setup health checks", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );
    const setupPos = source.indexOf("await agentOnboard.handleAgentSetup");
    const forwardPos = source.indexOf("ensureAgentDashboardForward(sandboxName, agent)", setupPos);

    assert.ok(setupPos !== -1, "agent setup call not found");
    assert.ok(
      forwardPos > setupPos,
      "agent dashboard forward should be re-established after agent health checks",
    );
  });

  it("re-establishes the agent dashboard forward after policies are applied", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );
    const policiesPos = source.indexOf("await setupPoliciesWithSelection");
    const completePoliciesPos = source.indexOf(
      'onboardSession.markStepComplete(\n        "policies"',
      policiesPos,
    );
    const forwardPos = source.indexOf(
      "ensureAgentDashboardForward(sandboxName, agent)",
      completePoliciesPos,
    );
    const completeSessionPos = source.indexOf(
      "onboardSession.completeSession",
      completePoliciesPos,
    );

    assert.ok(policiesPos !== -1, "policy setup call not found");
    assert.ok(completePoliciesPos !== -1, "policy completion call not found");
    assert.ok(forwardPos > completePoliciesPos, "agent forward should be reset after policy setup");
    assert.ok(
      forwardPos < completeSessionPos,
      "agent forward should be reset before onboarding is marked complete",
    );
  });

  it("runs fresh stale-gateway cleanup after the sandbox name is known but before createSandbox", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );
    const promptPos = source.indexOf(
      "if (!sandboxName) {\n        sandboxName = await promptValidatedSandboxName(agent);",
    );
    const cleanupPos = source.indexOf(
      "stopStaleDashboardListenersForSandbox(registry.listSandboxes().sandboxes, sandboxName);",
      promptPos,
    );
    const createPos = source.indexOf("sandboxName = await createSandbox(", promptPos);

    assert.ok(promptPos !== -1, "sandbox-name resolution block not found");
    assert.ok(cleanupPos > promptPos, "fresh cleanup should run after sandboxName is known");
    assert.ok(cleanupPos < createPos, "fresh cleanup should run before createSandbox allocates a port");
  });

  it("migrates a legacy credentials.json into env so setupInference can register the provider", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-resume-cred-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-resume-credential-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    // Pre-seed a pre-fix plaintext credentials.json. hydrateCredentialEnv
    // stages it non-destructively into process.env via
    // stageLegacyCredentialsToEnv(); the secure unlink only runs from the
    // post-onboard cleanup gate when the staged values are confirmed
    // migrated, so the legacy file must still exist after this test's
    // setupInference call (asserted further down).
    const legacyDir = path.join(tmpDir, ".nemoclaw");
    fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(legacyDir, "credentials.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-stored-secret" }),
      { mode: 0o600 },
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const legacyFilePath = JSON.stringify(path.join(legacyDir, "credentials.json"));
    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const fs = require("node:fs");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
    ].join("\n");
  }
  return "";
};
registry.updateSandbox = () => true;

delete process.env.OPENAI_API_KEY;

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify({
    commands,
    openai: process.env.OPENAI_API_KEY || null,
    legacyFileGone: !fs.existsSync(${legacyFilePath}),
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      openai: string;
      commands: CommandEntry[];
      legacyFileGone: boolean;
    }>(result.stdout);
    assert.equal(payload.openai, "sk-stored-secret");
    // setupInference's hydrateCredentialEnv only stages the legacy file
    // (non-destructive). The secure unlink runs only after a full successful
    // onboard, so an interrupted run can be retried without losing the
    // user's only copy of their credentials.
    assert.equal(
      payload.legacyFileGone,
      false,
      "legacy credentials.json must survive the staging-only hydrate path",
    );
    // commands[0]=gateway select, [1]=provider get, [2]=provider update
    const providerUpdate = payload.commands[2];
    assert.ok(providerUpdate, "expected provider update command");
    assert.equal(providerUpdate.env?.OPENAI_API_KEY, "sk-stored-secret");
    assert.doesNotMatch(providerUpdate.command, /sk-stored-secret/);
  });

  it("drops stale local sandbox registry entries when the live sandbox is gone", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-stale-sandbox-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "stale-sandbox-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const registry = require(${registryPath});
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
runner.runCapture = (command) => (_n(command).includes("sandbox get my-assistant") ? "" : "");

registry.registerSandbox({ name: "my-assistant" });

const { pruneStaleSandboxEntry } = require(${onboardPath});

const liveExists = pruneStaleSandboxEntry("my-assistant");
console.log(JSON.stringify({ liveExists, sandbox: registry.getSandbox("my-assistant") }));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payloadLine = result.stdout
      .trim()
      .split("\n")
      .slice()
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
    const payload = JSON.parse(payloadLine);
    assert.equal(payload.liveExists, false);
    assert.equal(payload.sandbox, null);
  });

  it(
    "builds the sandbox without uploading an external OpenClaw config file",
    { timeout: 90_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-create-sandbox-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "create-sandbox-check.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
const registerCalls = [];
const updateCalls = [];
const defaultCalls = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command);
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.registerSandbox = (entry) => {
  registerCalls.push(entry);
  return true;
};
registry.updateSandbox = (name, updates) => {
  updateCalls.push({ name, updates });
  return true;
};
registry.setDefault = (name) => {
  defaultCalls.push(name);
  return true;
};
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: _n(args[1][1]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4");
  console.log(JSON.stringify({ sandboxName, commands, registerCalls, updateCalls, defaultCalls }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);
      assert.equal(payload.sandboxName, "my-assistant");
      assert.deepEqual(payload.defaultCalls, ["my-assistant"]);
      assert.ok(
        payload.registerCalls.some(
          (entry: Record<string, unknown>) =>
            entry.name === "my-assistant" &&
            entry.model === "gpt-5.4" &&
            Object.prototype.hasOwnProperty.call(entry, "agentVersion"),
        ),
        "expected registry metadata for created sandbox",
      );
      assert.ok(
        payload.updateCalls.every(
          (call: { name: string; updates: Record<string, unknown> }) =>
            call.name === "my-assistant" && call.updates,
        ),
        "expected any registry metadata updates to target the created sandbox",
      );
      const createCommand = payload.commands.find((entry: CommandEntry) =>
        entry.command.includes("sandbox create"),
      );
      assert.ok(createCommand, "expected sandbox create command");
      assert.match(createCommand.command, /nemoclaw-start/);
      assert.doesNotMatch(createCommand.command, /--upload/);
      assert.doesNotMatch(createCommand.command, /OPENCLAW_CONFIG_PATH/);
      assert.doesNotMatch(createCommand.command, /NVIDIA_API_KEY=/);
      assert.doesNotMatch(createCommand.command, /DISCORD_BOT_TOKEN=/);
      assert.doesNotMatch(createCommand.command, /SLACK_BOT_TOKEN=/);
      assert.ok(
        payload.commands.some(
          (entry: CommandEntry) =>
            entry.command.includes("forward start --background 18789 my-assistant") ||
            entry.command.includes("forward start --background 0.0.0.0:18789 my-assistant"),
        ),
        "expected dashboard forward (loopback or WSL 0.0.0.0)",
      );
    },
  );

  it("binds the dashboard forward to 0.0.0.0 when CHAT_UI_URL points to a remote host", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-remote-forward-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-remote-forward.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command);
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: _n(args[1][1]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.CHAT_UI_URL = "https://chat.example.com";
  await createSandbox(null, "gpt-5.4");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = parseStdoutJson<CommandEntry[]>(result.stdout);
    assert.ok(
      commands.some((entry: CommandEntry) =>
        entry.command.includes("forward start --background 0.0.0.0:18789 my-assistant"),
      ),
      "expected remote dashboard forward target",
    );
  });

  it("injects NEMOCLAW_DASHBOARD_PORT into sandbox create envArgs when set (#1925)", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dashboard-port-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "dashboard-port-envargs.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runFile = (file, args = [], opts = {}) => {
  commands.push({ command: _n([file, ...args]), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  // Custom port: dashboard readiness curl uses 19000 (DASHBOARD_PORT from env)
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command);
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 19000 12345 running";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: _n(args[1][1]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    // Strip CHAT_UI_URL so createSandbox falls back to http://127.0.0.1:19000.
    // Without this, a CHAT_UI_URL set in the developer's shell or CI would be
    // inherited, causing chatUiUrl to use the wrong port and making the forward
    // command assertion below fail spuriously.
    const { CHAT_UI_URL: _stripped, ...inheritedEnv } = process.env;
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...inheritedEnv,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_DASHBOARD_PORT: "19000",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payloadLine = result.stdout
      .trim()
      .split("\n")
      .slice()
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
    const payload = JSON.parse(payloadLine);
    const createCommand = payload.commands.find((entry: CommandEntry) =>
      entry.command.includes("sandbox create"),
    );
    assert.ok(createCommand, "expected sandbox create command");
    // Part 1 of fix (#1925): NEMOCLAW_DASHBOARD_PORT must be in envArgs so
    // nemoclaw-start.sh can unconditionally override CHAT_UI_URL at runtime,
    // overriding whatever value the Docker image had baked in.
    assert.match(createCommand.command, /NEMOCLAW_DASHBOARD_PORT=19000/);
    // Forward must use same-port mapping (openshell does not support asymmetric)
    assert.ok(
      payload.commands.some(
        (entry: CommandEntry) =>
          entry.command.includes("forward start --background 19000 my-assistant") ||
          entry.command.includes("forward start --background 0.0.0.0:19000 my-assistant"),
      ),
      "expected dashboard forward for port 19000",
    );
    assert.ok(
      !payload.commands.some((entry: CommandEntry) => entry.command.includes("19000:18789")),
      "forward must not use asymmetric 19000:18789 mapping",
    );
    assert.ok(
      !payload.commands.some((entry: CommandEntry) => entry.command.includes("19000:19000")),
      "forward must not use port:port form (openshell does not support it)",
    );
  });

  it(
    "non-interactive exits with error when existing sandbox is not ready",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-noninteractive-notready-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "noninteractive-notready.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const childProcess = require("node:child_process");

runner.run = (command) => {
  if (_n(command).includes("sandbox delete")) {
    throw new Error("unexpected sandbox delete");
  }
  return { status: 0 };
};
runner.runCapture = (command) => {
  // Existing sandbox that is NOT ready
  if (_n(command).includes("sandbox get my-assistant")) return "my-assistant";
  if (_n(command).includes("sandbox list")) return "my-assistant NotReady";
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });
childProcess.spawn = () => {
  throw new Error("unexpected sandbox create");
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log("ERROR_DID_NOT_EXIT");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      };
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.notEqual(result.status, 0, "expected non-zero exit for not-ready sandbox");
      assert.ok(
        !result.stdout.includes("ERROR_DID_NOT_EXIT"),
        "should have exited before reaching sandbox create",
      );
      const output = (result.stdout || "") + (result.stderr || "");
      assert.ok(
        output.includes("--recreate-sandbox") || output.includes("NEMOCLAW_RECREATE_SANDBOX"),
        "should hint about --recreate-sandbox flag",
      );
    },
  );

  it(
    "recreate-sandbox flag forces deletion and recreation of a ready sandbox",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-recreate-flag-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "recreate-flag.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "my-assistant";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  if (_n(command).includes("forward list")) return "";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command, {
      defaultCurlOutput: "ok",
    });
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;

const preflight = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"))});
preflight.checkPortAvailable = async () => ({ ok: true });

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: _n(args[1][1]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_RECREATE_SANDBOX = "1";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.ok(
        payload.commands.some((entry: CommandEntry) => entry.command.includes("sandbox delete")),
        "should delete existing sandbox when --recreate-sandbox is set",
      );
      assert.ok(
        payload.commands.some((entry: CommandEntry) => entry.command.includes("sandbox create")),
        "should create a new sandbox when --recreate-sandbox is set",
      );
    },
  );

  it(
    "recreating a sandbox preserves the user's policy preset selections",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-recreate-preserves-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "recreate-preserves.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const sessionModulePath = JSON.stringify(
        path.join(repoRoot, "dist", "lib", "state", "onboard-session.js"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const onboardSession = require(${sessionModulePath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "my-assistant";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  if (_n(command).includes("forward list")) return "";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command, {
      defaultCurlOutput: "ok",
    });
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  return "";
};

// Existing sandbox has a custom preset selection: only "npm" (not the
// full "balanced" tier). Recreating the sandbox must preserve this
// customisation rather than reverting to the tier defaults.
registry.getSandbox = () => ({
  name: "my-assistant",
  gpuEnabled: false,
  policies: ["npm"],
  policyTier: "balanced",
});
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;

const preflight = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"))});
preflight.checkPortAvailable = async () => ({ ok: true });

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: _n(args[1][1]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_RECREATE_SANDBOX = "1";
  await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  const session = onboardSession.loadSession();
  console.log(JSON.stringify({ policyPresets: session && session.policyPresets }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.deepEqual(
        payload.policyPresets,
        ["npm"],
        "createSandbox should write the previous sandbox's policy presets to the onboard session before destroying it so they can be reapplied after recreation",
      );
    },
  );

  it(
    "interactive mode prompts before reusing an existing ready sandbox",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-interactive-reuse-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "interactive-reuse.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const commands = [];
runner.run = (command, opts = {}) => {
  const commandString = Array.isArray(command) ? command.join(" ") : String(command);
  if (_n(command).includes("sandbox download")) {
    const parts = commandString.match(/'([^']*)'/g) || [];
    const downloadDir = Array.isArray(command)
      ? String(command[command.length - 1] || "")
      : parts.length
        ? parts[parts.length - 1].slice(1, -1)
        : null;
    if (downloadDir) {
      fs.mkdirSync(downloadDir, { recursive: true });
      fs.writeFileSync(
        path.join(downloadDir, "config.json"),
        JSON.stringify({ provider: "nvidia-prod", model: "gpt-5.4" }),
      );
    }
  }
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runFile = (file, args = [], opts = {}) => {
  commands.push({ type: "runFile", command: _n([file, ...args]), file, args, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "my-assistant";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });

// Mock prompt to return "y" (reuse)
credentials.prompt = async () => "y";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: args[1]?.[1] || String(args[0]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      // Run WITHOUT NEMOCLAW_NON_INTERACTIVE to exercise interactive path
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      };
      delete env["NEMOCLAW_NON_INTERACTIVE"];
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.equal(payload.sandboxName, "my-assistant", "should reuse when user answers y");
      assert.ok(
        payload.commands.every((entry: CommandEntry) => !entry.command.includes("sandbox create")),
        "should NOT recreate sandbox when user chooses to reuse",
      );
      assert.ok(
        payload.commands.every((entry: CommandEntry) => !entry.command.includes("sandbox delete")),
        "should NOT delete sandbox when user chooses to reuse",
      );
      assert.ok(
        result.stdout.includes("already exists"),
        "should show 'already exists' message in interactive mode",
      );
    },
  );

  it(
    "interactive mode deletes and recreates sandbox when user confirms drift recreate",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-interactive-decline-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "interactive-decline.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const commands = [];
runner.run = (command, opts = {}) => {
  const commandString = Array.isArray(command) ? command.join(" ") : String(command);
  if (_n(command).includes("sandbox download")) {
    const parts = commandString.match(/'([^']*)'/g) || [];
    const downloadDir = Array.isArray(command)
      ? String(command[command.length - 1] || "")
      : parts.length
        ? parts[parts.length - 1].slice(1, -1)
        : null;
    if (downloadDir) {
      fs.mkdirSync(downloadDir, { recursive: true });
      fs.writeFileSync(
        path.join(downloadDir, "config.json"),
        JSON.stringify({ provider: "openai-prod", model: "gpt-4o" }),
      );
    }
  }
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runFile = (file, args = [], opts = {}) => {
  commands.push({ type: "runFile", command: _n([file, ...args]), file, args, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "my-assistant";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  if (_n(command).includes("forward list")) return "";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command, {
      defaultCurlOutput: "ok",
    });
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;

const preflight = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"))});
preflight.checkPortAvailable = async () => ({ ok: true });

// Mock prompt to return "y" (confirm recreate)
credentials.prompt = async () => "y";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: _n(args[1][1]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      // Run WITHOUT NEMOCLAW_NON_INTERACTIVE to exercise interactive path
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      };
      delete env["NEMOCLAW_NON_INTERACTIVE"];
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.ok(
        payload.commands.some((entry: CommandEntry) =>
          /sandbox.*delete/.test(String(entry.command)),
        ),
        "should delete existing sandbox when user confirms recreate",
      );
      assert.ok(
        payload.commands.some((entry: CommandEntry) =>
          /sandbox.*create/.test(String(entry.command)),
        ),
        "should create a new sandbox when user confirms recreate",
      );
      assert.ok(
        result.stdout.includes("requested inference selection changed"),
        "should show drift warning before prompting",
      );
    },
  );

  it(
    "interactive mode auto-recreates when existing sandbox is not ready",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-interactive-notready-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "interactive-notready.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
let sandboxDeleted = false;
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  if (_n(command).includes("sandbox delete")) sandboxDeleted = true;
  return { status: 0 };
};
runner.runCapture = (command) => {
  // Existing sandbox that is NOT ready initially, becomes Ready after recreation
  if (_n(command).includes("sandbox get my-assistant")) return "my-assistant";
  if (_n(command).includes("sandbox list")) {
    return sandboxDeleted ? "my-assistant Ready" : "my-assistant NotReady";
  }
  if (_n(command).includes("forward list")) return "";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command, {
      defaultCurlOutput: "ok",
    });
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;

const preflight = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"))});
preflight.checkPortAvailable = async () => ({ ok: true });

// User confirms recreation when prompted
credentials.prompt = async () => "y";

const fakeSpawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: _n(args[1][1]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};
childProcess.spawn = fakeSpawn;

// Also patch spawn inside the compiled sandbox-create-stream module.
// It imports spawn at load time from "node:child_process", so patching the
// childProcess object above does not reach it. Patch the cached module
// directly so streamSandboxCreate (called by createSandbox) doesn't spawn
// a real bash process that tries to hit a live gateway.
const sandboxCreateStreamMod = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "sandbox", "create-stream.js"))});
const _origStreamCreate = sandboxCreateStreamMod.streamSandboxCreate;
sandboxCreateStreamMod.streamSandboxCreate = (command, env, options = {}) => {
  return _origStreamCreate(command, env, { ...options, spawnImpl: fakeSpawn });
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      // Run WITHOUT NEMOCLAW_NON_INTERACTIVE to exercise interactive path
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      };
      delete env["NEMOCLAW_NON_INTERACTIVE"];
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.ok(
        payload.commands.some((entry: CommandEntry) => entry.command.includes("sandbox delete")),
        "should delete not-ready sandbox after user confirms",
      );
      assert.ok(
        payload.commands.some((entry: CommandEntry) => entry.command.includes("sandbox create")),
        "should recreate sandbox when existing one is not ready",
      );
      assert.ok(result.stdout.includes("not ready"), "should mention sandbox is not ready");
    },
  );
  it(
    "continues once the sandbox is Ready even if the create stream never closes",
    { timeout: 20000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-create-ready-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "create-sandbox-ready-check.js");
      const payloadPath = path.join(tmpDir, "payload.json");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");

const commands = [];
let sandboxListCalls = 0;
const keepAlive = setInterval(() => {}, 1000);
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) {
    sandboxListCalls += 1;
    return sandboxListCalls >= 2 ? "my-assistant Ready" : "my-assistant Pending";
  }
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command);
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.unrefCalls = 0;
  child.stdout.destroyCalls = 0;
  child.stderr.destroyCalls = 0;
  child.stdout.destroy = () => {
    child.stdout.destroyCalls += 1;
  };
  child.stderr.destroy = () => {
    child.stderr.destroyCalls += 1;
  };
  child.unref = () => {
    child.unrefCalls += 1;
  };
  child.kill = (signal) => {
    child.killCalls.push(signal);
    process.nextTick(() => child.emit("close", signal === "SIGTERM" ? 0 : 1));
    return true;
  };
  commands.push({ command: _n(args[1][1]), env: args[2]?.env || null, child });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4");
  const createCommand = commands.find((entry) => entry.command.includes("sandbox create"));
  fs.writeFileSync(${JSON.stringify(payloadPath)}, JSON.stringify({
    sandboxName,
    sandboxListCalls,
    killCalls: createCommand.child.killCalls,
    unrefCalls: createCommand.child.unrefCalls,
    stdoutDestroyCalls: createCommand.child.stdout.destroyCalls,
    stderrDestroyCalls: createCommand.child.stderr.destroyCalls,
  }));
  clearInterval(keepAlive);
})().catch((error) => {
  clearInterval(keepAlive);
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
          OPENSHELL_DRIVERS: "docker",
        },
        timeout: 15000,
      });

      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
      assert.equal(payload.sandboxName, "my-assistant");
      assert.ok(payload.sandboxListCalls >= 2);
      assert.deepEqual(payload.killCalls, ["SIGTERM"]);
      assert.equal(payload.unrefCalls, 1);
      assert.equal(payload.stdoutDestroyCalls, 1);
      assert.equal(payload.stderrDestroyCalls, 1);
    },
  );

  it("restores the dashboard forward when onboarding reuses an existing ready sandbox", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-reuse-forward-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "reuse-sandbox-forward.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "my-assistant";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.CHAT_UI_URL = "https://chat.example.com";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      sandboxName: string;
      commands: CommandEntry[];
    }>(result.stdout);
    assert.equal(payload.sandboxName, "my-assistant");
    assert.ok(
      payload.commands.some((entry: CommandEntry) =>
        entry.command.includes("forward start --background 0.0.0.0:18789 my-assistant"),
      ),
      "expected dashboard forward restore on sandbox reuse",
    );
    assert.ok(
      payload.commands.every((entry: CommandEntry) => !entry.command.includes("sandbox create")),
      "did not expect sandbox create when reusing existing sandbox",
    );
  });

  it("accepts gateway inference when system inference is separately not configured", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-inference-get-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "inference-get-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
      "",
      "System inference:",
      "",
      "  Not configured",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;
process.env.OPENAI_API_KEY = "sk-secret-value";
process.env.OPENSHELL_GATEWAY = "nemoclaw";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = parseStdoutJson<string[]>(result.stdout);
    // gateway select + provider get + provider update + inference set
    assert.equal(commands.length, 4);
  });

  it("accepts gateway inference output that omits the Route line", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-inference-route-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "inference-route-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
      "",
      "System inference:",
      "",
      "  Not configured",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;
process.env.OPENAI_API_KEY = "sk-secret-value";
process.env.OPENSHELL_GATEWAY = "nemoclaw";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = parseStdoutJson<string[]>(result.stdout);
    // gateway select + provider get + provider update + inference set
    assert.equal(commands.length, 4);
  });

  it("regression #1881: registry.updateSandbox(model/provider) is called AFTER createSandbox", () => {
    // updateSandbox() silently no-ops when the entry does not exist yet.
    // This asserts that the model/provider update comes AFTER createSandbox()
    // returns, not before registerSandbox() is called (the original bug).
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );
    const createSandboxPos = source.indexOf("sandboxName = await createSandbox(");
    assert.ok(createSandboxPos !== -1, "createSandbox call not found in onboard.ts");
    const updateAfterCreate = source.indexOf(
      "registry.updateSandbox(sandboxName, {",
      createSandboxPos,
    );
    assert.ok(
      updateAfterCreate !== -1,
      "registry.updateSandbox(model, provider) must appear AFTER createSandbox() — regression #1881",
    );
  });

  // ── Base image digest pinning (#1904) ──────────────────────────

  it("regression #1904: pullAndResolveBaseImageDigest uses sandbox-base registry", () => {
    // Structural check: verify the constant matches the Dockerfile default
    // and does NOT reference the openshell-community registry.
    assert.ok(
      SANDBOX_BASE_IMAGE.includes("nemoclaw/sandbox-base"),
      `SANDBOX_BASE_IMAGE must reference nemoclaw/sandbox-base, got: ${SANDBOX_BASE_IMAGE}`,
    );
    assert.ok(
      !SANDBOX_BASE_IMAGE.includes("openshell-community"),
      `SANDBOX_BASE_IMAGE must NOT reference openshell-community, got: ${SANDBOX_BASE_IMAGE}`,
    );
  });

  it("regression #1904: createSandbox calls pullAndResolveBaseImageDigest before patchStagedDockerfile", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
      "utf-8",
    );
    const pullPos = source.search(/const resolved = pullAndResolveBaseImageDigest\s*\(/);
    assert.ok(pullPos !== -1, "pullAndResolveBaseImageDigest call not found in onboard.ts");
    const patchPos = source.indexOf("patchStagedDockerfile(", pullPos);
    assert.ok(
      patchPos > pullPos,
      "pullAndResolveBaseImageDigest must be called BEFORE patchStagedDockerfile — regression #1904",
    );
  });

});
