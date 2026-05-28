// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { Interface as ReadlineInterface } from "node:readline";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as policies from "../dist/lib/policy";
import { execTimeout } from "./helpers/timeouts";

const requireForTest = createRequire(import.meta.url);
const readline = requireForTest("node:readline") as typeof import("node:readline");
const YAML = requireForTest("yaml");
const REPO_ROOT = path.join(import.meta.dirname, "..");
const resolveOpenshellModule = requireForTest(
  path.join(REPO_ROOT, "dist", "lib", "adapters", "openshell", "resolve.js"),
) as { resolveOpenshell: (...args: unknown[]) => string | null };
const CLI_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "nemoclaw.js"));
const CREDENTIALS_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "credentials", "store.js"));
const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "policy", "index.js"));
const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "state", "registry.js"));
const SELECT_FROM_LIST_ITEMS = [
  { name: "npm", description: "npm and Yarn registry access" },
  { name: "pypi", description: "Python Package Index (PyPI) access" },
];

type PolicyCall = {
  type: string;
  message?: string;
  sandboxName?: string;
  presetName?: string;
  path?: string;
};

type AppliedOptions = {
  applied?: string[];
};

function requirePresetContent(content: string | null): string {
  expect(content).toBeTruthy();
  if (!content) {
    throw new Error("Expected preset content to be present");
  }
  return content;
}

function parsePresetYaml(presetName: string): Record<string, any> {
  return YAML.parse(requirePresetContent(policies.loadPreset(presetName))) as Record<string, any>;
}

function parseRepoYaml(relativePath: string): Record<string, any> {
  return YAML.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8")) as Record<
    string,
    any
  >;
}

function runPolicyAdd(
  confirmAnswer: string,
  extraArgs: string[] = [],
  envOverrides: Record<string, string | undefined> = {},
  presetName: string = "pypi",
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-add-"));
  const scriptPath = path.join(tmpDir, "policy-add-check.js");
  const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
const credentials = require(${CREDENTIALS_PATH});
const calls = [];
policies.selectFromList = async () => ${JSON.stringify(presetName)};
policies.loadPreset = () => "network_policies:\n  example:\n    host: example.com\n";
policies.getPresetEndpoints = () => ["example.com"];
credentials.prompt = async (message) => {
  calls.push({ type: "prompt", message });
  return ${JSON.stringify(confirmAnswer)};
};
registry.getSandbox = (name) => (name === "test-sandbox" ? { name } : null);
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });
policies.listPresets = () => [
  { name: "npm", description: "npm and Yarn registry access" },
  { name: "pypi", description: "Python Package Index (PyPI) access" },
  { name: "discord", description: "Discord API, gateway, and CDN access" },
];
policies.getAppliedPresets = () => [];
policies.applyPreset = (sandboxName, presetName) => {
  calls.push({ type: "apply", sandboxName, presetName });
  return true;
};
process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-add", ...${JSON.stringify(extraArgs)}];
Promise.resolve(require(${CLI_PATH}).mainPromise).finally(() => {
  process.stdout.write("\n__CALLS__" + JSON.stringify(calls));
});
`;

  fs.writeFileSync(scriptPath, script);

  try {
    return spawnSync(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        ...envOverrides,
      },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runSelectFromList(input: string, { applied = [] }: AppliedOptions = {}) {
  const script = String.raw`
const { selectFromList } = require(${POLICIES_PATH});
const items = JSON.parse(process.env.NEMOCLAW_TEST_ITEMS);
const options = JSON.parse(process.env.NEMOCLAW_TEST_OPTIONS || "{}");

selectFromList(items, options)
  .then((value) => {
    process.stdout.write(String(value) + "\n");
  })
  .catch((error) => {
    const message = error && error.message ? error.message : String(error);
    process.stderr.write(message);
    process.exit(1);
  });
