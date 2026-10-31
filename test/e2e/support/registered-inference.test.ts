// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveRegisteredInferenceProvider } from "../../../src/lib/inference/native-provider/registered.ts";
import { inspectInferenceProviderProfile } from "../../../src/lib/adapters/openshell/provider-profile.ts";
import type { OpenShellProviderAdapter } from "../../../src/lib/adapters/openshell/provider-adapter.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { expectOpenAiChatThroughSandbox } from "../live/inference-routing-helpers.ts";
import { getSandbox } from "../../../src/lib/state/registry.ts";
import {
  nativeLocalIdentity,
  type NativeLocalBinding,
} from "../../../src/lib/inference/native-local/contract.ts";
import { customNativeProvider } from "../../../src/lib/inference/native-provider/custom.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  INFERENCE_CURL_DIAGNOSTIC_SCRIPT,
  INFERENCE_CURL_HTTP_CODE_MARKER,
} from "../fixtures/curl-policy-denial.ts";
import {
  operatorInferenceSwitchFixture,
  OPERATOR_SWITCH_PROVIDER,
  OPERATOR_SWITCH_CREDENTIAL_ENV,
  registeredCompatibleChatCommand,
  registeredCompatibleResponseCommand,
  readRegisteredLocalRoute,
} from "../fixtures/registered-inference.ts";

vi.mock("../fixtures/e2e-test.ts", async () => ({ expect: (await import("vitest")).expect }));

vi.mock("../../../src/lib/state/registry.ts", () => ({ getSandbox: vi.fn() }));

const localBinding: NativeLocalBinding = {
  provider: "compatible-endpoint",
  agent: "openclaw",
  endpointUrl: "http://host.openshell.internal:8000/v1",
  credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  authMode: "authenticated",
  gatewayName: "test-gateway",
  sandboxName: "test-sandbox",
};
const local = {
  ...localBinding,
  ...nativeLocalIdentity(localBinding),
  schemaVersion: 1 as const,
  providerId: "provider-one",
};
const selection = {
  name: "test-sandbox",
  agent: "openclaw" as const,
  gatewayName: "test-gateway",
  provider: "compatible-endpoint",
  model: "test-model",
  nativeLocalProviderAttachment: local,
};
const payload = JSON.stringify({
  model: "test-model",
  messages: [{ role: "user", content: "PONG $(not-a-command)" }],
});
let directory: string;
beforeEach(() => {
  vi.mocked(getSandbox).mockReturnValue(selection);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "registered-inference-"));
  fs.writeFileSync(path.join(directory, "curl"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
    mode: 0o755,
  });
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
function run(command: [string, ...string[]], env: Record<string, string>) {
  const options = {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: directory,
      TMPDIR: directory,
      PATH: `${directory}:${process.env.PATH}`,
      ...env,
    },
  } as const;
  const executable = new Map([
    ["bash", "bash"],
    ["/bin/bash", "/bin/bash"],
    ["curl", "curl"],
  ]).get(command[0]);
  expect(executable).toBeDefined();
  return spawnSync(executable!, command.slice(1), options);
}

it("executes the local probe with its exact endpoint, payload and scoped credential", () => {
  const credential = "openshell:resolve:env:v17_NEMOCLAW_LOCAL_INFERENCE_TOKEN";
  const result = run(registeredCompatibleChatCommand("test-sandbox", "test-model", payload), {
    NEMOCLAW_LOCAL_INFERENCE_TOKEN: credential,
  });
  expect(result.status).toBe(0);
  expect(result.stdout.split("\n")).toEqual([
    "-fsS",
    "--max-time",
    "60",
    `${local.endpointUrl}/chat/completions`,
    "-H",
    "Content-Type: application/json",
    "-H",
    `Authorization: Bearer ${credential}`,
    "--data-raw",
    payload,
    "",
  ]);
});

it.each([
  "raw-secret",
  "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  "openshell:resolve:env:v17_NEMOCLAW_LOCAL_INFERENCE_TOKEN\nraw-secret",
])("rejects an unsafe local credential before invoking curl: %s", (credential) => {
  const result = run(registeredCompatibleChatCommand("test-sandbox", "test-model", payload), {
    NEMOCLAW_LOCAL_INFERENCE_TOKEN: credential,
  });
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
});

