// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureOpenshell: vi.fn(),
  resolveGatewayTeardownAuthority: vi.fn(),
}));

vi.mock("../adapters/openshell/runtime", () => ({
  captureOpenshell: mocks.captureOpenshell,
  runOpenshell: vi.fn(),
}));

vi.mock("./gateway-teardown-authority", () => ({
  resolveGatewayTeardownAuthority: mocks.resolveGatewayTeardownAuthority,
}));

import type { Session } from "../state/onboard-session";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import { fingerprintSandboxRecreateValue } from "./sandbox-recreate-transaction";
import {
  fingerprintOnboardRecreateTargetIntent,
  type OnboardRecreateTargetIntent,
  openOnboardRecreateJournal,
} from "./onboard-recreate-journal";

const BASE_INTENT: OnboardRecreateTargetIntent = {
  agent: "openclaw",
  fromDockerfile: null,
  provider: "nvidia-prod",
  model: "gpt-5.4",
  preferredInferenceApi: "openai-completions",
  sandboxGpuConfig: { sandboxGpuEnabled: false, mode: "0" },
  gatewayName: "nemoclaw-9090",
  gatewayPort: 9090,
  toolDisclosure: "progressive",
  dcodeAutoApprovalMode: null,
  observabilityEnabled: false,
};

describe("non-resumed replacement target fingerprint (#7735)", () => {
  it("is stable for the same replacement intent", () => {
    expect(fingerprintOnboardRecreateTargetIntent({ ...BASE_INTENT })).toBe(
      fingerprintOnboardRecreateTargetIntent(BASE_INTENT),
    );
  });

  it.each([
    { observabilityEnabled: true },
    { toolDisclosure: "direct" },
    { sandboxGpuConfig: { sandboxGpuEnabled: true, mode: "all" } },
    { dcodeAutoApprovalMode: "thread-opt-in" },
  ])("changes when a recorded replacement input changes [case %#]", (drift) => {
    expect(fingerprintOnboardRecreateTargetIntent({ ...BASE_INTENT, ...drift })).not.toBe(
      fingerprintOnboardRecreateTargetIntent(BASE_INTENT),
    );
  });

  it("changes when the replacement targets another gateway", () => {
    expect(
      fingerprintOnboardRecreateTargetIntent({
        ...BASE_INTENT,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      }),
    ).not.toBe(fingerprintOnboardRecreateTargetIntent(BASE_INTENT));
  });
});

const SANDBOX_ID = "sbx-71c9a4e08b";
const SANDBOX_FINGERPRINT = fingerprintSandboxRecreateValue(SANDBOX_ID);
const REPLACEMENT_FINGERPRINT = fingerprintSandboxRecreateValue("sbx-2f80d5a613");

const NON_DEFAULT_TARGET = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw-9090",
  gatewayPort: 9090,
};

function livePresentProbe(phase = "Ready") {
  const rendered = `Name: alpha\nId: ${SANDBOX_ID}\nPhase: ${phase}\n`;
  return { status: 0, output: rendered, stdout: rendered, stderr: "" };
}

function replacementProbe(phase = "Ready") {
  const rendered = `Name: alpha\nId: sbx-2f80d5a613\nPhase: ${phase}\n`;
  return { status: 0, output: rendered, stdout: rendered, stderr: "" };
}

function absentProbe() {
  return {
    status: 1,
    output: "",
    stdout: "",
    stderr: "Error: sandbox alpha not found",
  };
}

