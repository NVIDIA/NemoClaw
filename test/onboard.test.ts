// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendHostProxyEnvArgs } from "../src/lib/onboard/host-proxy-env.js";
import {
  isValidInferenceInputsOverride,
  maybePromptForInferenceInputCapability,
  shouldPromptForInferenceInputCapability,
} from "../src/lib/onboard/inference-input-capability.js";
import { createInferenceRouteHelpers } from "../src/lib/onboard/inference-route.js";
import type { SetupInference, SetupInferenceDeps } from "../src/lib/onboard/setup-inference.js";
import { stageOptimizedSandboxBuildContext } from "../src/lib/sandbox/build-context.js";
import { writeOkOpenshell } from "./helpers/onboard-openshell-fixture";
import { testTimeoutOptions } from "./helpers/timeouts";
import {
  createDirectSetupInferenceHarnessFactory,
  runProductionSetupInferenceCredentialBoundary,
  withProcessEnv,
} from "./support/setup-inference-test-harness.js";

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

const loadedOnboardInternals = require("../src/lib/onboard");
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
  createSetupInference,
  SANDBOX_BASE_IMAGE,
} = onboardTestInternals;

const createDirectSetupInferenceHarness =
  createDirectSetupInferenceHarnessFactory(createSetupInference);

describe("onboard helpers", () => {
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

  it("trims surrounding whitespace from proxy env values before forwarding", () => {
    // A `HTTP_PROXY="  http://x:8888  "` from a sloppy shell rc must not
    // flow through with surrounding whitespace — downstream consumers
    // that don't re-trim would treat the value as malformed.
    const envArgs: string[] = [];

    appendHostProxyEnvArgs(envArgs, {
      HTTP_PROXY: "  http://127.0.0.1:8888  ",
      HTTPS_PROXY: "\thttp://127.0.0.1:8888\n",
    });

    expect(envArgs).toContain("HTTP_PROXY=http://127.0.0.1:8888");
    expect(envArgs).toContain("HTTPS_PROXY=http://127.0.0.1:8888");
    for (const entry of envArgs) {
      expect(entry, "no forwarded entry should contain leading/trailing whitespace").toBe(
        entry.trim(),
      );
    }
  });

  it("synthesizes both NO_PROXY and no_proxy in the sandbox so case-sensitive consumers stay covered", () => {
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

    const upper = envArgs.find((e) => e.startsWith("NO_PROXY="));
    const lower = envArgs.find((e) => e.startsWith("no_proxy="));
    expect(upper, "NO_PROXY should be synthesized").toBeDefined();
    expect(lower, "no_proxy (lowercase) should also be synthesized").toBeDefined();
    for (const v of [upper, lower]) {
      expect(v).toContain("localhost");
      expect(v).toContain("127.0.0.1");
      expect(v).toContain("host.docker.internal");
    }
  });

  it("seeds inference.local and host.containers.internal into the sandbox-create NO_PROXY/no_proxy", () => {
    // Boundary pin: appendHostProxyEnvArgs() forwards env into `openshell
    // sandbox create -- env ...`, and OpenShell consults the seeded
    // NO_PROXY at sandbox-create time when deciding whether to chain its
    // L7 proxy through the host HTTP_PROXY for a given hostname. Both
    // `inference.local` (OpenShell-managed inference) and
    // `host.containers.internal` (rootless container host alias) must be
    // emitted here so the L7 proxy never tunnels them through the host
    // proxy. The complementary runtime exclusion (nemoclaw-start.sh sets a
    // narrower NO_PROXY without inference.local once sandbox boots) is
    // asserted in test/service-env.test.ts.
    const envArgs: string[] = [];

    appendHostProxyEnvArgs(envArgs, {
      HTTP_PROXY: "http://127.0.0.1:8118",
    });

    const upper = envArgs.find((e) => e.startsWith("NO_PROXY="));
    const lower = envArgs.find((e) => e.startsWith("no_proxy="));
    expect(upper, "NO_PROXY should be synthesized").toBeDefined();
    expect(lower, "no_proxy should be synthesized").toBeDefined();
    for (const v of [upper, lower]) {
      const parts = (v ?? "").split("=")[1]?.split(",") ?? [];
      expect(parts).toContain("inference.local");
      expect(parts).toContain("host.containers.internal");
    }
  });

  it("propagates NEMOCLAW_MINIMAL_BOOTSTRAP=1 from host into sandbox env (#2598)", () => {
    const envArgs: string[] = [];
    appendHostProxyEnvArgs(envArgs, { NEMOCLAW_MINIMAL_BOOTSTRAP: "1" });
    expect(envArgs).toContain("NEMOCLAW_MINIMAL_BOOTSTRAP=1");
  });

  it("omits NEMOCLAW_MINIMAL_BOOTSTRAP when unset or not the literal '1' (#2598)", () => {
    for (const value of [undefined, "", "0", "true", "yes"]) {
      const envArgs: string[] = [];
      const env: NodeJS.ProcessEnv =
        value === undefined ? {} : { NEMOCLAW_MINIMAL_BOOTSTRAP: value };
      appendHostProxyEnvArgs(envArgs, env);
      expect(envArgs.some((e) => e.startsWith("NEMOCLAW_MINIMAL_BOOTSTRAP="))).toBe(false);
    }
  });

  it(
    "prints doctor logs automatically when gateway fails to start (#1605)",
    testTimeoutOptions(20_000),
    () => {
      // Intentional process-contract coverage: this case verifies the real child exit status and
      // stdout/stderr handling across the Node -> shell -> OpenShell adapter boundary. The
      // setupInference cases below are unit-shaped and run directly through typed dependencies.
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-diag-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "gateway-diag.cjs");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));

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
      sandboxName: true,
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
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-"));

    try {
      const { buildCtx, stagedDockerfile } = stageOptimizedSandboxBuildContext(repoRoot, tmpDir);

      expect(stagedDockerfile).toBe(path.join(buildCtx, "Dockerfile"));
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw", "package-lock.json"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw", "src"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw-blueprint", ".venv"))).toBe(false);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "nemoclaw-start.sh"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "patch-openclaw-tool-catalog.js"))).toBe(
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
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-reuse-forward-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "reuse-sandbox-forward.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOkOpenshell(fakeBin);

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
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", toolDisclosure: "progressive" });

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

      // provider get + provider update + inference set
      assert.equal(harness.commands.length, 3);
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

      // provider get + provider update + inference set
      assert.equal(harness.commands.length, 3);
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
    const repoRoot = path.join(import.meta.dirname, "..");
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
});
