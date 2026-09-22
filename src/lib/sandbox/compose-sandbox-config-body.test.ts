// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { OpenShellRuntimeSelection } from "../adapters/openshell/runtime-selection";
import YAML from "yaml";

const {
  buildOpenClawNativeConfigBatchInvocation,
  buildOpenClawNativeConfigSetInvocation,
  composeSandboxConfigBody,
  hermesConfigAllowsPrivateUrls,
  writeSandboxConfig,
} = require("./config") as {
  buildOpenClawNativeConfigBatchInvocation: (
    sandboxName: string,
    updates: Array<{ dotpath: string; value: unknown }>,
    gateway?: string | OpenShellRuntimeSelection,
  ) => { args: string[]; input: string; env?: Record<string, string>; replaceEnv?: boolean };
  buildOpenClawNativeConfigSetInvocation: (
    sandboxName: string,
    dotpath: string,
    value: Record<string, unknown>,
    gateway?: string | OpenShellRuntimeSelection,
  ) => { args: string[]; input: string };
  composeSandboxConfigBody: (
    config: Record<string, unknown>,
    target: {
      agentName: string;
      configPath: string;
      configDir: string;
      format: string;
      configFile: string;
    },
  ) => string;
  hermesConfigAllowsPrivateUrls: (config: Record<string, unknown>) => boolean;
  writeSandboxConfig: (
    sandboxName: string,
    target: typeof OPENCLAW_TARGET,
    config: Record<string, unknown>,
  ) => void;
};

const HERMES_TARGET = {
  agentName: "hermes",
  configPath: "/sandbox/.hermes/config.yaml",
  configDir: "/sandbox/.hermes",
  format: "yaml",
  configFile: "config.yaml",
};

const OPENCLAW_TARGET = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  format: "json",
  configFile: "openclaw.json",
};