it.each([
  { model: "other" },
  { gatewayName: "other-gateway" },
  { agent: "hermes" },
  { nativeLocalProviderAttachment: { ...local, providerId: "" } },
  { nativeLocalProviderAttachment: undefined },
])("rejects a stale or missing selection before constructing a probe: %j", (change) => {
  vi.mocked(getSandbox).mockReturnValue({ ...selection, ...change } as typeof selection);
  expect(() => registeredCompatibleChatCommand("test-sandbox", "test-model", payload)).toThrow();
});

it("reads the replacement endpoint from the current registry after recreation", () => {
  const binding = { ...localBinding, endpointUrl: "http://host.openshell.internal:8001/v1" };
  vi.mocked(getSandbox).mockReturnValue({
    ...selection,
    nativeLocalProviderAttachment: {
      ...binding,
      ...nativeLocalIdentity(binding),
      schemaVersion: 1,
      providerId: "replacement",
    },
  });
  const result = run(registeredCompatibleChatCommand("test-sandbox", "test-model", payload), {
    NEMOCLAW_LOCAL_INFERENCE_TOKEN: "openshell:resolve:env:v18_NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`${binding.endpointUrl}/chat/completions`);
  expect(result.stdout).not.toContain(local.endpointUrl);
});

it.each([false, true])(
  "preserves hosted error responses and the explicit redirect choice: %s",
  (follow) => {
    const definition = customNativeProvider({
      provider: "compatible-endpoint",
      endpointUrl: "https://example.com/v1",
      api: "openai-completions",
      credentialEnv: "COMPATIBLE_API_KEY",
      allowedIps: ["8.8.8.8"],
    });
    vi.mocked(getSandbox).mockReturnValue({
      ...selection,
      nativeLocalProviderAttachment: undefined,
      nativeHostedProviderAttachment: { ...definition, schemaVersion: 1, providerId: "hosted-one" },
    });
    const credential = "openshell:resolve:env:v18_COMPATIBLE_API_KEY";
    const result = run(
      registeredCompatibleResponseCommand("test-sandbox", "test-model", payload, follow),
      { COMPATIBLE_API_KEY: credential },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.split("\n")).toEqual([
      "--verbose",
      "--write-out",
      "",
      `${INFERENCE_CURL_HTTP_CODE_MARKER}%{http_code}`,
      "",
      "-sS",
      "--include",
      ...(follow ? ["--location", "--post302", "--max-redirs", "3"] : []),
      "--max-time",
      "60",
      "https://example.com/v1/chat/completions",
      "-H",
      "Content-Type: application/json",
      "-H",
      `Authorization: Bearer ${credential}`,
      "--data-raw",
      payload,
      "",
    ]);
  },
);

it.each([0, 7, 56, 127])("retains curl status %s and only connect diagnostics", (status) => {
  fs.writeFileSync(
    path.join(directory, "curl"),
    `#!/bin/sh
printf '\nNEMOCLAW_INFERENCE_CURL_HTTP_CODE=000\n'
printf '%s\n' '> Authorization: Bearer scoped-handle' '> Cookie: private-cookie' '* Server auth using Basic with user secret-user' '* Immediate connect fail for 198.18.0.1: Permission denied' 'curl: (7) Failed to connect' >&2
exit ${status}
`,
    { mode: 0o755 },
  );
  const result = run(
    [
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      `${INFERENCE_CURL_DIAGNOSTIC_SCRIPT}; curl -sS https://example.com/v1/models`,
    ],
    {},
  );
  expect(result.status).toBe(status);
  expect(result.stdout).toBe("\nNEMOCLAW_INFERENCE_CURL_HTTP_CODE=000\n");
  expect(result.stderr).toBe(
    "* Immediate connect fail for 198.18.0.1: Permission denied\ncurl: (7) Failed to connect\n",
  );
  expect(fs.readdirSync(directory)).toEqual(["curl"]);
});

function readback(providerId = local.providerId, attached = local.providerName) {
  return vi
    .fn()
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: `Name: ${local.providerName}\nId: ${providerId}\nResource version: 1\nType: ${local.profileId}\nCredential keys: ${local.credentialEnv}\nConfig keys: <none>`,
      stderr: "",
    })
    .mockResolvedValueOnce({ exitCode: 0, stdout: attached, stderr: "" });
}
it("reads the sibling provider identity and attachment on its recorded gateway", async () => {
  const openshell = readback();
  const result = await readRegisteredLocalRoute(
    { openshell } as unknown as SandboxClient,
    "test-sandbox",
    "before",
  );
  expect(result).toEqual({
    exitCode: 0,
    stdout: JSON.stringify({
      provider: selection.provider,
      model: selection.model,
      receipt: local,
    }),
    stderr: "",
  });
  expect(openshell.mock.calls.map(([command]) => command)).toEqual([
    ["provider", "get", "-g", "test-gateway", local.providerName],
    ["sandbox", "provider", "list", "-g", "test-gateway", "test-sandbox"],
  ]);
});
it.each([
  ["other-provider", local.providerName],
  [local.providerId, "detached"],
])("rejects a replaced or detached sibling provider: %s %s", async (id, attached) => {
  const openshell = readback(id, attached);
  expect(
    await readRegisteredLocalRoute(
      { openshell } as unknown as SandboxClient,
      "test-sandbox",
      "after",
    ),
  ).toMatchObject({
    exitCode: 1,
    stderr: "Sibling native provider identity or attachment mismatch",
  });
});

