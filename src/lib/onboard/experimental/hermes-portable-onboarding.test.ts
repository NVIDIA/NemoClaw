// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PodmanSocketAuthority, PodmanSocketAuthorityDeps } from "../../adapters/podman";
import type { HermesPortableOpenShellExecutableAuthority } from "../../adapters/openshell/resolve-shared";
import type { HermesPortablePodmanExecutableAuthority } from "./hermes-portable-podman-authority";
import { loadAgent } from "../../agent/defs";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock-acquisition";
import type { SandboxEntry } from "../../state/registry";
import {
  isCurrentSandboxInferenceRouteReservation,
  normalizeSandboxInferenceRouteSelection,
} from "../../state/registry/route-reservation";
import {
  captureHermesPortablePolicySource,
  createHermesPortableTransactionId,
  hermesPortableReceiptDirectory,
  publishHermesPortableDurablePolicySource,
} from "./hermes-portable-receipt";
import { hermesPortableCreatePolicySemanticDigest } from "./hermes-portable-policy-authority";
import {
  classifyHermesPortableRegistry,
  createHermesPortableChildEnvironment,
  createHermesPortableReadyRunner,
  createHermesPortableOpenShellCapture,
  createHermesPortableReadyCapture,
  observeHermesPortableSandbox,
  rewriteHermesPortableCreatePolicyArgv,
  runHermesPortableOnboardingTransaction,
  scopeHermesPortableCreateGatewayArgv,
  shouldManageHermesPortableDashboard,
  type HermesPortableOnboardingDeps,
} from "./hermes-portable-onboarding";

const ID = "a".repeat(64);
const IMAGE = "b".repeat(64);
const SANDBOX_ID = "sandbox-id-1";
const LIVE_IDENTITY_FINGERPRINT = "live-identity-1";
const ROUTE_SESSION_ID = "session-alpha";
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
    "NEMOCLAW_HERMES_API_PORT=8642",
    "NEMOCLAW_SANDBOX_NAME=alpha",
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

function interruptReceiptWrite(
  marker: Buffer,
  message: string,
  writtenLength: (requestedLength: number) => number,
): void {
  const originalWrite = fs.writeSync;
  let interrupted = false;
  const writeSpy = vi.spyOn(fs, "writeSync") as unknown as {
    mockImplementation(
      implementation: (
        descriptor: number,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number | null,
      ) => number,
    ): void;
  };
  writeSpy.mockImplementation((descriptor, buffer, offset, length, position) => {
    interrupted &&
      (() => {
        throw new Error(message);
      })();
    const requested = Buffer.from(buffer).subarray(offset, offset + length);
    return position === 0 && requested.includes(marker)
      ? ((interrupted = true),
        originalWrite(descriptor, buffer, offset, writtenLength(length), position))
      : originalWrite(descriptor, buffer, offset, length, position);
  });
}

function interruptCanonicalReceiptLink(phase: "configuring" | "active"): void {
  const originalLink = fs.linkSync;
  let interrupted = false;
  vi.spyOn(fs, "linkSync").mockImplementation((source, target) => {
    originalLink(source, target);
    !interrupted &&
      String(target).endsWith(`${phase}.json`) &&
      (() => {
        interrupted = true;
        throw new Error(`simulated ${phase} canonical-link exit`);
      })();
  });
}

function openshellExecutableAuthority(): HermesPortableOpenShellExecutableAuthority {
  return {
    version: "0.0.101",
    executable: {
      executablePath: "/usr/bin/openshell",
      device: "1",
      inode: "10",
      mode: String(0o100755),
      ownerUid: "0",
      size: "1024",
      modifiedTimeNanoseconds: "11",
      changedTimeNanoseconds: "12",
      sha256: "f".repeat(64),
      directoryChain: ["/usr/bin", "/usr", "/"].map((directory, index) => ({
        device: "1",
        inode: String(index + 20),
        mode: String(0o40755),
        ownerUid: "0",
        path: directory,
      })),
    },
  };
}

