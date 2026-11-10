// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { gatewaySource } from "./run-installed-native-web-ui.mts";
import { nativeOpenClawModels } from "./native-openclaw-models.mts";
import {
  NATIVE_NODE_UI_POLICY,
  nativeQualificationLoopbackConfig,
  renderNativeGatewayConfig,
  writeNativeGatewayConfig,
  type NativeGatewayOptions,
} from "./native-security.mts";

const template =
  '[openshell.drivers.mxc]\nwxc_exec_path = "stock.exe"\nbackend = "process_container"\n[other]\nretained = true\n';
const render = (options: NativeGatewayOptions = {}) =>
  renderNativeGatewayConfig(template, "C:\\NemoClaw", undefined, options);

test("the actual worker preserves native settings and distinguishes a restart from installer reconfiguration", async () => {
  const source = gatewaySource();
  const start = source.indexOf("const configurationPath = ");
  const end = source.indexOf("// Register sealed paths", start);
  assert(start > 0 && end > start);
  const files = new Map<string, string>();
  const file = path.win32.join("owned-config", "openclaw.json");
  let discoveries = 0;
  let failDiscovery = false;
  const execute = (setupSelection: string) =>
    runInNewContext("(async () => {" + source.slice(start, end) + "})()", {
      fs: {
        existsSync: (name: string) => files.has(name),
        readFileSync: (name: string) => files.get(name),
      },
      writeFileSync: (name: string, text: string) => files.set(name, text),
      parsePackagedOpenClawConfiguration: async (text: string) => JSON.parse(text),
      join: path.win32.join,
      configDirectory: "owned-config",
      configured: true,
      process: { env: { OPENCLAW_COMPILED_ASSET_ROOT: "sealed-root" } },
      browserPort: 60418,
      modelPort: 18790,
      modelToken: "fresh-token",
      inference: "nvidia",
      modelId: "nvidia/first",
      setupSelection,
      serviceConfiguration: {},
      nativeOpenClawModels,
      buildPackagedModelCatalog: async (inference: string, baseUrl: string, apiKey: string) => {
        discoveries++;
        assert.equal(inference, "nvidia");
        if (failDiscovery) throw new Error("catalog unavailable");
        return {
          provider: "nvidia",
          configuration: {
            baseUrl,
            apiKey,
            api: "openai-completions",
            models: [{ id: "nvidia/first" }, { id: "nvidia/second" }],
          },
          references: { "nvidia/first": "nvidia/first", "nvidia/second": "nvidia/second" },
        };
      },
    });
  await execute("original-setup");
  assert.equal(JSON.parse(files.get(file)!).agents.defaults.model.primary, "nvidia/first");
  files.set(
    file,
    JSON.stringify({
      agents: { defaults: { model: "nvidia/second", thinkingDefault: "medium" } },
      gateway: { bind: "all" },
    }),
  );
  await execute("original-setup");
  const restored = JSON.parse(files.get(file)!);
  assert.equal(restored.agents.defaults.model.primary, "nvidia/second");
  assert.equal(restored.agents.defaults.thinkingDefault, "medium");
  assert.equal(restored.models.providers.nvidia.apiKey, "fresh-token");
  assert.equal(restored.gateway.bind, "loopback");
  await execute("changed-setup");
  assert.equal(JSON.parse(files.get(file)!).agents.defaults.model.primary, "nvidia/first");
  const before = Array.from(files);
  failDiscovery = true;
  await assert.rejects(execute("unavailable-setup"), /catalog unavailable/);
  assert.deepEqual(Array.from(files), before);
  assert.equal(discoveries, 4);
});

