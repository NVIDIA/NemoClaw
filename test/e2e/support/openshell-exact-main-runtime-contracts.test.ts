// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawnSync } from "node:child_process";

import { promisify } from "node:util";
import { createConnection } from "node:net";

import { describe, expect, it, vi } from "vitest";

import * as policy from "../../../src/lib/policy";
import {
  assertExactMainPolicyAndIdentityContracts,
  buildExactMainLiveExeIdentityScript,
  DIRECT_BYPASS_PROBE_CODE,
  inspectExactMainIsolation,
  parseExactMainPolicyStatus,
  waitForRestartedPolicy,
} from "../live/openshell-exact-main-runtime-contracts.ts";

function completeIsolation(): Record<string, unknown> {
  return {
    Id: "a".repeat(64),
    HostConfig: { NetworkMode: "none", CapDrop: ["ALL"], CapAdd: null, Privileged: false },
  };
}

describe("OpenShell exact-main policy, native isolation, and process-identity proof helpers", () => {
  it.each([
    { label: "composed effective policy", revisionHash: "base", effectiveHash: "changed" },
    { label: "stored base revision", revisionHash: "changed", effectiveHash: "composed" },
  ])("waits for the same $label hash after restart", async ({ revisionHash, effectiveHash }) => {
    vi.useFakeTimers();
    const status = (hash: string, state: string) => ({
      activeVersion: 4,
      hash,
      sandbox: "exact-main-proof",
      status: state,
      version: 4,
    });
    const effective = status("composed", "effective");
    const revision = status("base", "loaded");
    const result = (value: ReturnType<typeof status>) => ({
      exitCode: 0,
      stdout: JSON.stringify({ ...value, active_version: value.activeVersion }),
      stderr: "",
      timedOut: false,
      signal: null,
    });
    const openshell = vi
      .fn()
      .mockResolvedValueOnce(result(status(revisionHash, "loaded")))
      .mockResolvedValueOnce(result(status(effectiveHash, "effective")))
      .mockResolvedValueOnce(result(revision))
      .mockResolvedValueOnce(result(effective));
    try {
      const pending = waitForRestartedPolicy(
        { openshell } as never,
        "exact-main-proof",
        effective,
        revision,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({ effective, revision });
      expect(openshell).toHaveBeenCalledTimes(4);
      expect(openshell.mock.calls.map(([args]) => args)).toEqual([
        ["policy", "get", "--rev", "4", "exact-main-proof", "--output", "json"],
        ["policy", "get", "exact-main-proof", "--output", "json"],
        ["policy", "get", "--rev", "4", "exact-main-proof", "--output", "json"],
        ["policy", "get", "exact-main-proof", "--output", "json"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      label: "stop fails",
      failure: "stop",
      operations: ["stop"],
      dockerOperations: ["ps", "inspect"],
      message: "stop exact-main OpenShell sandbox container failed",
    },
    {
      label: "start fails",
      failure: "start",
      operations: ["stop", "start"],
      dockerOperations: ["ps", "inspect"],
      message: "start exact-main OpenShell sandbox container failed",
    },
    {
      label: "restart completes",
      failure: null,
      operations: ["stop", "start"],
      dockerOperations: ["ps", "inspect", "ps"],
      message: "inspect restarted container",
    },
  ])(
    "restores the policy when $label",
    async ({ failure, operations, dockerOperations, message }) => {
      vi.stubEnv("NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF", "1");
      const basePolicy = "version: 1\nnetwork_policies: {}\n";
      const setPolicy = vi.spyOn(policy, "setPolicyDocument").mockResolvedValue(true);
      const success = (stdout: string) => ({
        artifacts: { result: "", stderr: "", stdout: "" },
        command: [],
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout,
        timedOut: false,
      });
      const status = (version: number, state: string) =>
        success(
          JSON.stringify({
            active_version: version,
            config_revision: version,
            hash: `sha256:${state}-policy-${version}`,
            policy_source: "sandbox",
            sandbox: "exact-main-proof",
            status: state,
            version,
          }),
        );
      const openshell = vi.fn();
      [
        success(basePolicy),
        status(1, "effective"),
        status(2, "effective"),
        status(2, "loaded"),
        ...operations.map((operation) => ({
          ...success(""),
          exitCode: failure === operation ? 1 : 0,
          stderr: failure === operation ? "lifecycle failed" : "",
        })),
        success(basePolicy),
      ].forEach((result) => openshell.mockResolvedValueOnce(result));
      const command = vi
        .fn()
        .mockResolvedValueOnce(
          success(
            `${"a".repeat(64)}\topenshell-default--exact-main-proof-proofid\tproofid\tdefault`,
          ),
        )
        .mockResolvedValueOnce(success(JSON.stringify(completeIsolation())))
        .mockRejectedValueOnce(new Error("inspect restarted container"));

      try {
        await expect(
          assertExactMainPolicyAndIdentityContracts({
            artifacts: {} as never,
            cleanup: { add: vi.fn() } as never,
            host: { command } as never,
            mcpUrl: "https://mcp.example.test/mcp",
            sandbox: { openshell } as never,
            sandboxName: "exact-main-proof",
          }),
        ).rejects.toThrow(message);
        expect(openshell.mock.calls.slice(4, -1).map(([args]) => args)).toEqual(
          operations.map((operation) => ["sandbox", operation, "exact-main-proof"]),
        );
        expect(command.mock.calls.map(([, args]) => args[0])).toEqual(dockerOperations);
        expect(setPolicy).toHaveBeenLastCalledWith(
          "exact-main-proof",
          basePolicy.trim(),
          expect.objectContaining({ operation: "restore the exact-main policy proof" }),
        );
      } finally {
        setPolicy.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it("applies and restores the identity proof through live OpenShell policy authority", async () => {
    vi.stubEnv("NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF", "1");
    const basePolicy = "version: 1\nnetwork_policies: {}\n";
    const policyMutations: Array<{ document: string; operation: string | undefined }> = [];
    const setPolicy = vi
      .spyOn(policy, "setPolicyDocument")
      .mockImplementation(async (_sandboxName, document, options) => {
        policyMutations.push({ document, operation: options?.operation });
        return true;
      });
    const success = (stdout: string) => ({
      artifacts: { result: "", stderr: "", stdout: "" },
      command: [],
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout,
      timedOut: false,
    });
    const openshell = vi
      .fn()
      .mockResolvedValueOnce(success(basePolicy))
      .mockResolvedValueOnce(
        success(
          JSON.stringify({
            active_version: 1,
            config_revision: 1,
            hash: "sha256:before",
            policy_source: "sandbox",
            sandbox: "exact-main-proof",
            status: "effective",
            version: 1,
          }),
        ),
      )
      .mockResolvedValueOnce({
        ...success(""),
        exitCode: 1,
        stderr: "stop after live-policy mutation",
      })
      .mockResolvedValueOnce(success(basePolicy));
    const sandbox = {
      openshell,
    } as never;

    try {
      await expect(
        assertExactMainPolicyAndIdentityContracts({
          artifacts: {} as never,
          cleanup: { add: vi.fn() } as never,
          host: {} as never,
          mcpUrl: "https://mcp.example.test/mcp",
          sandbox,
          sandboxName: "exact-main-proof",
        }),
      ).rejects.toThrow("stop after live-policy mutation");
    } finally {
      setPolicy.mockRestore();
      vi.unstubAllEnvs();
    }

    expect(policyMutations).toHaveLength(2);
    expect(policyMutations[0]?.document).toContain("exact_main_live_exe_identity");
    expect(policyMutations[0]?.operation).toBe("apply the exact-main live-exe identity policy");
    expect(policyMutations[1]?.document).toBe(basePolicy.trim());
    expect(policyMutations[1]?.operation).toBe("restore the exact-main policy proof");
    const openshellCalls = openshell.mock.calls.map(([args]) => args as string[]);
    expect(openshellCalls.some((args) => args[0] === "policy" && args[1] === "set")).toBe(false);
  });

  it("closes owned TCP/UDP listeners and restores policy after the complete native proof", async () => {
    vi.stubEnv("NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF", "1");
    const base = "version: 1\nnetwork_policies: {}";
    const result = (stdout: string) => ({
      artifacts: { result: "", stderr: "", stdout: "" },
      command: [],
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout,
      timedOut: false,
    });
    const status = (version: number, state: string) =>
      result(
        JSON.stringify({
          active_version: version,
          hash: `policy-${version}`,
          policy_source: "sandbox",
          sandbox: "exact-main-proof",
          status: state,
          version,
        }),
      );
    let port = 0;
    const mutations = vi
      .spyOn(policy, "setPolicyDocument")
      .mockImplementation(async (_name, document) => {
        port = Number(document.match(/port: (\d+)/u)?.[1] ?? port);
        return true;
      });
    const openshell = vi.fn();
    [
      result(base),
      status(1, "effective"),
      status(2, "effective"),
      status(2, "loaded"),
      result(""),
      result(""),
      status(2, "loaded"),
      status(2, "effective"),
      result("Acknowledged initial policy revision as loaded [version:2]"),
      result(base),
    ].forEach((value) => openshell.mockResolvedValueOnce(value));
    const command = vi.fn(async (name: string, args: string[]) => {
      const handlers: Record<string, () => Promise<ReturnType<typeof result>>> = {
        python3: async () => ({
          ...result(""),
          ...(await promisify(execFile)(name, args, { timeout: 5_000 })),
        }),
        inspect: async () => result(JSON.stringify(completeIsolation())),
        ps: async () =>
          result(
            `${"a".repeat(64)}\topenshell-default--exact-main-proof-proofid\tproofid\tdefault`,
          ),
      };
      return await handlers[name === "python3" ? name : args[0]]();
    });
    const identityConnection = () =>
      new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port }, () =>
          socket.write("identity-control"),
        );
        socket.on("error", reject);
        socket.on("data", () => socket.end());
        socket.on("close", () => resolve());
      });
    const execShell = vi.fn(async () => {
      await identityConnection();
      await identityConnection();
      return result(
        "NEMOCLAW_LIVE_EXE_OLD_FIRST=allowed\nNEMOCLAW_LIVE_EXE_OLD_SECOND=allowed\nNEMOCLAW_LIVE_EXE_NEW=EACCES\nNEMOCLAW_LIVE_EXE_OLD_LINK=/tmp/live-python (deleted)\n",
      );
    });
    const cleanup: Array<() => Promise<void>> = [];
    const artifacts = { writeJson: vi.fn() };
    try {
      await assertExactMainPolicyAndIdentityContracts({
        artifacts: artifacts as never,
        cleanup: {
          add: (_label: string, action: () => Promise<void>) => cleanup.push(action),
        } as never,
        host: { command } as never,
        sandbox: {
          openshell,
          execShell,
          exec: vi.fn(async () =>
            result(
              JSON.stringify({
                tcp: { connected: false, error: { errno: 13 } },
                udp: { echoed: false, error: { errno: 13 } },
              }),
            ),
          ),
        } as never,
        sandboxName: "exact-main-proof",
        mcpUrl: "https://mcp.example.test/mcp",
      });
      expect(command.mock.calls.filter(([name]) => name === "python3")).toHaveLength(2);
      expect(mutations).toHaveBeenLastCalledWith(
        "exact-main-proof",
        base,
        expect.objectContaining({ operation: "restore the exact-main policy proof" }),
      );
      expect(artifacts.writeJson).toHaveBeenCalledWith(
        "exact-main-policy-native-identity-summary.json",
        expect.objectContaining({
          isolationAfterRestart: expect.objectContaining({ networkMode: "none" }),
        }),
      );
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = createConnection({ host: "127.0.0.1", port }, () => {
            socket.destroy();
            resolve();
          });
          socket.on("error", reject);
        }),
      ).rejects.toMatchObject({ code: "ECONNREFUSED" });
      await cleanup.reduce(async (previous, action) => {
        await previous;
        await action();
      }, Promise.resolve());
    } finally {
      await cleanup.reduce(async (previous, action) => {
        await previous;
        await action();
      }, Promise.resolve());
      mutations.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("parses effective and stored revision identities without discarding version or hash", () => {
    expect(
      parseExactMainPolicyStatus(
        JSON.stringify({
          active_version: 17,
          config_revision: 23,
          hash: "sha256:effective",
          policy_source: "sandbox",
          sandbox: "e2e-mcp-dcode",
          status: "effective",
          version: 17,
        }),
      ),
    ).toEqual({
      activeVersion: 17,
      configRevision: "23",
      hash: "sha256:effective",
      policySource: "sandbox",
      sandbox: "e2e-mcp-dcode",
      status: "effective",
      version: 17,
    });
    expect(
      parseExactMainPolicyStatus(
        JSON.stringify({
          active_version: 17,
          hash: "sha256:effective",
          sandbox: "e2e-mcp-dcode",
          status: "loaded",
          version: 17,
        }),
      ),
    ).toMatchObject({ activeVersion: 17, status: "loaded", version: 17 });
  });

  it("preserves OpenShell unsigned 64-bit config revisions as exact decimal strings", () => {
    const status = parseExactMainPolicyStatus(
      '{"active_version":2,"config_revision":7692118364955054884,"hash":"sha256:effective","policy_source":"sandbox","sandbox":"e2e-mcp-dcode","status":"effective","version":2}',
    );

    expect(status.configRevision).toBe("7692118364955054884");
  });

  it("requires the native workload network and capability boundary", () => {
    expect(
      inspectExactMainIsolation(JSON.stringify([completeIsolation()]), "a".repeat(64)),
    ).toEqual({
      containerId: "a".repeat(64),
      networkMode: "none",
      capDrop: ["ALL"],
      privileged: false,
    });
  });

  it.each([
    { NetworkMode: "host" },
    { CapDrop: [] },
    { CapAdd: ["NET_ADMIN"] },
    { Privileged: true },
  ])("rejects a weakened native isolation boundary [%j]", (changed) => {
    const value = completeIsolation();
    value.HostConfig = { ...(value.HostConfig as object), ...changed };
    expect(() => inspectExactMainIsolation(JSON.stringify([value]), "a".repeat(64))).toThrow(
      "native network/capability isolation",
    );
  });

  it.each([
    [],
    [completeIsolation(), completeIsolation()],
    [{ ...completeIsolation(), Id: "b".repeat(64) }],
  ])("rejects missing, ambiguous or replaced workload identity [%j]", (...value) => {
    expect(() => inspectExactMainIsolation(JSON.stringify(value), "a".repeat(64))).toThrow();
  });

  it.each([
    { name: "broker EACCES", error: "EACCES", status: 0 },
    { name: "unreachable listener", error: "ECONNREFUSED", status: 1 },
    { name: "generic permission failure", error: "EPERM", status: 1 },
    { name: "network timeout", error: "ETIMEDOUT", status: 1 },
  ])("executes the denial probe and rejects unrelated failures [$name]", ({ error, status }) => {
    const shim = `import socket, errno, sys
class DeniedSocket:
    def settimeout(self, value): pass
    def connect(self, address): raise OSError(errno.${error}, "controlled failure")
    def close(self): pass
def denied(*args, **kwargs): raise OSError(errno.${error}, "controlled failure")
socket.create_connection = denied
socket.socket = lambda *args, **kwargs: DeniedSocket()
sys.argv = ["probe", "host.openshell.internal", "12345"]
`;
    const result = spawnSync("python3", ["-c", shim + DIRECT_BYPASS_PROBE_CODE], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(status);
    expect(JSON.parse(result.stdout)).toMatchObject({
      tcp: { connected: false },
      udp: { echoed: false },
    });
  });

  it("keeps the old live inode and new altered-path denial in one process-level probe", () => {
    const script = buildExactMainLiveExeIdentityScript("https://mcp.example.test/mcp");
    const syntax = spawnSync("bash", ["-n"], { encoding: "utf8", input: script });
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(script).toContain('sha256sum "/proc/$old_pid/exe"');
    expect(script).toContain("NEMOCLAW_EXACT_MAIN_REPLACEMENT");
    expect(script).toContain("NEMOCLAW_LIVE_EXE_OLD_FIRST=%s");
    expect(script).toContain("NEMOCLAW_LIVE_EXE_OLD_SECOND=%s");
    expect(script).toContain("NEMOCLAW_LIVE_EXE_NEW=%s");
    expect(script).toContain("for _ in range(50):");
    expect(script).toContain('if status == "allowed":');
    expect(script).toContain("publish(sys.argv[3])");
    expect(script).toContain("publish(sys.argv[4])");
    expect(script).toContain("expected initial live-exe broker connection allowed");
    expect(script).toContain("expected replacement live-exe broker EACCES");
  });
});
