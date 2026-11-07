// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeGatewaySession } from "../../packaging/windows/runtime/native-gateway-session.mts";

import {
  brokerOperationForRequest,
  nativeCredentialBinding,
  nativeQualificationLoopbackConfig,
  readOpenedRegularFile,
  readWindowsCredential,
  resolveBrokerUpstreamUrl,
} from "../../packaging/windows/runtime/native-security.mts";

const { credentialSpawn } = vi.hoisted(() => ({ credentialSpawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: credentialSpawn,
}));
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
      kill: vi.fn(() => true),
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("qualification loopback policy selection", () => {
  it("allows only selected ports on BaseContainer and preserves the AppContainer default", () => {
    expect(
      nativeQualificationLoopbackConfig(
        { tier: "base-container", needsDaclAugmentation: false },
        [12345, 23456, 12345],
      ),
    ).toEqual({ kind: "loopback", ports: [12345, 23456] });
    expect(
      nativeQualificationLoopbackConfig(
        { tier: "appcontainer-dacl", needsDaclAugmentation: true },
        [12345],
      ),
    ).toEqual({ kind: "deny" });
  });
  it.each([
    null,
    {},
    { tier: "other" },
    { tier: "base-container", needsDaclAugmentation: true },
    { tier: "appcontainer-dacl", needsDaclAugmentation: false },
  ])("rejects an unknown or inconsistent probe %j", (probe) => {
    expect(() => nativeQualificationLoopbackConfig(probe, [12345])).toThrow();
  });
  it.each([
    { ports: [] },
    { ports: [0] },
    { ports: [-1] },
    { ports: [65536] },
    { ports: [1.5] },
    { ports: [NaN] },
  ])("rejects invalid ports $ports", ({ ports }) => {
    expect(() =>
      nativeQualificationLoopbackConfig(
        { tier: "base-container", needsDaclAugmentation: false },
        ports,
      ),
    ).toThrow();
  });
});

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

  it("terminates and rejects a hung credential read without waiting for a close event", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    credentialSpawn.mockReturnValueOnce(child);
    const pending = readWindowsCredential("launcher", nvidiaCredentialIdentity, true);
    const rejected = expect(pending).rejects.toThrow(
      "Reading the selected Windows credential timed out.",
    );
    child.stdout.write("partial-private-key");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    child.emit("close", 0);
    expect(vi.getTimerCount()).toBe(0);
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

  it("limits actual descriptor reads when a file grows after its metadata check", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-file-growth-"));
    try {
      const file = path.join(directory, "receipt");
      fs.writeFileSync(file, "small");
      fs.appendFileSync(file, "x".repeat(128));
      const checked = fs.statSync(file);
      Object.defineProperty(checked, "size", { value: Buffer.byteLength("small") });
      // Reproduce a legitimate stale fstat size without a check/use path race;
      // the following descriptor reads still use the real, now-grown file.
      vi.spyOn(fs, "fstatSync").mockReturnValueOnce(checked);
      const reads = vi.spyOn(fs, "readSync");
      expect(() => readOpenedRegularFile(file, { maxBytes: 8 })).toThrow(/exceeds its limit/u);
      expect(reads.mock.results.reduce((bytes, result) => bytes + Number(result.value), 0)).toBe(9);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects linked receipts when a single owned file is required", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-receipt-links-"));
    try {
      const file = path.join(directory, "receipt");
      const alias = path.join(directory, "alias");
      fs.writeFileSync(file, "bounded");
      const options = {
        encoding: "utf8" as const,
        maxBytes: 512,
        rejectLinks: true,
        rejectHardLinks: true,
      };
      expect(readOpenedRegularFile(file, options)).toBe("bounded");
      fs.linkSync(file, alias);
      expect(() => readOpenedRegularFile(file, options)).toThrow(/multiple links/u);
      expect(() => readOpenedRegularFile(alias, options)).toThrow(/multiple links/u);
      expect(readOpenedRegularFile(file, { encoding: "utf8" })).toBe("bounded");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects receipt identity changes and reads only the checked descriptor", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-receipt-identity-"));
    const originalLstat = fs.lstatSync;
    try {
      const file = path.join(directory, "receipt");
      const replacement = path.join(directory, "replacement");
      fs.writeFileSync(file, "owned");
      fs.writeFileSync(replacement, "replacement");
      const options = {
        encoding: "utf8" as const,
        maxBytes: 512,
        rejectLinks: true,
        rejectHardLinks: true,
      };
      const replacementStat = originalLstat(replacement);
      vi.spyOn(fs, "lstatSync").mockReturnValueOnce(replacementStat);
      expect(() => readOpenedRegularFile(file, options)).toThrow(/changed identity/u);
      vi.mocked(fs.lstatSync).mockImplementationOnce(
        (...args: Parameters<typeof originalLstat>) => {
          const checked = originalLstat(...args);
          fs.renameSync(file, path.join(directory, "checked"));
          fs.renameSync(replacement, file);
          return checked;
        },
      );
      expect(readOpenedRegularFile(file, options)).toBe("owned");
      expect(fs.readFileSync(file, "utf8")).toBe("replacement");
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["started", "stopped"] as const)(
    "reads the checked %s gateway receipt even when its path is replaced",
    async (kind) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-gateway-receipt-"));
      const session = new NativeGatewaySession(
        path.join(directory, "install"),
        path.join(directory, "run"),
      );
      // Exercise receipt consumption without starting a Windows process. The
      // native gateway session suite separately owns process and DACL evidence.
      Object.assign(session, { gateway: { pid: 1234, exitCode: 0, signalCode: null } });
      const nonce = Reflect.get(session, "stopNonce");
      const value = {
        schemaVersion: 1,
        nonce,
        gatewayProcessId: 42,
        stopped: true,
        activeProcesses: 0,
        requested: true,
        gatewayExitCode: 0,
      };
      const file = path.join(
        session.root,
        "gateway-stopped.json" + (kind === "started" ? ".started" : ""),
      );
      const originalLstat = fs.lstatSync;
      try {
        fs.mkdirSync(session.root);
        fs.writeFileSync(file, JSON.stringify(value));
        const replacement = path.join(session.root, "replacement");
        fs.writeFileSync(replacement, JSON.stringify({ ...value, nonce: "wrong-owner" }));
        vi.spyOn(fs, "lstatSync").mockImplementationOnce(
          (...args: Parameters<typeof originalLstat>) => {
            const checked = originalLstat(...args);
            fs.renameSync(file, path.join(session.root, "checked"));
            fs.renameSync(replacement, file);
            return checked;
          },
        );
        const observed = await {
          started: async () => session.gatewayProcessId,
          stopped: async () => session.stopGateway(),
        }[kind]();
        expect(observed).toBe({ started: 42, stopped: true }[kind]);
        expect(JSON.parse(fs.readFileSync(file, "utf8")).nonce).toBe("wrong-owner");
      } finally {
        vi.restoreAllMocks();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(
    (["started", "stopped"] as const).flatMap((kind) => [
      ...["null", "{", "x".repeat(513)].map((text, index) => ({
        kind,
        name: ["null", "malformed JSON", "oversized"][index],
        serialize: (_value: Record<string, unknown>) => text,
      })),
      ...[
        { nonce: "wrong-owner" },
        { schemaVersion: 2 },
        ...(kind === "started"
          ? [0, -1, 1.5, 0x100000000].map((gatewayProcessId) => ({ gatewayProcessId }))
          : [
              { stopped: false },
              { activeProcesses: 1 },
              { requested: "true" },
              { gatewayExitCode: -1 },
              { gatewayExitCode: 1.5 },
              { gatewayExitCode: 0x100000000 },
            ]),
      ].map((overrides) => ({
        kind,
        name: JSON.stringify(overrides),
        serialize: (value: Record<string, unknown>) => JSON.stringify({ ...value, ...overrides }),
      })),
    ]),
  )(
    "rejects $name in a $kind gateway receipt and preserves recovery",
    async ({ kind, serialize }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-gateway-invalid-receipt-"));
      const session = new NativeGatewaySession(
        path.join(directory, "install"),
        path.join(directory, "run"),
      );
      Object.assign(session, { gateway: { pid: 1234, exitCode: 0, signalCode: null } });
      const value = {
        schemaVersion: 1,
        nonce: Reflect.get(session, "stopNonce"),
        gatewayProcessId: 42,
        stopped: true,
        activeProcesses: 0,
        requested: true,
        gatewayExitCode: 0,
      };
      const file = path.join(
        session.root,
        "gateway-stopped.json" + (kind === "started" ? ".started" : ""),
      );
      const rejectReceipt = {
        started: async () =>
          expect(() => session.gatewayProcessId).toThrow(/identity is not available/u),
        stopped: async () => expect(await session.stopGateway()).toBe(false),
      }[kind];
      try {
        fs.mkdirSync(session.root);
        await rejectReceipt();
        fs.writeFileSync(file, serialize(value));
        await rejectReceipt();
        fs.writeFileSync(file, JSON.stringify(value));
        const alias = path.join(session.root, "alias");
        fs.linkSync(file, alias);
        await rejectReceipt();
        fs.unlinkSync(alias);
        const observed = await {
          started: async () => session.gatewayProcessId,
          stopped: async () => session.stopGateway(),
        }[kind]();
        expect(observed).toBe({ started: 42, stopped: true }[kind]);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
