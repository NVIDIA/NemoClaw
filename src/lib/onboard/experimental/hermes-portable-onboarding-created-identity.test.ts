// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  NEMOCLAW_CREATE_ATTEMPT_LABEL,
  NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH,
  settleCreatedOpenShellSandboxId,
} from "../../adapters/openshell/sandbox-identity";
import {
  createHermesPortableReadyCapture,
  createHermesPortableReadyRunner,
} from "./hermes-portable-onboarding";

const CREATE_ATTEMPT_NONCE = "a".repeat(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH);
const CREATED_IDENTITY_SELECTOR_ARGS = [
  "sandbox",
  "list",
  "-g",
  "nemoclaw",
  "--selector",
  `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${CREATE_ATTEMPT_NONCE}`,
  "--output",
  "json",
  "--limit",
  "2",
];

describe("Hermes Portable created-identity capture", () => {
  it("routes the exact create-attempt selector through the receipt gateway (#10423)", () => {
    const capture = vi.fn(() => ({
      status: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    const run = createHermesPortableReadyRunner("alpha", "nemoclaw", capture);

    expect(run(CREATED_IDENTITY_SELECTOR_ARGS).status).toBe(0);
    expect(capture).toHaveBeenCalledExactlyOnceWith(CREATED_IDENTITY_SELECTOR_ARGS);
  });

  it("routes the exact post-create publication lookup through the receipt gateway (#10423)", () => {
    const capture = vi.fn(() => ({
      status: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    const run = createHermesPortableReadyRunner("alpha", "nemoclaw", capture);
    const args = ["sandbox", "get", "-g", "nemoclaw", "alpha"];

    expect(run(args).status).toBe(0);
    expect(capture).toHaveBeenCalledExactlyOnceWith(args);
  });

  it("accepts the observer's exact named-gateway readiness list (#9803)", () => {
    const capture = vi.fn(() => ({
      status: 0,
      stdout: Buffer.from("alpha Ready"),
      stderr: Buffer.alloc(0),
    }));
    const run = createHermesPortableReadyRunner("alpha", "nemoclaw", capture);
    const args = ["sandbox", "list", "-g", "nemoclaw"];

    expect(run(args).status).toBe(0);
    expect(capture).toHaveBeenCalledExactlyOnceWith(args);
  });

  it("accepts the exact named-gateway readiness exec (#9803)", () => {
    const capture = vi.fn(() => ({
      status: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    const run = createHermesPortableReadyRunner("alpha", "nemoclaw", capture);
    const args = ["sandbox", "exec", "-g", "nemoclaw", "--name", "alpha", "--", "true"];

    expect(run(args).status).toBe(0);
    expect(capture).toHaveBeenCalledExactlyOnceWith(args);
  });

  it.each([
    ["another gateway", ["sandbox", "exec", "-g", "other", "--name", "alpha", "--", "true"]],
    ["another sandbox", ["sandbox", "exec", "-g", "nemoclaw", "--name", "beta", "--", "true"]],
  ])("rejects a readiness exec for %s before capture (#9803)", (_case, args) => {
    const capture = vi.fn();
    const run = createHermesPortableReadyRunner("alpha", "nemoclaw", capture);

    expect(() => run(args)).toThrow("unsupported OpenShell command");
    expect(capture).not.toHaveBeenCalled();
  });

  it("rejects a readiness list for another gateway before capture (#9803)", () => {
    const capture = vi.fn();
    const run = createHermesPortableReadyRunner("alpha", "nemoclaw", capture);

    expect(() => run(["sandbox", "list", "-g", "other"])).toThrow("unsupported OpenShell command");
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong gateway", ["sandbox", "get", "-g", "other", "alpha"]],
    ["wrong sandbox", ["sandbox", "get", "-g", "nemoclaw", "beta"]],
    ["reordered gateway", ["sandbox", "get", "alpha", "-g", "nemoclaw"]],
    ["extra argument", ["sandbox", "get", "-g", "nemoclaw", "alpha", "extra"]],
  ])("rejects a post-create publication lookup with %s before capture (#10423)", (_case, args) => {
    const capture = vi.fn();
    const run = createHermesPortableReadyRunner("alpha", "nemoclaw", capture);

    expect(() => run(args)).toThrow("unsupported OpenShell command");
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    [
      "wrong gateway",
      [
        ...CREATED_IDENTITY_SELECTOR_ARGS.slice(0, 3),
        "other",
        ...CREATED_IDENTITY_SELECTOR_ARGS.slice(4),
      ],
    ],
    [
      "wrong selector key",
      [
        ...CREATED_IDENTITY_SELECTOR_ARGS.slice(0, 5),
        `other=${CREATE_ATTEMPT_NONCE}`,
        ...CREATED_IDENTITY_SELECTOR_ARGS.slice(6),
      ],
    ],
    [
      "short nonce",
      [
        ...CREATED_IDENTITY_SELECTOR_ARGS.slice(0, 5),
        `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${"a".repeat(61)}`,
        ...CREATED_IDENTITY_SELECTOR_ARGS.slice(6),
      ],
    ],
    [
      "long nonce",
      [
        ...CREATED_IDENTITY_SELECTOR_ARGS.slice(0, 5),
        `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${"a".repeat(63)}`,
        ...CREATED_IDENTITY_SELECTOR_ARGS.slice(6),
      ],
    ],
    [
      "non-hex nonce",
      [
        ...CREATED_IDENTITY_SELECTOR_ARGS.slice(0, 5),
        `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${"g".repeat(62)}`,
        ...CREATED_IDENTITY_SELECTOR_ARGS.slice(6),
      ],
    ],
    [
      "wrong output",
      [
        ...CREATED_IDENTITY_SELECTOR_ARGS.slice(0, 7),
        "yaml",
        ...CREATED_IDENTITY_SELECTOR_ARGS.slice(8),
      ],
    ],
    ["wrong limit", [...CREATED_IDENTITY_SELECTOR_ARGS.slice(0, 9), "3"]],
    [
      "reordered selector",
      [
        "sandbox",
        "list",
        "-g",
        "nemoclaw",
        "--output",
        "json",
        "--selector",
        `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${CREATE_ATTEMPT_NONCE}`,
        "--limit",
        "2",
      ],
    ],
    ["extra argument", [...CREATED_IDENTITY_SELECTOR_ARGS, "extra"]],
  ])("rejects a created-identity selector with %s before capture (#10423)", (_case, args) => {
    const capture = vi.fn();
    const run = createHermesPortableReadyRunner("alpha", "nemoclaw", capture);

    expect(() => run(args)).toThrow("unsupported OpenShell command");
    expect(capture).not.toHaveBeenCalled();
  });

  it("composes the scoped selector with strict created-identity settlement (#10423)", () => {
    const capture = vi.fn(() => ({
      status: 0,
      stdout: Buffer.from(
        JSON.stringify([
          {
            id: "sandbox-id-1",
            name: "alpha",
            labels: { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: CREATE_ATTEMPT_NONCE },
            resource_version: 1,
            created_at: "2026-08-27T00:00:00Z",
            phase: "Ready",
            current_policy_version: 1,
          },
        ]),
      ),
      stderr: Buffer.alloc(0),
    }));
    const readyCapture = createHermesPortableReadyCapture("alpha", "nemoclaw", capture);

    expect(
      settleCreatedOpenShellSandboxId({
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        createAttemptNonce: CREATE_ATTEMPT_NONCE,
        runCaptureOpenshell: readyCapture,
        sleep: vi.fn(),
      }),
    ).toBe("sandbox-id-1");
    expect(capture).toHaveBeenCalledExactlyOnceWith(CREATED_IDENTITY_SELECTOR_ARGS);
  });

  it.each([
    ["malformed", { status: 0, stdout: Buffer.from("not-json"), stderr: Buffer.alloc(0) }],
    [
      "ambiguous",
      {
        status: 0,
        stdout: Buffer.from(
          JSON.stringify([
            {
              id: "sandbox-id-1",
              name: "alpha",
              labels: { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: CREATE_ATTEMPT_NONCE },
              resource_version: 1,
              created_at: "2026-08-27T00:00:00Z",
              phase: "Ready",
              current_policy_version: 1,
            },
            {
              id: "sandbox-id-2",
              name: "alpha",
              labels: { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: CREATE_ATTEMPT_NONCE },
              resource_version: 2,
              created_at: "2026-08-27T00:00:01Z",
              phase: "Ready",
              current_policy_version: 1,
            },
          ]),
        ),
        stderr: Buffer.alloc(0),
      },
    ],
    [
      "identity mismatch",
      {
        status: 0,
        stdout: Buffer.from(
          JSON.stringify([
            {
              id: "sandbox-id-1",
              name: "beta",
              labels: { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: CREATE_ATTEMPT_NONCE },
              resource_version: 1,
              created_at: "2026-08-27T00:00:00Z",
              phase: "Ready",
              current_policy_version: 1,
            },
          ]),
        ),
        stderr: Buffer.alloc(0),
      },
    ],
    ["nonzero", { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }],
    [
      "capture error",
      {
        status: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: new Error("capture canary"),
      },
    ],
  ])(
    "keeps %s created-identity results terminal through the scoped capture (#10423)",
    (_case, result) => {
      const capture = vi.fn(() => result);
      const readyCapture = createHermesPortableReadyCapture("alpha", "nemoclaw", capture as never);
      const sleep = vi.fn();

      expect(() =>
        settleCreatedOpenShellSandboxId({
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          createAttemptNonce: CREATE_ATTEMPT_NONCE,
          runCaptureOpenshell: readyCapture,
          sleep,
        }),
      ).toThrow("OpenShell did not return the exact created identity");
      expect(capture).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    },
  );
});
