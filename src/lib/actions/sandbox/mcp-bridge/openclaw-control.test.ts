// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testTimeout } from "../../../../../test/helpers/timeouts";

const suiteOptions = { timeout: testTimeout(35_000) };

function exercise(failure = "") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-live-openclaw-"));
  try {
    const source = `
const failure = ${JSON.stringify(failure)};
const crypto = require("node:crypto");
const replace = (module, key, value) => Object.defineProperty(require(module), key, {value,configurable:true,writable:true});
const base = "./src/lib/";
const id = "a".repeat(64);
const namespace = "owned-namespace";
const calls = [], writes = [], configSelections = [];
let checks = 0, closes = 0, registryReads = 0, probeCount = 0, configReads = 0, verificationReads = 0, runtimeResource;
let content = JSON.stringify({preserved:true}) + "\\n";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const okay = stdout => ({status:0,stdout,stderr:"",output:stdout});
replace(base+"state/registry.js", "getSandbox", () => {registryReads++; throw new Error("registry must not be read downstream");});
replace(base+"state/registry.js", "listSandboxes", () => {registryReads++; throw new Error("registry must not be read downstream");});
replace(base+"adapters/openshell/sanitized-capture.js", "captureSanitizedResolvedOpenshell", () => okay(JSON.stringify({gateway: failure === "gateway" ? "nemoclaw-other" : "nemoclaw-9090",compute_drivers:[{name:failure === "driver" ? "podman" : "docker",capabilities:{driver_name:"docker"}}]})));
const owner = {gatewayName:"nemoclaw-9090",gatewayPort:9090,mode:"nemoclaw-managed",source:"standalone",endpoint:null,stateDir:"/owned",supervisor:null,requiredCapabilities:[]};
replace(base+"onboard/gateway-teardown-authority.js", "resolveGatewayCredentialMutationAuthority", () => ({...owner, ...(failure === "owner" && checks > 1 ? {source:"declared"}: {})}));
replace(base+"onboard/host-gateway-process.js", "scopedHostGatewayProcessOwnershipFailure", () => failure === "process" ? "wrong process" : null);
replace(base+"onboard/docker-driver-gateway-config.js", "openExistingGatewayConfigAuthority", () => ({driver:"docker",sandboxNamespace:namespace,socketPath:null,configPath:"/owned/openshell-gateway.toml",assertCurrent(){if(failure === "config") throw new Error("config changed");},close(){closes++;}}));
const marker = JSON.stringify({version:1,pid:123,driver:"docker",platform:process.platform,arch:process.arch,endpoint:"https://127.0.0.1:9090",desiredEnvHash:"b".repeat(64),gatewayBin:"/owned/bin",openshellVersion:"0.0.106",dockerHost:"unix:///owned/docker.sock",createdAt:"now"});
replace(base+"onboard/docker-driver-gateway-runtime-marker.js", "readOwnedDockerDriverGatewayRuntimeFile", () => failure === "marker" && checks > 1 ? marker+" " : marker);
replace(base+"onboard/docker-driver-gateway-process-identity.js", "readDockerDriverGatewayProcessEnvironment", () => failure === "environment" ? null : ({OPENSHELL_GATEWAY_CONFIG:"/owned/openshell-gateway.toml",DOCKER_HOST:failure === "endpoint" ? "unix:///other/docker.sock" : "unix:///owned/docker.sock"}));
const engine = {engineId:"docker",operation:"sandbox-lifecycle",authorityId:"docker:owned",capture(args,timeout,input){
  calls.push({args,timeout});
  if (args[0] === "ps") return okay(failure === "duplicate" ? id+"\\n"+"b".repeat(64) : ((failure === "replacement" && writes.length) || (failure === "read-replacement" && configReads) || (failure === "verification-replacement" && verificationReads) ? "b".repeat(64) : id));
  if (args[0] === "inspect") return okay([JSON.stringify(args.at(-1)),"true","false",JSON.stringify({"openshell.ai/managed-by":"openshell","openshell.ai/sandbox-name":"alpha","openshell.ai/sandbox-id":failure === "id" ? "other" : "sb-alpha","openshell.ai/sandbox-workspace":failure === "workspace" ? "other" : "default","openshell.ai/sandbox-namespace":failure === "namespace" ? "other" : namespace})].join("\\t"));
  if (args.includes("/usr/local/bin/nemoclaw-gateway-control")) {
    const index = args.indexOf("/usr/local/bin/nemoclaw-gateway-control");
    const action = args[index+1];
    if (action === "probe") probeCount++;
    if (failure === "controller") return {status:1,stdout:"",stderr:"GATEWAY_UNSAFE_CONFIG_PATH"};
    if (failure === "settle" && probeCount > 2) return {status:1,stdout:"",stderr:"SUPERVISOR_UNAVAILABLE"};
    return okay("v1 "+args[index+2]+" complete ok 10 11\\nGATEWAY_PID=11");
  }
  if (args.includes("write-config")) {
    const expected = args[args.indexOf("--expected-config-sha256")+1];
    if (failure === "digest" || expected !== hash(content)) return {status:1,stdout:"",stderr:"GATEWAY_CONFIG_DIGEST_CHANGED"};
    content = input.toString("utf8"); writes.push(JSON.parse(content));
    return okay(JSON.stringify({type:"result",action:"write-config",status:"ok",configDir:"/sandbox/.openclaw",files:["openclaw.json",".config-hash"],configSha256:hash(content)}));
  }
  if (args.includes("test")) return okay("");
  throw new Error("unexpected engine command");
}};
replace(base+"onboard/runtime-provider/docker-operation-authority.js", "createDockerOperationAuthority", (_operation,env) => {
  if (env.DOCKER_HOST !== "unix:///owned/docker.sock" || env.DOCKER_CONTEXT !== undefined) throw new Error("engine authority was not pinned");
  return {engine,assertAuthority(){if(failure === "engine") throw new Error("engine changed");}};
});
replace(base+"adapters/openshell/client.js", "captureOpenshellCommand", (_bin,args,options) => {configReads++; configSelections.push(options.env); return okay(content);});
replace(base+"adapters/sandbox/command-transport.js", "executeSandboxCommandTransport", () => {verificationReads++; return okay("registered\\n");});
replace(base+"onboard/runtime-provider/docker-operation-authority.js", "captureDockerOperationCommand", (_authority,args,options) => {
  const result=engine.capture(args,options.timeoutMs,options.input);
  return {status:result.status,signal:null,stdout:Buffer.from(result.stdout),stderr:Buffer.from(result.stderr)};
});
const target = {sandbox:{name:"alpha",agent:"openclaw",gatewayName:"nemoclaw-9090",gatewayPort:9090},runtimeSelection:{gatewayName:"nemoclaw-9090",workspace:"default",localTlsDir:"/owned/tls"},liveIdentity:{sandboxId:"sb-alpha",assertRuntimeResource(provider,id){const next=provider+":"+id;if(runtimeResource && runtimeResource !== next) throw new Error("runtime resource changed");runtimeResource=next;},assertCurrent(){checks++; if(failure === "live") throw new Error("live identity changed");}}};
const entry = {server:"github",agent:"openclaw",adapter:"openclaw-config",url:"https://example.com/mcp",env:["MCP_TOKEN"],providerName:"alpha-mcp-github",policyName:"mcp-bridge-github"};
if (failure === "no-pin") delete target.liveIdentity.assertRuntimeResource;
let error;
try {
  const adapter = require(base+"actions/sandbox/mcp-bridge-adapter-openclaw.js");
  adapter.registerOpenClawAdapter("alpha",entry,target.runtimeSelection,{},false,"v1",target);
  adapter.registerOpenClawAdapter("alpha",entry,target.runtimeSelection,{},true,"v2",target);
  adapter.reloadOpenClawGatewayAfterMcpMutation("alpha",target);
  adapter.unregisterOpenClawAdapter("alpha",entry,target.runtimeSelection,{operationTarget:target});
  adapter.reloadOpenClawGatewayAfterMcpMutation("alpha",target);
} catch (caught) { error = caught.message; }
process.stdout.write(JSON.stringify({error,calls,writes,checks,closes,registryReads,configSelections,content:JSON.parse(content)}));
`;
    const result = spawnSync(process.execPath, ["-e", source], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        DOCKER_CONTEXT: "wrong-ambient-engine",
        OPENSHELL_GATEWAY: "nemoclaw-wrong-ambient",
        NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS: "0.002",
        NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS: "0.001",
        NODE_OPTIONS: `--require=${path.resolve("test/helpers/onboard-script-mocks.cjs")}`,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("OpenClaw MCP commands with an explicit live target", suiteOptions, () => {
  it("adds, refreshes, reloads, and removes through the real config and controller owners without registry reads", () => {
    const proof = exercise();
    expect(proof.error).toBeUndefined();
    expect(proof.registryReads).toBe(0);
    expect(proof.writes).toHaveLength(3);
    expect(proof.writes[0].mcp.servers.github.headers.Authorization).toBe(
      "Bearer openshell:resolve:env:v1_MCP_TOKEN",
    );
    expect(proof.writes[1].mcp.servers.github.headers.Authorization).toBe(
      "Bearer openshell:resolve:env:v2_MCP_TOKEN",
    );
    expect(proof.content).toEqual({
      preserved: true,
      tools: { alsoAllow: ["bundle-mcp"] },
      mcp: { servers: {} },
    });
    expect(
      proof.configSelections.every(
        (env: Record<string, string>) => env.OPENSHELL_GATEWAY === "nemoclaw-9090",
      ),
    ).toBe(true);
    expect(
      proof.calls
        .filter((call: { args: string[] }) => call.args[0] === "exec")
        .every(
          (call: { args: string[] }) =>
            call.args.includes("a".repeat(64)) && call.args.includes("root"),
        ),
    ).toBe(true);
    expect(proof.checks).toBeGreaterThan(20);
    expect(proof.closes).toBe(5);
  });

  it.each([
    "gateway",
    "driver",
    "owner",
    "process",
    "config",
    "marker",
    "duplicate",
    "id",
    "workspace",
    "namespace",
    "engine",
    "live",
    "no-pin",
    "read-replacement",
    "environment",
    "endpoint",
  ])("refuses %s authority failure before a config write", (failure) => {
    const proof = exercise(failure);
    expect(proof.error).toBeTruthy();
    expect(proof.writes).toHaveLength(0);
    expect(proof.registryReads).toBe(0);
  });

  it.each(["replacement", "verification-replacement"])(
    "refuses %s after the first write",
    (failure) => {
      const proof = exercise(failure);
      expect(proof.error).toBeTruthy();
      expect(proof.writes).toHaveLength(1);
    },
  );

  it.each(["controller", "digest"])("preserves the %s refusal and original config", (failure) => {
    const proof = exercise(failure);
    expect(proof.error).toBeTruthy();
    expect(proof.writes).toHaveLength(0);
    expect(proof.content).toEqual({ preserved: true });
  });

  it("does not report activation when managed health fails during settle", () => {
    const proof = exercise("settle");
    expect(proof.error).toContain("did not activate");
    expect(proof.writes).toHaveLength(2);
  });
});