const gatewayResponse = {
  ok: true,
  capability: "model.run",
  transport: "gateway",
  provider: "inference",
  model: "test-model",
  outputs: [{ text: "PONG" }],
};

it("runs the real OpenClaw gateway consumer with no endpoint or credential override", async () => {
  const exec = vi.fn(async () => ({
    exitCode: 0,
    stdout: JSON.stringify(gatewayResponse),
    stderr: "",
  }));
  await expectOpenAiChatThroughSandbox(
    { exec } as unknown as SandboxClient,
    "test-sandbox",
    "test-model",
    ["test-host-secret"],
    "gateway-consumer",
    "openclaw-gateway",
  );
  expect(exec).toHaveBeenCalledWith(
    "test-sandbox",
    [
      "openclaw",
      "infer",
      "model",
      "run",
      "--gateway",
      "--json",
      "--prompt",
      "Reply with exactly one word: PONG",
    ],
    expect.objectContaining({
      artifactName: "gateway-consumer",
      redactionValues: ["test-host-secret"],
      timeoutMs: 90000,
    }),
  );
  expect(vi.mocked(getSandbox)).not.toHaveBeenCalled();
});

it.each([
  { transport: "embedded" },
  { provider: "other" },
  { model: "other" },
  { ok: false },
  { capability: "other" },
  { outputs: [] },
  { outputs: [{ text: "wrong response" }] },
])("refuses a mismatched OpenClaw gateway response %j", async (override) => {
  const exec = vi.fn(async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ ...gatewayResponse, ...override }),
    stderr: "",
  }));
  await expect(
    expectOpenAiChatThroughSandbox(
      { exec } as unknown as SandboxClient,
      "test-sandbox",
      "test-model",
      [],
      "gateway-denial",
      "openclaw-gateway",
    ),
  ).rejects.toThrow();
});

it("propagates a failed OpenClaw gateway command even with success-shaped output", async () => {
  const exec = vi.fn(async () => ({
    exitCode: 42,
    stdout: JSON.stringify(gatewayResponse),
    stderr: "command failed",
  }));
  await expect(
    expectOpenAiChatThroughSandbox(
      { exec } as unknown as SandboxClient,
      "test-sandbox",
      "test-model",
      [],
      "gateway-command-failure",
      "openclaw-gateway",
    ),
  ).rejects.toThrow();
});

