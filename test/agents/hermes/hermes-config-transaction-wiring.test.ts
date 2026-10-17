// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const SOURCE_REQUIRE_HOOK = path.join(
  import.meta.dirname,
  "../../helpers",
  "onboard-script-mocks.cjs",
);

function runConfigWrite(
  mode: "sealed" | "native" | "native-restored" | "public" | "missing-gateway" | "changed-target",
  update = "model",
) {
  const rawConfig = "model:\n  default: trusted-model\n";
  const expectedDigest = createHash("sha256").update(rawConfig).digest("hex");
  const script = String.raw`
const Module = require("node:module");
const path = require("node:path");
const root = process.cwd();
const source = (...parts) => "./" + path.join("src", "lib", ...parts);
function installMock(filename, exports) {
  const resolved = require.resolve(filename);
  const replacement = new Module(resolved);
  replacement.filename = resolved;
  replacement.loaded = true;
  replacement.exports = exports;
  require.cache[resolved] = replacement;
}

const rawConfig = ${JSON.stringify(rawConfig)};
let captured = null;
let capturedPrivilegedExec = null;
const reads = [];
let selectionReads = 0;
console.log = () => undefined;
installMock(source("runner.js"), { validateName: () => undefined, ROOT: root });
installMock(source("state", "registry.js"), {
  getSandbox: () => ({ name: "alpha", agent: "hermes", gatewayName: ${mode === "missing-gateway" ? "undefined" : JSON.stringify("selected-gateway")} }),
});
installMock(source("state", "audit", "operational.js"), { appendAuditEntry: () => undefined });
installMock(source("state", "mcp-lifecycle-lock.js"), {
  withSandboxMutationLock: (_name, callback) => callback(),
});
installMock(source("actions", "sandbox", "mcp-bridge-provider-inspection.js"), {
  resolveSandboxConfigRuntimeSelection: () => {
    if (${mode === "missing-gateway"}) throw new Error("Sandbox has no registered gateway.");
    selectionReads += 1;
    return { gatewayName: ${mode === "changed-target"} && selectionReads > 1 ? "changed-gateway" : "selected-gateway", workspace: "default" };
  },
});
installMock(source("agent", "defs.js"), {
  loadAgent: () => ({
    configPaths: {
      dir: "/sandbox/.hermes",
      configFile: "config.yaml",
      format: "yaml",
      envFile: ".env",
    },
  }),
});
const { buildSelectedOpenShellSubprocessEnv } = require(source("adapters", "openshell", "command-argv.js"));
process.env.OPENSHELL_GATEWAY = "ambient-gateway";
process.env.OPENSHELL_WORKSPACE = "ambient-workspace";
process.env.OPENSHELL_LOCAL_TLS_DIR = "/ambient/tls";
process.env.OPENSHELL_TOKEN = "ambient-token";
installMock(source("adapters", "openshell", "client.js"), {
  buildSelectedOpenShellSubprocessEnv,
  captureOpenshellCommand: (_binary, argv) => { reads.push(argv); return { status: 0, stdout: rawConfig, output: rawConfig }; },
  runOpenshellCommand: (_binary, argv, options) => { captured = { argv, options }; return { status: 0, stdout: "updated=1\\n".replace("\\n", "\n") }; },
});
installMock(source("sandbox", "privileged-exec.js"), {
  capturePrivilegedSandboxCommand: (sandboxName, command, options) => {
    capturedPrivilegedExec = { command, sanitizeEnvironment: options.sanitizeEnvironment };
    captured = { argv: command, options };
    return Buffer.from("updated=1\n");
  },
  withPrivilegedSandboxExecutionLease: (_sandboxName, _operation, callback) => callback(),
});

const config = require(source("sandbox", "config.js"));
async function run() {
if (${mode === "public" || mode === "missing-gateway" || mode === "changed-target"}) {
  let error = null;
  try {
    await config.configSet("alpha", { key: "model.max_tokens", value: "24577", acceptNewPath: true });
  } catch (failure) { error = failure.message; }
  process.stdout.write(JSON.stringify({ ...captured, reads, error, privilegedExec: capturedPrivilegedExec }));
  return;
}
const target = config.resolveAgentConfig("alpha");
const parsed = config.readSandboxConfig("alpha", target);
parsed.model.default = "trusted-model-v2";
if (${JSON.stringify(update)} !== "model") {
  const { applyHermesManagedRoute } = require(source("hermes-managed-route.js"));
  applyHermesManagedRoute(parsed, {
    model: "trusted-model-v2", upstreamProvider: "vllm-local",
    baseUrl: "http://host.openshell.internal:8000/v1", inferenceApi: "openai-completions",
    nativeCredentialHandle: "openshell:resolve:env:v7_NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  });
}
config.writeSandboxConfig("alpha", target, parsed, ${JSON.stringify(mode === "native" ? "selected-gateway" : mode === "native-restored" ? { gatewayName: "selected-gateway", deferReload: true, restoreNativeLocalCredential: true } : update === "restored-native-local" ? { restoreNativeLocalCredential: true } : {})});
process.stdout.write(JSON.stringify({ ...captured, privilegedExec: capturedPrivilegedExec }));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
`;

  const result = spawnSync(process.execPath, ["--require", SOURCE_REQUIRE_HOOK, "-e", script], {
    cwd: path.join(import.meta.dirname, "../../.."),
    encoding: "utf-8",
    env: { ...process.env, NODE_OPTIONS: "" },
    timeout: 5000,
  });

  expect(result.status, result.stderr).toBe(0);
  const captured = JSON.parse(result.stdout) as {
    argv: string[];
    options: {
      input: string;
      timeout: number;
      sanitizeEnvironment: boolean;
      env?: Record<string, string>;
      replaceEnv?: boolean;
    };
    privilegedExec: { command: string[]; sanitizeEnvironment: boolean };
    reads: string[][];
    error: string | null;
  };
  return { captured, expectedDigest };
}