function podmanExecutableAuthority(): HermesPortablePodmanExecutableAuthority {
  return {
    version: "5.7.0",
    executable: {
      executablePath: "/usr/bin/podman",
      device: "1",
      inode: "30",
      mode: String(0o100755),
      ownerUid: "0",
      size: "2048",
      modifiedTimeNanoseconds: "31",
      changedTimeNanoseconds: "32",
      sha256: "9".repeat(64),
      directoryChain: ["/usr/bin", "/usr", "/"].map((directory, index) => ({
        device: "1",
        inode: String(index + 40),
        mode: String(0o40755),
        ownerUid: "0",
        path: directory,
      })),
    },
  };
}

function routeSelection() {
  return {
    provider: "ollama-local",
    model: "qwen3-vl:4b",
    endpointUrl: null,
    endpointSource: null,
    credentialEnv: null,
    preferredInferenceApi: null,
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
  } as const;
}

function matchingRegistryEntry(
  options: { openshellVersion?: string | null; liveFingerprint?: string } = {},
): SandboxEntry {
  return {
    name: "alpha",
    agent: "hermes",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
    openshellDriver: "docker",
    lifecycleLiveIdentityFingerprint: options.liveFingerprint ?? LIVE_IDENTITY_FINGERPRINT,
    openshellVersion: "openshellVersion" in options ? options.openshellVersion : "0.0.101",
  };
}

function input() {
  const uid = process.getuid!();
  const sourceDockerfilePath = `ghcr.io/nvidia/nemoclaw/hermes@sha256:${"a".repeat(64)}`;
  return {
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
    stateDir,
    createPolicyPath: policyPath,
    createArgv: [
      "/usr/bin/openshell",
      "sandbox",
      "create",
      "-g",
      "nemoclaw",
      "--from",
      sourceDockerfilePath,
      "--name",
      "alpha",
      "--policy",
      policyPath,
      "--",
      ...startupArgv(),
    ],
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
    openshellExecutableAuthority: openshellExecutableAuthority(),
    buildContext: {
      authority: {
        schemaVersion: 1 as const,
        sourceRevision: "1".repeat(40),
        dockerfileRelativePath: "agents/hermes/Dockerfile" as const,
        sourceManifestSha256: "2".repeat(64),
        contextManifestSha256: "3".repeat(64),
      },
      sourceDockerfilePath,
      assertCurrentSource: vi.fn(),
      materialize: vi.fn(() => ({
        buildContextPath: "/private/staged-hermes",
        dockerfilePath: "/private/staged-hermes/agents/hermes/Dockerfile",
        assertCurrent: vi.fn(),
      })),
      retire: vi.fn(() => true),
    },
    startup: {
      agent: loadAgent("hermes"),
      sandboxName: "alpha",
      startupArgv: startupArgv(),
    },
    inferenceRouteReservation: {
      sessionId: ROUTE_SESSION_ID,
      selection: routeSelection(),
    },
  };
}

function reservationForOnboarding(current: ReturnType<typeof input> = input()): SandboxEntry {
  return {
    name: current.sandboxName,
    pendingRouteReservation: true,
    reservationSessionId: current.inferenceRouteReservation.sessionId,
    ...normalizeSandboxInferenceRouteSelection(current.inferenceRouteReservation.selection),
    gatewayName: current.gatewayName,
    hostLocalInferenceReceipt: "receipt-1",
  };
}

