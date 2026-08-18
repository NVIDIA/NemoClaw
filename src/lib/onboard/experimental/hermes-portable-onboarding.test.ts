// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock-acquisition";
import { hermesPortableContainerInternals } from "./hermes-portable-container";
import {
  captureHermesPortablePolicySource,
  createHermesPortableTransactionId,
  publishHermesPortableDurablePolicySource,
} from "./hermes-portable-receipt";
import { hermesPortableCreatePolicySemanticDigest } from "./hermes-portable-policy-authority";
import {
  classifyHermesPortableRegistry,
  observeHermesPortableSandbox,
  rewriteHermesPortableCreatePolicyArgv,
  runHermesPortableOnboardingTransaction,
  type HermesPortableOnboardingDeps,
} from "./hermes-portable-onboarding";

const ID = "a".repeat(64);
const IMAGE = "b".repeat(64);
const SANDBOX_ID = "sandbox-id-1";
const LIVE_IDENTITY_FINGERPRINT = "live-identity-1";
const POLICY = "version: 1\nnetwork_policies: {}\n";
const LABELS = {
  "openshell.managed": "true",
  "openshell.ai/sandbox-id": SANDBOX_ID,
  "openshell.ai/sandbox-name": "alpha",
  "openshell.ai/sandbox-namespace": "",
  "openshell.ai/sandbox-workspace": "default",
};

let stateDir: string;
let policyPath: string;

