// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const PROTOTYPE = join(ROOT, "scripts", "hermes-switchyard-native-prototype");
const DOCKERFILE = readFileSync(join(ROOT, "agents", "hermes", "Dockerfile.base"), "utf8");
const BASE_IMAGE_RUNTIME = readFileSync(join(ROOT, "src", "lib", "agent", "base-image.ts"), "utf8");
const SANDBOX_PREBUILD = readFileSync(
  join(ROOT, "src", "lib", "onboard", "sandbox-prebuild.ts"),
  "utf8",
);
const FINAL_DOCKERFILE = readFileSync(join(ROOT, "agents", "hermes", "Dockerfile"), "utf8");
const README = readFileSync(join(PROTOTYPE, "README.md"), "utf8");
const PLUGINS = readFileSync(join(PROTOTYPE, "plugins.toml"), "utf8");
const PROVIDER = join(PROTOTYPE, "fake-provider.py");
const RUNNER = readFileSync(join(PROTOTYPE, "run.mts"), "utf8");
const SANDBOX_RUNNER = readFileSync(join(PROTOTYPE, "run-in-sandbox.sh"), "utf8");

const HERMES_REVISION = "08c76bb6baaa77d37821d4777b97f1026c46d5d2";
const HERMES_SHA256 = "5c0923c8ec1a072b5b749085872f473d3e9c015c3fa2a2a8619d93f8af9fa5c1";
const SWITCHYARD_REVISION = "c69a8b68f7c85e4b610c077690f90db6de9053ed";
const SWITCHYARD_SHA256 = "31866653db66435772c081350d6930898b15a8baea054bacdd9c43686287f2f2";
const BOUNDED_PROMPT =
  "Summarize this bounded status in one sentence: 0 critical, 0 high, and 2 medium findings.";
const CAPABLE_PROMPT =
  "Design a fail-closed remediation plan for critical vulnerabilities across multiple services, including credential isolation, rollback, and end-to-end validation.";

let provider: ChildProcess | undefined;
let tempRoot: string | undefined;

afterEach(() => {
  provider?.kill("SIGTERM");
  provider = undefined;
  if (tempRoot) rmSync(tempRoot, { force: true, recursive: true });
  tempRoot = undefined;
});

