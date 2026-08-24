// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  hermesPortableCreatePolicySemanticDigest,
  hermesPortablePolicyAuthorityInternals,
  proveHermesPortableLivePolicy,
  type HermesPortablePolicyCaptureResult,
} from "./hermes-portable-policy-authority";

const CREATE = Buffer.from(`version: 1
network_policies:
  inference:
    name: inference
    endpoints:
      - host: inference.local
        port: 443
`);

const FORMATTED = Buffer.from(`Policy: alpha
---
network_policies:
  inference: { endpoints: [{ port: 443, host: inference.local }], name: inference }
version: 1
`);

const NATIVE_GPU_CREATE = Buffer.from(`version: 1
filesystem_policy:
  include_workdir: true
  read_only:
    - /usr
    - /lib
    - /etc
    - /app
    - /var/log
    - /dev/urandom
  read_write:
    - /tmp
network_policies:
  inference:
    name: inference
    endpoints:
      - host: inference.local
        port: 443
`);

const NATIVE_GPU_LIVE = Buffer.from(`version: 1
filesystem_policy:
  include_workdir: true
  read_only:
    - /usr
    - /lib
    - /etc
    - /app
    - /var/log
    - /dev/urandom
    - /run/nvidia-persistenced
    - /usr/lib/wsl
  read_write:
    - /tmp
    - /proc
    - /dev/nvidiactl
    - /dev/nvidia-uvm
    - /dev/nvidia-uvm-tools
    - /dev/nvidia-modeset
    - /dev/dxg
    - /dev/nvidia0
    - /dev/nvidia1
network_policies:
  inference:
    name: inference
    endpoints:
      - host: inference.local
        port: 443
`);

function result(
  stdout: Buffer,
  status = 0,
  stderr = Buffer.alloc(0),
): HermesPortablePolicyCaptureResult {
  return { status, stdout, stderr };
}

function deeplyNestedPolicyAuthority(): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  Array.from({ length: 70 }).reduce<Record<string, unknown>>((current) => {
    const next: Record<string, unknown> = {};
    current.next = next;
    return next;
  }, root);
  return root;
}