test("OpenClaw allows the bound browser relay origin, not its private gateway pipe port", () => {
  const host = fs.readFileSync(
    new URL("./run-installed-native-web-ui.mts", import.meta.url),
    "utf8",
  );
  const start = host.indexOf("      const sandboxEnvironment = {");
  const end = host.indexOf("      const workloadRequest = {", start);
  assert(start >= 0 && end > start);
  const worker = gatewaySource();
  const declarations = worker.indexOf("const required = ");
  const declarationsEnd = worker.indexOf("let brokerTunnel = null;", declarations);
  const writer = worker.indexOf('writeFileSync(join(configDirectory, "openclaw.json"),');
  const writerEnd = worker.indexOf("// Register sealed paths", writer);
  assert(declarations >= 0 && declarationsEnd > declarations && writer >= 0 && writerEnd > writer);
  for (const qualification of [false, true]) {
    const env = runInNewContext(host.slice(start, end) + "sandboxEnvironment;", {
      worker: { environment: {} },
      home: "owned-home",
      modelId: "test-model",
      modelPort: 18790,
      brokerRelay: null,
      modelToken: "inert-fixture",
      openClawEntry: "sealed-entry",
      openClawRoot: "sealed-resources",
      qualification,
      relayRoot: "owned-relay",
      relayToken: "inert-relay",
      uiPort: 18789,
      uiRelay: { browserPort: 60418 },
      configuredIdentity: { config: { inference: "nvidia" } },
      systemRoot: "C:\\Windows",
      systemDrive: "C:",
      temp: "owned-temp",
      path: path.win32,
      process: { env: {} },
      createHash,
    });
    let config: { gateway: { controlUi: { allowedOrigins: string[] }; bind: string } } | undefined;
    const execute = (environment: Record<string, string | undefined>) =>
      runInNewContext(
        worker.slice(declarations, declarationsEnd) + worker.slice(writer, writerEnd),
        {
          process: { env: environment },
          serviceConfiguration: {},
          previousConfiguration: { gateway: { bind: "all" } },
          modelConfiguration: nativeOpenClawModels(
            {
              provider: "nvidia",
              configuration: { models: [{ id: "test-model" }] },
              references: { "test-model": "nvidia/test-model" },
            },
            "test-model",
          ),
          configDirectory: "owned-config",
          selectionPath: "owned-selection",
          join: path.win32.join,
          writeFileSync(_file: string, value: string) {
            if (_file !== "owned-selection") config = JSON.parse(value);
          },
        },
      );
    execute(env);
    assert(config);
    assert.equal(env.NEMOCLAW_MXC_BROWSER_PORT, "60418");
    assert.deepEqual(config.gateway.controlUi.allowedOrigins, [
      "http://127.0.0.1:60418",
      "http://localhost:60418",
    ]);
    assert.equal(config.gateway.bind, "loopback");
    assert.equal(env.NEMOCLAW_MXC_GATEWAY_PIPE_PORT, "18789");
    assert.equal(env.NEMOCLAW_MXC_BROKER_PIPE_PORT, "18790");
    for (const invalid of [undefined, "0", "65536", "1.5", "NaN"]) {
      config = undefined;
      assert.throws(
        () => execute({ ...env, NEMOCLAW_MXC_BROWSER_PORT: invalid }),
        /browser port|NEMOCLAW_MXC_BROWSER_PORT/u,
      );
      assert.equal(config, undefined);
    }
  }
});

test("supervised OpenClaw configuration uses the current driver schema without direct network grants", () => {
  const rendered = render({ network: { kind: "supervised" } });
  assert.match(rendered, /pc_allow_local_network = false\n/u);
  for (const unsupported of ["pc_network_allow", "pc_host_console", "pc_loopback_ports"])
    assert(!rendered.includes(unsupported));
  assert.throws(
    () => render({ network: { kind: "supervised" }, hostConsole: true }),
    /cannot grant the host console/u,
  );
  assert.throws(
    () => render({ network: { kind: "supervised", ports: [80] } } as NativeGatewayOptions),
    /profile network/u,
  );
});

test("gateway profiles keep qualification networking separate from Personal preview", () => {
  const denied = render();
  assert.match(
    denied,
    /pc_network_allow = false\npc_allow_local_network = false\npc_host_console = false\npc_loopback_ports = \[\]/u,
  );
  const personal = render({ network: { kind: "personal" }, hostConsole: true });
  assert.match(
    personal,
    /pc_network_allow = true\npc_allow_local_network = true\npc_host_console = true\npc_loopback_ports = \[\]/u,
  );
  const network = nativeQualificationLoopbackConfig(
    { tier: "base-container", needsDaclAugmentation: false },
    [1, 18080, 65535, 18080],
  );
  const qualification = render({ network });
  assert.match(
    qualification,
    /pc_network_allow = false\npc_allow_local_network = false\npc_host_console = false\npc_loopback_ports = \[1,18080,65535\]/u,
  );
  for (const rendered of [denied, personal, qualification]) {
    assert(rendered.endsWith('backend = "process_container"\n[other]\nretained = true\n'));
    assert(!rendered.includes("internetClient"));
    assert.equal(rendered.split("pc_loopback_ports =").length, 2);
  }
  assert.deepEqual(
    nativeQualificationLoopbackConfig(
      { tier: "appcontainer-dacl", needsDaclAugmentation: true },
      [18080],
    ),
    { kind: "deny" },
  );
});