describe("composeSandboxConfigBody", () => {
  it("prepends the upstream header and keeps the YAML body parseable for Hermes targets", () => {
    const config = {
      _nemoclaw_upstream: {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      },
      model: {
        default: "nvidia/nemotron-3-super-120b-a12b",
        provider: "custom",
        base_url: "https://inference.local/v1",
      },
    };

    const written = composeSandboxConfigBody(config, HERMES_TARGET);

    expect(written.startsWith("# Managed by NemoClaw")).toBe(true);
    expect(written).toContain("# Upstream provider: nvidia-prod");
    expect(written).toContain("# Upstream model: nvidia/nemotron-3-super-120b-a12b");

    const parsed = YAML.parse(written) as Record<string, unknown>;
    expect(parsed._nemoclaw_upstream).toEqual({
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
    });
    expect(parsed.model).toEqual({
      default: "nvidia/nemotron-3-super-120b-a12b",
      provider: "custom",
      base_url: "https://inference.local/v1",
    });
  });

  it("does not prepend the header for non-Hermes targets", () => {
    const config = { model: { id: "moonshotai/kimi-k2.6" } };
    const written = composeSandboxConfigBody(config, OPENCLAW_TARGET);
    expect(written.startsWith("#")).toBe(false);
    expect(JSON.parse(written)).toEqual(config);
  });

  it("refuses generic whole-file writes for OpenClaw", () => {
    expect(() => writeSandboxConfig("alpha", OPENCLAW_TARGET, {})).toThrow(
      /Refusing a whole-file OpenClaw config write/,
    );
  });

  it("streams native OpenClaw config values instead of exposing them in host argv", () => {
    const invocation = buildOpenClawNativeConfigSetInvocation(
      "alpha",
      "models.providers.inference",
      { apiKey: "sandbox-only-secret", models: [{ id: "model-a" }] },
    );

    expect(invocation.args.join(" ")).not.toContain("sandbox-only-secret");
    expect(invocation.args.join(" ")).toContain("openclaw config set --batch-file");
    expect(invocation.args.join(" ")).toContain("umask 077");
    expect(invocation.args.join(" ")).not.toContain("--batch-json");
    expect(invocation.args.join(" ")).not.toContain("models.providers.inference");
    expect(invocation.input).toContain("sandbox-only-secret");
    expect(JSON.parse(invocation.input)).toEqual([
      {
        path: "models.providers.inference",
        value: { apiKey: "sandbox-only-secret", models: [{ id: "model-a" }] },
      },
    ]);
  });

  it("sends related native OpenClaw config changes as one batch transaction", () => {
    const invocation = buildOpenClawNativeConfigBatchInvocation("alpha", [
      { dotpath: "agents.defaults.model.primary", value: "inference/model-a" },
      {
        dotpath: "models.providers.inference",
        value: { apiKey: "sandbox-only-secret", models: [{ id: "model-a" }] },
      },
    ]);

    expect(invocation.args.join(" ")).toContain("openclaw config set --batch-file");
    expect(invocation.args.join(" ")).not.toContain("--batch-json");
    expect(invocation.args.join(" ")).not.toContain("sandbox-only-secret");
    expect(JSON.parse(invocation.input)).toEqual([
      { path: "agents.defaults.model.primary", value: "inference/model-a" },
      {
        path: "models.providers.inference",
        value: { apiKey: "sandbox-only-secret", models: [{ id: "model-a" }] },
      },
    ]);
  });

  it("pins native writes to the supplied gateway instead of the ambient selection (#11764)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "other-gateway");
    const invocation = buildOpenClawNativeConfigSetInvocation(
      "alpha",
      "models",
      {},
      "nemoclaw-9090",
    );
    expect(invocation.args.slice(0, 6)).toEqual([
      "-g",
      "nemoclaw-9090",
      "sandbox",
      "exec",
      "--name",
      "alpha",
    ]);
  });

  it("preserves authoritative workspace and TLS selection for native MCP writes (#11764)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "other-gateway");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://other.invalid");
    vi.stubEnv("OPENSHELL_WORKSPACE", "other-workspace");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/other/tls");
    const invocation = buildOpenClawNativeConfigBatchInvocation(
      "alpha",
      [{ dotpath: "tools.alsoAllow", value: ["bundle-mcp"] }],
      {
        gatewayName: "nemoclaw-9090",
        workspace: "recorded-workspace",
        localTlsDir: "/recorded/tls",
      },
    );
    expect(invocation.args.slice(0, 2)).toEqual(["-g", "nemoclaw-9090"]);
    expect(invocation.replaceEnv).toBe(true);
    expect(invocation.env).toMatchObject({
      OPENSHELL_GATEWAY: "nemoclaw-9090",
      OPENSHELL_WORKSPACE: "recorded-workspace",
      OPENSHELL_LOCAL_TLS_DIR: "/recorded/tls",
    });
    expect(invocation.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(process.env.OPENSHELL_GATEWAY).toBe("other-gateway");
  });

  it("does not prepend the header when the Hermes target writes JSON", () => {
    const written = composeSandboxConfigBody(
      { _nemoclaw_upstream: { provider: "nvidia-prod", model: "x" } },
      { ...HERMES_TARGET, format: "json", configFile: "config.json" },
    );
    expect(written.startsWith("#")).toBe(false);
  });

  it("rejects header breakout attempts via malicious upstream values", () => {
    const malicious = {
      _nemoclaw_upstream: {
        provider: "nvidia-prod\ngateway:\n  base_url: http://attacker",
        model: "victim\r\nmodel:\n  api_key: leaked",
      },
      model: { default: "victim", provider: "custom", base_url: "https://inference.local" },
    };

    const written = composeSandboxConfigBody(malicious, HERMES_TARGET);

    expect(
      written
        .split(/\r?\n/)
        .every((line) => !line || line.startsWith("#") || !line.startsWith("gateway")),
    ).toBe(true);
    const parsed = YAML.parse(written) as Record<string, unknown>;
    // Header-injected keys must NOT appear in the parsed document.
    expect(parsed.gateway).toBeUndefined();
    // The model block is the one written by the body, not the malicious smuggle.
    const model = parsed.model as Record<string, unknown>;
    expect(model.api_key).toBeUndefined();
    expect(model.base_url).toBe("https://inference.local");
  });

  it("omits the header when no upstream annotation is present", () => {
    const config = { model: { provider: "custom", base_url: "x" } };
    const written = composeSandboxConfigBody(config, HERMES_TARGET);
    expect(written.startsWith("#")).toBe(false);
    expect(YAML.parse(written)).toEqual(config);
  });

  it("keeps private URLs denied until Hermes explicitly opts in (#8614)", () => {
    expect(hermesConfigAllowsPrivateUrls({})).toBe(false);
    expect(hermesConfigAllowsPrivateUrls({ security: { allow_private_urls: false } })).toBe(false);
    expect(hermesConfigAllowsPrivateUrls({ security: { allow_private_urls: true } })).toBe(true);
  });
});
