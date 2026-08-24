// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import { assertHermesPortableUninstallCompleteForOnboarding } from "../../state/hermes-portable-uninstall/journal";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock-acquisition";
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
} from "./hermes-portable-onboarding";
import {
  createHermesPortableTestInput,
  createHermesPortableTransactionFixture,
  HERMES_PORTABLE_TEST_POLICY as POLICY,
  HERMES_PORTABLE_TEST_LIVE_IDENTITY,
  hermesPortableReservationForOnboarding,
  hermesPortableTestOpenShellAuthority as openshellExecutableAuthority,
  hermesPortableTestPodmanAuthority as podmanExecutableAuthority,
  createHermesPortableContainerInspectResult,
  unexpectedHermesPortablePodmanArgs as unexpectedPodmanArgs,
  type HermesPortableTransactionFixtureOptions,
} from "../../../../test/helpers/hermes-portable-onboarding-fixture";

let stateDir: string;
let policyPath: string;

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

function input() {
  return createHermesPortableTestInput(stateDir, policyPath);
}

function reservationForOnboarding(current: ReturnType<typeof input> = input()) {
  return hermesPortableReservationForOnboarding(current);
}

function deps(options: HermesPortableTransactionFixtureOptions = {}) {
  return createHermesPortableTransactionFixture(input(), options);
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-onboard-"));
  policyPath = path.join(stateDir, "create.yaml");
  fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
});

afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe("Hermes portable onboarding transaction", () => {
  it("allows first onboarding when no uninstall state directory exists (#9608)", () => {
    expect(() =>
      assertHermesPortableUninstallCompleteForOnboarding(path.join(stateDir, "absent")),
    ).not.toThrow();
  });

  it("uses only the receipt-owned child environment and exact gateway observations (#9203)", () => {
    const runtimeAuthority = {
      ...input().runtimeAuthority,
      uid: 1001,
      runtimeDir: "/run/user/1001",
      socketPath: "/run/user/1001/podman/podman.sock",
    };
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
          DOCKER_HOST: `unix://${runtimeAuthority.socketPath}`,
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
    expect(createHermesPortableChildEnvironment(sourceEnv, runtimeAuthority)).toMatchObject({
      DOCKER_HOST: "unix:///run/user/1001/podman/podman.sock",
    });
    expect(() =>
      createHermesPortableChildEnvironment({ ...sourceEnv, HOME: "/home/other" }, runtimeAuthority),
    ).toThrow("HOME disagrees with runtime authority");
  });

  it("caps an explicit OpenShell capture timeout at the caller budget (#9211)", () => {
    const spawn = vi.fn(() => ({
      status: 0,
      signal: null,
      output: [],
      pid: 1,
      stdout: Buffer.from("[]"),
      stderr: Buffer.alloc(0),
      error: undefined,
    }));
    const capture = createHermesPortableOpenShellCapture(
      (args) => ["/usr/bin/openshell", ...args],
      { HOME: "/home/test", PATH: "/usr/bin" },
      undefined,
      undefined,
      spawn as never,
    );

    capture(["sandbox", "list", "-g", "nemoclaw"], 1_234);

    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      ["sandbox", "list", "-g", "nemoclaw"],
      expect.objectContaining({ timeout: 1_234 }),
    );
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

  it("settles the exact post-create sandbox identity when Ready publication lags (#9211)", async () => {
    const present = {
      kind: "present" as const,
      sandboxId: "sandbox-id-1",
      liveIdentityFingerprint: HERMES_PORTABLE_TEST_LIVE_IDENTITY,
    };
    const observations = [
      { kind: "absent" as const },
      { kind: "absent" as const },
      { kind: "ambiguous" as const, detail: "exact OpenShell sandbox is not Ready" },
      { kind: "ambiguous" as const, detail: "exact OpenShell sandbox is not Ready" },
      present,
    ];
    const observeSandbox = vi.fn((_timeoutBudgetMs?: number) => observations.shift() ?? present);
    let nowMs = 0;
    const delaySandboxReadyPublicationPoll = vi.fn(async (milliseconds: number) => {
      nowMs += milliseconds;
    });
    const fixture = deps({
      observeSandbox,
      delaySandboxReadyPublicationPoll,
      readSandboxReadyPublicationClockMs: () => nowMs,
    });

    const completed = await runHermesPortableOnboardingTransaction(input(), fixture.value);

    expect(completed.active.receipt.phase).toBe("active");
    expect(completed.created).toBe(true);
    expect(fixture.events.filter((event) => event === "create")).toHaveLength(1);
    expect(delaySandboxReadyPublicationPoll).toHaveBeenCalledTimes(2);
    expect(delaySandboxReadyPublicationPoll).toHaveBeenCalledWith(1_000);
    expect(
      observeSandbox.mock.calls.filter(([timeoutBudgetMs]) => timeoutBudgetMs !== undefined),
    ).toEqual([[60_000], [59_000], [58_000]]);
    expect(fixture.events[0]).toBe("lock-enter");
    expect(fixture.events.at(-1)).toBe("lock-exit");
  });

  it("resumes a pending post-create receipt while Ready publication lags (#9203)", async () => {
    let firstNowMs = 0;
    let firstObservations = 0;
    const firstObserveSandbox = vi.fn(() =>
      firstObservations++ < 2
        ? { kind: "absent" as const }
        : { kind: "ambiguous" as const, detail: "exact OpenShell sandbox is not Ready" },
    );
    const first = deps({
      observeSandbox: firstObserveSandbox,
      delaySandboxReadyPublicationPoll: async (milliseconds) => {
        firstNowMs += milliseconds;
      },
      readSandboxReadyPublicationClockMs: () => firstNowMs,
    });

    await expect(runHermesPortableOnboardingTransaction(input(), first.value)).rejects.toThrow(
      "cannot classify create result: exact OpenShell sandbox is not Ready",
    );
    expect(first.events.filter((event) => event === "create")).toHaveLength(1);
    fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });

    const present = {
      kind: "present" as const,
      sandboxId: "sandbox-id-1",
      liveIdentityFingerprint: HERMES_PORTABLE_TEST_LIVE_IDENTITY,
    };
    const resumeObservations = [
      { kind: "ambiguous" as const, detail: "exact OpenShell sandbox is not Ready" },
      { kind: "ambiguous" as const, detail: "exact OpenShell sandbox is not Ready" },
      present,
    ];
    const resumeObserveSandbox = vi.fn(() => resumeObservations.shift() ?? present);
    let resumeNowMs = 0;
    const delayResumePoll = vi.fn(async (milliseconds: number) => {
      resumeNowMs += milliseconds;
    });
    const second = deps({
      observeSandbox: resumeObserveSandbox,
      delaySandboxReadyPublicationPoll: delayResumePoll,
      readSandboxReadyPublicationClockMs: () => resumeNowMs,
    });

    const resumed = await runHermesPortableOnboardingTransaction(input(), second.value);

    expect(resumed.active.receipt.phase).toBe("active");
    expect(resumed.created).toBe(false);
    expect(second.events).not.toContain("create");
    expect(delayResumePoll).toHaveBeenCalledTimes(1);
    expect(delayResumePoll).toHaveBeenCalledWith(1_000);
    expect(resumeObserveSandbox.mock.calls.slice(0, 3)).toEqual([[undefined], [60_000], [59_000]]);
  });

  it("fails closed when exact post-create Ready publication exceeds its bound (#9211)", async () => {
    let observations = 0;
    const observeSandbox = vi.fn(() =>
      observations++ < 2
        ? { kind: "absent" as const }
        : { kind: "ambiguous" as const, detail: "exact OpenShell sandbox is not Ready" },
    );
    let nowMs = 0;
    const delaySandboxReadyPublicationPoll = vi.fn(async (milliseconds: number) => {
      nowMs += milliseconds;
    });
    const fixture = deps({
      observeSandbox,
      delaySandboxReadyPublicationPoll,
      readSandboxReadyPublicationClockMs: () => nowMs,
    });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "cannot classify create result: exact OpenShell sandbox is not Ready",
    );

    expect(fixture.events.filter((event) => event === "create")).toHaveLength(1);
    expect(delaySandboxReadyPublicationPoll).toHaveBeenCalledTimes(60);
    expect(observeSandbox.mock.calls.slice(2)).toEqual(
      Array.from({ length: 60 }, (_value, index) => [60_000 - index * 1_000]),
    );
    expect(fixture.events).not.toContain("registry");
    expect(fixture.events.at(-1)).toBe("lock-exit");
  });

  it("counts OpenShell observation time against the total Ready publication deadline (#9211)", async () => {
    let nowMs = 0;
    let observationIndex = 0;
    const observationDurationsMs = [0, 0, 46_000, 13_000] as const;
    const observations = [
      { kind: "absent" as const },
      { kind: "absent" as const },
      { kind: "ambiguous" as const, detail: "exact OpenShell sandbox is not Ready" },
      { kind: "ambiguous" as const, detail: "exact OpenShell sandbox is not Ready" },
    ];
    const observeSandbox = vi.fn((_timeoutBudgetMs?: number) => {
      const currentIndex = observationIndex++;
      nowMs += observationDurationsMs[currentIndex] ?? 0;
      return observations[currentIndex] ?? observations.at(-1)!;
    });
    const delaySandboxReadyPublicationPoll = vi.fn(async (milliseconds: number) => {
      nowMs += milliseconds;
    });
    const fixture = deps({
      observeSandbox,
      delaySandboxReadyPublicationPoll,
      readSandboxReadyPublicationClockMs: () => nowMs,
    });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "cannot classify create result: exact OpenShell sandbox is not Ready",
    );

    expect(observeSandbox.mock.calls.slice(2)).toEqual([[60_000], [13_000]]);
    expect(delaySandboxReadyPublicationPoll).toHaveBeenCalledTimes(1);
    expect(delaySandboxReadyPublicationPoll).toHaveBeenCalledWith(1_000);
    expect(nowMs).toBe(60_000);
    expect(fixture.events.filter((event) => event === "create")).toHaveLength(1);
    expect(fixture.events).not.toContain("registry");
  });

  it("does not retry an unrelated post-create ambiguity (#9211)", async () => {
    let observations = 0;
    const observeSandbox = vi.fn(() =>
      observations++ < 2
        ? { kind: "absent" as const }
        : { kind: "ambiguous" as const, detail: "gateway unavailable" },
    );
    let nowMs = 0;
    const delaySandboxReadyPublicationPoll = vi.fn(async (milliseconds: number) => {
      nowMs += milliseconds;
    });
    const fixture = deps({
      observeSandbox,
      delaySandboxReadyPublicationPoll,
      readSandboxReadyPublicationClockMs: () => nowMs,
    });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "cannot classify create result: gateway unavailable",
    );

    expect(fixture.events.filter((event) => event === "create")).toHaveLength(1);
    expect(delaySandboxReadyPublicationPoll).not.toHaveBeenCalled();
    expect(observeSandbox.mock.calls.slice(2)).toEqual([[60_000]]);
    expect(fixture.events).not.toContain("registry");
  });

  it("accepts selected GPU CDI devices in the portable create intent", async () => {
    const current = input();
    const separator = current.createArgv.indexOf("--");
    current.createArgv.splice(
      separator,
      0,
      "--driver-config-json",
      JSON.stringify({
        docker: { cdi_devices: ["nvidia.com/gpu=0"] },
        podman: { cdi_devices: ["nvidia.com/gpu=0"] },
      }),
      "--gpu",
    );
    const fixture = createHermesPortableTransactionFixture(current);

    const completed = await runHermesPortableOnboardingTransaction(current, fixture.value);

    expect(completed.active.receipt.phase).toBe("active");
    expect(completed.created).toBe(true);
    expect(fixture.events).toContain("create");
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
      args[0] === "container" && args[1] === "inspect"
        ? createHermesPortableContainerInspectResult("no")
        : unexpectedPodmanArgs(args),
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

  it.each([
    ["named sandbox-not-found", "sandbox 'alpha' not found"],
    [
      "OpenShell 0.0.106 entity-not-found",
      "Error:   × code: 'Some requested entity was not found', message: \"sandbox not found\"",
    ],
  ])(
    "classifies absence after a reachable gateway returns %s evidence (#9203)",
    (_label, stderr) => {
      const capture = vi
        .fn()
        .mockReturnValueOnce({ status: 0, stdout: "[]", stderr: "" })
        .mockReturnValueOnce({ status: 1, stdout: "", stderr });

      expect(observeHermesPortableSandbox("alpha", "nemoclaw", capture)).toEqual({
        kind: "absent",
      });
      expect(capture.mock.calls).toEqual([
        [["sandbox", "list", "-g", "nemoclaw"]],
        [["sandbox", "get", "-g", "nemoclaw", "alpha"]],
      ]);
    },
  );

  it("shares one observation budget across sandbox list and get (#9211)", () => {
    let nowMs = 100;
    let captureIndex = 0;
    const captureDurationsMs = [4_000, 0] as const;
    const captureResults = [
      { status: 0, stdout: "alpha Ready", stderr: "" },
      {
        status: 0,
        stdout: "Name: alpha\nID: sandbox-id-1\nPhase: Ready\n",
        stderr: "",
      },
    ];
    const capture = vi.fn((_args: readonly string[]) => {
      const currentIndex = captureIndex++;
      nowMs += captureDurationsMs[currentIndex] ?? 0;
      return captureResults[currentIndex]!;
    });

    expect(
      observeHermesPortableSandbox("alpha", "nemoclaw", capture, 5_000, () => nowMs),
    ).toMatchObject({ kind: "present", sandboxId: "sandbox-id-1" });
    expect(capture.mock.calls).toEqual([
      [["sandbox", "list", "-g", "nemoclaw"], 5_000],
      [["sandbox", "get", "-g", "nemoclaw", "alpha"], 1_000],
    ]);
  });

  it("stops an observation when the first capture consumes its total budget (#9211)", () => {
    let nowMs = 0;
    const capture = vi.fn(() => {
      nowMs = 5_000;
      return { status: 0, stdout: "alpha Creating", stderr: "" };
    });

    expect(observeHermesPortableSandbox("alpha", "nemoclaw", capture, 5_000, () => nowMs)).toEqual({
      kind: "ambiguous",
      detail: "exact OpenShell sandbox Ready publication exceeded its total deadline",
    });
    expect(capture).toHaveBeenCalledTimes(1);
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
    [
      "entity-not-found response for a different resource",
      {
        status: 1,
        stdout: "",
        stderr:
          "Error:   × code: 'Some requested entity was not found', message: \"gateway not found\"",
      },
      true,
    ],
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
      openshellVersion: "0.0.106",
    };

    expect(classifyHermesPortableRegistry(receipt, null)).toEqual({ kind: "missing" });
    expect(classifyHermesPortableRegistry(receipt, matching)).toMatchObject({ kind: "matching" });
    expect(
      classifyHermesPortableRegistry(receipt, { ...matching, openshellVersion: "0.0.101" }),
    ).toMatchObject({ kind: "conflict" });
    expect(
      classifyHermesPortableRegistry(receipt, { ...matching, lifecycleGeneration: "other" }),
    ).toMatchObject({ kind: "conflict" });
    expect(
      classifyHermesPortableRegistry(receipt, { ...matching, agent: "openclaw" }),
    ).toMatchObject({ kind: "conflict" });
  });
});
