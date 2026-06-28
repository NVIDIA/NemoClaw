// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type ProviderRecoveryInternals = {
  providerNameToOptionKey: (
    name: string | null | undefined,
    opts?: { hasNimContainer?: boolean },
  ) => string | null;
  readRecordedProvider: (sandboxName: string | null | undefined) => string | null;
  readRecordedModel: (sandboxName: string | null | undefined) => string | null;
  readRecordedNimContainer: (sandboxName: string | null | undefined) => string | null;
};

function isProviderRecoveryInternals(value: object | null): value is ProviderRecoveryInternals {
  return (
    value !== null &&
    typeof Reflect.get(value, "providerNameToOptionKey") === "function" &&
    typeof Reflect.get(value, "readRecordedProvider") === "function" &&
    typeof Reflect.get(value, "readRecordedModel") === "function" &&
    typeof Reflect.get(value, "readRecordedNimContainer") === "function"
  );
}

const loadedOnboardModule = require("../src/lib/onboard");
const onboardModule =
  typeof loadedOnboardModule === "object" && loadedOnboardModule !== null
    ? loadedOnboardModule
    : null;
if (!isProviderRecoveryInternals(onboardModule)) {
  throw new Error("Expected provider-recovery internals to be available");
}
const {
  providerNameToOptionKey,
  readRecordedProvider,
  readRecordedModel,
  readRecordedNimContainer,
} = onboardModule;

const registry: typeof import("../src/lib/state/registry") = require("../src/lib/state/registry");
const onboardSession: typeof import("../src/lib/state/onboard-session") = require("../src/lib/state/onboard-session");

// Force readLiveInference's defaultSandbox check to fail so unit tests that
// expect null don't depend on whether openshell is on PATH.
function stubLiveGatewayUntrusted(): void {
  registry.listSandboxes = () =>
    ({
      sandboxes: [{ name: "other-default" }, { name: "another" }],
      defaultSandbox: "other-default",
    }) as ReturnType<typeof registry.listSandboxes>;
}

describe("providerNameToOptionKey", () => {
  it("maps local provider names to option keys", () => {
    expect(providerNameToOptionKey("ollama-local")).toBe("ollama");
    // nvidia-nim is a legacy alias for cloud NVIDIA Endpoints, not Local NIM.
    expect(providerNameToOptionKey("nvidia-nim")).toBe("build");
  });

  it("disambiguates vllm-local via nimContainer", () => {
    // NIM persists as provider="vllm-local" + nimContainer; absence of the
    // nimContainer marker reliably means standalone vLLM in registry/session
    // recovery (the standalone path never records a container).
    expect(providerNameToOptionKey("vllm-local", { hasNimContainer: true })).toBe("nim-local");
    expect(providerNameToOptionKey("vllm-local", { hasNimContainer: false })).toBe("vllm");
    expect(providerNameToOptionKey("vllm-local", {})).toBe("vllm");
    expect(providerNameToOptionKey("vllm-local")).toBe("vllm");
  });

  it("maps remote provider names via REMOTE_PROVIDER_CONFIG reverse lookup", () => {
    expect(providerNameToOptionKey("nvidia-prod")).toBe("build");
    expect(providerNameToOptionKey("openai-api")).toBe("openai");
    expect(providerNameToOptionKey("anthropic-prod")).toBe("anthropic");
    expect(providerNameToOptionKey("gemini-api")).toBe("gemini");
    expect(providerNameToOptionKey("compatible-endpoint")).toBe("custom");
    expect(providerNameToOptionKey("compatible-anthropic-endpoint")).toBe("anthropicCompatible");
  });

  it("returns null for unknown or missing names", () => {
    expect(providerNameToOptionKey(null)).toBeNull();
    expect(providerNameToOptionKey(undefined)).toBeNull();
    expect(providerNameToOptionKey("")).toBeNull();
    expect(providerNameToOptionKey("not-a-real-provider")).toBeNull();
  });
});

