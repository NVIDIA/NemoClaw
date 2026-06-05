// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.join(import.meta.dirname, "..");
const LOCAL_INFERENCE_PATH = path.join(REPO_ROOT, "dist", "lib", "inference", "local.js");
const ONBOARD_OLLAMA_PROXY_PATH = path.join(REPO_ROOT, "dist", "lib", "inference", "ollama", "proxy.js");

type CapturedCall = { argv: readonly string[]; opts?: Record<string, unknown> };

type CaptureFn = (
  cmd: string | readonly string[],
  opts?: Record<string, unknown>,
) => string;

interface OllamaCapabilities {
  source: "api" | "unknown";
  capabilities: string[];
  supportsTools: boolean | null;
  rawError?: string;
}

interface LocalInferenceModule {
  probeOllamaModelCapabilities: (model: string, capture?: CaptureFn) => OllamaCapabilities;
  validateOllamaModel: (
    model: string,
    capture?: CaptureFn,
    isSparkImpl?: () => boolean,
    captureExImpl?: (cmd: string[]) => { stdout: string; exitCode: number | null; timedOut: boolean },
    options?: { allowToolsIncompatible?: boolean },
  ) => { ok: boolean; message?: string };
  setResolvedOllamaHost: (host: string) => void;
  resetOllamaHostCache: () => void;
  OLLAMA_LOCALHOST: string;
}

interface OnboardOllamaProxyModule {
  checkOllamaModelToolSupport: (
    model: string,
  ) => Promise<{ ok: boolean; message?: string; allowToolsIncompatible?: boolean }>;
}

function loadLocalInference(): LocalInferenceModule {
  return require(LOCAL_INFERENCE_PATH) as LocalInferenceModule;
}

/**
 * Build a scripted capture function that records argv calls and returns
 * scripted output for the first matching response (or "" if none).
 */
function makeCapture(
  responses: ReadonlyArray<{ match: RegExp; output: string }> = [],
): { capture: CaptureFn; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const capture: CaptureFn = (cmd, opts) => {
    const argv = Array.isArray(cmd) ? (cmd as readonly string[]) : [String(cmd)];
    calls.push({ argv, opts });
    const joined = argv.join(" ");
    const hit = responses.find((r) => r.match.test(joined));
    return hit ? hit.output : "";
  };
  return { capture, calls };
}

describe("probeOllamaModelCapabilities", () => {
  let localInference: LocalInferenceModule;

  beforeEach(() => {
    localInference = loadLocalInference();
    localInference.resetOllamaHostCache();
    localInference.setResolvedOllamaHost(localInference.OLLAMA_LOCALHOST);
  });

  it("returns supportsTools=true when capabilities array contains 'tools'", () => {
    const { capture } = makeCapture([
      {
        match: /\/api\/show/,
        output: JSON.stringify({ capabilities: ["completion", "tools"] }),
      },
    ]);
    const result = localInference.probeOllamaModelCapabilities("qwen3.5:9b", capture);
    expect(result.source).toBe("api");
    expect(result.supportsTools).toBe(true);
    expect(result.capabilities).toEqual(["completion", "tools"]);
  });

  it("returns supportsTools=false when capabilities lacks 'tools'", () => {
    const { capture } = makeCapture([
      {
        match: /\/api\/show/,
        output: JSON.stringify({ capabilities: ["completion"] }),
      },
    ]);
    const result = localInference.probeOllamaModelCapabilities("phi4", capture);
    expect(result.source).toBe("api");
    expect(result.supportsTools).toBe(false);
    expect(result.capabilities).toEqual(["completion"]);
  });

  it("returns supportsTools=null when /api/show returns empty body", () => {
    const { capture } = makeCapture([{ match: /\/api\/show/, output: "" }]);
    const result = localInference.probeOllamaModelCapabilities("phi4", capture);
    expect(result.source).toBe("unknown");
    expect(result.supportsTools).toBeNull();
    expect(result.rawError).toBeTruthy();
  });

  it("returns supportsTools=null when /api/show returns malformed JSON", () => {
    const { capture } = makeCapture([
      { match: /\/api\/show/, output: "not-json {" },
    ]);
    const result = localInference.probeOllamaModelCapabilities("phi4", capture);
    expect(result.source).toBe("unknown");
    expect(result.supportsTools).toBeNull();
    expect(result.rawError).toBeTruthy();
  });

  it("returns supportsTools=null when capabilities field is absent", () => {
    const { capture } = makeCapture([
      {
        match: /\/api\/show/,
        // Older Ollama version: returns model metadata but no capabilities field.
        output: JSON.stringify({ modelfile: "FROM phi4", parameters: "" }),
      },
    ]);
    const result = localInference.probeOllamaModelCapabilities("phi4", capture);
    expect(result.source).toBe("unknown");
    expect(result.supportsTools).toBeNull();
  });

  it("sends correct curl argv: POST, --connect-timeout 3, --max-time 5, JSON body, resolved host + OLLAMA_PORT", () => {
    localInference.setResolvedOllamaHost("127.0.0.1");
    const { capture, calls } = makeCapture([
      { match: /\/api\/show/, output: JSON.stringify({ capabilities: ["tools"] }) },
    ]);
    localInference.probeOllamaModelCapabilities("qwen3.5:9b", capture);
    expect(calls).toHaveLength(1);
    const argv = calls[0].argv;
    expect(argv[0]).toBe("curl");
    expect(argv).toContain("-sS");
    // connect/max timeouts
    const ctIdx = argv.indexOf("--connect-timeout");
    expect(ctIdx).toBeGreaterThanOrEqual(0);
    expect(argv[ctIdx + 1]).toBe("3");
    const mtIdx = argv.indexOf("--max-time");
    expect(mtIdx).toBeGreaterThanOrEqual(0);
    expect(argv[mtIdx + 1]).toBe("5");
    // POST + JSON header
    const xIdx = argv.indexOf("-X");
    expect(xIdx).toBeGreaterThanOrEqual(0);
    expect(argv[xIdx + 1]).toBe("POST");
    expect(argv).toContain("Content-Type: application/json");
    // JSON body has model name
    const dIdx = argv.indexOf("-d");
    expect(dIdx).toBeGreaterThanOrEqual(0);
    expect(argv[dIdx + 1]).toBe(JSON.stringify({ model: "qwen3.5:9b" }));
    // URL uses resolved host + OLLAMA_PORT (default 11434)
    expect(argv[argv.length - 1]).toBe("http://127.0.0.1:11434/api/show");
  });
});