function deps(
  options: {
    existingSandbox?: boolean;
    updateFails?: boolean;
    failAfterRegistry?: boolean;
    cleanupFails?: boolean;
    assertSocketAuthority?: (
      expected: PodmanSocketAuthority,
      deps?: PodmanSocketAuthorityDeps,
    ) => void;
    assertOpenShellExecutableAuthority?: () => void;
    afterRegistryCommit?: () => void | Promise<void>;
    observeSandbox?: HermesPortableOnboardingDeps<{ ready: true }>["observeSandbox"];
    registryOpenShellVersion?: string | null;
    registryLiveFingerprint?: string;
    existingRegistry?: boolean;
    registryEntry?: SandboxEntry | null;
    replaceRegistryBeforeRegistration?: SandboxEntry | null;
    podmanAuthority?: HermesPortablePodmanExecutableAuthority;
  } = {},
) {
  let present = options.existingSandbox === true;
  let restartPolicy = "no";
  let registryEntry =
    "registryEntry" in options
      ? (options.registryEntry ?? null)
      : options.existingRegistry === true
        ? matchingRegistryEntry({
            ...("registryOpenShellVersion" in options
              ? { openshellVersion: options.registryOpenShellVersion }
              : {}),
            liveFingerprint: options.registryLiveFingerprint,
          })
        : reservationForOnboarding();
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
    capturePodmanExecutableAuthority: () => options.podmanAuthority ?? podmanExecutableAuthority(),
    container: {
      podman,
      assertSocketAuthority: options.assertSocketAuthority ?? vi.fn(),
    },
    assertOpenShellExecutableAuthority: options.assertOpenShellExecutableAuthority ?? vi.fn(),
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
    createSandbox: async (argv, buildContextPath) => {
      events.push("create");
      const policyIndex = argv.indexOf("--policy");
      expect(argv[policyIndex + 1]).toContain("policy.");
      expect(argv[argv.indexOf("--from") + 1]).toBe(
        "/private/staged-hermes/agents/hermes/Dockerfile",
      );
      expect(buildContextPath).toBe("/private/staged-hermes");
      present = true;
      return { ready: true };
    },
    readRegistry: () => registryEntry,
    registerSandbox: (
      _result,
      _receipt,
      _liveIdentityFingerprint,
      revalidate,
      routeReservation,
    ) => {
      registryEntry =
        "replaceRegistryBeforeRegistration" in options
          ? (options.replaceRegistryBeforeRegistration ?? null)
          : registryEntry;
      isCurrentSandboxInferenceRouteReservation(routeReservation, registryEntry) ||
        (() => {
          throw new Error(
            "Cannot register a sandbox after its inference route reservation changed",
          );
        })();
      revalidate();
      events.push("registry");
      registryEntry = matchingRegistryEntry();
      return registryEntry;
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
  it("uses only the receipt-owned child environment and exact gateway observations (#9203)", () => {
    const runtimeAuthority = input().runtimeAuthority;
    const sourceEnv = {
      HOME: "/home/test",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/home/test/.config",
      XDG_RUNTIME_DIR: runtimeAuthority.runtimeDir,
      XDG_CACHE_HOME: "/tmp/ambient-cache",
      SSL_CERT_FILE: "/etc/ssl/certs.pem",
      OPENSHELL_GATEWAY: "ambient",
      DOCKER_HOST: "unix:///run/docker.sock",
      KUBECONFIG: "/home/test/.kube/config",
      SSH_AUTH_SOCK: "/run/user/1000/agent.sock",
      HTTPS_PROXY: "https://user:secret@proxy.example",
    } satisfies NodeJS.ProcessEnv;
    const spawn = vi.fn(() => ({
      status: 0,
      signal: null,
      output: [],
      pid: 1,
      stdout: Buffer.from("Name: alpha\nID: sandbox-id-1\nPhase: Ready\n"),
      stderr: Buffer.alloc(0),
      error: undefined,
    }));
    const capture = createHermesPortableOpenShellCapture(
      (args) => ["/usr/bin/openshell", ...args],
      sourceEnv,
      runtimeAuthority,
      undefined,
      spawn as never,
    );
    const ready = createHermesPortableReadyCapture("alpha", "nemoclaw", capture);

    expect(ready(["sandbox", "list"])).toContain("Phase: Ready");
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      ["sandbox", "list", "-g", "nemoclaw"],
      expect.objectContaining({
        env: {
          HOME: "/home/test",
          PATH: "/usr/bin",
          XDG_CONFIG_HOME: "/home/test/.config",
          XDG_RUNTIME_DIR: runtimeAuthority.runtimeDir,
          SSL_CERT_FILE: "/etc/ssl/certs.pem",
        },
      }),
    );
    expect(createHermesPortableChildEnvironment(sourceEnv, runtimeAuthority)).not.toHaveProperty(
      "OPENSHELL_GATEWAY",
    );
    expect(createHermesPortableChildEnvironment(sourceEnv, runtimeAuthority)).not.toHaveProperty(
      "XDG_CACHE_HOME",
    );
    expect(() =>
      createHermesPortableChildEnvironment({ ...sourceEnv, HOME: "/home/other" }, runtimeAuthority),
    ).toThrow("HOME disagrees with runtime authority");
  });

  it("rejects ambient endpoint selectors before an OpenShell child starts (#9203)", () => {
    const spawn = vi.fn();
    const capture = createHermesPortableOpenShellCapture(
      (args) => ["/usr/bin/openshell", ...args],
      { HOME: "/home/test", OPENSHELL_GATEWAY_ENDPOINT: "https://ambient.invalid" },
      input().runtimeAuthority,
      undefined,
      spawn as never,
    );

    expect(() => capture(["sandbox", "list", "-g", "nemoclaw"])).toThrow(
      "OPENSHELL_GATEWAY_ENDPOINT is set",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("adds exactly one create gateway and rejects existing gateway selection (#9203)", () => {
    const current = input();
    const unscoped = current.createArgv.filter((value) => !["-g", "nemoclaw"].includes(value));
    expect(scopeHermesPortableCreateGatewayArgv(unscoped, "nemoclaw")).toEqual(current.createArgv);
    expect(() => scopeHermesPortableCreateGatewayArgv(current.createArgv, "nemoclaw")).toThrow(
      "already contains gateway selection authority",
    );
  });

  it("does not enroll dashboard/TUI forward authority for schema-5 Hermes (#9203)", () => {
    expect(
      shouldManageHermesPortableDashboard(true, loadAgent("hermes"), {
        NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
      }),
    ).toBe(false);
    expect(
      shouldManageHermesPortableDashboard(true, loadAgent("hermes"), {
        NEMOCLAW_EXPERIMENTAL_PROFILE: "default",
      }),
    ).toBe(true);
    expect(
      shouldManageHermesPortableDashboard(true, loadAgent("openclaw"), {
        NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
      }),
    ).toBe(true);
  });

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

  it("rejects a pre-existing live sandbox before durable reservation (#9203)", async () => {
    const fixture = deps({ existingSandbox: true });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "live sandbox authority already exists before reservation",
    );
    expect(fs.existsSync(hermesPortableReceiptDirectory("alpha", stateDir))).toBe(false);
    expect(fixture.events).not.toContain("create");
    expect(fixture.podman).not.toHaveBeenCalled();
  });

  it("rejects a pre-existing registry row before durable reservation (#9203)", async () => {
    const fixture = deps({ existingRegistry: true });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "inference route reservation is not owned by the current onboarding session",
    );
    expect(fs.existsSync(hermesPortableReceiptDirectory("alpha", stateDir))).toBe(false);
    expect(fixture.events).not.toContain("create");
    expect(fixture.podman).not.toHaveBeenCalled();
  });

  it("admits the current session's exact inference route reservation before registration (#9203)", async () => {
    const fixture = deps();

    const completed = await runHermesPortableOnboardingTransaction(input(), fixture.value);

    expect(completed.active.receipt.phase).toBe("active");
    expect(completed.created).toBe(true);
    expect(fixture.events).toContain("registry");
  });

  it("aborts active publication after registry-side route replacement (#9203)", async () => {
    const replacement = {
      ...reservationForOnboarding(),
      reservationSessionId: "session-beta",
      model: "qwen3:8b",
    };
    const fixture = deps({ replaceRegistryBeforeRegistration: replacement });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "Cannot register a sandbox after its inference route reservation changed",
    );
    expect(fixture.events).not.toContain("registry");
    expect(
      fs.existsSync(path.join(hermesPortableReceiptDirectory("alpha", stateDir), "active.json")),
    ).toBe(false);
  });

  it("resumes identical pending authority with effects without a duplicate create (#9203)", async () => {
    const first = deps({ updateFails: true });
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

  it("rejects changed non-policy create intent on pending reentry before effects (#9203)", async () => {
    const first = deps({ cleanupFails: true });
    await expect(runHermesPortableOnboardingTransaction(input(), first.value)).rejects.toThrow(
      "temporary policy cleanup did not complete",
    );
    const pendingBytes = fs.readFileSync(
      path.join(hermesPortableReceiptDirectory("alpha", stateDir), "pending.json"),
      "utf8",
    );
    expect(JSON.parse(pendingBytes).createIntentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(pendingBytes).not.toContain("ghcr.io/nvidia/nemoclaw/hermes");
    const changed = input();
    changed.createArgv.splice(changed.createArgv.indexOf("--"), 0, "--gpu");
    const second = deps();

    await expect(runHermesPortableOnboardingTransaction(changed, second.value)).rejects.toThrow(
      "saved transaction disagrees",
    );
    expect(second.events).not.toContain("create");
  });

  it("rejects a new onboarding session taking over an existing pending receipt (#9203)", async () => {
    const first = deps({ cleanupFails: true });
    await expect(runHermesPortableOnboardingTransaction(input(), first.value)).rejects.toThrow(
      "temporary policy cleanup did not complete",
    );
    const changed = input();
    changed.inferenceRouteReservation = {
      ...changed.inferenceRouteReservation,
      sessionId: "session-beta",
    };
    const second = deps({
      registryEntry: reservationForOnboarding(changed),
    });

    await expect(runHermesPortableOnboardingTransaction(changed, second.value)).rejects.toThrow(
      "saved transaction disagrees",
    );
    expect(second.events).not.toContain("create");
  });

  it("binds the staged build-context manifest into pending create intent (#9203)", async () => {
    const localInput = input();
    const first = deps({ cleanupFails: true });
    await expect(runHermesPortableOnboardingTransaction(localInput, first.value)).rejects.toThrow(
      "temporary policy cleanup did not complete",
    );
    fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
    const changed = input();
    changed.buildContext.authority = {
      ...changed.buildContext.authority,
      contextManifestSha256: "4".repeat(64),
    };
    const second = deps();

    await expect(runHermesPortableOnboardingTransaction(changed, second.value)).rejects.toThrow(
      "saved transaction disagrees",
    );
    expect(second.events).not.toContain("create");
  });

  it("rejects a changed OpenShell executable identity on pending reentry (#9203)", async () => {
    const first = deps({ cleanupFails: true });
    await expect(runHermesPortableOnboardingTransaction(input(), first.value)).rejects.toThrow(
      "temporary policy cleanup did not complete",
    );
    const changed = input();
    changed.createArgv[0] = "/other/openshell";
    const second = deps();

    await expect(runHermesPortableOnboardingTransaction(changed, second.value)).rejects.toThrow(
      "saved transaction disagrees",
    );
    expect(second.events).not.toContain("create");
  });

  it("rejects changed Podman executable authority on pending reentry before effects (#9203)", async () => {
    const first = deps({ cleanupFails: true });
    await expect(runHermesPortableOnboardingTransaction(input(), first.value)).rejects.toThrow(
      "temporary policy cleanup did not complete",
    );
    const changedAuthority = podmanExecutableAuthority();
    const second = deps({
      podmanAuthority: {
        ...changedAuthority,
        executable: { ...changedAuthority.executable, inode: "31" },
      },
    });

    await expect(runHermesPortableOnboardingTransaction(input(), second.value)).rejects.toThrow(
      "saved transaction disagrees",
    );
    expect(second.events).not.toContain("create");
    expect(second.podman).not.toHaveBeenCalled();
  });

  it("rejects executable generation drift before OpenShell, create, or Podman effects (#9203)", async () => {
    const fixture = deps({
      assertOpenShellExecutableAuthority: () => {
        throw new Error("simulated OpenShell executable generation drift");
      },
    });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "simulated OpenShell executable generation drift",
    );
    expect(fixture.events).not.toContain("create");
    expect(fixture.events).not.toContain("policy-base");
    expect(fixture.podman).not.toHaveBeenCalled();
  });

  it("keeps configuring authority when registry OpenShell version disagrees (#9203)", async () => {
    const first = deps({ failAfterRegistry: true });
    await expect(runHermesPortableOnboardingTransaction(input(), first.value)).rejects.toThrow(
      "registry-to-active exit",
    );
    fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
    const fixture = deps({
      existingSandbox: true,
      existingRegistry: true,
      registryOpenShellVersion: "0.0.102",
    });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "registry conflicts with configuring authority",
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(hermesPortableReceiptDirectory("alpha", stateDir), "configuring.json"),
          "utf8",
        ),
      ).phase,
    ).toBe("configuring");
    expect(
      fs.existsSync(path.join(hermesPortableReceiptDirectory("alpha", stateDir), "active.json")),
    ).toBe(false);
    expect(
      fixture.podman.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "container" && args[1] === "update",
      ),
    ).toBe(false);
  });

  it("does not update Podman when a matching registry row has stale live identity (#9203)", async () => {
    const first = deps({ failAfterRegistry: true });
    await expect(runHermesPortableOnboardingTransaction(input(), first.value)).rejects.toThrow(
      "registry-to-active exit",
    );
    fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
    const resumed = deps({
      existingSandbox: true,
      existingRegistry: true,
      registryLiveFingerprint: "0".repeat(64),
    });

    await expect(runHermesPortableOnboardingTransaction(input(), resumed.value)).rejects.toThrow(
      "registry live identity disagrees",
    );
    expect(
      resumed.podman.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "container" && args[1] === "update",
      ),
    ).toBe(false);
  });

  it("rejects receipt-gateway drift on pending reentry before create (#9203)", async () => {
    const first = deps({ cleanupFails: true });
    await expect(runHermesPortableOnboardingTransaction(input(), first.value)).rejects.toThrow(
      "temporary policy cleanup did not complete",
    );
    const changed = input();
    changed.gatewayName = "other-gateway";
    changed.createArgv[changed.createArgv.indexOf("-g") + 1] = "other-gateway";
    const second = deps({ registryEntry: reservationForOnboarding(changed) });

    await expect(runHermesPortableOnboardingTransaction(changed, second.value)).rejects.toThrow(
      "saved transaction disagrees",
    );
    expect(second.events).not.toContain("create");
  });

  it("rejects credential-bearing create env before durable reservation (#9203)", async () => {
    const current = input();
    current.createArgv.splice(current.createArgv.indexOf("--"), 0, "--env", "API_KEY=do-not-log");
    const fixture = deps();

    await expect(runHermesPortableOnboardingTransaction(current, fixture.value)).rejects.toThrow(
      "unsupported effect-bearing option",
    );
    expect(fs.existsSync(hermesPortableReceiptDirectory("alpha", stateDir))).toBe(false);
    expect(fixture.events).not.toContain("create");
  });

  it("resumes an exact interrupted pending receipt prefix after process-style reentry (#9203)", async () => {
    interruptReceiptWrite(
      Buffer.from('{"schemaVersion":5'),
      "simulated process exit during pending write",
      (length) => Math.floor(length / 2),
    );
    const first = deps();
    await expect(runHermesPortableOnboardingTransaction(input(), first.value)).rejects.toThrow(
      "simulated process exit during pending write",
    );
    vi.restoreAllMocks();

    const second = deps();
    const resumed = await runHermesPortableOnboardingTransaction(input(), second.value);

    expect(resumed.active.receipt.phase).toBe("active");
    expect(second.events.filter((event) => event === "create")).toHaveLength(1);
  });

  it.each(["configuring", "active"] as const)(
    "resumes an exact interrupted %s receipt prefix after process-style reentry (#9203)",
    async (phase) => {
      interruptReceiptWrite(
        Buffer.from(`\"phase\":\"${phase}\"`),
        `simulated process exit during ${phase} write`,
        () => 1,
      );
      const first = deps();
      await expect(runHermesPortableOnboardingTransaction(input(), first.value)).rejects.toThrow(
        `simulated process exit during ${phase} write`,
      );
      vi.restoreAllMocks();
      fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });

      const retry = phase === "active" ? first : deps({ existingSandbox: true });
      const resumed = await runHermesPortableOnboardingTransaction(input(), retry.value);

      expect(resumed.active.receipt.phase).toBe("active");
      expect(retry.events.filter((event) => event === "create")).toHaveLength(
        phase === "active" ? 1 : 0,
      );
    },
  );

  it.each(["configuring", "active"] as const)(
    "resumes %s after a canonical hard-link process exit (#9203)",
    async (phase) => {
      interruptCanonicalReceiptLink(phase);
      const first = deps();
      await expect(runHermesPortableOnboardingTransaction(input(), first.value)).rejects.toThrow(
        `simulated ${phase} canonical-link exit`,
      );
      vi.restoreAllMocks();
      fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });

      const retry = phase === "active" ? first : deps({ existingSandbox: true });
      const resumed = await runHermesPortableOnboardingTransaction(input(), retry.value);

      expect(resumed.active.receipt.phase).toBe("active");
      expect(retry.events.filter((event) => event === "create")).toHaveLength(
        phase === "active" ? 1 : 0,
      );
    },
  );

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

  it("revalidates the current-user Podman socket immediately before create (#9203)", async () => {
    const assertSocketAuthority = vi.fn(() => {
      throw new Error("socket generation changed");
    });
    const fixture = deps({ assertSocketAuthority });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "socket generation changed",
    );

    expect(assertSocketAuthority).toHaveBeenCalledOnce();
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
    [
      "duplicate pair",
      (sourcePath: string) => ["--policy", sourcePath, "--policy", sourcePath],
      /exactly one canonical policy option/,
    ],
    [
      "equals form",
      (sourcePath: string) => [`--policy=${sourcePath}`],
      /one canonical '--policy <path>' option/,
    ],
    ["wrong path", () => ["--policy", "/tmp/other.yaml"], /does not name the captured source/],
  ])("rejects %s before policy argv rewriting (#9203)", (_label, buildArgv, error) => {
    const argv = buildArgv(policyPath);
    expect(() => rewriteHermesPortableCreatePolicyArgv(argv, policyPath, "/durable.yaml")).toThrow(
      error,
    );
  });

  it("rejects a noncanonical policy option before durable policy or create effects (#9203)", async () => {
    const fixture = deps();
    const invalid = input();
    invalid.createArgv = [
      "openshell",
      "sandbox",
      "create",
      "--policy",
      policyPath,
      `--policy=${policyPath}`,
      "alpha",
    ];

    await expect(runHermesPortableOnboardingTransaction(invalid, fixture.value)).rejects.toThrow(
      "one canonical '--policy <path>' option",
    );
    expect(fs.existsSync(hermesPortableReceiptDirectory("alpha", stateDir))).toBe(false);
    expect(fixture.events).not.toContain("create");
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

  it("accepts Ready identity only from the exact receipt gateway (#9203)", () => {
    const capture = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "alpha Ready", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: "Name: alpha\nID: sandbox-id-1\nPhase: Ready\n",
        stderr: "",
      });

    expect(observeHermesPortableSandbox("alpha", "nemoclaw", capture)).toMatchObject({
      kind: "present",
      sandboxId: "sandbox-id-1",
    });
    expect(capture).toHaveBeenLastCalledWith(["sandbox", "get", "-g", "nemoclaw", "alpha"]);
  });

  it("routes generic Ready identity and exec checks through the exact gateway (#9203)", () => {
    const capture = vi.fn(() => ({
      status: 0,
      stdout: Buffer.from("ready"),
      stderr: Buffer.alloc(0),
    }));
    const run = createHermesPortableReadyRunner("alpha", "nemoclaw", capture);

    expect(run(["sandbox", "get", "alpha"]).status).toBe(0);
    expect(run(["sandbox", "exec", "--name", "alpha", "--", "true"]).status).toBe(0);
    expect(capture.mock.calls).toEqual([
      [["sandbox", "get", "-g", "nemoclaw", "alpha"]],
      [["sandbox", "exec", "-g", "nemoclaw", "--name", "alpha", "--", "true"]],
    ]);
    expect(() => run(["sandbox", "get", "beta"])).toThrow("unsupported OpenShell command");
    expect(() => run(["sandbox", "exec", "--name", "beta", "--", "true"])).toThrow(
      "unsupported OpenShell command",
    );
  });

  it("rejects exact-gateway identity that has not reached Ready (#9203)", () => {
    const capture = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "alpha Creating", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: "Name: alpha\nID: sandbox-id-1\nPhase: Creating\n",
        stderr: "",
      });

    expect(observeHermesPortableSandbox("alpha", "nemoclaw", capture)).toEqual({
      kind: "ambiguous",
      detail: "exact OpenShell sandbox is not Ready",
    });
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
      openshellExecutableAuthority: openshellExecutableAuthority(),
    } as never;
    const matching = {
      name: "alpha",
      agent: "hermes",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "generation-1",
      openshellDriver: "docker",
      openshellVersion: "0.0.101",
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
