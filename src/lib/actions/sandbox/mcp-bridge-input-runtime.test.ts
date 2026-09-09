// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCliOpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter-cli";
import { selectedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";
import * as portableAgentLifecycle from "../../onboard/experimental/portable-agent-lifecycle";

import {
  addMcpBridge,
  dispatchMcpBridgeCommand,
  redactCredentialValuesForDisplay,
  removeMcpBridge,
  restartMcpBridge,
  resolveCredentialEnv,
  updateMcpBridgeDenyTools,
} from "./mcp-bridge";

function liveTargetCase(
  options: {
    agent?: string;
    registryText?: string;
    permissionFailure?: boolean;
    observedAgents?: string[];
    unsafe?: boolean;
    missing?: boolean;
    replacement?: boolean;
    wrongWorkspace?: boolean;
    gatewayInStderr?: boolean;
    metadataInStderr?: boolean;
    gateway?: string;
    endpoint?: string;
    ensureGateway?: "healthy_named" | "named_unhealthy";
  } = {},
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-live-target-"));
  const registryFile = path.join(home, ".nemoclaw", "sandboxes.json");
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  options.registryText !== undefined &&
    fs.writeFileSync(registryFile, options.registryText, { mode: 0o600 });
  try {
    const source = `
const options = ${JSON.stringify(options)};
const capture = require("./src/lib/adapters/openshell/sanitized-capture.js");
const inspection = require("./src/lib/actions/sandbox/mcp-bridge-provider-inspection.js");
const registry = require("./src/lib/state/registry.js");
const { ConfigPermissionError } = require("./src/lib/state/config-io.js");
const replace = (module, key, value) => Object.defineProperty(module, key, {value, configurable:true, writable:true});
if (options.permissionFailure) replace(registry, "getSandbox", () => { throw new ConfigPermissionError("unsafe registry permissions", "registry"); });
const runtimeSelections = [];
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const gatewayHealthChecks = [];
let recoveryCalls = 0;
replace(gatewayRuntime, "getNamedGatewayLifecycleState", (name, options) => {
  gatewayHealthChecks.push({name,options});
  return {state:options ? ${JSON.stringify(options.ensureGateway ?? "healthy_named")} : "missing_named"};
});
replace(gatewayRuntime, "recoverNamedGatewayRuntime", () => { recoveryCalls++; throw new Error("unexpected gateway recovery"); });
replace(inspection, "getMcpProviderInspectionRuntimeSelection", target => {
  runtimeSelections.push(target);
  return {gatewayName:target.gatewayName,workspace:"default",localTlsDir:"/trusted/tls"};
});
const identity = {name:"alpha",id:"sandbox.existing-1",workspace:options.wrongWorkspace ? "other-workspace" : "default"};
const successful = output => ({status:0,stdout:output,stderr:"",output});
const gatewayOutput = "Gateway: " + (options.gateway ?? "nemoclaw-9090") + "\\n";
const responses = [
  {...successful(gatewayOutput),...(options.gatewayInStderr ? {stdout:"",stderr:gatewayOutput} : {})},
  options.missing ? {status:1,output:"private backend diagnostic"} : {...successful(JSON.stringify(identity)),...(options.metadataInStderr ? {stdout:"",stderr:JSON.stringify(identity)} : {})},
  successful(JSON.stringify({agents:options.observedAgents ?? [options.agent ?? "openclaw"],unsafe:options.unsafe ?? false})),
  successful(JSON.stringify({...identity,id:options.replacement ? "sandbox.replaced-2" : identity.id})),
];
const calls = [];
replace(capture, "captureSanitizedResolvedOpenshell", (args, opts) => {
  calls.push({args,env:opts.env,timeout:opts.timeout,maxBuffer:opts.maxBuffer});
  return responses.shift();
});
const state = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
(async () => {
  let sandbox, error;
  try {
    sandbox = state.getSandboxOrThrow("alpha");
    if (options.ensureGateway) await state.ensureSandboxGatewaySelected("alpha", {gatewayName:sandbox.gatewayName,workspace:"default",localTlsDir:"/trusted/tls"});
  } catch (caught) { error = {name:caught.name,message:caught.message}; }
  process.stdout.write(JSON.stringify({sandbox,error,calls,runtimeSelections,gatewayHealthChecks,recoveryCalls}));
})();
`;
    const result = spawnSync(process.execPath, ["-e", source], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        NEMOCLAW_GATEWAY_PORT: "8080",
        OPENSHELL_GATEWAY: options.gateway ?? "nemoclaw-9090",
        OPENSHELL_WORKSPACE: "default",
        OPENSHELL_GATEWAY_ENDPOINT: options.endpoint ?? "",
        NVIDIA_API_KEY: "host-secret-must-not-reach-target-probe",
        NODE_OPTIONS: `--require=${path.resolve("test/helpers/onboard-script-mocks.cjs")}`,
      },
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return {
      ...JSON.parse(result.stdout),
      registryExists: fs.existsSync(registryFile),
      registryText: fs.existsSync(registryFile) ? fs.readFileSync(registryFile, "utf8") : undefined,
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("MCP live targets without registry reconstruction", () => {
  it("reads successful gateway-info metadata from stderr without reconstructing the registry", () => {
    const proof = liveTargetCase({ gatewayInStderr: true });
    expect(proof.error).toBeUndefined();
    expect(proof.sandbox).toEqual({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw-9090",
      gatewayPort: 9090,
    });
    expect(proof.registryExists).toBe(false);
  });
  it.each(["healthy_named", "named_unhealthy"] as const)(
    "never starts or selects a gateway for an unregistered target (%s)",
    (ensureGateway) => {
      const proof = liveTargetCase({ ensureGateway });
      expect(proof.recoveryCalls).toBe(0);
      expect(proof.registryExists).toBe(false);
      expect(proof.gatewayHealthChecks).toEqual([
        {
          name: "nemoclaw-9090",
          options: {
            ignoreProbeErrors: true,
            runtimeSelection: {
              gatewayName: "nemoclaw-9090",
              workspace: "default",
              localTlsDir: "/trusted/tls",
            },
          },
        },
      ]);
      expect(proof.error?.message).toBe(
        ensureGateway === "healthy_named"
          ? undefined
          : "Selected OpenShell gateway 'nemoclaw-9090' is not healthy. Refusing MCP target recovery without registry authority.",
      );
    },
  );

  it("accepts root-owned executable symlinks and rejects writable parents, user targets, and link cycles", () => {
    const program = liveTargetCase().calls[2].args[11];
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-S",
        "-c",
        `
import contextlib, io, json, os, stat, sys, types
program = sys.argv[1]
cases = {}
for mode in ("trusted", "writable-parent", "user-target", "user-link", "cycle"):
    entries = {p: types.SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR | 0o755) for p in ("/","/usr","/usr/local","/usr/local/bin","/opt","/opt/agent")}
    entries["/usr/local/bin/openclaw"] = types.SimpleNamespace(st_uid=0,st_mode=stat.S_IFLNK | 0o777)
    entries["/opt/agent/run"] = types.SimpleNamespace(st_uid=0,st_mode=stat.S_IFREG | 0o755)
    targets = {"/usr/local/bin/openclaw":"/opt/agent/run"}
    if mode == "writable-parent": entries["/opt/agent"].st_mode |= 0o022
    if mode == "user-target": entries["/opt/agent/run"].st_uid = 1000
    if mode == "user-link": entries["/usr/local/bin/openclaw"].st_uid = 1000
    if mode == "cycle": targets["/usr/local/bin/openclaw"] = "/usr/local/bin/openclaw"
    def lookup(path):
        if path not in entries: raise FileNotFoundError(path)
        return entries[path]
    os.lstat = lookup
    os.readlink = lambda path: targets[path]
    sys.argv = ["probe",json.dumps([["openclaw","/usr/local/bin/openclaw"]])]
    output = io.StringIO()
    with contextlib.redirect_stdout(output): exec(program,{})
    cases[mode] = json.loads(output.getvalue())
print(json.dumps(cases))
`,
        program,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      trusted: { agents: ["openclaw"], unsafe: false },
      "writable-parent": { agents: [], unsafe: true },
      "user-target": { agents: [], unsafe: true },
      "user-link": { agents: [], unsafe: true },
      cycle: { agents: [], unsafe: true },
    });
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code"])(
    "resolves %s on only the selected gateway without creating a registry",
    (agent) => {
      const proof = liveTargetCase({ agent });
      expect(proof.error).toBeUndefined();
      expect(proof.sandbox).toEqual({
        name: "alpha",
        agent,
        gatewayName: "nemoclaw-9090",
        gatewayPort: 9090,
      });
      expect(proof.registryExists).toBe(false);
      expect(proof.calls[0].args).toEqual(["gateway", "info", "-g", "nemoclaw-9090"]);
      expect(
        proof.calls
          .slice(1)
          .map((call: { env: Record<string, string> }) => [
            call.env.OPENSHELL_GATEWAY,
            call.env.OPENSHELL_WORKSPACE,
            call.env.OPENSHELL_LOCAL_TLS_DIR,
            call.env.NVIDIA_API_KEY,
          ]),
      ).toEqual(Array(3).fill(["nemoclaw-9090", "default", "/trusted/tls", undefined]));
      expect(proof.calls[2].args.slice(0, 11)).toEqual([
        "sandbox",
        "exec",
        "--name",
        "alpha",
        "--timeout",
        "15",
        "--",
        "/usr/bin/python3",
        "-I",
        "-S",
        "-c",
      ]);
      expect(proof.calls.map((call: { args: string[] }) => call.args.slice(0, 2))).toEqual([
        ["gateway", "info"],
        ["sandbox", "get"],
        ["sandbox", "exec"],
        ["sandbox", "get"],
      ]);
    },
  );

  it("preserves corrupt registry bytes while resolving live sources", () => {
    const proof = liveTargetCase({
      registryText: "{corrupt registry",
      agent: "langchain-deepagents-code",
    });
    expect(proof.error).toBeUndefined();
    expect(proof.sandbox.agent).toBe("langchain-deepagents-code");
    expect(proof.registryText).toBe("{corrupt registry");
  });

  it("returns a registered nondefault gateway without live inference or fallback", () => {
    const registered = {
      name: "alpha",
      agent: "hermes",
      gatewayName: "nemoclaw-9091",
      gatewayPort: 9091,
    };
    const text = JSON.stringify({ sandboxes: { alpha: registered }, defaultSandbox: "alpha" });
    const proof = liveTargetCase({ registryText: text });
    expect(proof.sandbox).toMatchObject(registered);
    expect(proof.calls).toEqual([]);
    expect(proof.runtimeSelections).toEqual([]);
    expect(proof.registryText).toBe(text);
  });

  it.each([
    { observedAgents: [], reason: "exactly one trusted" },
    { observedAgents: ["openclaw", "hermes"], reason: "exactly one trusted" },
    { observedAgents: ["unrecognized"], reason: "exactly one trusted" },
    { unsafe: true, reason: "exactly one trusted" },
    { missing: true, reason: "could not be identified" },
    { wrongWorkspace: true, reason: "could not be identified" },
    { metadataInStderr: true, reason: "could not be identified" },
    { replacement: true, reason: "changed identity" },
    { gateway: "other-gateway", reason: "supported exact" },
    { endpoint: "https://other-gateway.invalid", reason: "OPENSHELL_GATEWAY_ENDPOINT" },
    { permissionFailure: true, reason: "unsafe registry permissions" },
  ])("refuses an unproven target: $reason", ({ reason, ...options }) => {
    const proof = liveTargetCase(options);
    expect(proof.sandbox).toBeUndefined();
    expect(proof.error.message).toContain(reason);
    expect(proof.error.message).not.toContain("private backend diagnostic");
    expect(proof.registryExists).toBe(false);
  });
});

describe("MCP input runtime boundaries", () => {
  it("rejects schema-5 MCP mutations inside their lifecycle fences (#9203)", async ({
    onTestFinished,
  }) => {
    const guard = vi
      .spyOn(portableAgentLifecycle, "assertHermesPortableCommandUnavailable")
      .mockImplementation(() => {
        throw new Error("schema-5 rejected");
      });
    onTestFinished(() => guard.mockRestore());

    await expect(
      addMcpBridge("missing-sandbox", {
        server: "github",
        url: "https://mcp.example.test/mcp",
        env: [{ name: "TOKEN" }],
      }),
    ).rejects.toThrow("schema-5 rejected");
    await expect(removeMcpBridge("missing-sandbox", "github")).rejects.toThrow("schema-5 rejected");
    await expect(restartMcpBridge("missing-sandbox", "github")).rejects.toThrow(
      "schema-5 rejected",
    );
    await expect(
      updateMcpBridgeDenyTools("missing-sandbox", "github", ["delete_*"]),
    ).rejects.toThrow("schema-5 rejected");
    expect(guard.mock.calls.map((call) => call[1])).toEqual([
      "sandbox:mcp:add",
      "sandbox:mcp:remove",
      "sandbox:mcp:restart",
      "sandbox:mcp:update",
    ]);
  });

  it("rejects unauthenticated direct add callers before sandbox or network side effects", async () => {
    await expect(
      addMcpBridge("missing-sandbox", {
        server: "github",
        url: "https://mcp.example.test/mcp",
        env: [],
      }),
    ).rejects.toThrow(/requires exactly one --env KEY/);
    await expect(
      addMcpBridge("missing-sandbox", {
        server: "github",
        url: "https://mcp.example.test/mcp",
        env: [{ name: "GCP_PROJECT_ID", value: "host-only-secret" }],
      }),
    ).rejects.toThrow(/materialized as a raw child-process value/);
  });

  it("resolves host env values without requiring them for provider reuse", () => {
    const prior = process.env.MCP_BRIDGE_TEST_TOKEN;
    process.env.MCP_BRIDGE_TEST_TOKEN = "secret-value";
    try {
      expect(resolveCredentialEnv([{ name: "MCP_BRIDGE_TEST_TOKEN" }])).toEqual({
        MCP_BRIDGE_TEST_TOKEN: "secret-value",
      });
    } finally {
      prior === undefined
        ? delete process.env.MCP_BRIDGE_TEST_TOKEN
        : (process.env.MCP_BRIDGE_TEST_TOKEN = prior);
    }
    expect(resolveCredentialEnv([{ name: "MCP_BRIDGE_TEST_TOKEN_NOT_SET" }])).toEqual({});
  });

  it("redacts inline credential values from provider failure output", () => {
    const output = redactCredentialValuesForDisplay(
      "provider failed for --credential TOKEN=inline-secret-value",
      { TOKEN: "inline-secret-value" },
    );
    expect(output).toContain("provider failed for --credential");
    expect(output).not.toContain("inline-secret-value");
  });

  it("passes MCP provider credentials by environment name, not argv value", async () => {
    const run = vi.fn((_args: string[]) => ({ status: 0, stdout: "", stderr: "" }));
    const adapter = createCliOpenShellProviderAdapter({ run });

    await adapter.createProvider({
      name: "alpha-mcp-github",
      type: "nemoclaw-mcp-v1",
      credentials: [{ name: "TOKEN", value: "inline-secret-value" }],
      config: [],
      fromExisting: false,
      target: selectedOpenShellGateway(),
    });

    const args = run.mock.calls[0]?.[0] ?? [];
    expect(args).toEqual([
      "provider",
      "create",
      "--name",
      "alpha-mcp-github",
      "--type",
      "nemoclaw-mcp-v1",
      "--credential",
      "TOKEN",
    ]);
    expect(args.join(" ")).not.toContain("inline-secret-value");
    expect(args.join(" ")).not.toContain("TOKEN=inline-secret-value");
  });

  it("rejects surplus positional arguments before sandbox side effects", async () => {
    const priorExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.exitCode = undefined;
      await dispatchMcpBridgeCommand("missing-sandbox", ["list", "extra"]);
      expect(process.exitCode).toBe(2);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Usage: nemoclaw <sandbox> mcp list [--json]"),
      );

      process.exitCode = undefined;
      await dispatchMcpBridgeCommand("missing-sandbox", ["remove", "one", "two"]);
      expect(process.exitCode).toBe(2);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Usage: nemoclaw <sandbox> mcp remove <server> [--force]"),
      );
    } finally {
      errorSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
  });

  it("rejects the redundant undocumented --probe flag for add (#6379)", async () => {
    const priorExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.exitCode = undefined;
      await dispatchMcpBridgeCommand("missing-sandbox", [
        "add",
        "github",
        "--url",
        "https://mcp.example.test/mcp",
        "--env",
        "GITHUB_TOKEN",
        "--probe",
      ]);
      expect(process.exitCode).toBe(2);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Usage: nemoclaw <sandbox> mcp add"),
      );
    } finally {
      errorSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
  });

  it("documents force cleanup without promising residual registry removal", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await dispatchMcpBridgeCommand("missing-sandbox", ["remove", "--help"]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Best-effort source cleanup; preserves ambiguous providers"),
      );
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("stale registry removal"));
    } finally {
      logSpy.mockRestore();
    }
  });
});