describe("validateOllamaModel — tools-capable error mapping", () => {
  let localInference: LocalInferenceModule;

  beforeEach(() => {
    localInference = loadLocalInference();
  });

  it("rewrites '/api/generate does not support tools' into a friendly tools-capable suggestion", () => {
    const { capture } = makeCapture([
      {
        match: /\/api\/generate/,
        output: JSON.stringify({
          error: "registry.ollama.ai/library/phi4 does not support tools",
        }),
      },
    ]);
    const payload = JSON.stringify({ error: "registry.ollama.ai/library/phi4 does not support tools" });
    const captureEx = () => ({ stdout: payload, exitCode: 0, timedOut: false });
    const result = localInference.validateOllamaModel("phi4", capture, () => false, captureEx);
    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
    expect(result.message!).toContain("phi4");
    // Friendly message must direct the user to inspect capabilities themselves
    // rather than recommending a hardcoded list of models.
    expect(result.message!).toMatch(/ollama show/i);
    expect(result.message!.toLowerCase()).toContain("tools");
  });
});

// ─────────────────────────────────────────────────────────────────
// checkOllamaModelToolSupport: stub probeOllamaModelCapabilities by
// reaching into the cached local-inference module before requiring
// onboard-ollama-proxy. Because onboard-ollama-proxy destructures
// `probeOllamaModelCapabilities` at module-load time, we must clear
// onboard-ollama-proxy from the require cache between tests so it
// re-binds to the patched local-inference function.
//
// Equally critical: onboard.js destructures `prompt` from credentials
// at load time, so our credentials.prompt monkey-patch must be in
// place BEFORE onboard.js is first required. We install one durable
// proxy via shared state so re-creating per-test mocks doesn't hand
// onboard a stale closure.
// ─────────────────────────────────────────────────────────────────

interface ProxyTestHarness {
  proxy: OnboardOllamaProxyModule;
  logs: string[];
  errors: string[];
  promptCalls: string[];
  setProbeResult: (caps: OllamaCapabilities) => void;
  setPromptReply: (reply: string) => void;
}

// Shared global state — installed once, mutated per test.
const SHARED = {
  scriptedCaps: {
    source: "api",
    capabilities: ["tools"],
    supportsTools: true,
  } as OllamaCapabilities,
  promptReply: "",
  promptCalls: [] as string[],
  installed: false,
  originalProbe: undefined as undefined | LocalInferenceModule["probeOllamaModelCapabilities"],
  originalPrompt: undefined as undefined | ((msg: string) => Promise<string>),
};