describe("Hermes portable policy authority", () => {
  it("accepts formatting and mapping-order normalization from exact scoped base/full reads (#9203)", () => {
    const capture = vi.fn(() => result(FORMATTED));

    const proof = proveHermesPortableLivePolicy({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      createPolicyBytes: CREATE,
      capture,
    });

    expect(proof.verifiedLivePolicySemanticSha256).toBe(proof.intendedSemanticSha256);
    expect(capture.mock.calls).toEqual([
      [["policy", "get", "-g", "nemoclaw", "--base", "alpha"]],
      [["policy", "get", "-g", "nemoclaw", "--full", "alpha"]],
    ]);
  });

  it("accepts only OpenShell's documented native-GPU baseline enrichment (#10121)", () => {
    const capture = vi.fn(() => result(NATIVE_GPU_LIVE));

    const proof = proveHermesPortableLivePolicy({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      createPolicyBytes: NATIVE_GPU_CREATE,
      capture,
    });

    expect(proof.verifiedLivePolicySemanticSha256).not.toBe(proof.intendedSemanticSha256);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "an arbitrary added path",
      create: NATIVE_GPU_CREATE,
      live: NATIVE_GPU_LIVE.toString("utf8").replace("    - /dev/nvidia0\n", "    - /home\n"),
    },
    {
      label: "an intended path removal",
      create: NATIVE_GPU_CREATE,
      live: NATIVE_GPU_LIVE.toString("utf8").replace("    - /usr\n", ""),
    },
    {
      label: "a non-filesystem change",
      create: NATIVE_GPU_CREATE,
      live: NATIVE_GPU_LIVE.toString("utf8").replace("port: 443", "port: 8443"),
    },
    {
      label: "a near-match GPU device path",
      create: NATIVE_GPU_CREATE,
      live: NATIVE_GPU_LIVE.toString("utf8").replace("/dev/nvidia0", "/dev/nvidia0/escape"),
    },
    {
      label: "a duplicate live path",
      create: NATIVE_GPU_CREATE,
      live: NATIVE_GPU_LIVE.toString("utf8").replace(
        "    - /dev/nvidia0\n",
        "    - /dev/nvidia0\n    - /dev/nvidia0\n",
      ),
    },
    {
      label: "GPU additions without the documented /proc promotion",
      create: NATIVE_GPU_CREATE,
      live: NATIVE_GPU_LIVE.toString("utf8").replace("    - /proc\n", ""),
    },
    {
      label: "GPU enrichment of an ordinary policy",
      create: Buffer.from(
        NATIVE_GPU_CREATE.toString("utf8").replace("    - /etc\n", "    - /etc\n    - /proc\n"),
      ),
      live: NATIVE_GPU_LIVE.toString("utf8"),
    },
  ])("rejects $label as unproven policy drift (#10121)", ({ create, live }) => {
    expect(() =>
      proveHermesPortableLivePolicy({
        gatewayName: "nemoclaw",
        sandboxName: "alpha",
        createPolicyBytes: Buffer.isBuffer(create) ? create : Buffer.from(create),
        capture: () => result(Buffer.from(live)),
      }),
    ).toThrow("base policy disagrees");
  });

  it("rejects a reserved provider entry in the exact create input (#9203)", () => {
    const create = Buffer.from(`version: 1
network_policies:
  _provider_injected: { endpoints: [] }
`);

    expect(() => hermesPortableCreatePolicySemanticDigest(create)).toThrow(
      "create input contains a reserved provider-composed entry",
    );
  });

  it("rejects arbitrary content under a registered-looking provider key in full policy (#9203)", () => {
    const full = Buffer.from(`${CREATE.toString("utf8")}  _provider_nvidia_inference:
    name: _provider_nvidia_inference
    endpoints: []
`);
    const capture = vi.fn((args: readonly string[]) =>
      result(args.includes("--base") ? CREATE : full),
    );

    expect(() =>
      proveHermesPortableLivePolicy({
        gatewayName: "nemoclaw",
        sandboxName: "alpha",
        createPolicyBytes: CREATE,
        capture,
      }),
    ).toThrow("unproven provider-composed or out-of-band delta");
  });

  it("does not erase a __proto__ policy entry during semantic comparison (#9203)", () => {
    const full = Buffer.from(`${CREATE.toString("utf8")}  __proto__:
    name: injected
    endpoints: []
`);

    expect(() =>
      proveHermesPortableLivePolicy({
        gatewayName: "nemoclaw",
        sandboxName: "alpha",
        createPolicyBytes: CREATE,
        capture: (args) => result(args.includes("--base") ? CREATE : full),
      }),
    ).toThrow("out-of-band delta");
  });

  it("rejects cyclic and oversized semantic structures deterministically (#9203)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => hermesPortablePolicyAuthorityInternals.semanticDigest(cyclic)).toThrow(
      "cyclic semantic structure",
    );
    expect(() =>
      hermesPortablePolicyAuthorityInternals.semanticDigest(deeplyNestedPolicyAuthority()),
    ).toThrow("oversized semantic structure");
  });

  it("rejects capture ambiguity even when the child status is zero (#9203)", () => {
    const capture = vi.fn(() => ({
      ...result(FORMATTED),
      error: new Error("transport ended ambiguously"),
    }));

    expect(() =>
      proveHermesPortableLivePolicy({
        gatewayName: "nemoclaw",
        sandboxName: "alpha",
        createPolicyBytes: CREATE,
        capture,
      }),
    ).toThrow("scoped base policy failed with status 0");
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("rejects non-reserved semantic drift in base or full policy (#9203)", () => {
    const drift = Buffer.from(CREATE.toString("utf8").replace("port: 443", "port: 8443"));
    expect(() =>
      proveHermesPortableLivePolicy({
        gatewayName: "nemoclaw",
        sandboxName: "alpha",
        createPolicyBytes: CREATE,
        capture: (args) => result(args.includes("--base") ? drift : drift),
      }),
    ).toThrow("base policy disagrees");
    expect(() =>
      proveHermesPortableLivePolicy({
        gatewayName: "nemoclaw",
        sandboxName: "alpha",
        createPolicyBytes: CREATE,
        capture: (args) => result(args.includes("--base") ? CREATE : drift),
      }),
    ).toThrow("out-of-band delta");
  });

  it.each(["create", "base", "full"] as const)(
    "rejects malformed UTF-8 in the %s policy bytes (#9203)",
    (target) => {
      const malformed = Buffer.from([0xff]);
      const createPolicyBytes = target === "create" ? malformed : CREATE;
      const capture = (args: readonly string[]) =>
        result(
          target === "base" && args.includes("--base")
            ? malformed
            : target === "full" && args.includes("--full")
              ? malformed
              : CREATE,
        );

      expect(() =>
        proveHermesPortableLivePolicy({
          gatewayName: "nemoclaw",
          sandboxName: "alpha",
          createPolicyBytes,
          capture,
        }),
      ).toThrow("strict UTF-8");
    },
  );

  it("rejects duplicate policy documents and failed scoped reads (#9203)", () => {
    const duplicate = Buffer.from(`${CREATE.toString("utf8")}---\n${CREATE.toString("utf8")}`);
    expect(() => hermesPortableCreatePolicySemanticDigest(duplicate)).toThrow(
      "duplicate or ambiguous",
    );
    expect(() =>
      proveHermesPortableLivePolicy({
        gatewayName: "nemoclaw",
        sandboxName: "alpha",
        createPolicyBytes: CREATE,
        capture: () => result(Buffer.alloc(0), 1, Buffer.from("gateway unavailable")),
      }),
    ).toThrow("scoped base policy failed with status 1");
  });

  it("does not expose malformed policy content or capture stderr in errors (#9203)", () => {
    const secret = "DO_NOT_LOG_POLICY_SECRET";
    let malformedError: Error | null = null;
    try {
      hermesPortableCreatePolicySemanticDigest(
        Buffer.from(`version: 1\nnetwork_policies:\n  secret: [${secret}\n`),
      );
    } catch (error) {
      malformedError = error as Error;
    }
    expect(malformedError?.message).toContain("create input is invalid");
    expect(malformedError?.message).not.toContain(secret);

    let captureError: Error | null = null;
    try {
      proveHermesPortableLivePolicy({
        gatewayName: "nemoclaw",
        sandboxName: "alpha",
        createPolicyBytes: CREATE,
        capture: () => result(Buffer.alloc(0), 1, Buffer.from(secret)),
      });
    } catch (error) {
      captureError = error as Error;
    }
    expect(captureError?.message).toContain("scoped base policy failed with status 1");
    expect(captureError?.message).not.toContain(secret);
  });
});