describe("non-resumed onboard replacement journal (#7735)", () => {
  let session: Session;

  beforeEach(() => {
    vi.clearAllMocks();
    session = onboardSession.createSession({ sandboxName: "alpha" });
    vi.spyOn(onboardSession, "loadSession").mockImplementation(() => session);
    vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator) => {
      session = mutator(session) ?? session;
      return session;
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw-9090",
      gatewayPort: 9090,
    } as registry.SandboxEntry);
    mocks.resolveGatewayTeardownAuthority.mockReturnValue({
      gatewayName: "nemoclaw-9090",
      gatewayPort: 9090,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    });
    mocks.captureOpenshell.mockReturnValue(livePresentProbe());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function open(intent: OnboardRecreateTargetIntent = BASE_INTENT) {
    return openOnboardRecreateJournal({
      target: NON_DEFAULT_TARGET,
      agentName: "openclaw",
      intent,
      note: vi.fn(),
    });
  }

  it("journals an explicit recreation before the delete command runs", () => {
    open();

    const recorded = session.checkpoint?.sandboxRecreate;
    expect(recorded?.phase).toBe("planned");
    expect(recorded?.sandboxName).toBe("alpha");
    expect(recorded?.targetIntentFingerprint).toBe(
      fingerprintOnboardRecreateTargetIntent(BASE_INTENT),
    );
    expect(recorded?.sourceLiveIdentityFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(session.checkpoint)).not.toContain(SANDBOX_ID);
  });

  it("binds the journal to the selected sandbox identity and gateway authority", () => {
    open();

    expect(mocks.resolveGatewayTeardownAuthority).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-9090",
      gatewayPort: 9090,
    });
    const identity = session.checkpoint?.sandboxIdentity;
    expect(identity?.kind === "selected" && identity.value).toEqual({
      name: "alpha",
      agent: "openclaw",
    });
    const authority = session.checkpoint?.gatewayAuthority;
    expect(authority?.kind === "selected" && authority.value.gatewayPort).toBe(9090);
    expect(session.checkpoint?.sandboxRecreate?.gatewayName).toBe("nemoclaw-9090");
    expect(session.checkpoint?.sandboxRecreate?.gatewayPort).toBe(9090);
  });

  it("queries only the journaled gateway so a sibling gateway is never reached", () => {
    open();

    const expectedCommand = ["sandbox", "get", "-g", "nemoclaw-9090", "alpha"];
    const expectedOptions = {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      timeout: 15_000,
    };
    expect(mocks.captureOpenshell.mock.calls).toEqual([
      [expectedCommand, expectedOptions],
      [expectedCommand, expectedOptions],
    ]);
  });

  it("journals a not-ready repair before the delete boundary", () => {
    mocks.captureOpenshell.mockReturnValue(livePresentProbe("Pending"));

    open();

    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("planned");
  });

  it("records the delete boundary through the returned runtime", () => {
    const runtime = open();

    runtime.advance("deleting");
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("deleting");

    mocks.captureOpenshell.mockReturnValue(absentProbe());
    runtime.confirmDeleted();
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("deleted");
  });

  it("stops before the next mutation when the source outlives its delete", () => {
    const runtime = open();
    runtime.advance("deleting");

    expect(() => runtime.confirmDeleted()).toThrow(
      /OpenShell still reports the journaled source after delete/,
    );
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("deleting");
  });

  it("retires its own transaction once the replacement registry row commits", () => {
    const runtime = open();
    runtime.advance("deleting");
    mocks.captureOpenshell.mockReturnValue(absentProbe());
    runtime.confirmDeleted();
    runtime.advance("creating");
    mocks.captureOpenshell.mockReturnValue(livePresentProbe());
    runtime.recordCreated({ state: "ready", liveIdentityFingerprint: SANDBOX_FINGERPRINT });

    runtime.complete();

    expect(session.checkpoint?.sandboxRecreate).toBeNull();
  });

  it("accepts the proven replacement instead of deleting it again (#7734)", () => {
    const first = open();
    first.advance("deleting");
    mocks.captureOpenshell.mockReturnValue(absentProbe());
    first.confirmDeleted();
    first.advance("creating");
    mocks.captureOpenshell.mockReturnValue(replacementProbe());
    first.recordCreated({ state: "ready", liveIdentityFingerprint: REPLACEMENT_FINGERPRINT });
    first.advance("registry_committing");
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw-9090",
      gatewayPort: 9090,
      ...first.registrationFields,
    } as registry.SandboxEntry);

    const resumed = open();

    expect(resumed.acceptedTarget).toBe(true);
    resumed.complete();
    expect(session.checkpoint?.sandboxRecreate).toBeNull();
  });

  it("retires a replacement whose registration already reached completion", () => {
    const first = open();
    first.advance("deleting");
    mocks.captureOpenshell.mockReturnValue(absentProbe());
    first.confirmDeleted();
    first.advance("creating");
    mocks.captureOpenshell.mockReturnValue(replacementProbe());
    first.recordCreated({ state: "ready", liveIdentityFingerprint: REPLACEMENT_FINGERPRINT });
    first.advance("completed");
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw-9090",
      gatewayPort: 9090,
      ...first.registrationFields,
    } as registry.SandboxEntry);

    const resumed = open();

    expect(resumed.acceptedTarget).toBe(true);
    expect(() => resumed.complete()).not.toThrow();
    expect(session.checkpoint?.sandboxRecreate).toBeNull();
  });

  it("resumes the same replacement after a restart without a resume flag", () => {
    const first = open();
    first.advance("deleting");
    const firstId = session.checkpoint?.sandboxRecreate?.id;

    open();

    expect(session.checkpoint?.sandboxRecreate?.id).toBe(firstId);
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("deleting");
  });

  it("refuses a replacement whose target intent changed mid-transaction", () => {
    open();

    expect(() => open({ ...BASE_INTENT, observabilityEnabled: true })).toThrow(
      /different recreate transaction in progress/,
    );
  });

  it("refuses to continue when the live source identity no longer matches", () => {
    open();
    mocks.captureOpenshell.mockReturnValue({
      status: 0,
      output: "Name: alpha\nId: sbx-000000000\nPhase: Ready\n",
      stdout: "Name: alpha\nId: sbx-000000000\nPhase: Ready\n",
      stderr: "",
    });

    expect(() => open()).toThrow(/no longer has the journaled source identity/);
  });

  it("refuses to journal a replacement without its source registry row", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(null);

    expect(() => open()).toThrow(/without its source registry row/);
    expect(session.checkpoint?.sandboxRecreate ?? null).toBeNull();
  });

  it("fails closed when the gateway reports neither a live sandbox nor explicit absence", () => {
    mocks.captureOpenshell.mockReturnValue({
      status: 1,
      output: "",
      stdout: "",
      stderr: "Error: connection refused",
    });

    expect(() => open()).toThrow(/neither a live sandbox nor explicit absence/);
    expect(session.checkpoint?.sandboxRecreate ?? null).toBeNull();
  });

  it("fails closed when the live sandbox has no stable OpenShell Id", () => {
    mocks.captureOpenshell.mockReturnValue({
      status: 0,
      output: "Name: alpha\nPhase: Ready\n",
      stdout: "Name: alpha\nPhase: Ready\n",
      stderr: "",
    });

    expect(() => open()).toThrow(/did not report a stable sandbox Id/);
    expect(session.checkpoint?.sandboxRecreate ?? null).toBeNull();
  });

  it("opens at the deleted phase when the source sandbox is already gone", () => {
    mocks.captureOpenshell.mockReturnValue(absentProbe());

    open();

    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("deleted");
    expect(session.checkpoint?.sandboxRecreate?.sourceLiveIdentityFingerprint).toBeNull();
  });
});