describe("readRecordedProvider", () => {
  const originalGetSandbox = registry.getSandbox;
  const originalListSandboxes = registry.listSandboxes;
  const originalLoadSession = onboardSession.loadSession;
  afterEach(() => {
    registry.getSandbox = originalGetSandbox;
    registry.listSandboxes = originalListSandboxes;
    onboardSession.loadSession = originalLoadSession;
  });

  it("returns the provider stored in sandboxes.json", () => {
    registry.getSandbox = (name: string) =>
      name === "spark-1"
        ? ({ name, provider: "ollama-local" } as ReturnType<typeof registry.getSandbox>)
        : null;
    onboardSession.loadSession = () => null;
    stubLiveGatewayUntrusted();
    expect(readRecordedProvider("spark-1")).toBe("ollama-local");
  });

  it("falls back to the session when the registry entry is gone (rebuild path)", () => {
    // Simulates the #2728 rebuild flow: registry.removeSandbox has already
    // run, so getSandbox returns null. The session was enriched before the
    // destroy and still carries the previous provider.
    registry.getSandbox = () => null;
    onboardSession.loadSession = () =>
      ({
        sandboxName: "spark-1",
        provider: "ollama-local",
        model: "qwen2.5:14b",
      }) as ReturnType<typeof onboardSession.loadSession>;
    stubLiveGatewayUntrusted();
    expect(readRecordedProvider("spark-1")).toBe("ollama-local");
  });

  it("ignores a session that belongs to a different sandbox", () => {
    registry.getSandbox = () => null;
    onboardSession.loadSession = () =>
      ({
        sandboxName: "other-sandbox",
        provider: "ollama-local",
      }) as ReturnType<typeof onboardSession.loadSession>;
    stubLiveGatewayUntrusted();
    expect(readRecordedProvider("spark-1")).toBeNull();
  });

  it("returns null when registry, session, and live gateway all yield nothing", () => {
    registry.getSandbox = () => null;
    onboardSession.loadSession = () => null;
    stubLiveGatewayUntrusted();
    expect(readRecordedProvider("missing")).toBeNull();
  });

  it("returns null when registry entry has no provider and session has none either", () => {
    registry.getSandbox = () =>
      ({ name: "spark-1", provider: null }) as ReturnType<typeof registry.getSandbox>;
    onboardSession.loadSession = () =>
      ({ sandboxName: "spark-1", provider: null }) as ReturnType<typeof onboardSession.loadSession>;
    stubLiveGatewayUntrusted();
    expect(readRecordedProvider("spark-1")).toBeNull();
  });

  it("returns null for empty or missing sandbox names", () => {
    expect(readRecordedProvider(null)).toBeNull();
    expect(readRecordedProvider(undefined)).toBeNull();
    expect(readRecordedProvider("")).toBeNull();
  });

  it("falls back to the session when the registry read throws", () => {
    registry.getSandbox = () => {
      throw new Error("registry unreadable");
    };
    onboardSession.loadSession = () =>
      ({ sandboxName: "spark-1", provider: "ollama-local" }) as ReturnType<
        typeof onboardSession.loadSession
      >;
    stubLiveGatewayUntrusted();
    expect(readRecordedProvider("spark-1")).toBe("ollama-local");
  });

  it("returns null when registry, session, and live-gateway lookups all throw", () => {
    registry.getSandbox = () => {
      throw new Error("registry unreadable");
    };
    onboardSession.loadSession = () => {
      throw new Error("session unreadable");
    };
    registry.listSandboxes = () => {
      throw new Error("registry list unreadable");
    };
    expect(readRecordedProvider("spark-1")).toBeNull();
  });
});