`;

  return spawnSync(process.execPath, ["-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: execTimeout(5_000),
    input,
    env: {
      ...process.env,
      NEMOCLAW_TEST_ITEMS: JSON.stringify(SELECT_FROM_LIST_ITEMS),
      NEMOCLAW_TEST_OPTIONS: JSON.stringify({ applied }),
    },
  });
}

describe("policies", () => {
  describe("listPresets", () => {
    it("returns all 20 presets", () => {
      const presets = policies.listPresets();
      expect(presets.length).toBe(20);
    });

    it("each preset has name and description", () => {
      for (const p of policies.listPresets()) {
        expect(p.name).toBeTruthy();
        expect(p.description).toBeTruthy();
      }
    });

    it("returns expected preset names", () => {
      const names = policies
        .listPresets()
        .map((p: { name: string }) => p.name)
        .sort();
      const expected = [
        "brave",
        "brew",
        "discord",
        "github",
        "huggingface",
        "jira",
        "local-inference",
        "nous-audio",
        "nous-browser",
        "nous-code",
        "nous-image",
        "nous-web",
        "npm",
        "openclaw-pricing",
        "outlook",
        "pypi",
        "slack",
        "telegram",
        "wechat",
        "whatsapp",
      ];
      expect(names).toEqual(expected);
    });
  });

  describe("loadPreset", () => {
    it("loads existing preset", () => {
      const content = requirePresetContent(policies.loadPreset("outlook"));
      expect(content.includes("network_policies:")).toBeTruthy();
    });

    it("returns null for nonexistent preset", () => {
      expect(policies.loadPreset("nonexistent")).toBe(null);
    });

    it("rejects path traversal attempts", () => {
      expect(policies.loadPreset("../../etc/passwd")).toBe(null);
      expect(policies.loadPreset("../../../etc/shadow")).toBe(null);
    });

    it("includes /usr/bin/node in communication presets", () => {
      for (const preset of ["discord", "slack", "telegram", "whatsapp"]) {
        const content = requirePresetContent(policies.loadPreset(preset));
        expect(content).toContain("/usr/local/bin/node");
        expect(content).toContain("/usr/bin/node");
      }
    });

    it("whatsapp preset routes web.whatsapp.com as a raw L4 tunnel with TLS pass-through", () => {
      // The /ws/chat upgrade is HTTP/1.1-only; if the proxy terminates TLS it
      // negotiates h2 ALPN with Meta's edge and the WS upgrade fails (Meta
      // returns 405/400 because there is no 101 Switching Protocols flow
      // over h2). `access: full` + `tls: skip` keeps OpenShell out of the
      // bytes so Baileys does the TLS handshake end-to-end and gets h1.
      // Apex and *.web.whatsapp.com (fallback nodes w1.web.whatsapp.com,
      // w2.web.whatsapp.com, ...) share the same shape so reconnects do
      // not surprise the operator.
      const parsed = parsePresetYaml("whatsapp");
      const endpoints: Array<Record<string, unknown>> =
        parsed?.network_policies?.whatsapp?.endpoints ?? [];

      for (const host of ["web.whatsapp.com", "*.web.whatsapp.com"]) {
        const entry = endpoints.find((item) => item.host === host);
        if (!entry) throw new Error(`expected ${host} endpoint`);
        expect(entry.port).toBe(443);
        expect(entry.access).toBe("full");
        expect(entry.tls).toBe("skip");
        // L4 tunnels cannot enforce REST/WebSocket rules; declaring either
        // would coerce the proxy into a TLS-terminating path that breaks
        // the WS upgrade.
        expect(entry.protocol).toBeUndefined();
        expect(entry.rules).toBeUndefined();
      }
    });

    it("whatsapp REST traffic is constrained to *.whatsapp.net with GET + POST", () => {
      // Baileys touches several whatsapp.net subdomains during pairing and
      // steady-state (mmg, static, cdn, pps, v, e1, f, s). Earlier the preset
      // listed mmg and static individually; consolidating to a *.whatsapp.net
      // wildcard keeps the preset future-proof without expanding trust
      // beyond Meta-controlled infrastructure. Mirrors the jira preset's
      // *.atlassian.net wildcard.
      const parsed = parsePresetYaml("whatsapp");
      const endpoints: Array<Record<string, unknown>> =
        parsed?.network_policies?.whatsapp?.endpoints ?? [];

      // Apex listed separately so the matcher (which does not cover the
      // bare apex via `*.whatsapp.net`) still allows it if Baileys or a
      // future plugin ever resolves the apex.
      for (const host of ["whatsapp.net", "*.whatsapp.net"]) {
        const entry = endpoints.find((item) => item.host === host);
        if (!entry) throw new Error(`expected ${host} endpoint`);
        expect(entry.port).toBe(443);
        expect(entry.protocol).toBe("rest");
        expect(entry.enforcement).toBe("enforce");
        const rules = Array.isArray(entry.rules) ? entry.rules : [];
        const methods = rules
          .map((rule: { allow?: { method?: string } }) => rule.allow?.method)
          .sort();
        expect(methods).toEqual(["GET", "POST"]);
      }
    });

    it("whatsapp preset narrowly allows the Baileys version-discovery file on raw.githubusercontent.com", () => {
      // Baileys' fetchLatestBaileysVersion() reads one file from the
      // WhiskeySockets/Baileys master branch to refresh the WA protocol
      // constant at session creation. Without this allow rule the fetch
      // fails closed and Baileys advertises a stale bundled constant
      // which Meta now rejects on pair. Scope is pinned to that single
      // file path with GET only so the rule does not turn into a general
      // raw.githubusercontent.com escape hatch.
      const parsed = parsePresetYaml("whatsapp");
      const endpoints: Array<Record<string, unknown>> =
        parsed?.network_policies?.whatsapp?.endpoints ?? [];

      const entry = endpoints.find((item) => item.host === "raw.githubusercontent.com");
      if (!entry) throw new Error("expected raw.githubusercontent.com endpoint");
      expect(entry.port).toBe(443);
      expect(entry.protocol).toBe("rest");
      expect(entry.enforcement).toBe("enforce");
      expect(entry.rules).toEqual([
        {
          allow: {
            method: "GET",
            path: "/WhiskeySockets/Baileys/master/src/Defaults/index.ts",
          },
        },
      ]);
    });

    it("local-inference preset targets host.openshell.internal on Ollama, proxy, and vLLM ports", () => {
      const content = requirePresetContent(policies.loadPreset("local-inference"));
      expect(content).toContain("host.openshell.internal");
      expect(content).toContain("port: 11434");
      expect(content).toContain("port: 11435");
      expect(content).toContain("port: 8000");
    });

    it("local-inference preset allowlists private host-gateway IP ranges", () => {
      const content = requirePresetContent(policies.loadPreset("local-inference"));
      const parsed = YAML.parse(content);
      const endpoints = parsed.network_policies.local_inference.endpoints;
      const expectedRanges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

      for (const port of [11434, 11435, 8000]) {
        const endpoint = endpoints.find(
          (item: { host?: string; port?: number; allowed_ips?: string[] }) =>
            item.host === "host.openshell.internal" && item.port === port,
        );
        expect(endpoint, `missing host-gateway endpoint for port ${port}`).toBeDefined();
        expect(endpoint?.allowed_ips).toEqual(expectedRanges);
      }
    });

    it("openclaw-pricing preset pins LiteLLM and OpenRouter reference fetches to GET-only paths", () => {
      // OpenClaw's gateway/model-pricing subsystem fetches the LiteLLM
      // pricing table and the OpenRouter model catalogue on every start.
      // Both endpoints are read-only metadata fetches, so the preset must
      // expose exactly one GET rule per host on the specific path each
      // fetch reads, with no wildcards that could widen into a general
      // raw.githubusercontent.com or openrouter.ai escape hatch.
      const parsed = parsePresetYaml("openclaw-pricing");
      const endpoints: Array<Record<string, unknown>> =
        parsed?.network_policies?.["openclaw-pricing"]?.endpoints ?? [];
      expect(endpoints).toHaveLength(2);

      const litellm = endpoints.find((item) => item.host === "raw.githubusercontent.com");
      if (!litellm) throw new Error("expected raw.githubusercontent.com endpoint");
      expect(litellm.port).toBe(443);
      expect(litellm.protocol).toBe("rest");
      expect(litellm.enforcement).toBe("enforce");
      expect(litellm.rules).toEqual([
        {
          allow: {
            method: "GET",
            path: "/BerriAI/litellm/main/model_prices_and_context_window.json",
          },
        },
      ]);

      const openrouter = endpoints.find((item) => item.host === "openrouter.ai");
      if (!openrouter) throw new Error("expected openrouter.ai endpoint");
      expect(openrouter.port).toBe(443);
      expect(openrouter.protocol).toBe("rest");
      expect(openrouter.enforcement).toBe("enforce");
      expect(openrouter.rules).toEqual([{ allow: { method: "GET", path: "/api/v1/models" } }]);

      const binaries: Array<{ path: string }> =
        parsed?.network_policies?.["openclaw-pricing"]?.binaries ?? [];
      const binaryPaths = binaries.map((entry) => entry.path).sort();
      expect(binaryPaths).toEqual(["/usr/bin/node", "/usr/local/bin/node"]);
    });

    it("local-inference preset includes openclaw and common tool binaries", () => {
      const content = requirePresetContent(policies.loadPreset("local-inference"));
      expect(content).toContain("/usr/local/bin/openclaw");
      expect(content).not.toContain("/usr/local/bin/claude");
      // node, curl, and python3 are needed for direct inference access (#2199)
      expect(content).toContain("/usr/local/bin/node");
      expect(content).toContain("/usr/bin/node");
      expect(content).toContain("/usr/bin/curl");
      expect(content).toContain("/usr/bin/python3");
    });

    it("Nous managed-tool presets expose only the host broker plus Browser Use CDP exception", () => {
      const matrix = JSON.parse(
        fs.readFileSync(
          path.join(REPO_ROOT, "agents", "hermes", "host", "managed-tool-gateway-matrix.json"),
          "utf8",
        ),
      );
      const vendorHosts = [
        "firecrawl-gateway.nousresearch.com",
        "fal-queue-gateway.nousresearch.com",
        "openai-audio-gateway.nousresearch.com",
        "browser-use-gateway.nousresearch.com",
        "modal-gateway.nousresearch.com",
      ];

      for (const [presetName, entry] of Object.entries(matrix) as Array<
        [string, { brokerPath: string }]
      >) {
        const content = requirePresetContent(policies.loadPreset(presetName));
        const parsed = YAML.parse(content);
        const policyEntries = Object.values(parsed.network_policies ?? {}) as Array<{
          endpoints?: Array<{ host?: string; port?: number }>;
        }>;
        const endpoints = policyEntries.flatMap((policy) => policy.endpoints ?? []);
        const brokerEndpoint = endpoints.find(
          (endpoint) => endpoint.host === "host.openshell.internal" && endpoint.port === 11436,
        );
        expect(brokerEndpoint, `missing broker endpoint for ${presetName}`).toBeDefined();
        expect(JSON.stringify(brokerEndpoint)).toContain(entry.brokerPath);
        for (const host of vendorHosts) {
          expect(content).not.toContain(host);
        }
        if (presetName === "nous-browser") {
          expect(content).toContain("*.cdp1.browser-use.com");
        } else {
          expect(content).not.toContain("browser-use.com");
        }
      }
    });
  });

  describe("getPresetEndpoints", () => {
    it("extracts hosts from outlook preset", () => {
      const content = requirePresetContent(policies.loadPreset("outlook"));
      const hosts = policies.getPresetEndpoints(content);
      expect(hosts.includes("graph.microsoft.com")).toBeTruthy();
      expect(hosts.includes("login.microsoftonline.com")).toBeTruthy();
      expect(hosts.includes("outlook.office365.com")).toBeTruthy();
      expect(hosts.includes("outlook.office.com")).toBeTruthy();
    });

    it("extracts hosts from telegram preset", () => {
      const content = requirePresetContent(policies.loadPreset("telegram"));
      const hosts = policies.getPresetEndpoints(content);
      expect(hosts).toEqual(["api.telegram.org"]);
    });

    it("extracts the explicit iLink hosts from wechat preset", () => {
      // OpenShell's SSRF engine doesn't expand `*.<tld>` wildcards at
      // runtime, so the preset lists each known iLink IDC host explicitly.
      // Both hosts are load-bearing today — `ilinkai.weixin.qq.com` is the
      // bootstrap (hard-coded in src/ext/wechat/qr.ts), `ilinkai.wechat.com`
      // is the per-account baseUrl returned after QR confirm. Additional
      // IDC hosts may need to be added when operators observe new
      // `DENIED ... -> <host>:443` lines in OCSF logs.
      const content = requirePresetContent(policies.loadPreset("wechat"));
      const hosts = policies.getPresetEndpoints(content);
      expect(hosts).toContain("ilinkai.weixin.qq.com");
      expect(hosts).toContain("ilinkai.wechat.com");
      expect(hosts.every((host: string) => !host.includes("`"))).toBe(true);
    });

    it("every preset has at least one endpoint", () => {
      for (const p of policies.listPresets()) {
        const content = requirePresetContent(policies.loadPreset(p.name));
        const hosts = policies.getPresetEndpoints(content);
        expect(hosts.length > 0).toBeTruthy();
      }
    });

    it("strips surrounding quotes from hostnames", () => {
      const yaml = "host: \"example.com\"\n  host: 'other.com'";
      const hosts = policies.getPresetEndpoints(yaml);
      expect(hosts).toEqual(["example.com", "other.com"]);
    });

    it("ignores commented host examples and inline comments", () => {
      const yaml = [
        "# matches `host:` as text",
        "  # host: commented.example.com",
        "  - host: real.example.com # host: ignored.example.com",
      ].join("\n");
      const hosts = policies.getPresetEndpoints(yaml);
      expect(hosts).toEqual(["real.example.com"]);
    });
  });

  describe("getPresetValidationWarning", () => {
    it("returns a warning for the telegram preset that mentions re-running onboard", () => {
      const warning = policies.getPresetValidationWarning("telegram");
      expect(warning).toBeTruthy();
      expect(warning).toContain("telegram");
      expect(warning).toContain("Telegram");
      expect(warning).toContain("nemoclaw onboard");
    });

    it("returns a warning for discord, slack, and wechat", () => {
      expect(policies.getPresetValidationWarning("discord")).toContain("Discord");
      expect(policies.getPresetValidationWarning("slack")).toContain("Slack");
      expect(policies.getPresetValidationWarning("wechat")).toContain("WeChat");
    });

    it("adds Discord validation guidance for Node probes instead of curl or DNS-only checks", () => {
      const warning = policies.getPresetValidationWarning("discord");

      expect(warning).toContain("curl");
      expect(warning).toContain("preset binary allowlist");
      expect(warning).toContain("Node HTTPS");
      expect(warning).toContain("https://discord.com/api/v10/gateway");
      expect(warning).toContain('dns.resolve("gateway.discord.gg")');
    });

    it("adds Jira validation guidance that makes blocked versus redirected curl observable", () => {
      const warning = policies.getPresetValidationWarning("jira");

      expect(warning).toContain("curl -s");
      expect(warning).toContain("curl -sS -o /dev/null -w '%{http_code}'");
      expect(warning).toContain("000");
      expect(warning).toContain("Node HTTPS");
      expect(warning).toContain("https://api.atlassian.com");
    });

    it("returns null for presets without extra validation guidance", () => {
      expect(policies.getPresetValidationWarning("npm")).toBeNull();
      expect(policies.getPresetValidationWarning("pypi")).toBeNull();
      expect(policies.getPresetValidationWarning("github")).toBeNull();
      expect(policies.getPresetValidationWarning("brew")).toBeNull();
    });

    it("returns null for unknown preset names", () => {
      expect(policies.getPresetValidationWarning("")).toBeNull();
      expect(policies.getPresetValidationWarning("nonexistent")).toBeNull();
    });
  });

  describe("applyPresets", () => {
    it("merges built-in presets and submits one policy update", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-batch-"));
      const fakeOpenshell = path.join(tmpDir, "openshell");
      const callsPath = path.join(tmpDir, "calls.log");
      const policyOut = path.join(tmpDir, "policy.yaml");
      const script = String.raw`
const fs = require("node:fs");
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
registry.registerSandbox({ name: "test-sandbox", policies: [] });
const result = policies.applyPresets("test-sandbox", ["npm", "pypi"]);
process.stdout.write("\n__RESULT__" + JSON.stringify({
  result,
  calls: fs.readFileSync(process.env.CALLS_PATH, "utf-8").trim().split("\n").filter(Boolean),
  policy: fs.readFileSync(process.env.POLICY_OUT, "utf-8"),
  registry: registry.getSandbox("test-sandbox"),
}));
`;
      fs.writeFileSync(
        fakeOpenshell,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}
if [ "$1 $2" = "policy get" ]; then
  printf 'Version: 1\nHash: test\n---\nversion: 1\n\nnetwork_policies: {}\n'
  exit 0
fi
if [ "$1 $2" = "policy set" ]; then
  policy_file=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--policy" ]; then
      policy_file="$2"
      break
    fi
    shift
  done
  cp "$policy_file" ${JSON.stringify(policyOut)}
  printf 'Policy version 2 submitted\nPolicy version 2 loaded\n'
  exit 0
fi
exit 1
`,
        { mode: 0o755 },
      );

      try {
        const result = spawnSync(process.execPath, ["-e", script], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: tmpDir,
            NEMOCLAW_OPENSHELL_BIN: fakeOpenshell,
            CALLS_PATH: callsPath,
            POLICY_OUT: policyOut,
          },
        });

        expect(result.status).toBe(0);
        const marker = "__RESULT__";
        const markerIndex = result.stdout.indexOf(marker);
        expect(markerIndex).toBeGreaterThanOrEqual(0);
        const payload = JSON.parse(result.stdout.slice(markerIndex + marker.length));
        expect(payload.result).toBe(true);
        expect(payload.calls.filter((call: string) => call.startsWith("policy get "))).toHaveLength(1);
        expect(payload.calls.filter((call: string) => call.startsWith("policy set "))).toHaveLength(1);
        expect(payload.policy).toContain("npm_yarn:");
        expect(payload.policy).toContain("pypi:");
        expect(payload.registry.policies).toEqual(["npm", "pypi"]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("uses agent-specific preset content for Hermes Discord", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-hermes-"));
      const fakeOpenshell = path.join(tmpDir, "openshell");
      const policyOut = path.join(tmpDir, "policy.yaml");
      const script = String.raw`
const fs = require("node:fs");
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
registry.registerSandbox({ name: "hermes-sandbox", agent: "hermes", policies: [] });
const result = policies.applyPresets("hermes-sandbox", ["discord"]);
process.stdout.write("\n__RESULT__" + JSON.stringify({
  result,
  policy: fs.readFileSync(process.env.POLICY_OUT, "utf-8"),
  registry: registry.getSandbox("hermes-sandbox"),
}));
`;
      fs.writeFileSync(
        fakeOpenshell,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "policy get" ]; then
  printf 'Version: 1\nHash: test\n---\nversion: 1\n\nnetwork_policies: {}\n'
  exit 0
fi
if [ "$1 $2" = "policy set" ]; then
  policy_file=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--policy" ]; then
      policy_file="$2"
      break
    fi
    shift
  done
  cp "$policy_file" ${JSON.stringify(policyOut)}
  printf 'Policy version 2 submitted\nPolicy version 2 loaded\n'
  exit 0
fi
exit 1
`,
        { mode: 0o755 },
      );

      try {
        const result = spawnSync(process.execPath, ["-e", script], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: tmpDir,
            NEMOCLAW_OPENSHELL_BIN: fakeOpenshell,
            POLICY_OUT: policyOut,
          },
        });

        expect(result.status).toBe(0);
        const marker = "__RESULT__";
        const markerIndex = result.stdout.indexOf(marker);
        expect(markerIndex).toBeGreaterThanOrEqual(0);
        const payload = JSON.parse(result.stdout.slice(markerIndex + marker.length));
        const parsed = YAML.parse(payload.policy);
        const discordPolicy = parsed.network_policies.discord;
        const binaries = discordPolicy.binaries.map((entry: { path: string }) => entry.path);
        expect(binaries).toContain("/usr/bin/python3*");
        expect(binaries).toContain("/opt/hermes/.venv/bin/python");
        const discordCom = discordPolicy.endpoints.find(
          (endpoint: { host?: string }) => endpoint.host === "discord.com",
        );
        const mutationRules = discordCom.rules
          .map((rule: { allow?: { method?: string; path?: string } }) => rule.allow)
          .filter((rule: { method?: string } | undefined) =>
            ["PUT", "PATCH", "DELETE"].includes(rule?.method || ""),
          );
        expect(mutationRules).toContainEqual({
          method: "PATCH",
          path: "/api/v*/channels/*/messages/*",
        });
        expect(mutationRules).not.toContainEqual({ method: "PATCH", path: "/**" });
        expect(payload.registry.policies).toEqual(["discord"]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("uses agent-specific preset aliases for Hermes WeChat", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-hermes-wechat-"));
      const fakeOpenshell = path.join(tmpDir, "openshell");
      const policyOut = path.join(tmpDir, "policy.yaml");
      const script = String.raw`
const fs = require("node:fs");
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
registry.registerSandbox({ name: "hermes-sandbox", agent: "hermes", policies: [] });
const result = policies.applyPresets("hermes-sandbox", ["wechat"]);
process.stdout.write("\n__RESULT__" + JSON.stringify({
  result,
  policy: fs.readFileSync(process.env.POLICY_OUT, "utf-8"),
  registry: registry.getSandbox("hermes-sandbox"),
}));
`;
      fs.writeFileSync(
        fakeOpenshell,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "policy get" ]; then
  printf 'Version: 1\nHash: test\n---\nversion: 1\n\nnetwork_policies: {}\n'
  exit 0
fi
if [ "$1 $2" = "policy set" ]; then
  policy_file=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--policy" ]; then
      policy_file="$2"
      break
    fi
    shift
  done
  cp "$policy_file" ${JSON.stringify(policyOut)}
  printf 'Policy version 2 submitted\nPolicy version 2 loaded\n'
  exit 0
fi
exit 1
`,
        { mode: 0o755 },
      );

      try {
        const result = spawnSync(process.execPath, ["-e", script], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: tmpDir,
            NEMOCLAW_OPENSHELL_BIN: fakeOpenshell,
            POLICY_OUT: policyOut,
          },
        });

        expect(result.status).toBe(0);
        const marker = "__RESULT__";
        const markerIndex = result.stdout.indexOf(marker);
        expect(markerIndex).toBeGreaterThanOrEqual(0);
        const payload = JSON.parse(result.stdout.slice(markerIndex + marker.length));
        const parsed = YAML.parse(payload.policy);
        expect(parsed.network_policies.wechat).toBeUndefined();
        const wechatPolicy = parsed.network_policies.wechat_bridge;
        const binaries = wechatPolicy.binaries.map((entry: { path: string }) => entry.path);
        expect(binaries).toContain("/usr/bin/python3*");
        expect(binaries).toContain("/opt/hermes/.venv/bin/python");
        expect(payload.registry.policies).toEqual(["wechat"]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("applyPreset disclosure logging", () => {
    it("logs egress endpoints before applying", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });

      try {
        try {
          policies.applyPreset("test-sandbox", "npm");
        } catch {
          /* applyPreset may throw if sandbox not running — we only care about the log */
        }
        const messages = logSpy.mock.calls.map((call) =>
          typeof call[0] === "string" ? call[0] : undefined,
        );
        expect(
          messages.some((m) => typeof m === "string" && m.includes("Widening sandbox egress")),
        ).toBe(true);
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });

    it("does not log when preset does not exist", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        policies.applyPreset("test-sandbox", "nonexistent");
        const messages = logSpy.mock.calls.map((call) =>
          typeof call[0] === "string" ? call[0] : undefined,
        );
        expect(
          messages.some((m) => typeof m === "string" && m.includes("Widening sandbox egress")),
        ).toBe(false);
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
    });

    it("does not log when preset exists but has no host entries", () => {
      const noHostPreset =
        "preset:\n  name: empty\n\nnetwork_policies:\n  empty_rule:\n    name: empty_rule\n    endpoints: []\n";
      const loadSpy = vi.spyOn(policies, "loadPreset").mockReturnValue(noHostPreset);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });

      try {
        try {
          policies.applyPreset("test-sandbox", "empty");
        } catch {
          /* applyPreset may throw if sandbox not running */
        }
        const messages = logSpy.mock.calls.map((call) =>
          typeof call[0] === "string" ? call[0] : undefined,
        );
        expect(
          messages.some((m) => typeof m === "string" && m.includes("Widening sandbox egress")),
        ).toBe(false);
      } finally {
        loadSpy.mockRestore();
        logSpy.mockRestore();
        errSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });
  });

  describe("buildPolicySetCommand", () => {
    it("returns an argv array with sandbox name as a separate element", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "my-assistant");
      // The binary is resolved via resolveOpenshell() so it may be an absolute
      // path; assert the openshell tail and the rest of the argv shape.
      expect(cmd[0]).toMatch(/openshell$/);
      expect(cmd.slice(1)).toEqual([
        "policy",
        "set",
        "--policy",
        "/tmp/policy.yaml",
        "--wait",
        "my-assistant",
      ]);
    });

    it("preserves shell metacharacters literally in sandbox name (no injection)", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "test; whoami");
      expect(cmd).toContain("test; whoami");
      // The metacharacters are a literal argv element, not shell-interpreted
    });

    it("places --wait before the sandbox name", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "test-box");
      const waitIdx = cmd.indexOf("--wait");
      const nameIdx = cmd.indexOf("test-box");
      expect(waitIdx < nameIdx).toBeTruthy();
    });

    it("uses the resolved openshell binary when provided by the installer path", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-bin-"));
      const override = path.join(tmpDir, "openshell");
      fs.writeFileSync(override, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const prev = process.env.NEMOCLAW_OPENSHELL_BIN;
      process.env.NEMOCLAW_OPENSHELL_BIN = override;
      try {
        const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "my-assistant");
        expect(cmd).toEqual([
          override,
          "policy",
          "set",
          "--policy",
          "/tmp/policy.yaml",
          "--wait",
          "my-assistant",
        ]);
      } finally {
        if (prev === undefined) delete process.env.NEMOCLAW_OPENSHELL_BIN;
        else process.env.NEMOCLAW_OPENSHELL_BIN = prev;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("buildPolicyGetCommand", () => {
    it("returns an argv array with sandbox name as a separate element", () => {
      const cmd = policies.buildPolicyGetCommand("my-assistant");
      expect(cmd[0]).toMatch(/openshell$/);
      expect(cmd.slice(1)).toEqual(["policy", "get", "--full", "my-assistant"]);
    });
  });

  // Regression for issue #4224: when openshell is installed at ~/.local/bin/openshell
  // (the installer's user-local location) but PATH from a non-interactive shell does
  // not include ~/.local/bin/, buildPolicySetCommand / buildPolicyGetCommand must
  // resolve openshell to an absolute path so spawnSync does not raise ENOENT.
  describe("issue 4224: spawnSync openshell ENOENT in non-interactive shells", () => {
    let tmpHome: string;
    let fakeOpenshell: string;
    let origHome: string | undefined;
    let origPath: string | undefined;
    let origBin: string | undefined;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-issue4224-"));
      const localBin = path.join(tmpHome, ".local", "bin");
      fs.mkdirSync(localBin, { recursive: true });
      fakeOpenshell = path.join(localBin, "openshell");
      fs.writeFileSync(fakeOpenshell, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

      origHome = process.env.HOME;
      origPath = process.env.PATH;
      origBin = process.env.NEMOCLAW_OPENSHELL_BIN;
      // Simulate the non-interactive shell: openshell not on PATH, no override.
      process.env.HOME = tmpHome;
      process.env.PATH = "/nonexistent-nemoclaw-path";
      delete process.env.NEMOCLAW_OPENSHELL_BIN;
    });

    afterEach(() => {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
      if (origBin === undefined) delete process.env.NEMOCLAW_OPENSHELL_BIN;
      else process.env.NEMOCLAW_OPENSHELL_BIN = origBin;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it("buildPolicySetCommand resolves openshell to ~/.local/bin/openshell when PATH lacks it", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "my-assistant");
      expect(cmd[0]).toBe(fakeOpenshell);
      expect(cmd).toEqual([
        fakeOpenshell,
        "policy",
        "set",
        "--policy",
        "/tmp/policy.yaml",
        "--wait",
        "my-assistant",
      ]);
    });

    it("buildPolicyGetCommand resolves openshell to ~/.local/bin/openshell when PATH lacks it", () => {
      const cmd = policies.buildPolicyGetCommand("my-assistant");
      expect(cmd[0]).toBe(fakeOpenshell);
      expect(cmd).toEqual([fakeOpenshell, "policy", "get", "--full", "my-assistant"]);
    });

    it("assertOpenshellResolvable emits a diagnostic listing every checked location and exits nonzero when openshell cannot be resolved", () => {
      const resolveSpy = vi
        .spyOn(resolveOpenshellModule, "resolveOpenshell")
        .mockReturnValue(null);
      const errors: string[] = [];
      const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        errors.push(args.map((a) => String(a)).join(" "));
      });
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
        throw new Error("__test_exit__");
      }) as never);

      process.env.HOME = tmpHome;
      process.env.PATH = "/nonexistent-nemoclaw-path";
      process.env.NEMOCLAW_OPENSHELL_BIN = "/nonexistent/openshell";

      try {
        expect(() => policies.assertOpenshellResolvable()).toThrow(/__test_exit__/);
        expect(exitSpy).toHaveBeenCalledWith(1);
        const combined = errors.join("\n");
        expect(combined).toMatch(/openshell binary not found/);
        expect(combined).toMatch(/NEMOCLAW_OPENSHELL_BIN=\/nonexistent\/openshell/);
        // PATH value should be logged verbatim so bug reports name what was searched.
        expect(combined).toContain("PATH=/nonexistent-nemoclaw-path");
        expect(combined).toContain(`${tmpHome}/.local/bin/openshell`);
        expect(combined).toContain("/usr/local/bin/openshell");
        expect(combined).toContain("/usr/bin/openshell");
        expect(combined).toMatch(/Install OpenShell|NEMOCLAW_OPENSHELL_BIN/);
      } finally {
        resolveSpy.mockRestore();
        errSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });

    it("assertOpenshellResolvable is a noop when openshell resolves", () => {
      const resolveSpy = vi
        .spyOn(resolveOpenshellModule, "resolveOpenshell")
        .mockReturnValue(fakeOpenshell);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
        throw new Error("should not exit");
      }) as never);
      try {
        expect(() => policies.assertOpenshellResolvable()).not.toThrow();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(errSpy).not.toHaveBeenCalled();
      } finally {
        resolveSpy.mockRestore();
        errSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });

    // The assertion must fire BEFORE any temp dir/file creation. With a real
    // `process.exit(1)` the matching `finally` does not run, so a temp dir
    // created before the exit gets orphaned in $TMPDIR. A mocked exit (which
    // throws) doesn't reproduce that — `finally` still runs and cleans up. To
    // catch the real-world bug, snapshot $TMPDIR at the *moment* of exit:
    // if the assertion fires before mkdtempSync, no nemoclaw-policy-* dir
    // should exist yet.
    it("applyPreset does not create temp dirs before the openshell resolvability check", () => {
      const beforeCount = fs
        .readdirSync(os.tmpdir())
        .filter((entry) => entry.startsWith("nemoclaw-policy-")).length;
      let countAtExit = -1;

      const resolveSpy = vi
        .spyOn(resolveOpenshellModule, "resolveOpenshell")
        .mockReturnValue(null);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
        countAtExit = fs
          .readdirSync(os.tmpdir())
          .filter((entry) => entry.startsWith("nemoclaw-policy-")).length;
        throw new Error("__test_exit__");
      }) as never);

      try {
        // Apply a real built-in preset so applyPresetContent runs end-to-end
        // up to the resolvability check.
        expect(() => policies.applyPreset("my-assistant", "npm")).toThrow(/__test_exit__/);
        expect(exitSpy).toHaveBeenCalledWith(1);
        // No `nemoclaw-policy-*` temp dir should have been created before
        // the resolvability check exited.
        expect(countAtExit).toBe(beforeCount);
      } finally {
        resolveSpy.mockRestore();
        errSpy.mockRestore();
        logSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });
  });

  describe("extractPresetEntries", () => {
    it("returns null for null input", () => {
      expect(policies.extractPresetEntries(null)).toBe(null);
    });

    it("returns null for undefined input", () => {
      expect(policies.extractPresetEntries(undefined)).toBe(null);
    });

    it("returns null for empty string", () => {
      expect(policies.extractPresetEntries("")).toBe(null);
    });

    it("returns null when no network_policies section exists", () => {
      const content = "preset:\n  name: test\n  description: test preset";
      expect(policies.extractPresetEntries(content)).toBe(null);
    });

    it("extracts indented entries from network_policies section", () => {
      const content = [
        "preset:",
        "  name: test",
        "",
        "network_policies:",
        "  test_rule:",
        "    name: test_rule",
        "    endpoints:",
        "      - host: example.com",
        "        port: 443",
      ].join("\n");
      const entries = policies.extractPresetEntries(content);
      expect(entries).toContain("test_rule:");
      expect(entries).toContain("host: example.com");
      expect(entries).toContain("port: 443");
    });

    it("strips trailing whitespace from extracted entries", () => {
      const content = "network_policies:\n  rule:\n    name: rule\n\n\n";
      const entries = policies.extractPresetEntries(content);
      expect(entries).not.toMatch(/\n$/);
    });

    it("works on every real preset file", () => {
      for (const p of policies.listPresets()) {
        const content = requirePresetContent(policies.loadPreset(p.name));
        const entries = policies.extractPresetEntries(content);
        expect(entries).toBeTruthy();
        expect(entries).toContain("endpoints:");
      }
    });

    it("does not include preset metadata header", () => {
      const content = [
        "preset:",
        "  name: test",
        "  description: desc",
        "",
        "network_policies:",
        "  rule:",
        "    name: rule",
      ].join("\n");
      const entries = policies.extractPresetEntries(content);
      expect(entries).not.toContain("preset:");
      expect(entries).not.toContain("description:");
    });
  });

  describe("parseCurrentPolicy", () => {
    it("returns empty string for null input", () => {
      expect(policies.parseCurrentPolicy(null)).toBe("");
    });

    it("returns empty string for undefined input", () => {
      expect(policies.parseCurrentPolicy(undefined)).toBe("");
    });

    it("returns empty string for empty string input", () => {
      expect(policies.parseCurrentPolicy("")).toBe("");
    });

    it("strips metadata header before --- separator", () => {
      const raw = [
        "Version: 3",
        "Hash: abc123",
        "Updated: 2026-03-26",
        "---",
        "version: 1",
        "",
        "network_policies:",
        "  rule: {}",
      ].join("\n");
      const result = policies.parseCurrentPolicy(raw);
      expect(result).toBe("version: 1\n\nnetwork_policies:\n  rule: {}");
      expect(result).not.toContain("Hash:");
      expect(result).not.toContain("Updated:");
    });

    it("returns raw content when no --- separator exists", () => {
      const raw = "version: 1\nnetwork_policies:\n  rule: {}";
      expect(policies.parseCurrentPolicy(raw)).toBe(raw);
    });

    it("trims whitespace around extracted YAML", () => {
      const raw = "Header: value\n---\n  \nversion: 1\n  ";
      const result = policies.parseCurrentPolicy(raw);
      expect(result).toBe("version: 1");
    });

    it("handles --- appearing as first line", () => {
      const raw = "---\nversion: 1\nnetwork_policies: {}";
      const result = policies.parseCurrentPolicy(raw);
      expect(result).toBe("version: 1\nnetwork_policies: {}");
    });

    it("drops metadata-only or truncated policy reads", () => {
      const raw = "Version: 3\nHash: abc123";
      expect(policies.parseCurrentPolicy(raw)).toBe("");
    });

    it("drops non-policy error output instead of treating it as YAML", () => {
      const raw = "Error: failed to parse sandbox policy YAML";
      expect(policies.parseCurrentPolicy(raw)).toBe("");
    });

    it("drops syntactically invalid or truncated YAML bodies", () => {
      const raw = "Version: 3\n---\nversion: 1\nnetwork_policies";
      expect(policies.parseCurrentPolicy(raw)).toBe("");
    });
  });

  describe("mergePresetIntoPolicy", () => {
    // Legacy list-style entries (backward compat — uses text-based fallback)
    const sampleEntries = "  - host: example.com\n    allow: true";

    it("appends network_policies when current policy has content but no version header", () => {
      const versionless = "some_key:\n  foo: bar";
      const merged = policies.mergePresetIntoPolicy(versionless, sampleEntries);
      expect(merged).toContain("version:");
      expect(merged).toContain("some_key:");
      expect(merged).toContain("network_policies:");
      expect(merged).toContain("example.com");
    });

    it("appends preset entries when current policy has network_policies but no version", () => {
      const versionlessWithNp = "network_policies:\n  - host: existing.com\n    allow: true";
      const merged = policies.mergePresetIntoPolicy(versionlessWithNp, sampleEntries);
      expect(merged).toContain("version:");
      expect(merged).toContain("existing.com");
      expect(merged).toContain("example.com");
    });

    it("keeps existing version when present", () => {
      const withVersion = "version: 2\n\nnetwork_policies:\n  - host: old.com";
      const merged = policies.mergePresetIntoPolicy(withVersion, sampleEntries);
      expect(merged).toContain("version: 2");
      expect(merged).toContain("example.com");
    });

    it("returns version + network_policies when current policy is empty", () => {
      const merged = policies.mergePresetIntoPolicy("", sampleEntries);
      expect(merged).toContain("version: 1");
      expect(merged).toContain("network_policies:");
      expect(merged).toContain("example.com");
    });

    it("rebuilds from a clean scaffold when current policy read is truncated", () => {
      const merged = policies.mergePresetIntoPolicy("Version: 3\nHash: abc123", sampleEntries);
      expect(merged).toBe(
        "version: 1\n\nnetwork_policies:\n  - host: example.com\n    allow: true",
      );
    });

    it("adds a blank line after synthesized version headers", () => {
      const merged = policies.mergePresetIntoPolicy("some_key:\n  foo: bar", sampleEntries);
      expect(merged.startsWith("version: 1\n\nsome_key:")).toBe(true);
    });

    // --- Structured merge tests (real preset format) ---
    const realisticEntries =
      "  pypi_access:\n" +
      "    name: pypi_access\n" +
      "    endpoints:\n" +
      "      - host: pypi.org\n" +
      "        port: 443\n" +
      "        access: full\n" +
      "    binaries:\n" +
      "      - { path: /usr/bin/python3* }\n";

    it("uses structured YAML merge for real preset entries", () => {
      const current =
        "version: 1\n\n" +
        "network_policies:\n" +
        "  npm_yarn:\n" +
        "    name: npm_yarn\n" +
        "    endpoints:\n" +
        "      - host: registry.npmjs.org\n" +
        "        port: 443\n" +
        "        access: full\n" +
        "    binaries:\n" +
        "      - { path: /usr/local/bin/npm* }\n";
      const merged = policies.mergePresetIntoPolicy(current, realisticEntries);
      expect(merged).toContain("npm_yarn");
      expect(merged).toContain("registry.npmjs.org");
      expect(merged).toContain("pypi_access");
      expect(merged).toContain("pypi.org");
      expect(merged).toContain("version: 1");
    });

    it("deduplicates on policy name collision (preset overrides existing)", () => {
      const current =
        "version: 1\n\n" +
        "network_policies:\n" +
        "  pypi_access:\n" +
        "    name: pypi_access\n" +
        "    endpoints:\n" +
        "      - host: old-pypi.example.com\n" +
        "        port: 443\n" +
        "        access: full\n" +
        "    binaries:\n" +
        "      - { path: /usr/bin/pip* }\n";
      const merged = policies.mergePresetIntoPolicy(current, realisticEntries);
      expect(merged).toContain("pypi.org");
      expect(merged).not.toContain("old-pypi.example.com");
    });

    it("preserves non-network sections during structured merge", () => {
      const current =
        "version: 1\n\n" +
        "filesystem_policy:\n" +
        "  include_workdir: true\n" +
        "  read_only:\n" +
        "    - /usr\n\n" +
        "process:\n" +
        "  run_as_user: sandbox\n\n" +
        "network_policies:\n" +
        "  existing:\n" +
        "    name: existing\n" +
        "    endpoints:\n" +
        "      - host: api.example.com\n" +
        "        port: 443\n" +
        "        access: full\n" +
        "    binaries:\n" +
        "      - { path: /usr/local/bin/node* }\n";
      const merged = policies.mergePresetIntoPolicy(current, realisticEntries);
      expect(merged).toContain("filesystem_policy");
      expect(merged).toContain("include_workdir");
      expect(merged).toContain("run_as_user: sandbox");
      expect(merged).toContain("existing");
      expect(merged).toContain("pypi_access");
    });
  });

  describe("mergePresetNamesIntoPolicy", () => {
    it("merges built-in named presets into policy content", () => {
      const current =
        "version: 1\n\n" +
        "network_policies:\n" +
        "  existing:\n" +
        "    name: existing\n" +
        "    endpoints:\n" +
        "      - host: api.example.com\n" +
        "        port: 443\n" +
        "        access: full\n";

      const result = policies.mergePresetNamesIntoPolicy(current, ["slack"]);

      expect(result.appliedPresets).toEqual(["slack"]);
      expect(result.missingPresets).toEqual([]);
      expect(result.policy).toContain("existing");
      expect(result.policy).toContain("slack:");
      expect(result.policy).toContain("wss-primary.slack.com");
    });
  });

  describe("preset YAML schema", () => {
    it("no preset has rules at NetworkPolicyRuleDef level", () => {
      // rules must be inside endpoints, not as sibling of endpoints/binaries
      for (const p of policies.listPresets()) {
        const content = requirePresetContent(policies.loadPreset(p.name));
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // rules: at 4-space indent (same level as endpoints:) is wrong
          // rules: at 8+ space indent (inside an endpoint) is correct
          if (/^\s{4}rules:/.test(line)) {
            expect.unreachable(
              `${p.name} line ${i + 1}: rules at policy level (should be inside endpoint)`,
            );
          }
        }
      }
    });

    it("every preset has network_policies section", () => {
      for (const p of policies.listPresets()) {
        const content = requirePresetContent(policies.loadPreset(p.name));
        expect(content.includes("network_policies:")).toBeTruthy();
      }
    });

    it("pypi preset uses protocol: rest with read-only rules", () => {
      // PyPI only needs read access to install packages.
      // PyPI's pip uses http.request() (not undici), so it goes through
      // http-proxy-fix.js which rewrites FORWARD-mode to https.request,
      // avoiding CONNECT entirely. protocol: rest is therefore safe and
      // preferred for tighter L7 method enforcement.
      const content = requirePresetContent(policies.loadPreset("pypi"));
      expect(content).toBeTruthy();
      expect(content.includes("access: full")).toBe(false);
      expect(content.includes("protocol: rest")).toBe(true);
      expect(content.includes("method: GET")).toBe(true);
      // No write methods allowed
      expect(content.includes("method: PUT")).toBe(false);
      expect(content.includes("method: POST")).toBe(false);
      expect(content.includes("method: DELETE")).toBe(false);
    });

    it("npm preset uses L4 tunnel for CONNECT compatibility (#2767)", () => {
      // npm on Node 22 uses undici's built-in fetch which bypasses
      // http.request() and issues CONNECT directly through HTTPS_PROXY.
      // protocol: rest triggers L7 method inspection that rejects
      // CONNECT, causing ECONNRESET on tarball downloads. access: full
      // with tls: skip uses L4 tunneling that supports CONNECT.
      const content = requirePresetContent(policies.loadPreset("npm"));
      expect(content).toBeTruthy();
      expect(content.includes("access: full")).toBe(true);
      expect(content.includes("tls: skip")).toBe(true);
      expect(content.includes("protocol: rest")).toBe(false);
    });

    it("outlook preset allows PATCH on graph.microsoft.com", () => {
      // Microsoft Graph API uses PATCH for common email and calendar operations:
      // marking messages as read, updating drafts, modifying calendar events.
      const content = requirePresetContent(policies.loadPreset("outlook"));
      const graphSection = content.split("host: graph.microsoft.com")[1]?.split("- host:")[0] ?? "";
      expect(graphSection).toContain("method: PATCH");
    });

    it("messaging WebSocket presets use native inspected WebSocket policy", () => {
      const cases = [
        {
          preset: "discord",
          host: "gateway.discord.gg",
          credentialRewrite: true,
        },
        {
          preset: "discord",
          host: "*.discord.gg",
          credentialRewrite: true,
        },
        {
          preset: "slack",
          host: "wss-primary.slack.com",
          credentialRewrite: true,
        },
        {
          preset: "slack",
          host: "wss-backup.slack.com",
          credentialRewrite: true,
        },
      ];

      for (const { preset, host, credentialRewrite } of cases) {
        const content = requirePresetContent(policies.loadPreset(preset));
        const parsed = YAML.parse(content) as {
          network_policies?: Record<
            string,
            {
              endpoints?: Array<{
                host?: string;
                protocol?: string;
                access?: string;
                tls?: string;
                websocket_credential_rewrite?: boolean;
                request_body_credential_rewrite?: boolean;
                rules?: Array<{ allow?: { method?: string; path?: string } }>;
              }>;
            }
          >;
        };
        const endpoints = Object.values(parsed.network_policies ?? {}).flatMap(
          (policy) => policy.endpoints ?? [],
        );
        const endpoint = endpoints.find((candidate) => candidate.host === host);
        expect(endpoint).toBeTruthy();
        expect(endpoint).toMatchObject({ protocol: "websocket", enforcement: "enforce" });
        expect(endpoint).not.toHaveProperty("access");
        expect(endpoint).not.toHaveProperty("tls");
        expect(endpoint?.websocket_credential_rewrite === true).toBe(credentialRewrite);
        expect(endpoint?.rules).toEqual(
          expect.arrayContaining([
            { allow: { method: "GET", path: "/**" } },
            { allow: { method: "WEBSOCKET_TEXT", path: "/**" } },
          ]),
        );
      }
    });

    it("Slack REST endpoints opt into OpenShell request-body credential rewrite", () => {
      const policySources = [
        fs.readFileSync(
          path.join(REPO_ROOT, "nemoclaw-blueprint/policies/presets/slack.yaml"),
          "utf8",
        ),
        fs.readFileSync(path.join(REPO_ROOT, "agents/hermes/policy-additions.yaml"), "utf8"),
        fs.readFileSync(path.join(REPO_ROOT, "agents/hermes/policy-permissive.yaml"), "utf8"),
        fs.readFileSync(
          path.join(REPO_ROOT, "nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml"),
          "utf8",
        ),
      ];
      const slackRestHosts = new Set(["slack.com", "api.slack.com", "hooks.slack.com"]);

      for (const content of policySources) {
        const parsed = YAML.parse(content) as {
          network_policies?: Record<
            string,
            {
              endpoints?: Array<{
                host?: string;
                protocol?: string;
                request_body_credential_rewrite?: boolean;
              }>;
            }
          >;
        };
        const endpoints = Object.values(parsed.network_policies ?? {}).flatMap(
          (policy) => policy.endpoints ?? [],
        );
        for (const endpoint of endpoints.filter((candidate) =>
          slackRestHosts.has(candidate.host ?? ""),
        )) {
          expect(endpoint).toMatchObject({
            protocol: "rest",
            request_body_credential_rewrite: true,
          });
        }
      }
    });

    it("Hermes messaging gateway policies use native inspected WebSocket policy", () => {
      const policyFiles = [
        path.join(REPO_ROOT, "agents/hermes/policy-additions.yaml"),
        path.join(REPO_ROOT, "agents/hermes/policy-permissive.yaml"),
      ];
      const cases = [
        "gateway.discord.gg",
        "*.discord.gg",
        "wss-primary.slack.com",
        "wss-backup.slack.com",
      ];

      for (const file of policyFiles) {
        const content = fs.readFileSync(file, "utf8");
        const parsed = YAML.parse(content) as {
          network_policies?: Record<
            string,
            {
              endpoints?: Array<{
                host?: string;
                protocol?: string;
                access?: string;
                tls?: string;
                websocket_credential_rewrite?: boolean;
                rules?: Array<{ allow?: { method?: string; path?: string } }>;
              }>;
            }
          >;
        };
        const endpoints = Object.values(parsed.network_policies ?? {}).flatMap(
          (policy) => policy.endpoints ?? [],
        );
        for (const host of cases) {
          const endpoint = endpoints.find((candidate) => candidate.host === host);
          expect(endpoint).toBeTruthy();
          expect(endpoint).toMatchObject({
            protocol: "websocket",
            enforcement: "enforce",
            websocket_credential_rewrite: true,
          });
          expect(endpoint).not.toHaveProperty("access");
          expect(endpoint).not.toHaveProperty("tls");
          expect(endpoint?.rules).toEqual(
            expect.arrayContaining([
              { allow: { method: "GET", path: "/**" } },
              { allow: { method: "WEBSOCKET_TEXT", path: "/**" } },
            ]),
          );
        }
      }
    });

    it("Hermes Discord REST mutations are scoped to discord.com", () => {
      const parsed = parseRepoYaml("agents/hermes/policy-additions.yaml");
      const networkPolicies = parsed.network_policies as Record<
        string,
        {
          endpoints?: Array<{
            host?: string;
            rules?: Array<{ allow?: { method?: string; path?: string } }>;
          }>;
        }
      >;
      const rulesFor = (policy: string, host: string) =>
        (networkPolicies[policy]?.endpoints ?? [])
          .filter((endpoint) => endpoint.host === host)
          .flatMap((endpoint) => endpoint.rules ?? [])
          .map((rule) => rule.allow)
          .filter((rule): rule is { method: string; path: string } =>
            Boolean(rule?.method && rule?.path),
          );
      const sortRules = (rules: Array<{ method: string; path: string }>) =>
        [...rules].sort((a, b) =>
          `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
        );

      const nousRules = rulesFor("nous_research", "nousresearch.com");
      expect(nousRules).not.toContainEqual({ method: "PUT", path: "/**" });
      expect(nousRules).not.toContainEqual({ method: "PATCH", path: "/**" });
      expect(
        nousRules.filter((rule) => ["PUT", "PATCH", "DELETE"].includes(rule.method)),
      ).toEqual([]);

      const discordMutationRules = sortRules(
        rulesFor("discord", "discord.com").filter((rule) =>
          ["PUT", "PATCH", "DELETE"].includes(rule.method),
        ),
      );
      expect(discordMutationRules).toEqual(
        sortRules([
          { method: "PUT", path: "/api/v*/applications/*/commands" },
          { method: "PUT", path: "/api/v*/channels/*/messages/*/reactions/*/@me" },
          { method: "PATCH", path: "/api/v*/applications/*" },
          { method: "PATCH", path: "/api/v*/applications/*/commands/*" },
          { method: "PATCH", path: "/api/v*/channels/*/messages/*" },
          { method: "PATCH", path: "/api/v*/webhooks/*/*/messages/*" },
          { method: "DELETE", path: "/api/v*/applications/*/commands/*" },
          { method: "DELETE", path: "/api/v*/channels/*/messages/*" },
          { method: "DELETE", path: "/api/v*/channels/*/messages/*/reactions/*/*" },
          { method: "DELETE", path: "/api/v*/webhooks/*/*/messages/*" },
        ]),
      );
      expect(discordMutationRules.some((rule) => rule.path === "/**")).toBe(false);
    });

    it("Hermes GitHub policy does not whitelist the absent gh CLI (#2179)", () => {
      const parsed = parseRepoYaml("agents/hermes/policy-additions.yaml");
      const githubPolicy = parsed.network_policies?.github as
        | { binaries?: Array<{ path?: string }> }
        | undefined;
      const binaries = (githubPolicy?.binaries ?? []).map((binary) => binary.path).sort();
      expect(binaries).toEqual(["/opt/hermes/.venv/bin/python", "/usr/bin/git"]);
      expect(binaries).not.toContain("/usr/bin/gh");
    });

    it("REST policy YAML avoids deprecated tls: terminate", () => {
      const agentsDir = path.join(REPO_ROOT, "agents");
      const agentPolicyFiles = fs.existsSync(agentsDir)
        ? fs
            .readdirSync(agentsDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(agentsDir, entry.name, "policy-additions.yaml"))
            .filter((file) => fs.existsSync(file))
        : [];
      const policyFiles = [
        path.join(REPO_ROOT, "nemoclaw-blueprint/policies/openclaw-sandbox.yaml"),
        ...policies.listPresets().map((preset) =>
          path.join(REPO_ROOT, "nemoclaw-blueprint/policies/presets", preset.file),
        ),
        ...agentPolicyFiles,
      ];

      for (const file of policyFiles) {
        const content = fs.readFileSync(file, "utf8");
        expect(content).not.toContain("tls: terminate");
      }
    });

    it("baseline filesystem_policy.read_write grants the Homebrew prefix (#3913)", () => {
      // Companion to the Dockerfile.base step that bakes Homebrew core
      // into the sandbox image. Without /home/linuxbrew in read_write,
      // `brew install <formula>` cannot extract bottles or manage the
      // Cellar/opt symlinks at runtime, and the brew preset's binary
      // whitelist becomes dead code.
      const parsed = parseRepoYaml("nemoclaw-blueprint/policies/openclaw-sandbox.yaml");
      expect(parsed.filesystem_policy.read_write).toContain("/home/linuxbrew");
    });

    it("OpenClaw permissive policies preserve baseline read_write paths (#3916)", () => {
      const baseline = parseRepoYaml("nemoclaw-blueprint/policies/openclaw-sandbox.yaml") as {
        filesystem_policy?: { read_write?: string[] };
      };
      const baselineReadWrite = baseline.filesystem_policy?.read_write ?? [];
      const permissivePolicyPaths = [
        "nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml",
        "agents/openclaw/policy-permissive.yaml",
      ];

      for (const relativePath of permissivePolicyPaths) {
        const parsed = parseRepoYaml(relativePath) as {
          filesystem_policy?: { read_write?: string[] };
        };
        expect(parsed.filesystem_policy?.read_write, relativePath).toEqual(
          expect.arrayContaining(baselineReadWrite),
        );
      }
    });

    it("brew preset whitelists the PATH shim and Homebrew-managed entrypoints (#3913)", () => {
      const content = requirePresetContent(policies.loadPreset("brew"));
      const parsed = YAML.parse(content);
      const brewPolicy = parsed.network_policies?.brew as
        | { binaries?: Array<{ path?: string }> }
        | undefined;
      const binaries = (brewPolicy?.binaries ?? []).map((binary) => binary.path).sort();
      expect(binaries).toEqual(
        [
          "/home/linuxbrew/.linuxbrew/Homebrew/bin/*",
          "/home/linuxbrew/.linuxbrew/bin/*",
          "/home/linuxbrew/.linuxbrew/bin/brew",
          "/usr/bin/curl",
          "/usr/bin/git",
          "/usr/local/bin/brew",
        ].sort(),
      );
    });

    it("telegram REST preset relies on automatic TLS handling", () => {
      const content = requirePresetContent(policies.loadPreset("telegram"));
      expect(content).toBeTruthy();
      expect(content).toMatch(
        /host:\s*api\.telegram\.org[\s\S]*?protocol:\s*rest[\s\S]*?enforcement:\s*enforce/,
      );
      expect(content).not.toMatch(/host:\s*api\.telegram\.org[\s\S]*?tls:/);
    });

    it("wechat REST preset enumerates explicit iLink hosts on port 443 with allow GET/POST", () => {
      // OpenShell's SSRF engine doesn't expand `*.<tld>` wildcards at
      // runtime, so each iLink IDC host the upstream plugin can hit must be
      // listed explicitly. The proxy must still see
      // protocol/enforcement/method allowlists on each entry — dropping any
      // of those silently widens egress past what the preset documents.
      const content = requirePresetContent(policies.loadPreset("wechat"));
      for (const host of ["ilinkai\\.weixin\\.qq\\.com", "ilinkai\\.wechat\\.com"]) {
        expect(content).toMatch(
          new RegExp(
            `host:\\s*"?${host}"?[\\s\\S]*?port:\\s*443[\\s\\S]*?protocol:\\s*rest[\\s\\S]*?enforcement:\\s*enforce`,
          ),
        );
        expect(content).toMatch(
          new RegExp(
            `host:\\s*"?${host}"?[\\s\\S]*?allow:\\s*\\{\\s*method:\\s*GET[\\s\\S]*?allow:\\s*\\{\\s*method:\\s*POST`,
          ),
        );
      }
    });

    it("pypi preset allows HEAD for pip lazy-wheel metadata checks", () => {
      // pip and uv use HEAD requests for lazy wheel downloads and
      // range-request support. GET-only would break pip install.
      const content = requirePresetContent(policies.loadPreset("pypi"));
      expect(content.includes("method: HEAD")).toBe(true);
    });

    it("package-manager presets include binaries section", () => {
      // Without binaries, the proxy can't match pip/npm traffic to the policy
      // and returns 403.
      const packagePresets = [
        { name: "pypi", expectedBinary: "python" },
        { name: "npm", expectedBinary: "npm" },
      ];
      for (const { name, expectedBinary } of packagePresets) {
        const content = requirePresetContent(policies.loadPreset(name));
        expect(content).toBeTruthy();
        expect(content.includes("binaries:")).toBe(true);
        expect(content.includes(expectedBinary)).toBe(true);
      }
    });
  });

  describe("selectFromList", () => {
    it("returns preset name by number from stdin input", () => {
      const result = runSelectFromList("1\n");

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("npm");
      expect(result.stderr).toContain("Choose preset [1]:");
    });

    it("uses the first preset as the default when input is empty", () => {
      const result = runSelectFromList("\n");

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Choose preset [1]:");
      expect(result.stdout.trim()).toBe("npm");
    });

    it("defaults to the first not-applied preset", () => {
      const result = runSelectFromList("\n", { applied: ["npm"] });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Choose preset [2]:");
      expect(result.stdout.trim()).toBe("pypi");
    });

    it("rejects selecting an already-applied preset", () => {
      const result = runSelectFromList("1\n", { applied: ["npm"] });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Preset 'npm' is already applied.");
      expect(result.stdout.trim()).toBe("null");
    });

    it("rejects out-of-range preset number", () => {
      const result = runSelectFromList("99\n");

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Invalid preset number.");
      expect(result.stdout.trim()).toBe("null");
    });

    it("rejects non-numeric preset input", () => {
      const result = runSelectFromList("npm\n");

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Invalid preset number.");
      expect(result.stdout.trim()).toBe("null");
    });

    it("prints numbered list with applied markers, legend, and default prompt", () => {
      const result = runSelectFromList("2\n", { applied: ["npm"] });

      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/Available presets:/);
      expect(result.stderr).toMatch(/1\) ● npm — npm and Yarn registry access/);
      expect(result.stderr).toMatch(/2\) ○ pypi — Python Package Index \(PyPI\) access/);
      expect(result.stderr).toMatch(/● applied, ○ not applied/);
      expect(result.stderr).toMatch(/Choose preset \[2\]:/);
      expect(result.stdout.trim()).toBe("pypi");
    });
  });

  describe("removePresetFromPolicy", () => {
    const pypiEntries =
      "  pypi:\n" +
      "    name: pypi\n" +
      "    endpoints:\n" +
      "      - host: pypi.org\n" +
      "        port: 443\n";

    it("removes preset keys from policy YAML", () => {
      const current =
        "version: 1\n\n" +
        "network_policies:\n" +
        "  npm_yarn:\n" +
        "    name: npm_yarn\n" +
        "    endpoints:\n" +
        "      - host: registry.npmjs.org\n" +
        "        port: 443\n" +
        "        access: full\n" +
        "  pypi:\n" +
        "    name: pypi\n" +
        "    endpoints:\n" +
        "      - host: pypi.org\n" +
        "        port: 443\n" +
        "        access: full\n";
      const result = policies.removePresetFromPolicy(current, pypiEntries);
      expect(result).toContain("npm_yarn");
      expect(result).toContain("registry.npmjs.org");
      expect(result).not.toContain("pypi");
    });

    it("preserves non-network sections when removing preset", () => {
      const current =
        "version: 1\n\n" +
        "filesystem_policy:\n" +
        "  include_workdir: true\n\n" +
        "network_policies:\n" +
        "  pypi:\n" +
        "    name: pypi\n" +
        "    endpoints:\n" +
        "      - host: pypi.org\n" +
        "        port: 443\n";
      const result = policies.removePresetFromPolicy(current, pypiEntries);
      expect(result).toContain("filesystem_policy");
      expect(result).toContain("include_workdir");
      expect(result).not.toContain("pypi");
    });

    it("returns scaffold when current policy is empty", () => {
      const result = policies.removePresetFromPolicy("", pypiEntries);
      expect(result).toContain("version: 1");
    });

    it("returns current policy unchanged when presetEntries is null", () => {
      const current = "version: 1\n\nnetwork_policies:\n  npm_yarn:\n    name: npm_yarn\n";
      const result = policies.removePresetFromPolicy(current, null);
      expect(result).toContain("npm_yarn");
    });

    it("handles removing all network policies", () => {
      const current =
        "version: 1\n\nnetwork_policies:\n  pypi:\n    name: pypi\n    endpoints:\n      - host: pypi.org\n";
      const result = policies.removePresetFromPolicy(current, pypiEntries);
      expect(result).toContain("version: 1");
      expect(result).toContain("network_policies");
      expect(result).not.toContain("pypi");
    });

    it("returns policy unchanged when network_policies is a legacy array", () => {
      const current = "version: 1\n\nnetwork_policies:\n  - host: pypi.org\n    allow: true\n";
      const result = policies.removePresetFromPolicy(current, pypiEntries);
      expect(result).toContain("pypi.org");
      expect(result).toContain("allow: true");
    });
  });

  describe("selectForRemoval", () => {
    function runSelectForRemoval(input: string, { applied = [] }: AppliedOptions = {}) {
      const script = String.raw`
const { selectForRemoval } = require(${POLICIES_PATH});
const items = JSON.parse(process.env.NEMOCLAW_TEST_ITEMS);
const options = JSON.parse(process.env.NEMOCLAW_TEST_OPTIONS || "{}");

selectForRemoval(items, options)
  .then((value) => {
    process.stdout.write(String(value) + "\n");
  })
  .catch((error) => {
    const message = error && error.message ? error.message : String(error);
    process.stderr.write(message);
    process.exit(1);
  });
`;

      return spawnSync(process.execPath, ["-e", script], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        timeout: execTimeout(5_000),
        input,
        env: {
          ...process.env,
          NEMOCLAW_TEST_ITEMS: JSON.stringify(SELECT_FROM_LIST_ITEMS),
          NEMOCLAW_TEST_OPTIONS: JSON.stringify({ applied }),
        },
      });
    }

    it("returns null when no presets are applied", () => {
      const result = runSelectForRemoval("1\n", { applied: [] });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("No presets are currently applied");
      expect(result.stdout.trim()).toBe("null");
    });

    it("shows only applied presets and returns selected name", () => {
      const result = runSelectForRemoval("1\n", { applied: ["npm"] });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Applied presets:");
      expect(result.stderr).toContain("1) npm");
      expect(result.stderr).not.toContain("pypi");
      expect(result.stdout.trim()).toBe("npm");
    });

    it("returns null for empty input", () => {
      const result = runSelectForRemoval("\n", { applied: ["npm"] });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("null");
    });

    it("rejects non-numeric input", () => {
      const result = runSelectForRemoval("npm\n", { applied: ["npm"] });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Invalid preset number");
      expect(result.stdout.trim()).toBe("null");
    });

    it("rejects out-of-range number", () => {
      const result = runSelectForRemoval("99\n", { applied: ["npm"] });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Invalid preset number");
      expect(result.stdout.trim()).toBe("null");
    });

    it("selects second preset when both are applied", () => {
      const result = runSelectForRemoval("2\n", { applied: ["npm", "pypi"] });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("1) npm");
      expect(result.stderr).toContain("2) pypi");
      expect(result.stdout.trim()).toBe("pypi");
    });
  });

  describe("policy-add confirmation", () => {
    it("prompts for confirmation before applying a preset", () => {
      const result = runPolicyAdd("y");

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls).toContainEqual({
        type: "prompt",
        message: "  Apply 'pypi' to sandbox 'test-sandbox'? [Y/n]: ",
      });
      expect(calls).toContainEqual({
        type: "apply",
        sandboxName: "test-sandbox",
        presetName: "pypi",
      });
    });

    it("skips applying the preset when confirmation is declined", () => {
      const result = runPolicyAdd("n");

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls).toContainEqual({
        type: "prompt",
        message: "  Apply 'pypi' to sandbox 'test-sandbox'? [Y/n]: ",
      });
      expect(calls.some((call: PolicyCall) => call.type === "apply")).toBeFalsy();
    });

    it("does not prompt or apply when --dry-run is passed", () => {
      const result = runPolicyAdd("y", ["--dry-run"]);

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((call: PolicyCall) => call.type === "prompt")).toBeFalsy();
      expect(calls.some((call: PolicyCall) => call.type === "apply")).toBeFalsy();
      expect(result.stdout).toMatch(/Endpoints that would be opened: example\.com/);
      expect(result.stdout).toMatch(/--dry-run: no changes applied\./);
    });

    it("accepts a preset name with --yes for headless use", () => {
      const result = runPolicyAdd("n", ["pypi", "--yes"]);

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((call: PolicyCall) => call.type === "prompt")).toBeFalsy();
      expect(calls).toContainEqual({
        type: "apply",
        sandboxName: "test-sandbox",
        presetName: "pypi",
      });
    });

    it("honors non-interactive mode when a preset name is provided", () => {
      const result = runPolicyAdd("n", ["pypi"], { NEMOCLAW_NON_INTERACTIVE: "1" });

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((call: PolicyCall) => call.type === "prompt")).toBeFalsy();
      expect(calls).toContainEqual({
        type: "apply",
        sandboxName: "test-sandbox",
        presetName: "pypi",
      });
    });

    it("fails fast in non-interactive mode without a preset name", () => {
      const result = runPolicyAdd("y", [], { NEMOCLAW_NON_INTERACTIVE: "1" });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(
        /Non-interactive mode requires a preset name/,
      );
    });

    it("warns the user that the telegram preset alone does not enable Telegram messaging", () => {
      const result = runPolicyAdd("y", [], {}, "telegram");

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /Note: the 'telegram' preset only opens network egress to the Telegram API\./,
      );
      expect(result.stdout).toMatch(/re-run 'nemoclaw onboard' and select Telegram/);
    });

    it("warns the user that the wechat preset alone does not enable WeChat messaging", () => {
      const result = runPolicyAdd("y", [], {}, "wechat");

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /Note: the 'wechat' preset only opens network egress to the WeChat API\./,
      );
      expect(result.stdout).toMatch(/re-run 'nemoclaw onboard' and select WeChat/);
    });

    it("prints Discord validation guidance from the interactive preset flow", () => {
      const result = runPolicyAdd("y", [], {}, "discord");

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /curl is not in the preset binary allowlist, so curl probes can fail/,
      );
      expect(result.stdout).toContain("https://discord.com/api/v10/gateway");
      expect(result.stdout).toMatch(/dns\.resolve\("gateway\.discord\.gg"\)/);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls).toContainEqual({
        type: "apply",
        sandboxName: "test-sandbox",
        presetName: "discord",
      });
    });

    it("prints Discord validation guidance when the preset name is provided", () => {
      const result = runPolicyAdd("n", ["discord", "--yes"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /curl is not in the preset binary allowlist, so curl probes can fail/,
      );
      expect(result.stdout).toMatch(/Node HTTPS/);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((call: PolicyCall) => call.type === "prompt")).toBeFalsy();
      expect(calls).toContainEqual({
        type: "apply",
        sandboxName: "test-sandbox",
        presetName: "discord",
      });
    });

    it("does not warn about messaging when a non-messaging preset is selected", () => {
      const result = runPolicyAdd("y");

      expect(result.status).toBe(0);
      expect(result.stdout).not.toMatch(/only opens network egress to the/);
      expect(result.stdout).not.toMatch(/re-run 'nemoclaw onboard' and select/);
    });
  });

  describe("policy-remove confirmation", () => {
    function runPolicyRemove(
      confirmAnswer: string,
      extraArgs: string[] = [],
      envOverrides: Record<string, string | undefined> = {},
    ) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-remove-"));
      const scriptPath = path.join(tmpDir, "policy-remove-check.js");
      const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
const credentials = require(${CREDENTIALS_PATH});
const calls = [];
policies.selectForRemoval = async () => "pypi";
policies.loadPreset = () => "network_policies:\n  pypi:\n    host: pypi.org\n";
policies.getPresetEndpoints = () => ["pypi.org"];
credentials.prompt = async (message) => {
  calls.push({ type: "prompt", message });
  return ${JSON.stringify(confirmAnswer)};
};
registry.getSandbox = (name) => (name === "test-sandbox" ? { name, policies: ["pypi"] } : null);
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });
policies.listPresets = () => [
  { name: "npm", description: "npm and Yarn registry access" },
  { name: "pypi", description: "Python Package Index (PyPI) access" },
];
policies.listCustomPresets = () => [];
policies.getAppliedPresets = () => ["pypi"];
policies.removePreset = (sandboxName, presetName) => {
  calls.push({ type: "remove", sandboxName, presetName });
  return true;
};
process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-remove", ...${JSON.stringify(extraArgs)}];
Promise.resolve(require(${CLI_PATH}).mainPromise).finally(() => {
  process.stdout.write("\n__CALLS__" + JSON.stringify(calls));
});
`;

      fs.writeFileSync(scriptPath, script);

      return spawnSync(process.execPath, [scriptPath], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          ...envOverrides,
        },
      });
    }

    it("prompts for confirmation before removing a preset", () => {
      const result = runPolicyRemove("y");

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls).toContainEqual({
        type: "prompt",
        message: "  Remove 'pypi' from sandbox 'test-sandbox'? [Y/n]: ",
      });
      expect(calls).toContainEqual({
        type: "remove",
        sandboxName: "test-sandbox",
        presetName: "pypi",
      });
    });

    it("skips removing the preset when confirmation is declined", () => {
      const result = runPolicyRemove("n");

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls).toContainEqual({
        type: "prompt",
        message: "  Remove 'pypi' from sandbox 'test-sandbox'? [Y/n]: ",
      });
      expect(calls.some((call: PolicyCall) => call.type === "remove")).toBeFalsy();
    });

    it("does not prompt or remove when --dry-run is passed", () => {
      const result = runPolicyRemove("y", ["--dry-run"]);

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((call: PolicyCall) => call.type === "prompt")).toBeFalsy();
      expect(calls.some((call: PolicyCall) => call.type === "remove")).toBeFalsy();
      expect(result.stdout).toMatch(/Endpoints that would be removed: pypi\.org/);
      expect(result.stdout).toMatch(/--dry-run: no changes applied\./);
    });

    it("accepts a preset name with --yes for scripted removal", () => {
      const result = runPolicyRemove("n", ["pypi", "--yes"]);

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((call: PolicyCall) => call.type === "prompt")).toBeFalsy();
      expect(calls).toContainEqual({
        type: "remove",
        sandboxName: "test-sandbox",
        presetName: "pypi",
      });
    });

    it("honors non-interactive mode when removing an explicit preset", () => {
      const result = runPolicyRemove("n", ["pypi"], { NEMOCLAW_NON_INTERACTIVE: "1" });

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((call: PolicyCall) => call.type === "prompt")).toBeFalsy();
      expect(calls).toContainEqual({
        type: "remove",
        sandboxName: "test-sandbox",
        presetName: "pypi",
      });
    });

    it("fails fast in non-interactive mode without a preset name", () => {
      const result = runPolicyRemove("y", [], { NEMOCLAW_NON_INTERACTIVE: "1" });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(
        /Non-interactive mode requires a preset name/,
      );
    });

    it("accepts -y as an alias for --yes", () => {
      const result = runPolicyRemove("n", ["pypi", "-y"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((call: PolicyCall) => call.type === "prompt")).toBeFalsy();
      expect(calls).toContainEqual({
        type: "remove",
        sandboxName: "test-sandbox",
        presetName: "pypi",
      });
    });
  });

  describe("policy-remove custom presets", () => {
    function runPolicyRemoveCustom(
      presetName: string,
      extraArgs: string[] = [],
      envOverrides: Record<string, string | undefined> = {},
    ) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-remove-custom-"));
      const scriptPath = path.join(tmpDir, "policy-remove-custom-check.js");
      const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
const credentials = require(${CREDENTIALS_PATH});
const calls = [];
// No built-in matches.
policies.listPresets = () => [];
policies.listCustomPresets = () => [
  { file: "/tmp/my-api.yaml", name: "my-api", description: "custom preset" },
];
policies.getAppliedPresets = () => ["my-api"];
policies.loadPreset = () => null; // built-in lookup misses
policies.getPresetEndpoints = () => ["api.example.internal"];
policies.removePreset = (sandboxName, presetName) => {
  calls.push({ type: "remove", sandboxName, presetName });
  return true;
};
registry.getSandbox = (name) =>
  name === "test-sandbox" ? { name, policies: [], customPolicies: [] } : null;
registry.getCustomPolicies = () => [
  { name: "my-api", content: "network_policies:\n  my-api: {}\n", sourcePath: "/tmp/my-api.yaml" },
];
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });
credentials.prompt = async () => "y";
process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-remove", ${JSON.stringify(presetName)}, ...${JSON.stringify(extraArgs)}];
Promise.resolve(require(${CLI_PATH}).mainPromise).finally(() => {
  process.stdout.write("\n__CALLS__" + JSON.stringify(calls));
});
`;
      fs.writeFileSync(scriptPath, script);
      return spawnSync(process.execPath, [scriptPath], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: { ...process.env, HOME: tmpDir, ...envOverrides },
      });
    }

    it("removes a custom preset by name using registry-persisted content", () => {
      const result = runPolicyRemoveCustom("my-api", ["--yes"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls).toContainEqual({
        type: "remove",
        sandboxName: "test-sandbox",
        presetName: "my-api",
      });
      expect(result.stdout).toMatch(/api\.example\.internal/);
    });

    it("rejects an unknown preset name even when no built-ins are defined", () => {
      const result = runPolicyRemoveCustom("bogus", ["--yes"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Unknown preset 'bogus'/);
    });
  });

  describe("loadPresetFromFile", () => {
    const tmpDirs: string[] = [];
    afterEach(() => {
      while (tmpDirs.length > 0) {
        const dir = tmpDirs.pop();
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    function writeTmp(body: string, ext = "yaml") {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preset-"));
      tmpDirs.push(dir);
      const file = path.join(dir, `custom.${ext}`);
      fs.writeFileSync(file, body);
      return { dir, file };
    }

    it("loads a valid custom preset and returns its declared name", () => {
      const body = [
        "preset:",
        "  name: custom-rule",
        "  description: custom",
        "network_policies:",
        "  custom-rule:",
        "    name: custom-rule",
        "    endpoints:",
        "      - host: custom.example.com",
        "        port: 443",
      ].join("\n");
      const { file } = writeTmp(body);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const loaded = policies.loadPresetFromFile(file);
        expect(loaded).toBeTruthy();
        expect(loaded!.presetName).toBe("custom-rule");
        expect(loaded!.content).toContain("custom.example.com");
      } finally {
        errSpy.mockRestore();
      }
    });

    it("returns null when the file does not exist", () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile("/definitely/not/a/file.yaml")).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(msgs.some((m) => typeof m === "string" && m.includes("not found"))).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects non-yaml file extensions", () => {
      const { file } = writeTmp("preset:\n  name: ok\nnetwork_policies:\n  r: {}", "txt");
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(file)).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(msgs.some((m) => typeof m === "string" && m.includes(".yaml or .yml"))).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects invalid YAML", () => {
      const { file } = writeTmp(": : :\nfoo: [unclosed");
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(file)).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(msgs.some((m) => typeof m === "string" && m.includes("Invalid YAML"))).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects preset missing preset.name", () => {
      const body = "preset:\n  description: no name\nnetwork_policies:\n  r:\n    name: r\n";
      const { file } = writeTmp(body);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(file)).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(
          msgs.some((m) => typeof m === "string" && m.includes("must declare preset.name")),
        ).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects preset.name that is not an RFC 1123 label", () => {
      const body = "preset:\n  name: Has_Underscore\nnetwork_policies:\n  r:\n    name: r\n";
      const { file } = writeTmp(body);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(file)).toBe(null);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects preset missing network_policies", () => {
      const body = "preset:\n  name: ok\n";
      const { file } = writeTmp(body);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(file)).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(
          msgs.some((m) => typeof m === "string" && m.includes("missing network_policies")),
        ).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects a preset name that collides with a built-in", () => {
      const body = "preset:\n  name: slack\nnetwork_policies:\n  r:\n    name: r\n";
      const { file } = writeTmp(body);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(file)).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(
          msgs.some((m) => typeof m === "string" && m.includes("collides with a built-in")),
        ).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects files exceeding the size limit before reading", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preset-"));
      tmpDirs.push(dir);
      const file = path.join(dir, "huge.yaml");
      const padding = "# ".repeat(5_500_000);
      fs.writeFileSync(file, `preset:\n  name: huge\nnetwork_policies:\n  r:\n    name: r\n${padding}`);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(file)).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(msgs.some((m) => typeof m === "string" && m.includes("too large"))).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects symbolic links to a preset file", () => {
      const body = "preset:\n  name: link-target\nnetwork_policies:\n  r:\n    name: r\n";
      const { dir, file } = writeTmp(body);
      const linkPath = path.join(dir, "link.yaml");
      fs.symlinkSync(file, linkPath);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(linkPath)).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(msgs.some((m) => typeof m === "string" && m.includes("must not be a symbolic link"))).toBe(
          true,
        );
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  describe("policy-add --from-file / --from-dir", () => {
    function runPolicyAddExternal(
      extraArgs: string[] = [],
      envOverrides: Record<string, string | undefined> = {},
      promptAnswer = "y",
    ) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-external-"));
      const scriptPath = path.join(tmpDir, "policy-add-external.js");
      const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
const credentials = require(${CREDENTIALS_PATH});
const calls = [];
policies.selectFromList = async () => null;
policies.listPresets = () => [];
policies.getAppliedPresets = () => [];
policies.loadPresetFromFile = (p) => {
  calls.push({ type: "load", path: p });
  if (String(p).includes("bad")) return null;
  const m = String(p).match(/([a-z0-9-]+)\.yaml$/);
  const name = m ? m[1] : "unknown";
  return { presetName: name, content: "network_policies:\n  " + name + ":\n    host: " + name + ".example.com\n" };
};
policies.applyPresetContent = (sandboxName, presetName) => {
  calls.push({ type: "apply", sandboxName, presetName });
  return true;
};
policies.getPresetEndpoints = (content) => {
  const m = String(content).match(/host:\s*([^\s]+)/);
  return m ? [m[1]] : [];
};
credentials.prompt = async (message) => {
  calls.push({ type: "prompt", message });
  return ${JSON.stringify(promptAnswer)};
};
registry.getSandbox = (name) => (name === "test-sandbox" ? { name } : null);
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });
process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-add", ...${JSON.stringify(extraArgs)}];
Promise.resolve(require(${CLI_PATH}).mainPromise).finally(() => {
  process.stdout.write("\n__CALLS__" + JSON.stringify(calls));
});
`;
      fs.writeFileSync(scriptPath, script);
      return spawnSync(process.execPath, [scriptPath], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: { ...process.env, HOME: tmpDir, ...envOverrides },
      });
    }

    it("applies a custom preset when --from-file and --yes are provided", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-file-"));
      const file = path.join(tmp, "custom-rule.yaml");
      fs.writeFileSync(
        file,
        "preset:\n  name: custom-rule\nnetwork_policies:\n  custom-rule:\n    name: r\n",
      );
      const result = runPolicyAddExternal(["--from-file", file, "--yes"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls).toContainEqual({ type: "load", path: file });
      expect(calls).toContainEqual({
        type: "apply",
        sandboxName: "test-sandbox",
        presetName: "custom-rule",
      });
      expect(calls.some((c) => c.type === "prompt")).toBeFalsy();
    });

    it("exits non-zero when --from-file points to an unreadable preset", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-file-bad-"));
      const file = path.join(tmp, "bad.yaml");
      fs.writeFileSync(file, "preset:\n  name: ignored\n");
      const result = runPolicyAddExternal(["--from-file", file, "--yes"]);
      expect(result.status).not.toBe(0);
    });

    it("does not apply and does not prompt under --from-file --dry-run", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-file-dry-"));
      const file = path.join(tmp, "custom-rule.yaml");
      fs.writeFileSync(file, "preset:\n  name: custom-rule\nnetwork_policies: {}\n");
      const result = runPolicyAddExternal(["--from-file", file, "--dry-run", "--yes"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((c) => c.type === "apply")).toBeFalsy();
      expect(calls.some((c) => c.type === "prompt")).toBeFalsy();
      expect(result.stdout).toMatch(/--dry-run: 'custom-rule' not applied\./);
    });

    it("skips the confirmation prompt when NEMOCLAW_NON_INTERACTIVE=1", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-file-env-"));
      const file = path.join(tmp, "custom-rule.yaml");
      fs.writeFileSync(file, "preset:\n  name: custom-rule\nnetwork_policies: {}\n");
      const result = runPolicyAddExternal(["--from-file", file], { NEMOCLAW_NON_INTERACTIVE: "1" });
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((c) => c.type === "prompt")).toBeFalsy();
      expect(calls).toContainEqual({
        type: "apply",
        sandboxName: "test-sandbox",
        presetName: "custom-rule",
      });
    });

    it("does not apply an external preset when the confirmation prompt is declined", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-file-no-"));
      const file = path.join(tmp, "custom-rule.yaml");
      fs.writeFileSync(file, "preset:\n  name: custom-rule\nnetwork_policies: {}\n");
      const result = runPolicyAddExternal(["--from-file", file], {}, "no");
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((c) => c.type === "prompt")).toBeTruthy();
      expect(calls.some((c) => c.type === "apply")).toBeFalsy();
    });

    it("errors when --from-file and --from-dir are combined", () => {
      const result = runPolicyAddExternal(["--from-file", "a.yaml", "--from-dir", "b"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/cannot also be provided/);
    });

    it("errors when --from-file is missing its path argument", () => {
      const result = runPolicyAddExternal(["--from-file"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/--from-file/);
      expect(result.stderr).toMatch(/value|argument|path/);
    });

    it("applies every preset in --from-dir in sorted order and aborts on the first failure", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-dir-"));
      fs.writeFileSync(
        path.join(dir, "a-good.yaml"),
        "preset:\n  name: a-good\nnetwork_policies: {}\n",
      );
      fs.writeFileSync(
        path.join(dir, "b-bad.yaml"),
        "preset:\n  name: b-bad\nnetwork_policies: {}\n",
      );
      fs.writeFileSync(
        path.join(dir, "c-skipped.yaml"),
        "preset:\n  name: c-skipped\nnetwork_policies: {}\n",
      );
      const result = runPolicyAddExternal(["--from-dir", dir, "--yes"]);
      expect(result.status).not.toBe(0);
      // a-good succeeded (visible as the [a-good] endpoints log), b-bad triggered abort,
      // c-skipped was never loaded because the loop stopped at b-bad.
      expect(result.stdout).toMatch(/\[a-good\] Endpoints that would be opened/);
      expect(result.stdout).not.toMatch(/\[c-skipped\]/);
      expect(result.stderr).toMatch(/Aborting --from-dir/);
    });

    it("--from-dir skips hidden dotfile yaml presets", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-dir-hidden-"));
      fs.writeFileSync(path.join(dir, ".bad.yaml"), "preset:\n  name: bad\nnetwork_policies: {}\n");
      fs.writeFileSync(
        path.join(dir, "real.yaml"),
        "preset:\n  name: real\nnetwork_policies: {}\n",
      );
      const result = runPolicyAddExternal(["--from-dir", dir, "--yes"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      const loads = calls.filter((c) => c.type === "load").map((c) => c.path);
      expect(loads.length).toBe(1);
      expect(loads[0]).toMatch(/real\.yaml$/);
    });

    it("errors when --from-dir points at a non-directory", () => {
      const result = runPolicyAddExternal(["--from-dir", "/does/not/exist"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Directory not found/);
    });

    it("--from-dir skips sub-directories whose names end in .yaml/.yml", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-dir-skipdir-"));
      // A real preset file and a directory that happens to match the yaml glob.
      fs.writeFileSync(
        path.join(dir, "real.yaml"),
        "preset:\n  name: real\nnetwork_policies: {}\n",
      );
      fs.mkdirSync(path.join(dir, "archived.yaml"));
      const result = runPolicyAddExternal(["--from-dir", dir, "--yes"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      // Only the real file should have been loaded.
      const loads = calls.filter((c) => c.type === "load").map((c) => c.path);
      expect(loads.length).toBe(1);
      expect(loads[0]).toMatch(/real\.yaml$/);
    });
  });

  describe("interactive prompt cleanup", () => {
    async function runPromptLifecycle(
      functionName: "selectFromList" | "selectForRemoval",
      input: string,
    ) {
      const counts = { ref: 0, pause: 0, unref: 0 };
      const stdin = process.stdin as typeof process.stdin & {
        ref: () => typeof process.stdin;
        pause: () => typeof process.stdin;
        unref: () => typeof process.stdin;
      };
      const original = {
        ref: stdin.ref,
        pause: stdin.pause,
        unref: stdin.unref,
      };
      const createInterface = vi.spyOn(readline, "createInterface").mockReturnValue({
        question: (_question: string, callback: (answer: string) => void) => callback(input),
        close: vi.fn(),
      } as unknown as ReadlineInterface);
      stdin.ref = () => {
        counts.ref += 1;
        return process.stdin;
      };
      stdin.pause = () => {
        counts.pause += 1;
        return process.stdin;
      };
      stdin.unref = () => {
        counts.unref += 1;
        return process.stdin;
      };
      const items = [
        { name: "alpha", description: "first", file: "/tmp/alpha.yaml" },
        { name: "beta", description: "second", file: "/tmp/beta.yaml" },
      ];
      const options =
        functionName === "selectForRemoval" ? { applied: ["alpha"] } : { applied: [] };

      try {
        const selected = await policies[functionName](items, options);
        return { selected, counts };
      } finally {
        stdin.ref = original.ref;
        stdin.pause = original.pause;
        stdin.unref = original.unref;
        createInterface.mockRestore();
      }
    }

    it("releases and re-refs stdin around policy-add preset prompts", async () => {
      const result = await runPromptLifecycle("selectFromList", "1\n");
      expect(result.selected).toBe("alpha");
      expect(result.counts.ref).toBeGreaterThanOrEqual(1);
      expect(result.counts.pause).toBeGreaterThanOrEqual(1);
      expect(result.counts.unref).toBeGreaterThanOrEqual(1);
    });

    it("releases and re-refs stdin around policy-remove preset prompts", async () => {
      const result = await runPromptLifecycle("selectForRemoval", "1\n");
      expect(result.selected).toBe("alpha");
      expect(result.counts.ref).toBeGreaterThanOrEqual(1);
      expect(result.counts.pause).toBeGreaterThanOrEqual(1);
      expect(result.counts.unref).toBeGreaterThanOrEqual(1);
    });
  });
});
