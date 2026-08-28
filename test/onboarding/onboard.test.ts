// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getBuildIdentity } from "../../src/lib/core/version.js";
import { appendHostProxyEnvArgs } from "../../src/lib/onboard/host-proxy-env.js";
import {
  isValidInferenceInputsOverride,
  maybePromptForInferenceInputCapability,
  shouldPromptForInferenceInputCapability,
} from "../../src/lib/onboard/inference-input-capability.js";
import { createInferenceRouteHelpers } from "../../src/lib/onboard/inference-route.js";
import type { SetupInference, SetupInferenceDeps } from "../../src/lib/onboard/setup-inference.js";
import { stageOptimizedSandboxBuildContext } from "../../src/lib/sandbox/build-context.js";
import { writeOkOpenshell } from "../helpers/onboard-openshell-fixture";
import { testTimeoutOptions } from "../helpers/timeouts";
import {
  createDirectSetupInferenceHarnessFactory,
  runProductionSetupInferenceCredentialBoundary,
  withProcessEnv,
} from "../support/setup-inference-test-harness.js";

type ShimScalar = string | number | boolean | null | undefined;
type ShimCallable = (...args: readonly string[]) => ShimValue;
type ShimValue = ShimScalar | { [key: string]: ShimValue } | ShimValue[] | ShimCallable;
type ShimFn<TReturn = void> = (...args: ShimValue[]) => TReturn;
type CommandEntry = {
  command: string;
  env?: Record<string, string | undefined>;
  ignoreError?: boolean;
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
  clearAgentScopedResumeState: <T extends Record<string, unknown>>(
    session: T,
    selectedAgentName: string,
  ) => T;
  arePolicyPresetsApplied: (sandboxName: string, selectedPresets?: string[]) => boolean;
  pullAndResolveBaseImageDigest: () => { digest: string | null; ref: string } | null;
  createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
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

const loadedOnboardInternals = require("../../src/lib/onboard");
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
  clearAgentScopedResumeState,
  arePolicyPresetsApplied,
  createSetupInference,
  SANDBOX_BASE_IMAGE,
} = onboardTestInternals;

const createDirectSetupInferenceHarness =
  createDirectSetupInferenceHarnessFactory(createSetupInference);