test("gateway profiles reject malformed ports, modes, and conflicting options", () => {
  for (const ports of [[], Array(1), [0], [-1], [65536], [1.5], [NaN], [Infinity], ["80"], null]) {
    assert.throws(
      () => render({ network: { kind: "loopback", ports } } as NativeGatewayOptions),
      /loopback ports/u,
    );
  }
  for (const options of [
    { network: { kind: "unknown" } },
    { network: null },
    { network: { kind: "personal", ports: [80] } },
    { network: { kind: "deny", ports: [80] } },
    { hostConsole: "true" },
    { personalNetwork: true },
    null,
  ])
    assert.throws(() => render(options as NativeGatewayOptions), /gateway profile/u);
  for (const probe of [
    null,
    {},
    { tier: "base-container", needsDaclAugmentation: true },
    { tier: "appcontainer-dacl", needsDaclAugmentation: false },
  ]) {
    assert.throws(() => nativeQualificationLoopbackConfig(probe, [80]), /qualification/u);
  }
});

test("gateway templates cannot override the session-owned networking or console profile", () => {
  for (const key of [
    "pc_network_allow",
    "pc_allow_local_network",
    "pc_host_console",
    "pc_loopback_ports",
    "egress_proxy",
    "egress_proxy_addr",
    "pc_relay_spawner_path",
    "pc_relay_target_port",
  ]) {
    const conflicting = template.replace('backend = "process_container"', `${key} = true`);
    assert.throws(() => renderNativeGatewayConfig(conflicting, "C:\\NemoClaw"), /session-owned/u);
  }
  assert.throws(
    () => renderNativeGatewayConfig(template + "[openshell.drivers.mxc]\n", "C:\\NemoClaw"),
    /one MXC/u,
  );
  assert.throws(
    () =>
      renderNativeGatewayConfig(
        template.replace('wxc_exec_path = "stock.exe"', ""),
        "C:\\NemoClaw",
      ),
    /executable path/u,
  );
});

test("Node compatibility permits graphical startup but denies clipboard and input injection", () => {
  assert.deepEqual(NATIVE_NODE_UI_POLICY, [
    "ui:",
    "  allow_graphical_ui: true",
    "  clipboard: none",
    "  allow_input_injection: false",
    "",
  ]);
  assert(Object.isFrozen(NATIVE_NODE_UI_POLICY));
});

test("gateway writer validates the template before probing and refuses to overwrite configuration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-profile-"));
  try {
    const install = path.join(root, "install");
    const run = path.join(root, "run");
    fs.mkdirSync(path.join(install, "config"), { recursive: true });
    fs.mkdirSync(run);
    const input = path.join(install, "config", "mxc-gateway.toml");
    let probes = 0;
    const profile = async (): Promise<NativeGatewayOptions> => {
      probes += 1;
      return { network: { kind: "loopback", ports: [18080] } };
    };
    fs.writeFileSync(input, "[other]\nvalue = true\n");
    await assert.rejects(writeNativeGatewayConfig(install, run, undefined, profile), /one MXC/u);
    assert.equal(probes, 0);
    assert.deepEqual(fs.readdirSync(run), []);
    fs.writeFileSync(input, template);
    await assert.rejects(
      writeNativeGatewayConfig(install, install, undefined, profile),
      /outside/u,
    );
    assert.equal(probes, 0);
    const output = await writeNativeGatewayConfig(install, run, undefined, profile);
    assert.equal(probes, 1);
    assert.equal(
      fs.readFileSync(output, "utf8"),
      renderNativeGatewayConfig(template, install, undefined, {
        network: { kind: "loopback", ports: [18080] },
      }),
    );
    const before = fs.readFileSync(output);
    await assert.rejects(writeNativeGatewayConfig(install, run), /EEXIST/u);
    assert.deepEqual(fs.readFileSync(output), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