describe("readRecordedModel", () => {
  const originalGetSandbox = registry.getSandbox;
  const originalListSandboxes = registry.listSandboxes;
  const originalLoadSession = onboardSession.loadSession;
  afterEach(() => {
    registry.getSandbox = originalGetSandbox;
    registry.listSandboxes = originalListSandboxes;
    onboardSession.loadSession = originalLoadSession;
  });

  it("returns the model stored in sandboxes.json", () => {
    registry.getSandbox = (name: string) =>
      name === "spark-1"
        ? ({ name, model: "qwen2.5:14b" } as ReturnType<typeof registry.getSandbox>)
        : null;
    onboardSession.loadSession = () => null;
    stubLiveGatewayUntrusted();
    expect(readRecordedModel("spark-1")).toBe("qwen2.5:14b");
  });

  it("falls back to the session when the registry entry is gone (rebuild path)", () => {
    registry.getSandbox = () => null;
    onboardSession.loadSession = () =>
      ({
        sandboxName: "spark-1",
        model: "qwen2.5:14b",
      }) as ReturnType<typeof onboardSession.loadSession>;
    stubLiveGatewayUntrusted();
    expect(readRecordedModel("spark-1")).toBe("qwen2.5:14b");
  });

  it("ignores a session that belongs to a different sandbox", () => {
    registry.getSandbox = () => null;
    onboardSession.loadSession = () =>
      ({
        sandboxName: "other-sandbox",
        model: "qwen2.5:14b",
      }) as ReturnType<typeof onboardSession.loadSession>;
    stubLiveGatewayUntrusted();
    expect(readRecordedModel("spark-1")).toBeNull();
  });

  it("returns null when registry, session, and live gateway all yield nothing", () => {
    registry.getSandbox = () => null;
    onboardSession.loadSession = () => null;
    stubLiveGatewayUntrusted();
    expect(readRecordedModel("missing")).toBeNull();
  });

  it("returns null for empty or missing sandbox names", () => {
    expect(readRecordedModel(null)).toBeNull();
    expect(readRecordedModel(undefined)).toBeNull();
    expect(readRecordedModel("")).toBeNull();
  });
});

describe("readRecordedNimContainer", () => {
  const originalGetSandbox = registry.getSandbox;
  const originalLoadSession = onboardSession.loadSession;
  afterEach(() => {
    registry.getSandbox = originalGetSandbox;
    onboardSession.loadSession = originalLoadSession;
  });

  it("returns the nimContainer stored in sandboxes.json", () => {
    registry.getSandbox = (name: string) =>
      name === "spark-1"
        ? ({
            name,
            provider: "vllm-local",
            nimContainer: "nemoclaw-nim-foo",
          } as ReturnType<typeof registry.getSandbox>)
        : null;
    onboardSession.loadSession = () => null;
    expect(readRecordedNimContainer("spark-1")).toBe("nemoclaw-nim-foo");
  });

  it("falls back to the session for the rebuild path", () => {
    registry.getSandbox = () => null;
    onboardSession.loadSession = () =>
      ({
        sandboxName: "spark-1",
        nimContainer: "nemoclaw-nim-bar",
      }) as ReturnType<typeof onboardSession.loadSession>;
    expect(readRecordedNimContainer("spark-1")).toBe("nemoclaw-nim-bar");
  });

  it("returns null when neither registry nor session has a nimContainer", () => {
    registry.getSandbox = () =>
      ({ name: "spark-1", nimContainer: null }) as ReturnType<typeof registry.getSandbox>;
    onboardSession.loadSession = () =>
      ({ sandboxName: "spark-1", nimContainer: null }) as ReturnType<
        typeof onboardSession.loadSession
      >;
    expect(readRecordedNimContainer("spark-1")).toBeNull();
  });

  it("ignores a session that belongs to a different sandbox", () => {
    registry.getSandbox = () => null;
    onboardSession.loadSession = () =>
      ({
        sandboxName: "other-sandbox",
        nimContainer: "nemoclaw-nim-foo",
      }) as ReturnType<typeof onboardSession.loadSession>;
    expect(readRecordedNimContainer("spark-1")).toBeNull();
  });

  it("returns null for empty or missing sandbox names", () => {
    expect(readRecordedNimContainer(null)).toBeNull();
    expect(readRecordedNimContainer(undefined)).toBeNull();
    expect(readRecordedNimContainer("")).toBeNull();
  });
});