it("preserves the registered native curl caller used by DNS and runtime identity checks", async () => {
  const exec = vi.fn(async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ choices: [{ message: { content: "PONG" } }] }),
    stderr: "",
  }));
  await expectOpenAiChatThroughSandbox(
    { exec } as unknown as SandboxClient,
    "test-sandbox",
    "test-model",
    [],
    "native-curl",
  );
  expect(exec).toHaveBeenCalledWith(
    "test-sandbox",
    registeredCompatibleChatCommand(
      "test-sandbox",
      "test-model",
      JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
        max_tokens: 1024,
      }),
    ),
    expect.objectContaining({ artifactName: "native-curl" }),
  );
});

async function operatorFixture(
  endpointUrl = "https://operator.example.com/v1",
  addresses = ["8.8.8.8"],
) {
  let profile: any;
  let providerId: string | undefined;
  let created = 0;
  let attached = false;
  const command = vi.fn(async (_executable: string, args: string[], options: any) => {
    const result = (stdout = "", exitCode = 0) => ({ stdout, stderr: "", exitCode });
    const operation = args.find((arg) =>
      ["import", "export", "get", "create", "list", "detach", "delete"].includes(arg),
    );
    switch (operation) {
      case "import":
        profile = JSON.parse(fs.readFileSync(args[args.indexOf("--file") + 1]!, "utf8"));
        return result();
      case "export":
        return result(JSON.stringify(profile));
      case "get":
        return providerId
          ? result(
              [
                `Name: ${OPERATOR_SWITCH_PROVIDER}`,
                `Type: ${profile.id}`,
                `Id: ${providerId}`,
                "Resource version: 1",
                `Credential keys: ${OPERATOR_SWITCH_CREDENTIAL_ENV}`,
                "Config keys: <none>",
              ].join("\n"),
            )
          : result("provider not found", 1);
      case "create":
        expect(options.env[OPERATOR_SWITCH_CREDENTIAL_ENV]).toBe("synthetic-key");
        providerId = `fixture-${++created}`;
        return result();
      case "list":
        return result(attached ? OPERATOR_SWITCH_PROVIDER : "");
      case "detach":
        attached = false;
        return result();
      case "delete":
        providerId = undefined;
        return result();
      default:
        throw new Error("Unexpected fixture command");
    }
  });
  const fixture = await operatorInferenceSwitchFixture(
    { command, openshellCommandPath: "openshell" } as unknown as HostCliClient,
    {
      home: directory,
      env: { HOME: directory, OPENSHELL_GATEWAY: "nemoclaw" },
      endpointUrl,
      lookup: async () => addresses.map((address) => ({ address, family: 4 })),
      credentialValue: "synthetic-key",
      sandboxName: "test-sandbox",
      model: "test-model",
    },
  );
  return {
    fixture,
    command,
    attach: () => {
      attached = true;
    },
    changeProfile: () => {
      profile.endpoints[0].port = 18001;
    },
    replaceOutsideFixture: () => {
      providerId = "operator-owned-replacement";
    },
  };
}

it("creates an inference profile with exact endpoint and environment-only synthetic credentials", async () => {
  const { fixture, command } = await operatorFixture();
  const id = await fixture.create();
  expect(id).toBe("fixture-1");
  const imported = command.mock.calls.find((call) => call[1].includes("import"))!;
  const profile = JSON.parse(
    fs.readFileSync(imported[1][imported[1].indexOf("--file") + 1]!, "utf8"),
  );
  expect(profile).toMatchObject({
    inference_capable: true,
    endpoints: [
      {
        host: "operator.example.com",
        port: 443,
        allowed_ips: ["8.8.8.8"],
        protocol: "rest",
        enforcement: "enforce",
      },
    ],
    credentials: [{ env_vars: [OPERATOR_SWITCH_CREDENTIAL_ENV], auth_style: "bearer" }],
  });
  await expect(
    resolveRegisteredInferenceProvider({
      adapter: {
        getProvider: async () => ({
          ok: true,
          value: {
            name: OPERATOR_SWITCH_PROVIDER,
            type: profile.id,
            credentialKeys: [OPERATOR_SWITCH_CREDENTIAL_ENV],
            configKeys: [],
            revision: { id, resourceVersion: 1 },
          },
        }),
        inspectProviderProfile: async () => ({
          ok: true,
          value: {
            inference: inspectInferenceProviderProfile(JSON.stringify(profile)),
          },
        }),
      } as unknown as OpenShellProviderAdapter,
      gatewayName: "nemoclaw",
      sandboxName: "test-sandbox",
      providerName: OPERATOR_SWITCH_PROVIDER,
      endpointUrl: fixture.endpointUrl,
      inferenceApi: "openai-completions",
      credentialEnv: OPERATOR_SWITCH_CREDENTIAL_ENV,
    }),
  ).resolves.toMatchObject({ providerId: id, endpointUrl: "https://operator.example.com/v1" });
  expect(command.mock.calls.map((call) => call[1].join(" ")).join("\n")).not.toContain(
    "synthetic-key",
  );
  expect(imported[2].env[OPERATOR_SWITCH_CREDENTIAL_ENV]).toBeUndefined();
});