function installSharedStubs(): void {
  if (SHARED.installed) return;
  const localInference = loadLocalInference() as LocalInferenceModule & {
    probeOllamaModelCapabilities: (model: string) => OllamaCapabilities;
  };
  SHARED.originalProbe = localInference.probeOllamaModelCapabilities;
  (localInference as unknown as Record<string, unknown>).probeOllamaModelCapabilities = (
    _model: string,
  ) => SHARED.scriptedCaps;

  const credentialsPath = path.join(REPO_ROOT, "dist", "lib", "credentials", "store.js");
  const credentials = require(credentialsPath) as {
    prompt: (msg: string) => Promise<string>;
  };
  SHARED.originalPrompt = credentials.prompt;
  credentials.prompt = async (msg: string) => {
    SHARED.promptCalls.push(msg);
    return SHARED.promptReply;
  };

  SHARED.installed = true;
}

function loadProxyWithStubs(): ProxyTestHarness {
  installSharedStubs();
  // Reset per-test state.
  SHARED.scriptedCaps = {
    source: "api",
    capabilities: ["tools"],
    supportsTools: true,
  };
  SHARED.promptReply = "";
  SHARED.promptCalls.length = 0;

  // Invalidate the cache and re-require so the proxy module's
  // destructured `probeOllamaModelCapabilities` binding picks up the
  // stub installed by installSharedStubs(). Without this, a prior test
  // file could have loaded the proxy first and pinned the original.
  delete require.cache[ONBOARD_OLLAMA_PROXY_PATH];
  const proxy = require(ONBOARD_OLLAMA_PROXY_PATH) as OnboardOllamaProxyModule;

  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map((a) => String(a)).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map((a) => String(a)).join(" "));
  });

  const restore = () => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  };
  (loadProxyWithStubs as unknown as { _restore?: () => void })._restore = restore;

  return {
    proxy,
    logs,
    errors,
    promptCalls: SHARED.promptCalls,
    setProbeResult: (caps) => {
      SHARED.scriptedCaps = caps;
    },
    setPromptReply: (reply) => {
      SHARED.promptReply = reply;
    },
  };
}