function result(stdout: string, status = 0) {
  return { status, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

function inspect(restartPolicy: string) {
  return {
    status: 0,
    stdout: JSON.stringify([
      {
        Id: ID,
        Image: IMAGE,
        Name: `openshell-default--alpha-${SANDBOX_ID}`,
        Config: { Labels: LABELS },
        State: { Running: true, Paused: false, Status: "running" },
        HostConfig: { RestartPolicy: { Name: restartPolicy } },
      },
    ]),
    stderr: "",
  };
}

function startupArgv() {
  return [
    "env",
    "NEMOCLAW_SANDBOX_NAME=alpha",
    "NEMOCLAW_HERMES_API_PORT=8642",
    "/usr/local/bin/nemoclaw-start",
  ];
}

function directoryChain(directory: string): string[] {
  const parent = path.dirname(directory);
  return parent === directory ? [directory] : [directory, ...directoryChain(parent)];
}

function unexpectedPodmanArgs(args: readonly string[]): never {
  throw new Error(`unexpected podman args: ${args.join(" ")}`);
}

function removePolicySource(): true {
  fs.unlinkSync(policyPath);
  return true;
}

function input() {
  const uid = process.getuid!();
  return {
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
    stateDir,
    createPolicyPath: policyPath,
    createArgv: ["openshell", "sandbox", "create", "--policy", policyPath, "alpha"],
    runtimeAuthority: {
      schemaVersion: 1 as const,
      kind: "podman" as const,
      ownership: "current-user" as const,
      uid,
      homeDir: "/home/test",
      configHome: "/home/test/.config",
      runtimeDir: `/run/user/${String(uid)}`,
      socketPath: `/run/user/${String(uid)}/podman/podman.sock`,
    },
    startup: {
      agent: loadAgent("hermes"),
      sandboxName: "alpha",
      startupArgv: startupArgv(),
    },
  };
}

function deps(
  options: {
    existingSandbox?: boolean;
    updateFails?: boolean;
    failAfterRegistry?: boolean;
    cleanupFails?: boolean;
    afterRegistryCommit?: () => void | Promise<void>;
    observeSandbox?: HermesPortableOnboardingDeps<{ ready: true }>["observeSandbox"];
  } = {},
) {
  let present = options.existingSandbox === true;
  let restartPolicy = "no";
  let registry = false;
  const registryFailures = options.failAfterRegistry
    ? [new Error("simulated registry-to-active exit")]
    : [];
  const events: string[] = [];
  const podman = vi.fn((args: readonly string[]) => {
    const operation = args[0] === "ps" ? "ps" : args.slice(0, 2).join(" ");
    const handlers = new Map<
      string,
      () => { status: number | null; stdout: string; stderr: string }
    >([
      ["ps", () => ({ status: 0, stdout: `${ID}\n`, stderr: "" })],
      ["container inspect", () => inspect(restartPolicy)],
      ["container exec", () => ({ status: 0, stdout: "200\n", stderr: "" })],
      [
        "container update",
        () => {
          restartPolicy = options.updateFails ? restartPolicy : "unless-stopped";
          return options.updateFails
            ? { status: null, stdout: "", stderr: "timed out" }
            : { status: 0, stdout: "", stderr: "" };
        },
      ],
    ]);
    return handlers.get(operation)?.() ?? unexpectedPodmanArgs(args);
  });
  const value: HermesPortableOnboardingDeps<{ ready: true }> = {
    withLifecycleLock: async (_sandboxName, operation) => {
      events.push("lock-enter");
      try {
        return await withMcpLifecycleLock("alpha", operation, {
          stateDir: path.join(stateDir, "state"),
        });
      } finally {
        events.push("lock-exit");
      }
    },
    captureSocketAuthority: (socketPath) => {
      const directories = directoryChain(path.dirname(socketPath));
      return {
        device: "1",
        inode: "2",
        mode: "49536",
        ownerUid: String(process.getuid!()),
        socketPath,
        directoryChain: directories.map((directory, index) => ({
          device: "1",
          inode: String(index + 3),
          mode: String(index === 0 ? 0o40700 : 0o40755),
          ownerUid: String(index === 0 ? process.getuid!() : 0),
          path: directory,
        })),
      };
    },
    container: { podman, assertSocketAuthority: vi.fn() },
    capturePolicy: (args) => {
      events.push(args.includes("--base") ? "policy-base" : "policy-full");
      return result(POLICY);
    },
    observeSandbox:
      options.observeSandbox ??
      (() =>
        present
          ? {
              kind: "present",
              sandboxId: SANDBOX_ID,
              liveIdentityFingerprint: LIVE_IDENTITY_FINGERPRINT,
            }
          : { kind: "absent" }),
    createSandbox: async (argv) => {
      events.push("create");
      const policyIndex = argv.indexOf("--policy");
      expect(argv[policyIndex + 1]).toContain("policy.");
      present = true;
      return { ready: true };
    },
    registryDisposition: () =>
      registry
        ? {
            kind: "matching",
            entry: {
              lifecycleLiveIdentityFingerprint: LIVE_IDENTITY_FINGERPRINT,
            } as never,
          }
        : { kind: "missing" },
    registerSandbox: () => {
      events.push("registry");
      registry = true;
    },
    afterRegistryCommit: async () => {
      const failure = registryFailures.shift();
      await (failure ? Promise.reject(failure) : options.afterRegistryCommit?.());
    },
    cleanupTemporaryPolicy: () => {
      events.push("temp-cleanup");
      return options.cleanupFails ? false : removePolicySource();
    },
  };
  return { value, events, podman };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-onboard-"));
  policyPath = path.join(stateDir, "create.yaml");
  fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
});

afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe("Hermes portable onboarding transaction", () => {
  it("holds one lock through reserve, create, configuring, registry, and active publication (#9203)", async () => {
    const fixture = deps();

    const completed = await runHermesPortableOnboardingTransaction(input(), fixture.value);

    expect(completed.active.receipt.phase).toBe("active");
    expect(completed.created).toBe(true);
    expect(fixture.events[0]).toBe("lock-enter");
    expect(fixture.events.at(-1)).toBe("lock-exit");
    expect(fixture.events.indexOf("create")).toBeLessThan(fixture.events.indexOf("registry"));
    expect(fixture.events.indexOf("registry")).toBeLessThan(
      fixture.events.lastIndexOf("policy-base"),
    );
  });

  it("resumes identical pending authority with effects without a duplicate create (#9203)", async () => {
    const first = deps({ existingSandbox: true, updateFails: true });
    await expect(runHermesPortableOnboardingTransaction(input(), first.value)).rejects.toThrow(
      "restart-policy update failed",
    );
    fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
    const second = deps({ existingSandbox: true });

    const resumed = await runHermesPortableOnboardingTransaction(input(), second.value);

    expect(resumed.active.receipt.phase).toBe("active");
    expect(resumed.created).toBe(false);
    expect(second.events).not.toContain("create");
    expect(second.events).toContain("temp-cleanup");
    expect(fs.existsSync(policyPath)).toBe(false);
  });

  it("preserves configuring after an ambiguous update and completes registry on retry (#9203)", async () => {
    const first = deps({ updateFails: true });
    await expect(runHermesPortableOnboardingTransaction(input(), first.value)).rejects.toThrow();
    fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
    const second = deps({ existingSandbox: true });

    const resumed = await runHermesPortableOnboardingTransaction(input(), second.value);

    expect(resumed.active.receipt.phase).toBe("active");
    expect(second.events).toContain("registry");
  });

  it("resumes an exact durable-policy publication that crashed before pending (#9203)", async () => {
    const transactionId = createHermesPortableTransactionId();
    const currentInput = input();
    await withMcpLifecycleLock(
      "alpha",
      async () => {
        expect(() =>
          publishHermesPortableDurablePolicySource({
            sandboxName: "alpha",
            transactionId,
            stateDir,
            intendedSemanticSha256: hermesPortableCreatePolicySemanticDigest(Buffer.from(POLICY)),
            source: captureHermesPortablePolicySource(policyPath),
            hooks: {
              afterCanonicalLink: () => {
                throw new Error("simulated pre-pending exit");
              },
            },
          }),
        ).toThrow("simulated pre-pending exit");
      },
      { stateDir: path.join(stateDir, "state") },
    );
    const fixture = deps();

    const resumed = await runHermesPortableOnboardingTransaction(currentInput, fixture.value);

    expect(resumed.active.receipt.transactionId).toBe(transactionId);
    expect(resumed.active.receipt.phase).toBe("active");
  });

  it("rejects active authority when the live restart policy drifts (#9203)", async () => {
    const fixture = deps();
    await runHermesPortableOnboardingTransaction(input(), fixture.value);
    fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
    fixture.podman.mockImplementation((args: readonly string[]) =>
      args[0] === "container" && args[1] === "inspect" ? inspect("no") : unexpectedPodmanArgs(args),
    );

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "committed restart policy",
    );
  });

  it("resumes configuring after registry commit but before active publication (#9203)", async () => {
    const fixture = deps({ failAfterRegistry: true });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "registry-to-active exit",
    );
    fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
    const resumed = await runHermesPortableOnboardingTransaction(input(), fixture.value);

    expect(resumed.active.receipt.phase).toBe("active");
    expect(fixture.events.filter((event) => event === "create")).toHaveLength(1);
    expect(fixture.events.filter((event) => event === "registry")).toHaveLength(1);
  });

  it("keeps a contender outside the lock through registry and active publication (#9203)", async () => {
    let releaseContender!: () => void;
    const startContender = new Promise<void>((resolve) => {
      releaseContender = resolve;
    });
    let contenderEntered = false;
    const contender = startContender.then(async () => {
      await withMcpLifecycleLock(
        "alpha",
        async () => {
          contenderEntered = true;
        },
        { stateDir: path.join(stateDir, "state") },
      );
    });
    const fixture = deps({
      afterRegistryCommit: async () => {
        releaseContender();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(contenderEntered).toBe(false);
      },
    });

    await runHermesPortableOnboardingTransaction(input(), fixture.value);
    await contender;

    expect(contenderEntered).toBe(true);
  });

  it("preserves pending custody when temporary policy cleanup cannot complete (#9203)", async () => {
    const fixture = deps({ cleanupFails: true });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "temporary policy cleanup did not complete",
    );
    expect(fs.existsSync(policyPath)).toBe(true);
    expect(fixture.events).not.toContain("create");
  });

  it("rejects ambiguous create effects and conflicting registry authority (#9203)", async () => {
    const ambiguous = deps({
      observeSandbox: () => ({ kind: "ambiguous", detail: "gateway unavailable" }),
    });
    await expect(runHermesPortableOnboardingTransaction(input(), ambiguous.value)).rejects.toThrow(
      "gateway unavailable",
    );
    expect(ambiguous.events).not.toContain("create");
  });

  it.each([
    ["duplicate pair", ["--policy", policyPath, "--policy", policyPath]],
    ["equals form", [`--policy=${policyPath}`]],
    ["wrong path", ["--policy", "/tmp/other.yaml"]],
  ])("rejects %s before policy argv rewriting (#9203)", (_label, argv) => {
    expect(() =>
      rewriteHermesPortableCreatePolicyArgv(argv, policyPath, "/durable.yaml"),
    ).toThrow();
  });

  it("classifies absence only after a reachable gateway returns exact sandbox-not-found evidence (#9203)", () => {
    const capture = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "[]", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "sandbox 'alpha' not found" });

    expect(observeHermesPortableSandbox("alpha", "nemoclaw", capture)).toEqual({
      kind: "absent",
    });
    expect(capture.mock.calls).toEqual([
      [["sandbox", "list", "-g", "nemoclaw"]],
      [["sandbox", "get", "-g", "nemoclaw", "alpha"]],
    ]);
  });

  it.each([
    ["gateway missing", { status: 1, stdout: "", stderr: "gateway not found" }, false],
    ["transport failure", { status: null, stdout: "", stderr: "transport unavailable" }, true],
    ["unnamed sandbox", { status: 1, stdout: "", stderr: "unknown sandbox" }, true],
    ["ambiguous absence", { status: 1, stdout: "", stderr: "no sandbox connection" }, true],
  ])(
    "keeps %s fail-closed instead of treating it as sandbox absence (#9203)",
    (_label, reply, reachable) => {
      const capture = vi.fn((args: readonly string[]) =>
        args[1] === "list" ? (reachable ? { status: 0, stdout: "[]", stderr: "" } : reply) : reply,
      );

      expect(observeHermesPortableSandbox("alpha", "nemoclaw", capture)).toMatchObject({
        kind: "ambiguous",
      });
    },
  );

  it("requires exact Hermes registry agent, gateway, generation, and driver agreement (#9203)", () => {
    const receipt = {
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "generation-1",
    } as never;
    const matching = {
      name: "alpha",
      agent: "hermes",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "generation-1",
      openshellDriver: "docker",
    };

    expect(classifyHermesPortableRegistry(receipt, null)).toEqual({ kind: "missing" });
    expect(classifyHermesPortableRegistry(receipt, matching)).toMatchObject({ kind: "matching" });
    expect(
      classifyHermesPortableRegistry(receipt, { ...matching, lifecycleGeneration: "other" }),
    ).toMatchObject({ kind: "conflict" });
    expect(
      classifyHermesPortableRegistry(receipt, { ...matching, agent: "openclaw" }),
    ).toMatchObject({ kind: "conflict" });
  });
});