it("replaces only its attached immutable provider and cleans the new unattached identity", async () => {
  const { fixture, command, attach } = await operatorFixture();
  await fixture.create();
  attach();
  expect(await fixture.replace()).toBe("fixture-2");
  await fixture.cleanup();
  expect(command.mock.calls.filter((call) => call[1].includes("delete"))).toHaveLength(2);
  expect(command.mock.calls.find((call) => call[1].includes("detach"))![1]).toEqual([
    "sandbox",
    "provider",
    "detach",
    "test-sandbox",
    OPERATOR_SWITCH_PROVIDER,
    "-g",
    "nemoclaw",
  ]);
});

it("refuses replacement and cleanup when another operator owns the current provider identity", async () => {
  const { fixture, command, replaceOutsideFixture } = await operatorFixture();
  await fixture.create();
  replaceOutsideFixture();
  await expect(fixture.replace()).rejects.toThrow("unowned");
  await expect(fixture.cleanup()).rejects.toThrow("unowned");
  expect(
    command.mock.calls.filter((call) => call[1].includes("delete") || call[1].includes("detach")),
  ).toEqual([]);
});

it("cleans its provider attachment before deletion after an interrupted selection", async () => {
  const { fixture, command, attach } = await operatorFixture();
  await fixture.create();
  attach();
  await fixture.cleanup();
  expect(
    command.mock.calls.map((call) => call[1][2]).filter((operation) => operation === "detach"),
  ).toEqual(["detach"]);
  expect(command.mock.calls.filter((call) => call[1].includes("delete"))).toHaveLength(1);
});

it("binds the recorded selection to the original provider, exported profile and live attachment", async () => {
  const { fixture, attach } = await operatorFixture();
  const id = await fixture.create();
  attach();
  fs.mkdirSync(path.join(directory, ".nemoclaw"));
  fs.writeFileSync(
    path.join(directory, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({ sandboxes: { "test-sandbox": fixture.expected(id).selected } }),
  );
  expect(await fixture.evidence()).toMatchObject(fixture.expected(id));
});

it("does not recompute expected profile identity from a later changed export", async () => {
  const { fixture, attach, changeProfile } = await operatorFixture();
  const id = await fixture.create();
  attach();
  fs.mkdirSync(path.join(directory, ".nemoclaw"));
  fs.writeFileSync(
    path.join(directory, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({ sandboxes: { "test-sandbox": fixture.expected(id).selected } }),
  );
  changeProfile();
  expect(await fixture.evidence()).not.toMatchObject(fixture.expected(id));
});

it("rejects an HTTP operator fixture before writing its profile", async () => {
  const before = fs.readdirSync(directory);
  await expect(operatorFixture("http://operator.example.com/v1")).rejects.toThrow("HTTPS");
  expect(fs.readdirSync(directory)).toEqual(before);
});

it("rejects private operator endpoint resolution before writing its profile", async () => {
  const before = fs.readdirSync(directory);
  await expect(operatorFixture(undefined, ["10.1.2.3"])).rejects.toThrow("public endpoint IP pins");
  expect(fs.readdirSync(directory)).toEqual(before);
});