describe("readRecordedProvider — live gateway fallback", () => {
  // Covers the #2728 captured state: session.provider = null, registry has
  // the entry but with no useful provider field, AND the live gateway still
  // holds the original inference config from before the failure.  We have to
  // run this in a child process so a fake `openshell` binary on PATH can
  // serve `inference get`, since onboard.ts destructures runCapture at
  // module load time and can't be patched in-process.
  it("recovers provider+model from `openshell inference get` when registry+session yield nothing", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-live-recovery-"));
    const fakeBin = path.join(tmpDir, "bin");
    const home = path.join(tmpDir, "home");
    const scriptPath = path.join(tmpDir, "live-recovery.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "$1" = "inference" ] && [ "$2" = "get" ]; then
  cat <<'EOF'
Gateway inference:

  Route: inference.local
  Provider: ollama-local
  Model: qwen2.5:14b
  Version: 1
EOF
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    );

    fs.writeFileSync(
      scriptPath,
      `
const { readRecordedProvider, readRecordedModel } = require(${onboardPath});
console.log(JSON.stringify({
  provider: readRecordedProvider("spark-1"),
  model: readRecordedModel("spark-1"),
}));
`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.provider).toBe("ollama-local");
    expect(payload.model).toBe("qwen2.5:14b");
  });
});

describe("setupNim provider recovery policy", () => {
  it("ignores stale recorded providers when fresh setup disables provider recovery", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-fresh-provider-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "fresh-provider-recovery-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const sessionPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
    );
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"choices":[{"message":{"role":"assistant","content":"OK"}}]}'
status="200"
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const registry = require(${registryPath});
const onboardSession = require(${sessionPath});

runner.runCapture = () => "";
registry.getSandbox = () => null;
registry.listSandboxes = () => ({ sandboxes: [], defaultSandbox: null });
onboardSession.loadSession = () => ({
  sandboxName: "dcode-station",
  provider: "ollama-local",
  model: "llama3.1",
});
const prompts = [];
credentials.prompt = async (message) => {
  prompts.push(message);
  return "";
};
credentials.ensureApiKey = async () => {};
process.env.NEMOCLAW_NON_INTERACTIVE = "1";
const { setupNim } = require(${onboardPath});

(async () => {
  for (const key of [
    "NEMOCLAW_PROVIDER",
    "NEMOCLAW_PROVIDER_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "COMPATIBLE_API_KEY",
    "COMPATIBLE_ANTHROPIC_API_KEY",
  ]) {
    delete process.env[key];
  }
  process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-test";
  process.env.NEMOCLAW_MODEL = "nvidia/test-model";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const nonInteractive = await setupNim(null, "dcode-station", null, false);
    process.env.NEMOCLAW_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.NEMOCLAW_MODEL = "gpt-5.4";
    const explicitProvider = await setupNim(null, "dcode-station", null, false);
    delete process.env.NEMOCLAW_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    process.env.NEMOCLAW_MODEL = "nvidia/test-model";
    delete process.env.NEMOCLAW_NON_INTERACTIVE;
    const interactive = await setupNim(null, "dcode-station", null, false);
    originalLog(JSON.stringify({ nonInteractive, explicitProvider, interactive, prompts, lines }));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
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
        NEMOCLAW_TEST_NO_SLEEP: "1",
      },
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.nonInteractive.provider).toBe("nvidia-prod");
    expect(payload.nonInteractive.model).toBe("nvidia/test-model");
    expect(payload.nonInteractive.preferredInferenceApi).toBe("openai-completions");
    expect(payload.explicitProvider.provider).toBe("openai-api");
    expect(payload.explicitProvider.model).toBe("gpt-5.4");
    expect(payload.interactive.provider).toBe("nvidia-prod");
    expect(payload.interactive.preferredInferenceApi).toBe("openai-completions");
    expect(payload.prompts[0]).toMatch(/^  Choose \[\d+\]: $/);
    expect(
      payload.lines.some((line: string) => line.includes("Select your inference provider")),
    ).toBe(true);
    expect(
      payload.lines.some((line: string) => line.includes("[non-interactive] Provider: build")),
    ).toBe(true);
    expect(payload.lines.every((line: string) => !line.includes("recovered from sandbox"))).toBe(
      true,
    );
  });
});
