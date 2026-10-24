// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderMetadata,
} from "../../adapters/openshell/provider-adapter";
import { exportedProviderProfileMatchesContract } from "../../adapters/openshell/provider-profile";
import {
  createBlueprintNativeInference,
  findBlueprintNativeReceipt,
  reconcileBlueprintNativeTimeout,
  observeBlueprintCreatedInference,
  type BlueprintNativeReceipt,
} from "./blueprint";

function fixture(
  overrides: {
    credential?: string;
    providerName?: string;
    expiry?: number;
    collision?: boolean;
    wrongSandbox?: boolean;
    configFailure?: boolean;
  } = {},
) {
  const providerName = overrides.providerName ?? "chosen-provider";
  let source = "";
  let provider: OpenShellProviderMetadata | null = null;
  let nonce = "";
  let attached = false;
  let sandboxId = "sandbox-id-1";
  const events: string[] = [];
  const receipts: BlueprintNativeReceipt[] = [];
  const adapter = {
    importProviderProfile: vi.fn<OpenShellProviderAdapter["importProviderProfile"]>(
      ({ profilePath }) => {
        source = fs.readFileSync(profilePath, "utf8");
        return { ok: true };
      },
    ),
    getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>(async () => {
      return overrides.collision
        ? {
            ok: true,
            value: {
              name: providerName,
              type: "operator-profile",
              credentialKeys: [],
              configKeys: [],
              revision: { id: "operator-id", resourceVersion: 1 },
            },
          }
        : provider
          ? { ok: true, value: provider }
          : { ok: false, error: { kind: "command", reason: "not_found", message: "not found" } };
    }),
    createProvider: vi.fn<OpenShellProviderAdapter["createProvider"]>(async (request) => {
      events.push("create-provider");
      provider = {
        name: request.name,
        type: request.type,
        configKeys: [],
        credentialKeys: request.credentials.map((credential) => credential.name),
        revision: { id: "provider-id-1", resourceVersion: 1 },
        credentialExpiresAtMs: { OPENAI_API_KEY: overrides.expiry ?? 0 },
      };
      return { ok: true };
    }),
    inspectProviderProfile: vi.fn<OpenShellProviderAdapter["inspectProviderProfile"]>(
      async ({ expectedProfile }) =>
        expectedProfile &&
        exportedProviderProfileMatchesContract(JSON.stringify(YAML.parse(source)), expectedProfile)
          ? { ok: true, value: { credentialKeys: [] } }
          : {
              ok: false,
              error: {
                kind: "command",
                reason: "profile_incompatible",
                message: "profile mismatch",
              },
            },
    ),
    listProviderAttachments: vi.fn(async () => ({
      ok: true,
      value: { names: attached ? [providerName] : [] },
    })),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    detachProvider: vi.fn(),
    attachProvider: vi.fn(async () => {
      attached = true;
      events.push("attach-provider");
      return { ok: true };
    }),
  } as unknown as OpenShellProviderAdapter;
  const writeConfig = vi.fn<
    NonNullable<Parameters<typeof createBlueprintNativeInference>[1]>["writeConfig"]
  >(
    overrides.configFailure
      ? () => {
          events.push("write-config");
          throw new Error("configuration failed");
        }
      : () => {
          events.push("write-config");
        },
  );
  const deps = {
    adapter: vi.fn(() => adapter),
    capture: vi.fn(() =>
      JSON.stringify({
        sandboxes: [
          {
            id: sandboxId,
            name: "chosen-sandbox",
            labels: {
              "ai.nvidia.nemoclaw.create-attempt": overrides.wrongSandbox ? "b".repeat(62) : nonce,
            },
            resource_version: 1,
            created_at: "2026-01-01T00:00:00Z",
            phase: "Ready",
            current_policy_version: 1,
          },
        ],
        next_page_token: "",
      }),
    ),
    writeConfig,
    readHandle: vi.fn(async () => "openshell:resolve:env:v1_OPENAI_API_KEY"),
  };
  const input = {
    gatewayName: "chosen-gateway",
    sandboxName: "chosen-sandbox",
    provider: providerName,
    model: "custom-model",
    api: "openai-completions",
    endpointUrl: "http://8.8.8.8:8000/v1",
    prepareSandboxPolicy: vi.fn(async () => {
      events.push("verify-policy");
    }),
    credentialValue: overrides.credential ?? "test-host-secret",
    timeoutSeconds: 180,
    persist: vi.fn((receipt: BlueprintNativeReceipt) => {
      receipts.push(receipt);
      events.push(
        receipt.sandboxId
          ? "record-sandbox"
          : receipt.providerAttachment
            ? "record-provider"
            : "record-intent",
      );
    }),
    createSandbox: vi.fn(async (_providerName: string, createAttemptNonce: string) => {
      nonce = createAttemptNonce;
      events.push("create-sandbox");
    }),
  };
  return {
    input,
    deps,
    adapter,
    receipts,
    events,
    source: () => source,
    replaceSandbox: () => {
      sandboxId = "replacement-id";
    },
  };
}