describe("onboard helpers", () => {
  it("does not treat an empty policy preset selection as already applied (#6042)", () => {
    expect(arePolicyPresetsApplied("unused", [])).toBe(false);
  });

  it("adds host proxy variables to sandbox startup env args", () => {
    const envArgs = ["CHAT_UI_URL=http://127.0.0.1:18789"];

    appendHostProxyEnvArgs(envArgs, {
      HTTP_PROXY: "http://127.0.0.1:8888",
      HTTPS_PROXY: "http://127.0.0.1:8888",
      NO_PROXY: "corp.internal",
    });

    expect(envArgs).toContain("HTTP_PROXY=http://127.0.0.1:8888");
    expect(envArgs).toContain("HTTPS_PROXY=http://127.0.0.1:8888");
    const noProxy = envArgs.find((entry) => entry.startsWith("NO_PROXY="));
    expect(noProxy).toContain("corp.internal");
    expect(noProxy).toContain("localhost");
    expect(noProxy).toContain("127.0.0.1");
    expect(noProxy).toContain("host.docker.internal");
  });

  it("does not add NO_PROXY-only values when no host proxy is configured", () => {
    const envArgs = ["CHAT_UI_URL=http://127.0.0.1:18789"];

    appendHostProxyEnvArgs(envArgs, {
      NO_PROXY: "corp.internal",
    });

    expect(envArgs).toEqual(["CHAT_UI_URL=http://127.0.0.1:18789"]);
  });

  it.each([
    ["HTTP_PROXY", "  http://127.0.0.1:8888  "],
    ["HTTPS_PROXY", "\thttp://127.0.0.1:8888\n"],
  ])("trims surrounding whitespace from %s before forwarding", (name, value) => {
    // A `HTTP_PROXY="  http://x:8888  "` from a sloppy shell rc must not
    // flow through with surrounding whitespace — downstream consumers
    // that don't re-trim would treat the value as malformed.
    const envArgs: string[] = [];

    appendHostProxyEnvArgs(envArgs, { [name]: value });

    const forwarded = envArgs.find((entry) => entry.startsWith(`${name}=`));
    expect(forwarded).toBe(`${name}=http://127.0.0.1:8888`);
    expect(forwarded, "the forwarded entry must not contain surrounding whitespace").toBe(
      forwarded?.trim(),
    );
  });

  it.each(["NO_PROXY", "no_proxy"])(
    "synthesizes %s in the sandbox for case-sensitive consumers",
    (name) => {
      // `withLocalNoProxy` augments both NO_PROXY and no_proxy regardless of
      // which one the user originally set. A user who only sets HTTP_PROXY
      // (with no NO_PROXY at all) still gets both cases synthesized in the
      // sandbox so case-sensitive consumers (e.g. some Python libs read
      // `no_proxy` lowercase, Node fetch checks `NO_PROXY`) all honor the
      // localhost/Docker-host carve-outs. Pinning the dual-key behavior so a
      // future refactor of `withLocalNoProxy` doesn't silently drop one case.
      const envArgs: string[] = [];

      appendHostProxyEnvArgs(envArgs, {
        HTTP_PROXY: "http://127.0.0.1:8888",
      });

      const value = envArgs.find((entry) => entry.startsWith(`${name}=`));
      expect(value, `${name} should be synthesized`).toBeDefined();
      expect(value).toContain("localhost");
      expect(value).toContain("127.0.0.1");
      expect(value).toContain("host.docker.internal");
    },
  );

  it.each(["NO_PROXY", "no_proxy"])("seeds managed hosts into sandbox-create %s", (name) => {
    // Boundary pin: appendHostProxyEnvArgs() forwards env into `openshell
    // sandbox create -- env ...`, and OpenShell consults the seeded
    // NO_PROXY at sandbox-create time when deciding whether to chain its
    // L7 proxy through the host HTTP_PROXY for a given hostname. Both
    // `inference.local` (OpenShell-managed inference) and
    // `host.containers.internal` (rootless container host alias) must be
    // emitted here so the L7 proxy never tunnels them through the host
    // proxy. The complementary runtime exclusion (nemoclaw-start.sh sets a
    // narrower NO_PROXY without inference.local once sandbox boots) is
    // asserted in test/runtime/gateway/service-env.test.ts.
    const envArgs: string[] = [];

    appendHostProxyEnvArgs(envArgs, {
      HTTP_PROXY: "http://127.0.0.1:8118",
    });

    const value = envArgs.find((entry) => entry.startsWith(`${name}=`));
    expect(value, `${name} should be synthesized`).toBeDefined();
    const parts = (value ?? "").split("=")[1]?.split(",") ?? [];
    expect(parts).toContain("inference.local");
    expect(parts).toContain("host.containers.internal");
  });

  it("propagates NEMOCLAW_MINIMAL_BOOTSTRAP=1 from host into sandbox env (#2598)", () => {
    const envArgs: string[] = [];
    appendHostProxyEnvArgs(envArgs, { NEMOCLAW_MINIMAL_BOOTSTRAP: "1" });
    expect(envArgs).toContain("NEMOCLAW_MINIMAL_BOOTSTRAP=1");
  });

  it.each([[undefined], [""], ["0"], ["true"], ["yes"]])(
    "omits NEMOCLAW_MINIMAL_BOOTSTRAP for %j (#2598)",
    (value) => {
      const envArgs: string[] = [];
      const env: NodeJS.ProcessEnv =
        value === undefined ? {} : { NEMOCLAW_MINIMAL_BOOTSTRAP: value };
      appendHostProxyEnvArgs(envArgs, env);
      expect(envArgs.some((e) => e.startsWith("NEMOCLAW_MINIMAL_BOOTSTRAP="))).toBe(false);
    },
  );

  it(
    "prints owning-deployment guidance when NemoClaw does not launch the gateway (#9120)",
    testTimeoutOptions(20_000),
    () => {
      // Intentional process-contract coverage: this case verifies the real
      // child exit status and stderr guidance across the Node -> OpenShell
      // adapter boundary.
      const repoRoot = path.join(import.meta.dirname, "../..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-diag-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "gateway-diag.cjs");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));

      fs.mkdirSync(fakeBin, { recursive: true });
      // No gateway metadata is available, so the external-launcher branch
      // prints recovery guidance and exits.
      fs.writeFileSync(
        path.join(fakeBin, "openshell"),
        `#!/usr/bin/env bash
exit 1
`,
        { mode: 0o755 },
      );

      // FreeBSD selects the external gateway launcher branch in the current
      // provider plan.
      const script = `
Object.defineProperty(process, "platform", { value: "freebsd" });
const { startGateway } = require(${onboardPath});
startGateway(null).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
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

      assert.match(result.stderr, /does not start the 'nemoclaw' gateway on this host/u);
      assert.match(result.stderr, /deployment that owns the gateway process/u);
      assert.match(result.stderr, /openshell gateway select nemoclaw/u);
      assert.doesNotMatch(result.stderr, /openshell gateway start/u);
    },
  );

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

  it("ignores an incomplete session sandbox name when checking resume conflicts (#2753)", () => {
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

  it("prompts for input capability only on likely multimodal model names", () => {
    expect(shouldPromptForInferenceInputCapability("nvidia/nemotron-3-nano-omni-30b-a3b")).toBe(
      true,
    );
    expect(shouldPromptForInferenceInputCapability("qwen2.5-vl-72b")).toBe(true);
    expect(shouldPromptForInferenceInputCapability("moonshotai/kimi-k2.6")).toBe(false);
    expect(shouldPromptForInferenceInputCapability(null)).toBe(false);
  });

  it("accepts only supported inference input capability overrides", () => {
    expect(isValidInferenceInputsOverride("text")).toBe(true);
    expect(isValidInferenceInputsOverride("image")).toBe(true);
    expect(isValidInferenceInputsOverride("text,image")).toBe(true);
    expect(isValidInferenceInputsOverride("image,text")).toBe(true);
    expect(isValidInferenceInputsOverride("text,text")).toBe(false);
    expect(isValidInferenceInputsOverride("image,image")).toBe(false);
    expect(isValidInferenceInputsOverride("text, image")).toBe(false);
    expect(isValidInferenceInputsOverride("audio")).toBe(false);
  });

  it("normalizes invalid inference input capability overrides when choosing text only", async () => {
    const env = {
      NEMOCLAW_INFERENCE_INPUTS: "audio",
    } as NodeJS.ProcessEnv;

    await maybePromptForInferenceInputCapability("nvidia/nemotron-3-nano-omni-30b-a3b", {
      env,
      isNonInteractive: () => false,
      prompt: async () => "",
    });

    expect(env.NEMOCLAW_INFERENCE_INPUTS).toBe("text");
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

  it("does not treat a requested agent change as a hard resume conflict", () => {
    expect(
      getResumeConfigConflicts(
        {
          sandboxName: "my-assistant",
          agent: "openclaw",
        },
        { agent: "hermes" },
      ),
    ).toEqual([]);
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

  it("clears agent-scoped provider state when a resume switches from Hermes to OpenClaw", () => {
    const completeStep = {
      status: "complete",
      startedAt: "2026-05-19T00:00:00.000Z",
      completedAt: "2026-05-19T00:01:00.000Z",
      error: null,
    };
    const session = {
      agent: "hermes",
      provider: "hermes-provider",
      model: "moonshotai/kimi-k2.6",
      endpointUrl: "https://8.8.8.8/v1",
      credentialEnv: "NOUS_API_KEY",
      hermesAuthMethod: "oauth",
      hermesToolGateways: ["nous-web"],
      preferredInferenceApi: "openai-completions",
      nimContainer: "nim-hermes",
      routerPid: 123,
      routerCredentialHash: "hash",
      sandboxName: "hermes-box",
      webSearchConfig: { fetchEnabled: true, provider: "tavily" },
      messagingPlan: null,
      resourceProfile: { cpu: "75%", memory: "75%" },
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: true,
        resourceProfile: true,
      },
      policyPresets: ["nous-web", "brave"],
      lastCompletedStep: "policies",
      lastStepStarted: "policies",
      steps: {
        preflight: { ...completeStep },
        gateway: { ...completeStep },
        provider_selection: { ...completeStep },
        inference: { ...completeStep },
        sandbox: { ...completeStep },
        openclaw: { ...completeStep },
        agent_setup: { ...completeStep },
        policies: { ...completeStep },
      },
    };

    const cleared = clearAgentScopedResumeState(session, "openclaw") as typeof session;

    expect(cleared.agent).toBeNull();
    expect(cleared.provider).toBeNull();
    expect(cleared.model).toBeNull();
    expect(cleared.endpointUrl).toBeNull();
    expect(cleared.credentialEnv).toBeNull();
    expect(cleared.hermesAuthMethod).toBeNull();
    expect(cleared.hermesToolGateways).toBeNull();
    expect(cleared.preferredInferenceApi).toBeNull();
    expect(cleared.nimContainer).toBeNull();
    expect(cleared.routerPid).toBeNull();
    expect(cleared.routerCredentialHash).toBeNull();
    expect(cleared.sandboxName).toBe("hermes-box");
    expect(cleared.webSearchConfig).toBeNull();
    expect(cleared.messagingPlan).toBeNull();
    expect(cleared.resourceProfile).toEqual({ cpu: "75%", memory: "75%" });
    expect(cleared.sandboxPromptProgress).toEqual({
      sandboxName: false,
      webSearch: false,
      messaging: false,
      resourceProfile: true,
    });
    expect(cleared.policyPresets).toBeNull();
    expect(cleared.steps.gateway.status).toBe("complete");
    expect(cleared.steps.provider_selection.status).toBe("pending");
    expect(cleared.steps.sandbox.status).toBe("pending");
    expect(cleared.steps.policies.status).toBe("pending");
    expect(cleared.lastCompletedStep).toBe("gateway");
    expect(cleared.lastStepStarted).toBeNull();
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
    const repoRoot = path.join(import.meta.dirname, "../..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-"));

    try {
      const { buildCtx, stagedDockerfile } = stageOptimizedSandboxBuildContext(repoRoot, tmpDir);

      expect(stagedDockerfile).toBe(path.join(buildCtx, "Dockerfile"));
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw", "package-lock.json"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw", "src"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw-blueprint", ".venv"))).toBe(false);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "nemoclaw-start.sh"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "patch-openclaw-tool-catalog.mts"))).toBe(
        true,
      );
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
    const credentialValue = "nvapi-TEST-NOT-A-REAL-VALUE";
    const { credentialEvidence: evidence } = runProductionSetupInferenceCredentialBoundary({
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      credentialValue,
      model: "nvidia/nemotron-3-super-120b-a12b",
      provider: "nvidia-nim",
    });
    assert.match(evidence.providerCommand.argv.join(" "), /--credential NVIDIA_INFERENCE_API_KEY/);
    assert.deepEqual(evidence.argvContainingSecret, []);
    assert.deepEqual(evidence.secretBearingCommands, ["provider update"]);
    assert.equal(evidence.providerCommand.env.NVIDIA_INFERENCE_API_KEY, credentialValue);
    assert.deepEqual(evidence.unscopedCommandKinds, []);
    assert.deepEqual(evidence.unscopedCredentialValues, []);
    assert.deepEqual(evidence.unscopedCommandsContainingSecret, []);
    assert.deepEqual(evidence.setupCredentialValues, [credentialValue, credentialValue]);
    assert.equal(evidence.parentCredentialUnchanged, true);
  });

  it("restores the dashboard forward when onboarding reuses an existing ready sandbox", async () => {
    const repoRoot = path.join(import.meta.dirname, "../..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-reuse-forward-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "reuse-sandbox-forward.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const onboardScriptMocksPath = JSON.stringify(
      path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOkOpenshell(fakeBin);

    const script = String.raw`
	const runner = require(${runnerPath});
	const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
	const registry = require(${registryPath});
	const fixtureMocks = require(${onboardScriptMocksPath});
	const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
const existingSandbox = fixtureMocks.createCreatedSandboxFixture({ lifecycleState: "created" });
existingSandbox.installRuntimeObservation();
const sandboxCommand = (command) => Array.isArray(command) ? command : _n(command).split(/\s+/u);
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
	  const profileResult = fixtureMocks.mockEndpointlessProviderProfileRun(command, "nemoclaw-mcp-v1", false);
  if (profileResult !== null) return profileResult;
  return existingSandbox.run(sandboxCommand(command)) ?? { status: 0 };
};
runner.runCapture = (command) => {
  const sandboxResult = existingSandbox.run(sandboxCommand(command));
  if (sandboxResult !== null) return sandboxResult.status === 0 ? sandboxResult.stdout.toString() : "";
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
	registry.getSandbox = () => fixtureMocks.managedSandboxPolicyReceiptFixture({
	  name: "my-assistant",
	  toolDisclosure: "progressive",
	}, { sandboxId: existingSandbox.state.sandboxId });

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => child.emit("close", 0));
  return child;
};

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
    assert.match(
      result.stdout,
      /Existing provider\/model selection is unreadable; reusing sandbox\./,
    );
  });

  it("accepts gateway inference when system inference is separately not configured", async () => {
    const output = [
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
    ].join("\n");
    const route = createInferenceRouteHelpers(() => output);

    await withProcessEnv({ OPENAI_API_KEY: "sk-TEST-NOT-A-REAL-VALUE" }, async () => {
      const harness = createDirectSetupInferenceHarness({
        runOpenshell: (args) =>
          args.slice(0, 2).join(" ") === "provider get"
            ? { status: 0, stdout: "", stderr: "" }
            : undefined,
        overrides: { verifyInferenceRoute: route.verifyInferenceRoute },
      });

      await harness.setupInference(
        "test-box",
        "gpt-5.4",
        "openai-api",
        "https://api.openai.com/v1",
        "OPENAI_API_KEY",
      );

      // openai provider profile validation + provider get + provider update + inference set
      assert.equal(
        harness.commands[0].command,
        "provider profile -g nemoclaw export openai --output json",
      );
      assert.equal(harness.commands.length, 4);
    });
  });
  it("accepts gateway inference output that omits the Route line", async () => {
    const output = [
      "Gateway inference:",
      "",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
      "",
      "System inference:",
      "",
      "  Not configured",
    ].join("\n");
    const route = createInferenceRouteHelpers(() => output);

    await withProcessEnv({ OPENAI_API_KEY: "sk-TEST-NOT-A-REAL-VALUE" }, async () => {
      const harness = createDirectSetupInferenceHarness({
        runOpenshell: (args) =>
          args.slice(0, 2).join(" ") === "provider get"
            ? { status: 0, stdout: "", stderr: "" }
            : undefined,
        overrides: { verifyInferenceRoute: route.verifyInferenceRoute },
      });

      await harness.setupInference(
        "test-box",
        "gpt-5.4",
        "openai-api",
        "https://api.openai.com/v1",
        "OPENAI_API_KEY",
      );

      // openai provider profile validation + provider get + provider update + inference set
      assert.equal(
        harness.commands[0].command,
        "provider profile -g nemoclaw export openai --output json",
      );
      assert.equal(harness.commands.length, 4);
    });
  });
  it("uses the sandbox-base registry in pullAndResolveBaseImageDigest (#1904)", () => {
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

  it("aborts createSandbox for missing BRAVE_API_KEY before any sandbox delete (#3626)", () => {
    // Regression: the Brave credential guard previously sat *after* the
    // recreate/sandbox-delete branch ran. A user with Brave enabled and no
    // BRAVE_API_KEY would lose their existing sandbox before seeing the abort.
    // Move it next to the credential lookup and assert no `sandbox delete`
    // command escapes before exit.
    const repoRoot = path.join(import.meta.dirname, "../..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-brave-abort-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "brave-abort-check.js");
    const outputPath = path.join(tmpDir, "outcome.json");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const outputPathLiteral = JSON.stringify(outputPath);

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOkOpenshell(fakeBin);

    const script = String.raw`
const fs = require("node:fs");
const runner = require(${runnerPath});

const openshellCalls = [];
runner.runOpenshell = (command) => {
  openshellCalls.push(Array.isArray(command) ? command.join(" ") : String(command));
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCaptureOpenshell = () => "";
runner.run = (command) => {
  openshellCalls.push("run: " + (Array.isArray(command) ? command.join(" ") : String(command)));
  return { status: 0 };
};

const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args.join(" "));
const originalExit = process.exit;
process.exit = (code) => {
  fs.writeFileSync(${outputPathLiteral}, JSON.stringify({ exitCode: code, errors, openshellCalls }));
  originalExit(code);
};

// Reproduce the bug scenario: Brave enabled, no key anywhere.
delete process.env.BRAVE_API_KEY;

const { createSandbox } = require(${onboardPath});
(async () => {
  await createSandbox(
    null,           // gpu
    "gpt-5.4",      // model
    "nvidia-prod",  // provider
    null,           // preferredInferenceApi
    "my-assistant", // sandboxNameOverride
    { fetchEnabled: true }, // webSearchConfig
  );
})().catch(() => {});
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
        NEMOCLAW_RECREATE_SANDBOX: "1",
        BRAVE_API_KEY: "",
      },
    });

    assert.ok(
      fs.existsSync(outputPath),
      `outcome file missing; exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const payload = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as {
      exitCode: number;
      errors: string[];
      openshellCalls: string[];
    };
    expect(payload.exitCode).toBe(1);
    expect(payload.errors.join("\n")).toMatch(/BRAVE_API_KEY is not available/);
    // The abort must run before *any* destructive openshell command —
    // most importantly `sandbox delete`. `forward list` is read-only and
    // happens earlier; only flag mutating commands here.
    const destructive = payload.openshellCalls.filter((c) =>
      /\bsandbox\s+(?:delete|create|rebuild)\b|\bprovider\s+(?:delete|create|update)\b/.test(c),
    );
    expect(destructive).toEqual([]);
  });

  it("rejects portable managed bootstrap before recreate state mutation (#9068)", () => {
    const repoRoot = path.join(import.meta.dirname, "../..");
    const catalogRevision = getBuildIdentity({ rootDir: repoRoot }).sourceRevision;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-managed-recreate-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "portable-managed-recreate.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const onboardSessionPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const catalogPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "managed-image", "catalog.ts"),
    );
    const contractPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "managed-image", "contract.ts"),
    );
    const protectionPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "sandbox-recreate-protection.ts"),
    );
    const journalPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "onboard-recreate-journal.ts"),
    );
    const scriptMocksPath = JSON.stringify(
      path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOkOpenshell(fakeBin);

    const script = String.raw`
const runner = require(${runnerPath});
require(${scriptMocksPath}).mockStandaloneGatewayTeardownAuthority();
const onboardSession = require(${onboardSessionPath});
onboardSession.loadSession = () => ({
  checkpoint: {
    profile: { kind: "selected", value: "portable" },
    runtimeAuthority: {
      kind: "selected",
      value: {
        schemaVersion: 1,
        kind: "podman",
        ownership: "current-user",
        uid: 1001,
        homeDir: "/home/tester",
        configHome: "/home/tester/.config",
        runtimeDir: "/run/user/1001",
        socketPath: "/run/user/1001/podman/podman.sock",
      },
    },
  },
});
const events = [];
const normalize = (command) =>
  (Array.isArray(command) ? command.join(" ") : String(command)).replace(/'/g, "");

const contract = require(${contractPath});
const catalog = require(${catalogPath});
catalog.resolveManagedImageCatalogFromGhcr = async ({ release, platform }) =>
  Object.fromEntries(contract.SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => {
    const image = contract.MANAGED_IMAGE_REPOSITORIES[agent];
    const digest = "sha256:" + String(index + 1).repeat(64);
    return [agent, {
      contractVersion: contract.MANAGED_IMAGE_CONTRACT_VERSION,
      agent,
      platform,
      image,
      digest,
      reference: image + "@" + digest,
      source: {
        repository: contract.MANAGED_IMAGE_SOURCE_REPOSITORY,
        revision: ${JSON.stringify(catalogRevision)},
        release,
        cohort: "ghrun-9068-1",
      },
      startupProfileContractVersion: contract.MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
      capabilityContractVersion: contract.MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
    }];
  }));

const protectionModule = require(${protectionPath});
const createProtection = protectionModule.createSandboxRecreateProtection;
protectionModule.createSandboxRecreateProtection = (...args) => {
  const protection = createProtection(...args);
  return {
    ...protection,
    backup: () => {
      events.push({ kind: "backup" });
      return { ok: true, backup: null, failureKind: "none" };
    },
  };
};

const journalModule = require(${journalPath});
const openJournal = journalModule.openOnboardRecreateJournal;
journalModule.openOnboardRecreateJournal = (...args) => {
  events.push({ kind: "openJournal" });
  return openJournal(...args);
};

const registry = require(${registryPath});
const sourceSandbox = {
  name: "my-assistant",
  agent: null,
  gpuEnabled: true,
  openshellDriver: "docker",
  imageTag: "openshell/sandbox-from:source",
  workload: {
    schemaVersion: 1,
    kind: "legacy-dockerfile",
    reference: "openshell/sandbox-from:source",
    shared: false,
  },
};
registry.getSandbox = () => sourceSandbox;
registry.registerSandbox = () => { events.push({ kind: "registerSandbox" }); return true; };
registry.updateSandbox = () => { events.push({ kind: "updateSandbox" }); return true; };
registry.removeSandbox = () => { events.push({ kind: "removeSandbox" }); return true; };

runner.run = (command) => {
  const value = normalize(command);
  events.push({ kind: "run", command: value });
  return { status: 0 };
};
runner.runCapture = (command) => {
  const value = normalize(command);
  if (value.includes("sandbox get") && value.includes("my-assistant")) {
    return "Name: my-assistant\nId: sbx-portable-source\n";
  }
  if (value.includes("sandbox list")) return "my-assistant Ready";
  if (value.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return require(${scriptMocksPath}).mockOnboardRunCapture(command, { defaultCurlOutput: "ok" }) || "";
};

const childProcess = require("node:child_process");
childProcess.spawn = () => {
  events.push({ kind: "spawn" });
  throw new Error("unexpected sandbox create");
};

const { createSandboxWithTemporaryManagedRuntime } = require(${onboardPath});
(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_RECREATE_SANDBOX = "1";
  try {
    await createSandboxWithTemporaryManagedRuntime(
      null,
      "gpt-5.4",
      "nvidia-prod",
      null,
      "my-assistant",
    );
    console.log(JSON.stringify({ error: "guard did not reject", events }));
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error), events }));
  }
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
      NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_RECREATE_SANDBOX: "1",
    };
    delete env.NEMOCLAW_RECREATE_WITHOUT_BACKUP;
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env,
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      error: string;
      events: Array<{ kind: string; command?: string }>;
    }>(result.stdout);
    expect(payload.error).toContain(
      "Portable OpenClaw onboarding cannot use managed-image bootstrap",
    );
    expect(
      payload.events.filter(
        (event) =>
          event.kind === "backup" ||
          event.kind === "openJournal" ||
          event.kind === "removeSandbox" ||
          event.kind === "registerSandbox" ||
          event.kind === "updateSandbox" ||
          event.kind === "spawn" ||
          /\bsandbox\s+(?:delete|create|rebuild)\b|\bprovider\s+(?:delete|create|update)\b/.test(
            event.command || "",
          ),
      ),
    ).toEqual([]);
  });
});