describe("checkOllamaModelToolSupport", () => {
  const ENV_KEYS_TO_RESTORE = [
    "NEMOCLAW_NON_INTERACTIVE",
    "NEMOCLAW_YES",
    "NEMOCLAW_OLLAMA_REQUIRE_TOOLS",
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS_TO_RESTORE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    const restore = (loadProxyWithStubs as unknown as { _restore?: () => void })._restore;
    if (restore) restore();
    for (const key of ENV_KEYS_TO_RESTORE) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("interactive yes → {ok:true, allowToolsIncompatible:true}", async () => {
    const h = loadProxyWithStubs();
    h.setProbeResult({
      source: "api",
      capabilities: ["completion"],
      supportsTools: false,
    });
    h.setPromptReply("y");
    const out = await h.proxy.checkOllamaModelToolSupport("phi4");
    // The override flag is what downstream validators consume to skip the
    // strict tools probe — without it onboard would loop back. See #4241.
    expect(out).toEqual({ ok: true, allowToolsIncompatible: true });
    // Warning banner was printed.
    expect(h.logs.some((l) => l.includes("does not advertise the 'tools' capability"))).toBe(true);
    // Prompt was actually shown.
    expect(h.promptCalls.length).toBeGreaterThan(0);
  });

  it("interactive no → {ok:false} with 'choose a tools-capable model' message", async () => {
    const h = loadProxyWithStubs();
    h.setProbeResult({
      source: "api",
      capabilities: ["completion"],
      supportsTools: false,
    });
    h.setPromptReply("n");
    const out = await h.proxy.checkOllamaModelToolSupport("phi4");
    expect(out.ok).toBe(false);
    expect(out.message).toBeTruthy();
    expect(out.message!.toLowerCase()).toContain("tools-capable");
  });

  it("non-interactive default → {ok:false} with stderr containing NEMOCLAW_OLLAMA_REQUIRE_TOOLS=0", async () => {
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";
    const h = loadProxyWithStubs();
    h.setProbeResult({
      source: "api",
      capabilities: ["completion"],
      supportsTools: false,
    });
    const out = await h.proxy.checkOllamaModelToolSupport("phi4");
    expect(out.ok).toBe(false);
    expect(h.errors.some((e) => e.includes("NEMOCLAW_OLLAMA_REQUIRE_TOOLS=0"))).toBe(true);
  });

  it("non-interactive + NEMOCLAW_OLLAMA_REQUIRE_TOOLS=0 → {ok:true, allowToolsIncompatible:true} after stderr warning", async () => {
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";
    process.env.NEMOCLAW_OLLAMA_REQUIRE_TOOLS = "0";
    const h = loadProxyWithStubs();
    h.setProbeResult({
      source: "api",
      capabilities: ["completion"],
      supportsTools: false,
    });
    const out = await h.proxy.checkOllamaModelToolSupport("phi4");
    expect(out.ok).toBe(true);
    expect(out.allowToolsIncompatible).toBe(true);
    // Stderr warning mentions the env-var override + model name.
    const matched = h.errors.some(
      (e) => e.includes("NEMOCLAW_OLLAMA_REQUIRE_TOOLS=0") && e.includes("phi4"),
    );
    expect(matched).toBe(true);
  });

  it("NEMOCLAW_YES=1 → {ok:true, allowToolsIncompatible:true} after note", async () => {
    process.env.NEMOCLAW_YES = "1";
    const h = loadProxyWithStubs();
    h.setProbeResult({
      source: "api",
      capabilities: ["completion"],
      supportsTools: false,
    });
    const out = await h.proxy.checkOllamaModelToolSupport("phi4");
    expect(out).toEqual({ ok: true, allowToolsIncompatible: true });
    // Note about --yes is printed.
    expect(h.logs.some((l) => l.toLowerCase().includes("--yes"))).toBe(true);
    // Prompt should NOT have been shown.
    expect(h.promptCalls.length).toBe(0);
  });

  it("probe failed (capabilities unknown) → {ok:true} (graceful degradation)", async () => {
    const h = loadProxyWithStubs();
    h.setProbeResult({
      source: "unknown",
      capabilities: [],
      supportsTools: null,
      rawError: "connection refused",
    });
    const out = await h.proxy.checkOllamaModelToolSupport("phi4");
    // Probe could not determine capabilities — no override needed because we
    // don't know the model is incompatible.
    expect(out).toEqual({ ok: true });
    // Informational note printed; no warning banner.
    expect(h.logs.some((l) => l.includes("Could not verify 'tools' capability"))).toBe(true);
    expect(h.logs.some((l) => l.includes("does not advertise the 'tools' capability"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// Regression coverage for #4241: the no-tools override must propagate
// through `validateOllamaModel`, so a model that the user explicitly
// accepted does not get rejected again on the same "does not support
// tools" error during the second validation pass in setupInference.
// Without the override (`allowToolsIncompatible: false`/unset), the
// validator must still fail early so the wizard does not silently
// strand the user on an unusable model.
// ─────────────────────────────────────────────────────────────────

describe("validateOllamaModel — no-tools override propagation (#4241)", () => {
  let localInference: LocalInferenceModule;

  beforeEach(() => {
    localInference = loadLocalInference();
  });

  function captureExReturning(errText: string) {
    const payload = JSON.stringify({ error: errText });
    return () => ({ stdout: payload, exitCode: 0, timedOut: false });
  }

  it("rejects a no-tools model when no override is set (back-to-selection path)", () => {
    const { capture } = makeCapture([]);
    const captureEx = captureExReturning(
      "registry.ollama.ai/library/tinyllama:1.1b does not support tools",
    );
    const result = localInference.validateOllamaModel(
      "tinyllama:1.1b",
      capture,
      () => false,
      captureEx,
    );
    expect(result.ok).toBe(false);
    expect(result.message!).toContain("tinyllama");
    expect(result.message!.toLowerCase()).toContain("tools");
  });

  it("rejects a no-tools model when allowToolsIncompatible is false (explicit no override)", () => {
    const { capture } = makeCapture([]);
    const captureEx = captureExReturning(
      "registry.ollama.ai/library/tinyllama:1.1b does not support tools",
    );
    const result = localInference.validateOllamaModel(
      "tinyllama:1.1b",
      capture,
      () => false,
      captureEx,
      { allowToolsIncompatible: false },
    );
    expect(result.ok).toBe(false);
    expect(result.message!.toLowerCase()).toContain("tools");
  });

  it("accepts a no-tools model when allowToolsIncompatible is true (override accepted upstream)", () => {
    const { capture } = makeCapture([]);
    const captureEx = captureExReturning(
      "registry.ollama.ai/library/tinyllama:1.1b does not support tools",
    );
    const warned: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warned.push(args.map((a) => String(a)).join(" "));
    });
    try {
      const result = localInference.validateOllamaModel(
        "tinyllama:1.1b",
        capture,
        () => false,
        captureEx,
        { allowToolsIncompatible: true },
      );
      expect(result.ok).toBe(true);
      // The earlier accept-the-override warning is restated rather than
      // reverted into a hard validation failure that would loop selection.
      expect(warned.some((l) => l.includes("no-tools override was accepted"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("still surfaces non-tools errors (e.g. memory) regardless of override", () => {
    const { capture } = makeCapture([]);
    const captureEx = captureExReturning(
      "model requires more system memory (50 GiB) than is available (8 GiB)",
    );
    const result = localInference.validateOllamaModel(
      "tinyllama:1.1b",
      capture,
      () => false,
      captureEx,
      { allowToolsIncompatible: true },
    );
    expect(result.ok).toBe(false);
    expect(result.message!).toContain("more system memory");
  });

  // The override only suppresses the tools-capability rejection. The Spark
  // CPU-only runtime check (probeOllamaRuntimeModelStatus) must still run
  // after the warning fires and surface its own diagnostic — otherwise an
  // accepted no-tools model on Spark could silently land on CPU.
  it("Spark CPU-only check still rejects after override is accepted", () => {
    const cpuOnlyApiPs = JSON.stringify({
      models: [{ name: "tinyllama:1.1b", model: "tinyllama:1.1b", size_vram: 0, processor: "100% CPU" }],
    });
    const { capture } = makeCapture([{ match: /\/api\/ps/, output: cpuOnlyApiPs }]);
    const captureEx = captureExReturning(
      "registry.ollama.ai/library/tinyllama:1.1b does not support tools",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = localInference.validateOllamaModel(
        "tinyllama:1.1b",
        capture,
        () => true,
        captureEx,
        { allowToolsIncompatible: true },
      );
      expect(result.ok).toBe(false);
      expect(result.message!.toLowerCase()).toContain("cpu");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// End-to-end propagation: when checkOllamaModelToolSupport accepts the
// override, the same model must clear the second validateOllamaModel
// call without looping back to model selection (the user-visible
// #4241 regression). Pre-fix this assertion fails because
// validateOllamaModel does not know about the override and re-rejects.
// ─────────────────────────────────────────────────────────────────

describe("override propagation across checkOllamaModelToolSupport → validateOllamaModel (#4241)", () => {
  it("user accepts override → later validateOllamaModel does NOT reject for the same tools-incompatible error", async () => {
    const h = loadProxyWithStubs();
    h.setProbeResult({
      source: "api",
      capabilities: ["completion"],
      supportsTools: false,
    });
    h.setPromptReply("y");

    // (1) The capability check is what an onboarding session would run first.
    const cap = await h.proxy.checkOllamaModelToolSupport("tinyllama:1.1b");
    expect(cap.ok).toBe(true);
    expect(cap.allowToolsIncompatible).toBe(true);

    // (2) The same setupInference path runs validateOllamaModel(model) after
    //     `openshell inference set`. Pre-fix it returned ok:false on the same
    //     "does not support tools" condition and onboarding called
    //     process.exit(1). Threading `allowToolsIncompatible` keeps it ok:true.
    const localInference = loadLocalInference();
    const captureEx = () => ({
      stdout: JSON.stringify({
        error: "registry.ollama.ai/library/tinyllama:1.1b does not support tools",
      }),
      exitCode: 0,
      timedOut: false,
    });
    const result = localInference.validateOllamaModel(
      "tinyllama:1.1b",
      () => "",
      () => false,
      captureEx,
      { allowToolsIncompatible: cap.allowToolsIncompatible === true },
    );
    expect(result.ok).toBe(true);
  });

  it("user declines override → both stages refuse and no later validation runs", async () => {
    const h = loadProxyWithStubs();
    h.setProbeResult({
      source: "api",
      capabilities: ["completion"],
      supportsTools: false,
    });
    h.setPromptReply("n");

    const cap = await h.proxy.checkOllamaModelToolSupport("tinyllama:1.1b");
    expect(cap.ok).toBe(false);
    // Override was never granted, so downstream validators must keep rejecting
    // the same model.
    expect(cap.allowToolsIncompatible).toBeUndefined();

    const localInference = loadLocalInference();
    const captureEx = () => ({
      stdout: JSON.stringify({
        error: "registry.ollama.ai/library/tinyllama:1.1b does not support tools",
      }),
      exitCode: 0,
      timedOut: false,
    });
    const result = localInference.validateOllamaModel(
      "tinyllama:1.1b",
      () => "",
      () => false,
      captureEx,
      { allowToolsIncompatible: cap.allowToolsIncompatible === true },
    );
    expect(result.ok).toBe(false);
  });
});
