// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenShellRuntimeSelection } from "../adapters/openshell/runtime-selection";
import { NVIDIA_INFERENCE_PLACEHOLDER } from "../inference-credential";
import { getSandboxInferenceConfig } from "../inference/config";
import { NVIDIA_HOSTED_NATIVE_ENDPOINT } from "../inference/native-nvidia/contract";
import { HOSTED_NATIVE_PROVIDERS } from "../inference/native-provider/hosted";
import YAML from "yaml";

const {
  buildOpenClawNativeConfigBatchInvocation,
  buildOpenClawNativeConfigSetInvocation,
  composeSandboxConfigBody,
  hermesConfigAllowsPrivateUrls,
  runOpenClawNativeConfigBatchUntilHandleReady,
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
  runOpenClawNativeConfigBatchUntilHandleReady: (
    nativeHandleUpdate: boolean,
    run: () => { status: number; stderr: string; error?: Error; signal?: string },
    wait?: (ms: number) => void,
    warn?: (message: string) => void,
  ) => void;
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

  it("gives a newly attached native NVIDIA handle to OpenClaw without exposing the raw key", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-config-"));
    try {
      const executable = path.join(directory, "openclaw");
      fs.writeFileSync(executable, '#!/bin/sh\ncat "$4"\n', { mode: 0o700 });
      const invocation = buildOpenClawNativeConfigBatchInvocation("alpha", [
        { dotpath: "agents.defaults.model.primary", value: "inference/nvidia/model-a" },
        {
          dotpath: "models.providers.inference",
          value: {
            baseUrl: NVIDIA_HOSTED_NATIVE_ENDPOINT,
            apiKey: NVIDIA_INFERENCE_PLACEHOLDER,
            api: "openai-completions",
            models: [{ id: "nvidia/model-a" }],
          },
        },
      ]);
      const command = invocation.args.slice(invocation.args.indexOf("--") + 1);
      const handle = "openshell:resolve:env:v42_NVIDIA_INFERENCE_API_KEY";
      const run = (value: string | undefined) =>
        spawnSync(command[0]!, command.slice(1), {
          input: invocation.input,
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
            ...(value === undefined
              ? { NVIDIA_INFERENCE_API_KEY: undefined }
              : { NVIDIA_INFERENCE_API_KEY: value }),
          },
        });

      const success = run(handle);
      expect(success.status, `${success.error?.message ?? ""} ${success.stderr}`).toBe(0);
      const batch = JSON.parse(success.stdout) as Array<{ path: string; value: unknown }>;
      expect(batch).toEqual([
        { path: "agents.defaults.model.primary", value: "inference/nvidia/model-a" },
        {
          path: "models.providers.inference",
          value: {
            baseUrl: NVIDIA_HOSTED_NATIVE_ENDPOINT,
            apiKey: handle,
            api: "openai-completions",
            models: [{ id: "nvidia/model-a" }],
          },
        },
      ]);
      expect(invocation.input).not.toContain(handle);
      expect(invocation.args.join(" ")).not.toContain(handle);
      expect(invocation.input).toContain(NVIDIA_INFERENCE_PLACEHOLDER);
      expect(invocation.input).toContain(NVIDIA_HOSTED_NATIVE_ENDPOINT);

      expect(() =>
        buildOpenClawNativeConfigBatchInvocation("alpha", [
          {
            dotpath: "models.providers.inference",
            value: {
              baseUrl: "https://other.example/v1",
              apiKey: NVIDIA_INFERENCE_PLACEHOLDER,
            },
          },
        ]),
      ).toThrow("Native provider endpoint does not match");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "compatible-endpoint",
      "inference",
      "COMPATIBLE_API_KEY",
      "http://10.1.1.225:8123/v1",
      "openai-completions",
    ],
    [
      "compatible-endpoint",
      "inference",
      "COMPATIBLE_API_KEY",
      "https://fixture.example/v1",
      "openai-responses",
    ],
    [
      "compatible-anthropic-endpoint",
      "inference",
      "COMPATIBLE_ANTHROPIC_API_KEY",
      "https://fixture.example/openai/v1",
      "openai-completions",
    ],
    [
      "compatible-anthropic-endpoint",
      "inference",
      "COMPATIBLE_ANTHROPIC_API_KEY",
      "https://fixture.example/openai/v1",
      "openai-responses",
    ],
    [
      "compatible-anthropic-endpoint",
      "anthropic",
      "COMPATIBLE_ANTHROPIC_API_KEY",
      "https://fixture.example",
      "anthropic-messages",
    ],
    ["openai-api", "openai", "OPENAI_API_KEY", "https://api.openai.com/v1", "openai-completions"],
    [
      "anthropic-prod",
      "anthropic",
      "ANTHROPIC_API_KEY",
      "https://api.anthropic.com",
      "anthropic-messages",
    ],
    [
      "hermes-provider",
      "inference",
      "OPENAI_API_KEY",
      "https://hermes.example/v1",
      "openai-completions",
    ],
  ])(
    "materializes %s native credentials at %s from %s before the atomic config write",
    (logicalProvider, provider, key, baseUrl, api) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-config-"));
      try {
        fs.writeFileSync(path.join(directory, "openclaw"), '#!/bin/sh\ncat "$4"\n', {
          mode: 0o700,
        });
        const canonical = `openshell:resolve:env:${key}`;
        const headers = { "X-NemoClaw-Upstream-Provider": logicalProvider };
        const handle = `openshell:resolve:env:s${"a".repeat(64)}_${key}`;
        const updates = [
          { dotpath: "agents.defaults.model.primary", value: `${provider}/model-a` },
          {
            dotpath: `models.providers.${provider}`,
            value: { baseUrl, api, headers, apiKey: canonical, models: [{ id: "model-a" }] },
          },
          { dotpath: "channels.telegram.botToken", value: canonical },
        ];
        const invocation = buildOpenClawNativeConfigBatchInvocation("alpha", updates);
        const command = invocation.args.slice(invocation.args.indexOf("--") + 1);
        const result = spawnSync(command[0]!, command.slice(1), {
          input: invocation.input,
          encoding: "utf8",
          timeout: 5_000,
          env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}`, [key]: handle },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual([
          { path: updates[0]!.dotpath, value: updates[0]!.value },
          {
            path: updates[1]!.dotpath,
            value: { baseUrl, api, headers, apiKey: handle, models: [{ id: "model-a" }] },
          },
          { path: updates[2]!.dotpath, value: canonical },
        ]);
        expect(invocation.input).not.toContain(handle);
        expect(invocation.args.join(" ")).not.toContain(handle);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(
    [
      { value: undefined, expectedStatus: 75 },
      { value: "nvapi-do-not-write", expectedStatus: 1 },
      { value: "openshell:resolve:env:NVIDIA_INFERENCE_API_KEY", expectedStatus: 1 },
      { value: "openshell:resolve:env:v43_OTHER_API_KEY", expectedStatus: 1 },
    ].flatMap((scenario) =>
      ["NVIDIA_INFERENCE_API_KEY", "COMPATIBLE_API_KEY"].map((key) => ({ ...scenario, key })),
    ),
  )(
    "refuses invalid native $key handle $value before config mutation",
    ({ value, expectedStatus, key }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-config-"));
      try {
        fs.writeFileSync(path.join(directory, "openclaw"), '#!/bin/sh\ncat "$4"\n', {
          mode: 0o700,
        });
        const invocation = buildOpenClawNativeConfigBatchInvocation("alpha", [
          {
            dotpath: "models.providers.inference",
            value: {
              baseUrl: NVIDIA_HOSTED_NATIVE_ENDPOINT,
              apiKey:
                key === "NVIDIA_INFERENCE_API_KEY"
                  ? NVIDIA_INFERENCE_PLACEHOLDER
                  : `openshell:resolve:env:${key}`,
              api: "openai-completions",
              headers: {
                "X-NemoClaw-Upstream-Provider":
                  key === "NVIDIA_INFERENCE_API_KEY" ? "nvidia-prod" : "compatible-endpoint",
              },
            },
          },
        ]);
        const command = invocation.args.slice(invocation.args.indexOf("--") + 1);
        const failed = spawnSync(command[0]!, command.slice(1), {
          input: invocation.input,
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
            [key]: value,
          },
        });
        expect(failed.status).toBe(expectedStatus);
        expect(failed.stdout).toBe("");
        expect(failed.stderr).not.toContain("nvapi-do-not-write");
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(HOSTED_NATIVE_PROVIDERS)(
    "pins the scoped $label handle before OpenClaw applies the native config batch (#13040)",
    (provider) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-config-"));
      try {
        fs.writeFileSync(path.join(directory, "openclaw"), '#!/bin/sh\ncat "$4"\n', {
          mode: 0o700,
        });
        const placeholder = `openshell:resolve:env:${provider.credentialEnv}`;
        const handle = `openshell:resolve:env:v42_${provider.credentialEnv}`;
        const route = getSandboxInferenceConfig("model-a", provider.logicalProvider);
        const providerPath = `models.providers.${route.providerKey}`;
        const primary = route.primaryModelRef;
        const invocation = buildOpenClawNativeConfigBatchInvocation("alpha", [
          { dotpath: "agents.defaults.model.primary", value: primary },
          {
            dotpath: providerPath,
            value: {
              baseUrl: provider.endpoint,
              apiKey: placeholder,
              headers: { "X-NemoClaw-Upstream-Provider": provider.logicalProvider },
            },
          },
        ]);
        const command = invocation.args.slice(invocation.args.indexOf("--") + 1);
        const result = spawnSync(command[0]!, command.slice(1), {
          input: invocation.input,
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
            [provider.credentialEnv]: handle,
          },
        });
        expect(result.status, `${result.error?.message ?? ""} ${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual([
          { path: "agents.defaults.model.primary", value: primary },
          {
            path: providerPath,
            value: {
              baseUrl: provider.endpoint,
              apiKey: handle,
              headers: { "X-NemoClaw-Upstream-Provider": provider.logicalProvider },
            },
          },
        ]);
        expect(invocation.input).not.toContain(handle);
        expect(invocation.args.join(" ")).not.toContain(handle);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { value: undefined, expectedStatus: 75 },
    { value: "raw-provider-secret", expectedStatus: 1 },
    { value: "openshell:resolve:env:OPENROUTER_API_KEY", expectedStatus: 1 },
    { value: "openshell:resolve:env:v42_OPENAI_API_KEY", expectedStatus: 1 },
  ])(
    "refuses an unavailable or invalid OpenRouter handle $value before config mutation (#13040)",
    ({ value, expectedStatus }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-config-"));
      try {
        fs.writeFileSync(path.join(directory, "openclaw"), '#!/bin/sh\ncat "$4"\n', {
          mode: 0o700,
        });
        const invocation = buildOpenClawNativeConfigBatchInvocation("alpha", [
          {
            dotpath: "models.providers.inference",
            value: {
              baseUrl: "https://openrouter.ai/api/v1",
              apiKey: "openshell:resolve:env:OPENROUTER_API_KEY",
              headers: { "X-NemoClaw-Upstream-Provider": "openrouter-api" },
            },
          },
        ]);
        const command = invocation.args.slice(invocation.args.indexOf("--") + 1);
        const failed = spawnSync(command[0]!, command.slice(1), {
          input: invocation.input,
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
            OPENROUTER_API_KEY: value,
          },
        });
        expect(failed.status).toBe(expectedStatus);
        expect(failed.stdout).toBe("");
        expect(failed.stderr).not.toContain("raw-provider-secret");
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects a hosted handle with the wrong provider or endpoint before config mutation (#13040)", () => {
    const update = {
      dotpath: "models.providers.inference",
      value: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "openshell:resolve:env:OPENROUTER_API_KEY",
        headers: { "X-NemoClaw-Upstream-Provider": "openrouter-api" },
      },
    };
    expect(() =>
      buildOpenClawNativeConfigBatchInvocation("alpha", [
        { ...update, value: { ...update.value, baseUrl: "https://other.example/v1" } },
      ]),
    ).toThrow("Native OpenRouter configuration does not match its attached provider endpoint");
    expect(() =>
      buildOpenClawNativeConfigBatchInvocation("alpha", [
        {
          ...update,
          value: {
            ...update.value,
            headers: { "X-NemoClaw-Upstream-Provider": "openai-api" },
          },
        },
      ]),
    ).toThrow("Native OpenAI configuration does not match its attached provider endpoint");
    expect(() =>
      buildOpenClawNativeConfigBatchInvocation("alpha", [
        {
          dotpath: "models.providers.inference",
          value: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "openshell:resolve:env:OPENAI_API_KEY",
            headers: { "X-NemoClaw-Upstream-Provider": "openai-api" },
          },
        },
      ]),
    ).toThrow("Native provider config path does not match its identity");
  });

  it.each([
    {
      label: "credential from another provider",
      patch: { apiKey: "openshell:resolve:env:ANTHROPIC_API_KEY" },
    },
    {
      label: "endpoint with embedded credentials",
      patch: { baseUrl: "https://user:secret@fixture.example/v1" },
    },
    { label: "endpoint with a query", patch: { baseUrl: "https://fixture.example/v1?key=secret" } },
  ])("rejects custom native $label before config mutation (#13195)", ({ patch }) => {
    expect(() =>
      buildOpenClawNativeConfigBatchInvocation("alpha", [
        {
          dotpath: "models.providers.inference",
          value: {
            baseUrl: "https://fixture.example/v1",
            api: "openai-completions",
            apiKey: "openshell:resolve:env:COMPATIBLE_API_KEY",
            headers: { "X-NemoClaw-Upstream-Provider": "compatible-endpoint" },
            ...patch,
          },
        },
      ]),
    ).toThrow();
  });

  it("rejects a custom native path mismatch or ambiguous batch before config mutation (#13195)", () => {
    const update = {
      dotpath: "models.providers.anthropic",
      value: {
        baseUrl: "https://fixture.example",
        api: "anthropic-messages",
        apiKey: "openshell:resolve:env:COMPATIBLE_ANTHROPIC_API_KEY",
        headers: { "X-NemoClaw-Upstream-Provider": "compatible-anthropic-endpoint" },
      },
    };
    expect(() =>
      buildOpenClawNativeConfigBatchInvocation("alpha", [
        { ...update, dotpath: "models.providers.inference" },
      ]),
    ).toThrow("Native provider config path does not match its identity");
    expect(() => buildOpenClawNativeConfigBatchInvocation("alpha", [update, update])).toThrow(
      "Expected one native provider config update",
    );
  });

  it("keeps shared-route compatible endpoint placeholders outside native handle pinning (#13040, #13195)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compatible-config-"));
    try {
      fs.writeFileSync(path.join(directory, "openclaw"), '#!/bin/sh\ncat "$4"\n', {
        mode: 0o700,
      });
      const updates = [
        {
          dotpath: "models.providers.inference",
          value: {
            baseUrl: "https://inference.local/v1",
            apiKey: "openshell:resolve:env:COMPATIBLE_API_KEY",
            headers: { "X-NemoClaw-Upstream-Provider": "compatible-endpoint" },
          },
        },
      ];
      const invocation = buildOpenClawNativeConfigBatchInvocation("alpha", updates);
      const command = invocation.args.slice(invocation.args.indexOf("--") + 1);
      const result = spawnSync(command[0]!, command.slice(1), {
        input: invocation.input,
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
      });
      expect(result.status, `${result.error?.message ?? ""} ${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        { path: updates[0]!.dotpath, value: updates[0]!.value },
      ]);
      expect(invocation.args.join(" ")).not.toContain("COMPATIBLE_API_KEY");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "custom endpoint",
      baseUrl: "https://user.example/v1",
      apiKey: "openshell:resolve:env:USER_API_KEY",
    },
    {
      label: "hosted endpoint without a provider marker",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "openshell:resolve:env:OPENROUTER_API_KEY",
    },
  ])(
    "keeps an unmarked $label placeholder unchanged in the OpenClaw batch (#13040)",
    ({ baseUrl, apiKey }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-unmarked-config-"));
      try {
        fs.writeFileSync(path.join(directory, "openclaw"), '#!/bin/sh\ncat "$4"\n', {
          mode: 0o700,
        });
        const update = {
          dotpath: "models.providers.inference",
          value: {
            baseUrl,
            apiKey,
          },
        };
        const invocation = buildOpenClawNativeConfigBatchInvocation("alpha", [update]);
        const command = invocation.args.slice(invocation.args.indexOf("--") + 1);
        const result = spawnSync(command[0]!, command.slice(1), {
          input: invocation.input,
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
            USER_API_KEY: undefined,
            OPENROUTER_API_KEY: undefined,
          },
        });
        expect(result.status, `${result.error?.message ?? ""} ${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual([{ path: update.dotpath, value: update.value }]);
        expect(invocation.args.join(" ")).not.toContain(apiKey);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects a mismatched NVIDIA provider marker before handle pinning (#13040)", () => {
    expect(() =>
      buildOpenClawNativeConfigBatchInvocation("alpha", [
        {
          dotpath: "models.providers.openai",
          value: {
            baseUrl: NVIDIA_HOSTED_NATIVE_ENDPOINT,
            apiKey: NVIDIA_INFERENCE_PLACEHOLDER,
            headers: { "X-NemoClaw-Upstream-Provider": "openai-api" },
          },
        },
      ]),
    ).toThrow("Native NVIDIA provider identity does not match its credential placeholder");
  });

  it("pins a scoped handle for an authenticated Hermes endpoint (#13040)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-config-"));
    try {
      fs.writeFileSync(path.join(directory, "openclaw"), '#!/bin/sh\ncat "$4"\n', {
        mode: 0o700,
      });
      const endpoint = "https://hermes.example/v1/";
      const handle = "openshell:resolve:env:s" + "a".repeat(64) + "_OPENAI_API_KEY";
      const invocation = buildOpenClawNativeConfigBatchInvocation("alpha", [
        {
          dotpath: "models.providers.inference",
          value: {
            baseUrl: endpoint,
            apiKey: "openshell:resolve:env:OPENAI_API_KEY",
            headers: { "X-NemoClaw-Upstream-Provider": "hermes-provider" },
          },
        },
      ]);
      const command = invocation.args.slice(invocation.args.indexOf("--") + 1);
      const result = spawnSync(command[0]!, command.slice(1), {
        input: invocation.input,
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          OPENAI_API_KEY: handle,
        },
      });
      expect(result.status, `${result.error?.message ?? ""} ${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)[0].value).toMatchObject({
        baseUrl: endpoint,
        apiKey: handle,
      });
      expect(invocation.input).not.toContain(handle);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retries only a missing newly attached handle before OpenClaw mutates config", () => {
    const pending = { status: 75, stderr: "NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING\n" };
    const succeeded = { status: 0, stderr: "" };
    const run = vi.fn().mockReturnValueOnce(pending).mockReturnValueOnce(succeeded);
    const wait = vi.fn();
    const warn = vi.fn();

    runOpenClawNativeConfigBatchUntilHandleReady(true, run, wait, warn);
    expect(run).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledExactlyOnceWith(2_000);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Native provider handle pending; config attempt 1/10",
    );

    const exhaustedRun = vi.fn().mockReturnValue(pending);
    const exhaustedWait = vi.fn();
    expect(() =>
      runOpenClawNativeConfigBatchUntilHandleReady(true, exhaustedRun, exhaustedWait, vi.fn()),
    ).toThrow("Native OpenClaw config command failed after 10 attempt(s)");
    expect(exhaustedRun).toHaveBeenCalledTimes(10);
    expect(exhaustedWait).toHaveBeenCalledTimes(9);
  });

  it.each([
    { status: 75, stderr: "unrelated failure" },
    { status: 1, stderr: "NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING" },
    { status: 1, stderr: "Native provider handle is unavailable or invalid" },
  ])("does not retry other native config failures: $status $stderr", (result) => {
    const failedRun = vi.fn().mockReturnValue(result);
    const wait = vi.fn();
    expect(() =>
      runOpenClawNativeConfigBatchUntilHandleReady(true, failedRun, wait, vi.fn()),
    ).toThrow("Native OpenClaw config command failed after 1 attempt(s)");
    expect(failedRun).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
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