describe("Hermes host config transaction wiring", () => {
  it("writes public config through the sandbox owner on its registered gateway (#12603)", () => {
    const { captured, expectedDigest } = runConfigWrite("public");
    expect(captured.error).toBeNull();
    expect(captured.privilegedExec).toBeNull();
    expect(captured.reads).toHaveLength(2);
    const target = ["-g", "selected-gateway", "sandbox", "exec", "--name", "alpha"];
    expect([...captured.reads, captured.argv].map((argv) => argv.slice(0, 6))).toEqual([
      target,
      target,
      target,
    ]);
    expect(captured.argv.at(-1)).toBe(expectedDigest);
    expect(captured.options.input).toContain("max_tokens: 24577");
    expect(captured.options).toMatchObject({
      replaceEnv: true,
      env: {
        OPENSHELL_GATEWAY: "selected-gateway",
        OPENSHELL_WORKSPACE: "default",
      },
    });
    expect(captured.options.env).not.toHaveProperty("OPENSHELL_LOCAL_TLS_DIR");
    expect(captured.options.env).not.toHaveProperty("OPENSHELL_TOKEN");
  });

  it("rejects public config writes without a registered gateway before reading or mutating (#12603)", () => {
    const { captured } = runConfigWrite("missing-gateway");
    expect(captured.error).toMatch(/registered gateway/);
    expect(captured.reads).toEqual([]);
    expect(captured.privilegedExec).toBeNull();
    expect(captured.argv).toBeUndefined();
  });
  it("rejects a changed runtime target before the locked read or write (#12603)", () => {
    const { captured } = runConfigWrite("changed-target");
    expect(captured.error).toMatch(/runtime target changed/);
    expect(captured.reads).toHaveLength(1);
    expect(captured.privilegedExec).toBeNull();
    expect(captured.argv).toBeUndefined();
  });

  it("passes the read digest and serialized update to the native transaction", () => {
    const { captured, expectedDigest } = runConfigWrite("native");

    expect(captured.argv.slice(0, 6)).toEqual([
      "-g",
      "selected-gateway",
      "sandbox",
      "exec",
      "--name",
      "alpha",
    ]);
    expect(captured.argv.at(-1)).toBe(expectedDigest);
    expect(captured.options.input).toContain("default: trusted-model-v2");
    expect(captured.privilegedExec).toBeNull();
  });
  it("routes restored credentials through the selected native runtime without reloading", () => {
    const { captured, expectedDigest } = runConfigWrite("native-restored", "restored-native-local");
    expect(captured.argv.slice(0, 2)).toEqual(["-g", "selected-gateway"]);
    expect(captured.argv.slice(-2)).toEqual([expectedDigest, "restore-native-local"]);
    expect(captured.privilegedExec).toBeNull();
    expect(captured.argv.join(" ")).not.toContain("openshell:resolve:env:v7_");
  });
  it.each(["model", "native-local", "restored-native-local"])(
    "passes the read digest and %s update to the sealed transaction",
    (update) => {
      const { captured, expectedDigest } = runConfigWrite("sealed", update);
      const handle = "openshell:resolve:env:v7_NEMOCLAW_LOCAL_INFERENCE_TOKEN";
      expect(captured.argv.includes("--restore-native-local-credential")).toBe(
        update === "restored-native-local",
      );
      expect(yaml.load(captured.options.input)).toMatchObject(
        update === "model"
          ? { model: { default: "trusted-model-v2" } }
          : {
              model: { default: "trusted-model-v2", api_key: handle },
              providers: { "vllm-local": { api_key: handle } },
              custom_providers: [{ api_key: handle }],
            },
      );
      expect(captured.argv.join(" ")).not.toContain(handle);
      const digestFlag = captured.argv.indexOf("--expected-config-sha256");
      expect(captured.argv).toEqual(
        expect.arrayContaining([
          "timeout",
          "--signal=TERM",
          "--kill-after=5s",
          "2m",
          "/opt/hermes/.venv/bin/python",
          "-I",
          "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py",
          "write-config",
          "--hermes-dir",
          "/sandbox/.hermes",
          "--hash-file",
          "/etc/nemoclaw/hermes.config-hash",
          "--state-file",
          "/run/nemoclaw/hermes-restart-seal.json",
        ]),
      );
      expect(digestFlag).toBeGreaterThanOrEqual(0);
      expect(captured.argv[digestFlag + 1]).toBe(expectedDigest);
      expect(captured.options.input).toContain("default: trusted-model-v2");
      expect(captured.options.timeout).toBe(150000);
      expect(captured.options.sanitizeEnvironment).toBe(true);
      expect(captured.privilegedExec.sanitizeEnvironment).toBe(true);
      expect(captured.privilegedExec.command).toEqual(
        expect.arrayContaining([
          "/opt/hermes/.venv/bin/python",
          "-I",
          "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py",
          "write-config",
        ]),
      );
    },
  );
});