async function reservePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server did not reserve an IPv4 port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function waitForProvider(port: number, child: ChildProcess): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  for (let attempt = 0; attempt < 750; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `native prototype provider exited with ${child.exitCode}: ${stderr.trim() || "no stderr"}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The child has not bound its loopback listener yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(
    `native prototype provider did not become ready: ${stderr.trim() || "no stderr"}`,
  );
}

describe("Hermes Relay Switchyard native prototype", () => {
  it("keeps V1 immutable and records V2 as a separate architecture milestone (#7937)", () => {
    expect(README).toContain("V1 is frozen at NemoClaw commit `d58276ab7`");
    expect(README).toContain("normal supervised Hermes gateway");
    expect(README).toContain("Hermes native Relay runtime (Hermes #77915)");
    expect(README).toContain("nvidia.switchyard dynamic plugin (Switchyard #270)");
    expect(README).toContain(HERMES_REVISION);
    expect(README).toContain(SWITCHYARD_REVISION);
    expect(README).toContain("must not launch Hermes through `nemo-relay run`");
    expect(README).toContain("Architecture iteration ledger");
    expect(README).toContain("V3 | planned, separate iteration");
  });

  // source-shape-contract: security -- Exact upstream revisions, archive hashes, and plugin activation bytes bind every network-fetched prototype component to the reviewed V2 supply-chain contract
  it("pins the upstream archives, Relay wheel, and external plugin bundle (#7937)", () => {
    for (const value of [
      HERMES_REVISION,
      HERMES_SHA256,
      SWITCHYARD_REVISION,
      SWITCHYARD_SHA256,
      "nemo-relay==0.7.0rc6",
      "HERMES_NEMO_RELAY_PLUGINS_TOML",
      "switchyard-nemo-relay-plugin",
      'native_api = "1"',
    ]) {
      expect(DOCKERFILE).toContain(value);
    }
    expect(DOCKERFILE).toContain(
      "COPY --from=hermes-relay-native-overlay /src/agent/relay_runtime.py",
    );
    expect(DOCKERFILE).toContain(
      "COPY --from=switchyard-native-plugin-builder /out/switchyard-relay-plugin/",
    );
    expect(DOCKERFILE).not.toContain("cargo build --locked --release -p nemo-relay-cli");
    expect(BASE_IMAGE_RUNTIME).toContain("NEMOCLAW_HERMES_SWITCHYARD_NATIVE_PROTOTYPE");
    expect(BASE_IMAGE_RUNTIME).toContain('HERMES_VERSION: "v2026.8.3"');
    expect(BASE_IMAGE_RUNTIME).toContain('HERMES_SEMVER: "0.20.0"');
    expect(DOCKERFILE).toContain('test "${HERMES_NPM_INTEGRITY}" = "unpublished-prototype-only"');
    expect(DOCKERFILE).toContain("security-dependencies-v2026.8.3.patch");
    expect(DOCKERFILE).toContain("whatsapp-proxy-v2026.8.3.patch");
    expect(DOCKERFILE).toContain('if [ "${HERMES_NPM_UNPUBLISHED_PROTOTYPE}" = "1" ]; then');
    expect(DOCKERFILE).toContain('set -- "$@" --python /usr/bin/python3');
    expect(FINAL_DOCKERFILE).toContain("patch-session-list-preview-v2026.8.3.py");
    expect(FINAL_DOCKERFILE).toContain("hermes-cli-adapter-v1-v2026.8.3.json");
    expect(FINAL_DOCKERFILE).toContain('test "$hermes_semver" = "0.20.0"');
    expect(FINAL_DOCKERFILE).toContain("Skipping the v0.19 named-profile defaults patch");
    expect(SANDBOX_PREBUILD).toContain('"NEMOCLAW_HERMES_SWITCHYARD_NATIVE_PROTOTYPE=1"');
    expect(README).toContain("A supported dependency update must not inherit that exception.");
    expect(README).toContain("leaving the canonical 0.19 patch untouched");
    expect(README).toContain("named-profile policy parity remains an explicit");
  });

  it("drives the normal supervised gateway without a Relay sidecar (#7937)", () => {
    expect(SANDBOX_RUNNER).toContain("http://127.0.0.1:8642/v1/chat/completions");
    expect(SANDBOX_RUNNER).toContain("gateway_pid_before");
    expect(SANDBOX_RUNNER).toContain("gateway_pid_after");
    expect(SANDBOX_RUNNER).toContain("relay_sidecar_processes");
    expect(SANDBOX_RUNNER).toContain(
      'expected = ["provider/classifier", "provider/fast", "provider/classifier", "provider/quality"]',
    );
    expect(SANDBOX_RUNNER).not.toContain("nemo-relay run");
    expect(RUNNER).toContain('"sandbox",');
    expect(RUNNER).toContain('"exec",');

    const usage = spawnSync(process.execPath, [join(PROTOTYPE, "run.mts")], {
      encoding: "utf8",
    });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain(
      "npm run prototype:hermes-switchyard:native -- <sandbox-name> [--restart]",
    );
    expect(RUNNER).toContain('"gateway", "restart"');
    expect(RUNNER).toContain("gateway_pid_replaced");
  });

  it("configures only classifier, fast, and quality loopback targets without credentials (#7937)", () => {
    expect(PLUGINS).toContain(
      'manifest = "/usr/local/lib/nemoclaw/switchyard-relay-plugin/relay-plugin.toml"',
    );
    expect(PLUGINS).toContain('kind = "llm_classifier"');
    expect(PLUGINS).toContain('classifier_target = "classifier"');
    expect(PLUGINS).toContain('weak_target = "fast"');
    expect(PLUGINS).toContain('strong_target = "quality"');
    expect(PLUGINS.match(/base_url = "http:\/\/127\.0\.0\.1:4101"/g)).toHaveLength(3);
    expect(PLUGINS).not.toMatch(/header_env|authorization|api[_-]?key|secret/i);
    expect(PLUGINS).not.toContain("switchyard-server");
  });

  it("serves deterministic classifier results and rejects inherited authorization (#7937)", async () => {
    const port = await reservePort();
    tempRoot = mkdtempSync(join(tmpdir(), "nemoclaw-switchyard-native-test-"));
    const logPath = join(tempRoot, "provider.jsonl");
    provider = spawn("python3", [PROVIDER, "--port", String(port), "--log", logPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    await waitForProvider(port, provider);

    const classifier = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      body: JSON.stringify({
        messages: [{ content: BOUNDED_PROMPT, role: "user" }],
        model: "provider/classifier",
        stream: false,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(classifier.status).toBe(200);
    const response = (await classifier.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(JSON.parse(response.choices[0]?.message.content ?? "{}")).toMatchObject({
      recommended_route: "efficient",
    });

    const capableClassifier = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      body: JSON.stringify({
        messages: [{ content: CAPABLE_PROMPT, role: "user" }],
        model: "provider/classifier",
        stream: false,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(capableClassifier.status).toBe(200);
    const capableResponse = (await capableClassifier.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(JSON.parse(capableResponse.choices[0]?.message.content ?? "{}")).toMatchObject({
      recommended_route: "capable",
    });

    const credentialLeak = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      body: JSON.stringify({ messages: [], model: "provider/fast" }),
      headers: { authorization: "Bearer should-not-arrive", "content-type": "application/json" },
      method: "POST",
    });
    expect(credentialLeak.status).toBe(401);

    const events = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.filter((event) => event.model === "provider/classifier")).toHaveLength(2);
    expect(events.slice(0, 2).map((event) => event.prompt_kind)).toEqual(["bounded", "capable"]);
    expect(events.at(-1)).toMatchObject({ accepted: false, authorization_present: true });
  });
});
