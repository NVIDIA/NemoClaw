// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  brokerOperationForRequest,
  nativeCredentialBinding,
  readOpenedRegularFile,
  readWindowsCredential,
  resolveBrokerUpstreamUrl,
  validatedChatMessages,
} from "../../../packaging/windows/runtime/native-security.mts";

const { credentialSpawn } = vi.hoisted(() => ({ credentialSpawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: credentialSpawn }));
const nvidiaCredentialIdentity = {
  agent: "openclaw",
  inference: "nvidia",
  endpoint: "https://integrate.api.nvidia.com/v1",
};
const localCredentialIdentity = {
  agent: "openclaw",
  inference: "local",
  endpoint: "http://127.0.0.1:8000/v1",
};

function mockCredentialOutput(chunks: Buffer[], code = 0) {
  credentialSpawn.mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      for (const chunk of chunks) child.stdout.write(chunk);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code);
    });
    return child;
  });
}

describe("native Windows runtime security boundaries", () => {
  it("keeps broker request targets on the configured provider origin", () => {
    expect(
      resolveBrokerUpstreamUrl("https://provider.example/v1", "chat-completions").toString(),
    ).toBe("https://provider.example/v1/chat/completions");
    expect(brokerOperationForRequest("POST", "/v1/chat/completions")).toBe("chat-completions");
    expect(brokerOperationForRequest("GET", "/v1/models")).toBe("models");
    expect(brokerOperationForRequest("POST", "/v1//attacker.example/steal")).toBeNull();
    expect(brokerOperationForRequest("POST", "/v1/chat/completions?target=attacker")).toBeNull();
    expect(brokerOperationForRequest("DELETE", "/v1/models")).toBeNull();
    expect(() => resolveBrokerUpstreamUrl("http://provider.example/v1", "models")).toThrow(
      /provider endpoint violates/u,
    );
    expect(resolveBrokerUpstreamUrl("http://127.0.0.1:8000/v1", "models").origin).toBe(
      "http://127.0.0.1:8000",
    );
    expect(resolveBrokerUpstreamUrl("http://localhost:8000/v1", "models").origin).toBe(
      "http://localhost:8000",
    );
    expect(() =>
      resolveBrokerUpstreamUrl("https://provider.example/v1", "delete" as never),
    ).toThrow(/not allowlisted/u);
  });

  it.each(["https://user:secret@provider.example/v1", "https://provider.example/v1#fragment"])(
    "rejects an unauthorized provider URL %s",
    (endpoint) => {
      expect(() => resolveBrokerUpstreamUrl(endpoint, "models")).toThrow(
        /provider endpoint violates/u,
      );
    },
  );

  it("rejects oversized credentials even when earlier stdout chunks fit the limit", async () => {
    mockCredentialOutput([Buffer.alloc(1024, "x"), Buffer.alloc(1025, "y")]);
    await expect(readWindowsCredential("launcher", nvidiaCredentialIdentity, true)).rejects.toThrow(
      /bounded provider credential/u,
    );
    mockCredentialOutput([Buffer.alloc(2048, "x")]);
    await expect(readWindowsCredential("launcher", nvidiaCredentialIdentity, true)).resolves.toBe(
      "x".repeat(2048),
    );
  });

  it("rejects empty or failed credential reads and skips providers without credentials", async () => {
    mockCredentialOutput([]);
    await expect(readWindowsCredential("launcher", localCredentialIdentity, true)).rejects.toThrow(
      /bounded provider credential/u,
    );
    mockCredentialOutput([Buffer.from("candidate-test-value")], 2);
    await expect(readWindowsCredential("launcher", nvidiaCredentialIdentity, true)).rejects.toThrow(
      /bounded provider credential/u,
    );
    const calls = credentialSpawn.mock.calls.length;
    await expect(readWindowsCredential("launcher", localCredentialIdentity, false)).resolves.toBe(
      "",
    );
    expect(credentialSpawn.mock.calls).toHaveLength(calls);
  });

  it("binds credentials to the agent, provider, and canonical broker endpoint", () => {
    const identity = {
      agent: "openclaw",
      inference: "compatible",
      endpoint: "https://PROVIDER.example:443/v1",
    };
    const binding = nativeCredentialBinding(identity);
    expect(binding).toMatch(/^[a-f0-9]{64}$/u);
    expect(nativeCredentialBinding({ ...identity, endpoint: "https://provider.example/v1/" })).toBe(
      binding,
    );
    const loopbackHttps = { ...localCredentialIdentity, endpoint: "https://127.0.0.1/v1" };
    expect(nativeCredentialBinding({ ...loopbackHttps, inference: "compatible" })).not.toBe(
      nativeCredentialBinding(loopbackHttps),
    );
    expect(() =>
      nativeCredentialBinding({
        ...nvidiaCredentialIdentity,
        endpoint: "https://other-provider.example/v1",
      }),
    ).toThrow(/does not match/u);
    expect(() =>
      nativeCredentialBinding({
        ...localCredentialIdentity,
        endpoint: "https://other-provider.example/v1",
      }),
    ).toThrow(/not loopback/u);
  });

  it.each([
    { agent: "hermes" },
    { endpoint: "https://other-provider.example/v1" },
    { endpoint: "https://provider.example/other" },
    { endpoint: "https://provider.example:8443/v1" },
  ])("changes the credential binding when its authority changes %j", (changed) => {
    const identity = {
      agent: "openclaw",
      inference: "compatible",
      endpoint: "https://PROVIDER.example:443/v1",
    };
    expect(nativeCredentialBinding({ ...identity, ...changed })).not.toBe(
      nativeCredentialBinding(identity),
    );
  });

  it("reads only the bound credential and never retries a missing key in a global slot", async () => {
    const before = credentialSpawn.mock.calls.length;
    mockCredentialOutput([], 2);
    await expect(readWindowsCredential("launcher", localCredentialIdentity, true)).rejects.toThrow(
      /bounded provider credential/u,
    );
    expect(credentialSpawn.mock.calls).toHaveLength(before + 1);
    expect(credentialSpawn.mock.calls[before]?.[1]).toEqual([
      "--credential-read",
      "local",
      "--binding",
      nativeCredentialBinding(localCredentialIdentity),
    ]);
  });

  it("opens relay files once and rejects non-files or oversized content", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-security-"));
    try {
      const file = path.join(directory, "token");
      fs.writeFileSync(file, "bounded", "utf8");
      expect(readOpenedRegularFile(file, { encoding: "utf8", maxBytes: 7 })).toBe("bounded");
      expect(() => readOpenedRegularFile(file, { encoding: "utf8", maxBytes: 6 })).toThrow(
        /exceeds its limit/u,
      );
      expect(() => readOpenedRegularFile(directory, { encoding: "utf8" })).toThrow(
        /not a regular file/u,
      );
      expect(
        readOpenedRegularFile(path.join(directory, "missing"), { encoding: "utf8" }),
      ).toBeNull();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("projects NemoCUA model requests through a bounded message schema", () => {
    expect(
      validatedChatMessages({
        messages: [{ role: "user", content: "observe the bounded page" }],
        tools: [{ type: "untrusted" }],
      }),
    ).toEqual([{ role: "user", content: "observe the bounded page" }]);
    expect(() =>
      validatedChatMessages({ messages: [{ role: "tool", content: "secret" }] }),
    ).toThrow(/invalid message/u);
    expect(() =>
      validatedChatMessages({ messages: [{ role: "user", content: "x".repeat(64 * 1024 + 1) }] }),
    ).toThrow(/exceeds its limit/u);
    expect(() =>
      validatedChatMessages({
        messages: Array.from({ length: 65 }, () => ({ role: "user", content: "x" })),
      }),
    ).toThrow(/message list is invalid/u);
    expect(() =>
      validatedChatMessages({
        messages: Array.from({ length: 17 }, () => ({
          role: "user",
          content: "x".repeat(64 * 1024),
        })),
      }),
    ).toThrow(/content exceeds its limit/u);
  });

  it.each([{ body: null }, { body: [] }, { body: "message" }, { body: { messages: {} } }])(
    "rejects an invalid NemoCUA message envelope %j",
    ({ body }) => {
      expect(() => validatedChatMessages(body)).toThrow(/invalid/u);
    },
  );
});