describe("blueprint native creation", () => {
  it.each(["Provider_1.prod", `a${"b".repeat(127)}`])(
    "creates and verifies the supported provider name %s",
    async (providerName) => {
      const f = fixture({ providerName });
      const created = await createBlueprintNativeInference(f.input, f.deps);
      expect(f.adapter.createProvider).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ name: providerName, fromExisting: false }),
      );
      expect(f.receipts.at(-1)).toMatchObject({
        provider: providerName,
        configPublished: true,
        providerAttachment: { providerName, providerId: "provider-id-1" },
      });
      await expect(created.observe()).resolves.toBe(created.identity);
    },
  );

  it.each(["1provider", "--help", "$(id)", "provider\n::error::forged", `a${"b".repeat(128)}`])(
    "rejects malformed provider name %j before host operations",
    async (providerName) => {
      const f = fixture({ providerName });
      const createDirectory = vi.spyOn(fs, "mkdtempSync");
      await expect(createBlueprintNativeInference(f.input, f.deps)).rejects.toThrow(
        "Invalid blueprint native inference selection.",
      );
      expect(createDirectory).not.toHaveBeenCalled();
      expect(f.deps.adapter).not.toHaveBeenCalled();
      expect(f.deps.capture).not.toHaveBeenCalled();
      expect(f.deps.readHandle).not.toHaveBeenCalled();
      expect(f.deps.writeConfig).not.toHaveBeenCalled();
      expect(f.input.persist).not.toHaveBeenCalled();
      expect(f.input.createSandbox).not.toHaveBeenCalled();
      expect(f.input.prepareSandboxPolicy).not.toHaveBeenCalled();
    },
  );

  it("records immutable ownership before later effects and preserves the requested provider, model and timeout", async () => {
    const f = fixture();
    const created = await createBlueprintNativeInference(f.input, f.deps);
    expect(f.events).toEqual([
      "record-intent",
      "create-sandbox",
      "record-sandbox",
      "verify-policy",
      "create-provider",
      "record-sandbox",
      "attach-provider",
      "write-config",
      "record-sandbox",
    ]);
    expect(f.input.createSandbox).toHaveBeenCalledWith(
      "chosen-provider",
      expect.stringMatching(/^[a-f0-9]{62}$/u),
    );
    expect(f.adapter.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "chosen-provider",
        credentials: [{ name: "OPENAI_API_KEY", value: "test-host-secret" }],
        fromExisting: false,
      }),
    );
    expect(f.deps.writeConfig).toHaveBeenCalledWith(
      "chosen-sandbox",
      [
        {
          dotpath: "models.providers.inference",
          value: {
            baseUrl: "http://8.8.8.8:8000/v1",
            api: "openai-completions",
            apiKey: "openshell:resolve:env:v1_OPENAI_API_KEY",
            timeoutSeconds: 180,
            models: [{ id: "custom-model", name: "custom-model" }],
          },
        },
        { dotpath: "agents.defaults.model.primary", value: "inference/custom-model" },
      ],
      "chosen-gateway",
    );
    expect(
      JSON.stringify(f.receipts) + f.source() + JSON.stringify(f.deps.capture.mock.calls),
    ).not.toContain("test-host-secret");
    expect(f.receipts.at(-1)).toMatchObject({
      sandboxId: "sandbox-id-1",
      configPublished: true,
      providerAttachment: { providerId: "provider-id-1", providerName: "chosen-provider" },
    });
    await expect(created.observe()).resolves.toBe(created.identity);
  });

  it("creates a credential-free profile without reading or inheriting another credential", async () => {
    const f = fixture({ credential: "" });
    await createBlueprintNativeInference(f.input, f.deps);
    expect(YAML.parse(f.source()).credentials).toEqual([]);
    expect(f.adapter.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: [], fromExisting: false }),
    );
    expect(f.deps.readHandle).not.toHaveBeenCalled();
    expect(f.deps.writeConfig.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: expect.objectContaining({ apiKey: "unused", authHeader: false }),
        }),
      ]),
    );
  });

  it("retains the Anthropic credential boundary and paths", async () => {
    const f = fixture();
    await createBlueprintNativeInference(
      { ...f.input, api: "anthropic-messages", endpointUrl: "https://8.8.8.8/v1" },
      f.deps,
    );
    expect(YAML.parse(f.source())).toMatchObject({
      credentials: [
        { env_vars: ["OPENAI_API_KEY"], auth_style: "header", header_name: "x-api-key" },
      ],
      endpoints: [
        {
          host: "8.8.8.8",
          port: 443,
          allowed_ips: ["8.8.8.8"],
          rules: [
            { allow: { method: "GET", path: "/v1/models" } },
            { allow: { method: "POST", path: "/v1/messages" } },
            { allow: { method: "POST", path: "/v1/messages/count_tokens" } },
          ],
        },
      ],
    });
  });

  it.each([
    "http://127.0.0.1:8000/v1",
    "http://10.1.2.3/v1",
    "https://example.com/v1",
    "https://user:secret@8.8.8.8/v1",
    "http://8.8.8.8/v1?key=secret",
    "http://8.8.8.8/%2e%2e/v1",
  ])(
    "refuses an endpoint outside the existing admission boundary before mutation: %s",
    async (endpointUrl) => {
      const f = fixture();
      await expect(
        createBlueprintNativeInference({ ...f.input, endpointUrl }, f.deps),
      ).rejects.toThrow();
      expect(f.adapter.importProviderProfile).not.toHaveBeenCalled();
      expect(f.input.createSandbox).not.toHaveBeenCalled();
      expect(f.deps.writeConfig).not.toHaveBeenCalled();
    },
  );

  it.each([{ collision: true }, { wrongSandbox: true }, { expiry: 1 }])(
    "rejects conflicting or unusable authority before configuring the agent: %j",
    async (options) => {
      const f = fixture(options);
      await expect(createBlueprintNativeInference(f.input, f.deps)).rejects.toThrow();
      expect(f.deps.writeConfig).not.toHaveBeenCalled();
      expect(f.adapter.updateProvider).not.toHaveBeenCalled();
      expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
      expect(f.adapter.detachProvider).not.toHaveBeenCalled();
    },
  );

  it.each(["", "test-host-secret"])(
    "does not adopt an unrecorded same-profile provider: %j",
    async (credential) => {
      const f = fixture({ credential });
      vi.mocked(f.adapter.getProvider).mockImplementation(async () => ({
        ok: true,
        value: {
          name: "chosen-provider",
          type: YAML.parse(f.source()).id,
          configKeys: [],
          credentialKeys: credential ? ["OPENAI_API_KEY"] : [],
          revision: { id: "operator-id", resourceVersion: 1 },
        },
      }));
      await expect(createBlueprintNativeInference(f.input, f.deps)).rejects.toThrow(
        "without a matching",
      );
      expect(f.adapter.createProvider).not.toHaveBeenCalled();
      expect(f.adapter.updateProvider).not.toHaveBeenCalled();
      expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    },
  );

  it("refuses credential-required reuse of an anonymous native provider", async () => {
    const f = fixture({ credential: "" });
    await createBlueprintNativeInference(f.input, f.deps);
    await expect(
      observeBlueprintCreatedInference(
        { ...f.input, requiresCredential: true },
        f.receipts.at(-1)!,
        f.deps,
      ),
    ).rejects.toThrow("does not match");
    expect(f.adapter.updateProvider).not.toHaveBeenCalled();
  });

  it("rejects unexpected credentials on a recorded anonymous provider", async () => {
    const f = fixture({ credential: "" });
    const created = await createBlueprintNativeInference(f.input, f.deps);
    vi.mocked(f.adapter.getProvider).mockResolvedValue({
      ok: true,
      value: {
        name: "chosen-provider",
        type: YAML.parse(f.source()).id,
        configKeys: [],
        credentialKeys: ["OPENAI_API_KEY"],
        revision: { id: "provider-id-1", resourceVersion: 1 },
      },
    });
    await expect(created.observe()).rejects.toThrow("does not match");
    expect(f.adapter.updateProvider).not.toHaveBeenCalled();
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
  });

  it("does not expose inference credentials after policy refusal", async () => {
    const f = fixture();
    f.input.prepareSandboxPolicy.mockRejectedValueOnce(new Error("policy refused"));
    await expect(createBlueprintNativeInference(f.input, f.deps)).rejects.toThrow("policy refused");
    expect(f.receipts.at(-1)?.sandboxId).toBe("sandbox-id-1");
    expect(f.adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(f.adapter.createProvider).not.toHaveBeenCalled();
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    expect(f.deps.readHandle).not.toHaveBeenCalled();
    expect(f.deps.writeConfig).not.toHaveBeenCalled();
  });

  it("stops before provider creation when the sandbox changes during policy verification", async () => {
    const f = fixture();
    f.input.prepareSandboxPolicy.mockImplementationOnce(async () => {
      f.replaceSandbox();
    });
    await expect(createBlueprintNativeInference(f.input, f.deps)).rejects.toThrow(
      "identity changed",
    );
    expect(f.adapter.createProvider).not.toHaveBeenCalled();
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    expect(f.deps.writeConfig).not.toHaveBeenCalled();
  });

  it("stops before attachment when the sandbox changes after provider creation", async () => {
    const f = fixture();
    f.input.persist
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        f.replaceSandbox();
      });
    await expect(createBlueprintNativeInference(f.input, f.deps)).rejects.toThrow(
      "identity changed",
    );
    expect(f.adapter.createProvider).toHaveBeenCalledTimes(1);
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    expect(f.deps.writeConfig).not.toHaveBeenCalled();
  });

  it("retains resources and refuses retry after configuration fails without a timeout", async () => {
    const f = fixture({ configFailure: true });
    const input = { ...f.input, timeoutSeconds: undefined };
    await expect(createBlueprintNativeInference(input, f.deps)).rejects.toThrow(
      "configuration failed",
    );
    const receipt = f.receipts.at(-1)!;
    expect(receipt.sandboxId).toBe("sandbox-id-1");
    expect(receipt.configPublished).toBeUndefined();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-recovery-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const run = path.join(home, ".nemoclaw/state/runs/nc-failed");
    try {
      fs.mkdirSync(run, { recursive: true });
      fs.writeFileSync(path.join(run, "plan.json"), JSON.stringify({ native_inference: receipt }));
      expect(() => findBlueprintNativeReceipt(input)).toThrow("incomplete");
      await expect(observeBlueprintCreatedInference(input, receipt, f.deps)).rejects.toThrow(
        "publication is incomplete",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
    expect(f.deps.writeConfig).toHaveBeenCalledTimes(1);
  });

  it("refuses later reuse after replacement or a changed requested model", async () => {
    const f = fixture();
    const created = await createBlueprintNativeInference(f.input, f.deps);
    await expect(
      observeBlueprintCreatedInference(
        { ...f.input, model: "other-model" },
        f.receipts.at(-1)!,
        f.deps,
      ),
    ).rejects.toThrow("does not match");
    f.replaceSandbox();
    await expect(created.observe()).rejects.toThrow("identity changed");
    expect(f.deps.writeConfig).toHaveBeenCalledTimes(1);
  });
});

async function recoveryFixture() {
  const f = fixture();
  await createBlueprintNativeInference(f.input, f.deps);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-recovery-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const directory = path.join(home, ".nemoclaw/state/runs/nc-current");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "plan.json");
  const plan = JSON.stringify({ native_inference: f.receipts.at(-1) });
  fs.writeFileSync(file, plan);
  return { ...f, home, directory, file, plan };
}

describe("blueprint run receipt recovery", () => {
  it("reads a completed receipt at the byte limit and closes its descriptor", async () => {
    const f = await recoveryFixture();
    try {
      fs.writeFileSync(f.file, f.plan.padEnd(1024 * 1024, " "));
      const open = vi.spyOn(fs, "openSync");
      expect(findBlueprintNativeReceipt(f.input)).toEqual(f.receipts.at(-1));
      expect(() => fs.fstatSync(open.mock.results[0]!.value)).toThrow();
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  it("skips an oversized receipt without reading its content", async () => {
    const f = await recoveryFixture();
    try {
      fs.writeFileSync(f.file, f.plan.padEnd(1024 * 1024 + 1, " "));
      const read = vi.spyOn(fs, "readSync");
      const open = vi.spyOn(fs, "openSync");
      expect(findBlueprintNativeReceipt(f.input)).toBeNull();
      expect(read).not.toHaveBeenCalled();
      expect(() => fs.fstatSync(open.mock.results[0]!.value)).toThrow();
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  it("skips a symbolic-link receipt without reading its target", async () => {
    const f = await recoveryFixture();
    try {
      const outside = path.join(f.home, "outside.json");
      fs.renameSync(f.file, outside);
      fs.symlinkSync(outside, f.file);
      const read = vi.spyOn(fs, "readSync");
      expect(findBlueprintNativeReceipt(f.input)).toBeNull();
      expect(read).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  it("rejects a symbolic link substituted immediately before opening the receipt", async () => {
    const f = await recoveryFixture();
    const open = fs.openSync;
    try {
      const outside = path.join(f.home, "outside.json");
      fs.writeFileSync(outside, f.plan);
      vi.spyOn(fs, "openSync").mockImplementationOnce((file, flags) => {
        fs.unlinkSync(f.file);
        fs.symlinkSync(outside, f.file);
        return open(file, flags);
      });
      const read = vi.spyOn(fs, "readSync");
      expect(findBlueprintNativeReceipt(f.input)).toBeNull();
      expect(read).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  it("refuses a nonblocking FIFO receipt before reading", async () => {
    const f = await recoveryFixture();
    try {
      fs.unlinkSync(f.file);
      execFileSync("mkfifo", [f.file]);
      const read = vi.spyOn(fs, "readSync");
      const openFile = fs.openSync;
      const open = vi.spyOn(fs, "openSync").mockImplementationOnce((file, flags) => {
        expect(Number(flags) & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
        return openFile(file, flags);
      });
      expect(findBlueprintNativeReceipt(f.input)).toBeNull();
      expect(read).not.toHaveBeenCalled();
      expect(() => fs.fstatSync(open.mock.results[0]!.value)).toThrow();
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  }, 5_000);

  it("refuses a file replaced after opening without reading the replacement", async () => {
    const f = await recoveryFixture();
    const open = fs.openSync;
    try {
      const opened = vi.spyOn(fs, "openSync").mockImplementationOnce((file, flags) => {
        const descriptor = open(file, flags);
        fs.renameSync(f.file, path.join(f.home, "retained.json"));
        fs.writeFileSync(f.file, f.plan);
        return descriptor;
      });
      const read = vi.spyOn(fs, "readSync");
      expect(() => findBlueprintNativeReceipt(f.input)).toThrow("changed while it was read");
      expect(read).not.toHaveBeenCalled();
      expect(() => fs.fstatSync(opened.mock.results[0]!.value)).toThrow();
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  it("refuses a file replaced after reading and closes the original descriptor", async () => {
    const f = await recoveryFixture();
    const stat = fs.fstatSync;
    try {
      vi.spyOn(fs, "fstatSync")
        .mockImplementationOnce((descriptor) => stat(descriptor))
        .mockImplementationOnce((descriptor) => {
          fs.renameSync(f.file, path.join(f.home, "retained.json"));
          fs.writeFileSync(f.file, f.plan);
          return stat(descriptor);
        });
      const open = vi.spyOn(fs, "openSync");
      expect(() => findBlueprintNativeReceipt(f.input)).toThrow("changed while it was read");
      expect(() => fs.fstatSync(open.mock.results[0]!.value)).toThrow();
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  it("refuses two different complete receipts for the same sandbox", async () => {
    const f = await recoveryFixture();
    try {
      const other = path.join(path.dirname(f.directory), "nc-other");
      fs.mkdirSync(other);
      const receipt = f.receipts.at(-1)!;
      fs.writeFileSync(
        path.join(other, "plan.json"),
        JSON.stringify({
          native_inference: {
            ...receipt,
            providerAttachment: { ...receipt.providerAttachment, providerId: "other-provider-id" },
          },
        }),
      );
      expect(() => findBlueprintNativeReceipt(f.input)).toThrow("Conflicting blueprint");
      expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
      expect(f.adapter.updateProvider).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  it("refuses a run directory replaced by a symbolic link before reading", async () => {
    const f = await recoveryFixture();
    const open = fs.openSync;
    try {
      const outside = path.join(f.home, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "plan.json"), f.plan);
      vi.spyOn(fs, "openSync").mockImplementationOnce((file, flags) => {
        fs.renameSync(f.directory, path.join(f.home, "retained"));
        fs.symlinkSync(outside, f.directory);
        return open(file, flags);
      });
      const read = vi.spyOn(fs, "readSync");
      expect(() => findBlueprintNativeReceipt(f.input)).toThrow("changed while it was read");
      expect(read).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  it("bounds a receipt that grows after descriptor validation and refuses it", async () => {
    const f = await recoveryFixture();
    const stat = fs.fstatSync;
    try {
      vi.spyOn(fs, "fstatSync").mockImplementationOnce((descriptor) => {
        const before = stat(descriptor);
        fs.appendFileSync(f.file, " ".repeat(2 * 1024 * 1024));
        return before;
      });
      const read = vi.spyOn(fs, "readSync");
      const open = vi.spyOn(fs, "openSync");
      expect(() => findBlueprintNativeReceipt(f.input)).toThrow("changed while it was read");
      expect(read).toHaveBeenCalledTimes(1);
      expect(read.mock.results[0]?.value).toBe(1024 * 1024 + 1);
      expect(() => fs.fstatSync(open.mock.results[0]!.value)).toThrow();
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  it.each([
    "{ malformed historical JSON",
    JSON.stringify({ native_inference: { gatewayName: "other", sandboxName: "chosen-sandbox" } }),
  ])("ignores an unrelated unusable run while preserving valid authority", async (otherPlan) => {
    const f = fixture();
    await createBlueprintNativeInference(f.input, f.deps);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-recovery-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const runs = path.join(home, ".nemoclaw/state/runs");
    try {
      fs.mkdirSync(path.join(runs, "nc-first"), { recursive: true });
      fs.mkdirSync(path.join(runs, "nc-second"));
      fs.writeFileSync(path.join(runs, "nc-first/plan.json"), otherPlan);
      fs.writeFileSync(
        path.join(runs, "nc-second/plan.json"),
        JSON.stringify({ native_inference: f.receipts.at(-1) }),
      );
      const receipt = findBlueprintNativeReceipt(f.input);
      expect(receipt).toEqual(f.receipts.at(-1));
      await expect(
        observeBlueprintCreatedInference({ ...f.input, endpointUrl: undefined }, receipt!, f.deps),
      ).resolves.toContain("provider-id-1");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(["incomplete", "malformed"])(
    "refuses a matching %s run despite another complete receipt",
    async (kind) => {
      const f = fixture();
      await createBlueprintNativeInference(f.input, f.deps);
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-recovery-"));
      vi.spyOn(os, "homedir").mockReturnValue(home);
      const runs = path.join(home, ".nemoclaw/state/runs");
      try {
        fs.mkdirSync(path.join(runs, "nc-first"), { recursive: true });
        fs.mkdirSync(path.join(runs, "nc-second"));
        const partial =
          kind === "incomplete" ? f.receipts[0] : { ...f.receipts.at(-1), schemaVersion: 7 };
        fs.writeFileSync(
          path.join(runs, "nc-first/plan.json"),
          JSON.stringify({ native_inference: partial }),
        );
        fs.writeFileSync(
          path.join(runs, "nc-second/plan.json"),
          JSON.stringify({ native_inference: f.receipts.at(-1) }),
        );
        expect(() => findBlueprintNativeReceipt(f.input)).toThrow(/incomplete|Invalid/);
        expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

function timeoutFixture() {
  const input = {
    gatewayName: "chosen-gateway",
    sandboxName: "chosen-sandbox",
    provider: "chosen-provider",
    model: "custom-model",
    api: "openai-completions",
    timeoutSeconds: 300,
  };
  const config = {
    agents: { defaults: { model: { primary: "inference/custom-model" }, timeoutSeconds: 600 } },
    models: {
      providers: {
        inference: {
          api: "openai-completions",
          baseUrl: "http://8.8.8.8:8000/v1",
          apiKey: "openshell:resolve:env:v1_OPENAI_API_KEY",
          timeoutSeconds: 180,
        },
      },
    },
  };
  const deps = {
    readConfig: vi.fn(() => config),
    configTarget: vi.fn(() => ({
      agentName: "openclaw",
      configPath: "/sandbox/.openclaw/openclaw.json",
      configDir: "/sandbox/.openclaw",
      configFile: "openclaw.json",
      format: "json",
    })),
    writeConfig: vi.fn(),
  };
  return { input, config, deps, observe: vi.fn(async () => "immutable-identity") };
}

describe("blueprint native timeout reuse", () => {
  it("updates only the selected provider request timeout under repeated authority checks", async () => {
    const f = timeoutFixture();
    await reconcileBlueprintNativeTimeout(f.input, f.observe, f.deps);
    expect(f.deps.writeConfig).toHaveBeenCalledWith(
      "chosen-sandbox",
      [{ dotpath: "models.providers.inference.timeoutSeconds", value: 300 }],
      "chosen-gateway",
    );
    expect(f.config.agents.defaults.timeoutSeconds).toBe(600);
    expect(f.observe).toHaveBeenCalledTimes(3);
  });
  it.each([
    ["openai-completions", "http://8.8.8.8:8000/v1", "http://8.8.8.8:8000/v1/"],
    ["anthropic-messages", "http://8.8.8.8:8000", "http://8.8.8.8:8000/v1"],
  ])(
    "normalizes the %s provider endpoint before timeout reuse",
    async (api, configuredUrl, requestedUrl) => {
      const f = timeoutFixture();
      f.config.models.providers.inference.api = api;
      f.config.models.providers.inference.baseUrl = configuredUrl;
      await reconcileBlueprintNativeTimeout(
        { ...f.input, api, endpointUrl: requestedUrl },
        f.observe,
        f.deps,
      );
      expect(f.deps.writeConfig).toHaveBeenCalledTimes(1);
      expect(f.observe).toHaveBeenCalledTimes(3);
    },
  );

  it("preserves an already matching timeout without writing config", async () => {
    const f = timeoutFixture();
    await reconcileBlueprintNativeTimeout({ ...f.input, timeoutSeconds: 180 }, f.observe, f.deps);
    expect(f.deps.writeConfig).not.toHaveBeenCalled();
  });
  it.each([
    { model: "other-model" },
    { api: "anthropic-messages" },
    { endpointUrl: "http://9.9.9.9/v1" },
    { timeoutSeconds: 0 },
  ])("refuses mismatched selection before writes: %j", async (override) => {
    const f = timeoutFixture();
    await expect(
      reconcileBlueprintNativeTimeout({ ...f.input, ...override }, f.observe, f.deps),
    ).rejects.toThrow();
    expect(f.deps.writeConfig).not.toHaveBeenCalled();
  });
  it("refuses identity replacement between config read and write", async () => {
    const f = timeoutFixture();
    f.observe.mockResolvedValueOnce("original").mockResolvedValueOnce("replacement");
    await expect(reconcileBlueprintNativeTimeout(f.input, f.observe, f.deps)).rejects.toThrow(
      "before timeout update",
    );
    expect(f.deps.writeConfig).not.toHaveBeenCalled();
  });
});
