// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  extractBuiltImageRef,
  printSandboxCreateRecoveryHints,
  reconstructImageRefCreateCommand,
  shouldIncludeBuildContextPath,
} from "../../dist/lib/build-context";

type ConsoleErrorSpy = ReturnType<typeof vi.spyOn>;

describe("build context filtering", () => {
  it("filters local-only artifacts out of the sandbox build context", () => {
    expect(
      shouldIncludeBuildContextPath(
        "/repo/nemoclaw-blueprint",
        "/repo/nemoclaw-blueprint/orchestrator/main.py",
      ),
    ).toBe(true);
    expect(
      shouldIncludeBuildContextPath(
        "/repo/nemoclaw-blueprint",
        "/repo/nemoclaw-blueprint/.venv/bin/python",
      ),
    ).toBe(false);
    expect(
      shouldIncludeBuildContextPath(
        "/repo/nemoclaw-blueprint",
        "/repo/nemoclaw-blueprint/.ruff_cache/cache",
      ),
    ).toBe(false);
  });
});

describe("printSandboxCreateRecoveryHints", () => {
  let errorSpy: ConsoleErrorSpy;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  function stderr(): string {
    return errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
  }

  it("prints resume guidance when sandbox image upload times out", () => {
    printSandboxCreateRecoveryHints("failed to read image export stream");

    expect(stderr()).toContain("image upload into the OpenShell gateway timed out");
    expect(stderr()).toContain("onboard --resume");
    expect(stderr()).toContain("Docker memory");
  });

  it("prints progress-specific resume guidance when upload reached the gateway", () => {
    printSandboxCreateRecoveryHints(
      [
        "[progress] Uploaded to gateway",
        "failed to read image export stream",
      ].join("\n"),
    );

    expect(stderr()).toContain("reuse existing gateway state");
  });

  it("prints resume guidance when sandbox image upload resets after transfer progress", () => {
    printSandboxCreateRecoveryHints(
      [
        "Image openshell/sandbox-from:123 is available in the gateway.",
        "Connection reset by peer",
      ].join("\n"),
    );

    expect(stderr()).toContain("image push/import stream was interrupted");
    expect(stderr()).toContain("onboard --resume");
    expect(stderr()).toContain("reached the gateway");
  });

  // Manual / ARM64 E2E note (#3266):
  //
  // The misleading "failed to upload image tar into container" Docker 404 only
  // reproduces on Linux ARM64 (aarch64) hosts when OpenShell streams a large
  // built image tar into the gateway container; it cannot be reproduced on
  // x86_64. To verify on real aarch64 hardware:
  //   1. `nemoclaw onboard` on a Linux ARM64 host with a large sandbox image.
  //   2. Confirm OpenShell aborts with the upload-tar 404 against
  //      `openshell-cluster-nemoclaw` even though the gateway container is up.
  //   3. Confirm NemoClaw now prints the local-registry / image-ref workaround
  //      (with the preserved built image tag) and the "Linux ARM64 (aarch64)"
  //      note instead of the bare `onboard --resume` guidance.
  //   4. Follow the printed steps — re-run NemoClaw's own create invocation with
  //      `--from localhost:5000/<built-image>` swapped in (keeping the provider/
  //      GPU/resource flags and the `-- env … nemoclaw-start` wrapper) — and
  //      confirm the sandbox is created without rebuilding.
  // This recovery path runs ONLY after the OpenShell upload failure is
  // classified; ordinary x86_64 happy-path onboards never reach it. The tests
  // below assert that branch deterministically by injecting platform/arch.
  it("prints the local-registry workaround with the preserved built image tag for the #3266 upload 404", () => {
    printSandboxCreateRecoveryHints(
      [
        "  Built image openshell/sandbox-from-nemoclaw:abcd1234",
        "Error: failed to upload image tar into container",
        "Docker responded with status code 404: the container does not exist",
        'no container with name or ID "openshell-cluster-nemoclaw" found',
      ].join("\n"),
      { platform: "linux", arch: "x64" },
    );

    const out = stderr();
    expect(out).toContain("failed to upload the image tar into the gateway container");
    expect(out).toContain("gateway container is healthy");
    expect(out).toContain("registry:2");
    // Preserves the built image tag so the operator can re-tag/push without rebuilding.
    expect(out).toContain("docker push localhost:5000/openshell/sandbox-from-nemoclaw:abcd1234");
    // Covers buildah-built images (the ARM64 path that triggers #3266): a docker-only
    // push fails with "No such image" when the image lives in buildah storage.
    expect(out).toContain(
      "buildah push openshell/sandbox-from-nemoclaw:abcd1234 docker://localhost:5000/openshell/sandbox-from-nemoclaw:abcd1234",
    );
    // Step 3 must point at NemoClaw's own create invocation (swap only --from), not a
    // pared-down command that would drop the provider/GPU/resource/env flags.
    expect(out).toContain("--from localhost:5000/openshell/sandbox-from-nemoclaw:abcd1234");
    expect(out).toContain("nemoclaw-start");
    expect(out).not.toContain("openshell sandbox create --from");
    expect(out).toContain("onboard --resume");
  });

  it("adds the Linux ARM64 (aarch64) note for the #3266 upload 404 only on Linux arm64", () => {
    printSandboxCreateRecoveryHints("failed to upload image tar into container", {
      platform: "linux",
      arch: "arm64",
    });
    expect(stderr()).toContain("known limitation on Linux ARM64 (aarch64)");
  });

  it("omits the ARM64 note for the #3266 upload 404 on x86_64 hosts", () => {
    printSandboxCreateRecoveryHints("failed to upload image tar into container", {
      platform: "linux",
      arch: "x64",
    });
    const out = stderr();
    expect(out).not.toContain("Linux ARM64 (aarch64)");
    expect(out).toContain("Workaround without rebuilding the image");
  });

  it("reconstructs NemoClaw's create command (only --from swapped) when createArgs are supplied", () => {
    printSandboxCreateRecoveryHints(
      [
        "  Built image openshell/sandbox-from-nemoclaw:abcd1234",
        "failed to upload image tar into container",
      ].join("\n"),
      {
        platform: "linux",
        arch: "arm64",
        createArgs: [
          "--from",
          "/tmp/nemoclaw-xyz/Dockerfile",
          "--name",
          "my-assistant",
          "--policy",
          "/tmp/nemoclaw-policy-xyz.yaml",
          "--provider",
          "my-assistant-slack",
        ],
      },
    );

    const out = stderr();
    // --from points at the pushed registry ref, not the (cleaned-up) Dockerfile.
    expect(out).toContain("--from localhost:5000/openshell/sandbox-from-nemoclaw:abcd1234");
    expect(out).not.toContain("/tmp/nemoclaw-xyz/Dockerfile");
    // The configured provider/name flags survive so the recreated sandbox is not misconfigured.
    expect(out).toContain("--name my-assistant");
    expect(out).toContain("--provider my-assistant-slack");
    // The temporary policy path is not echoed; a placeholder takes its place.
    expect(out).not.toContain("/tmp/nemoclaw-policy-xyz.yaml");
    expect(out).toContain("<your-policy-file>");
    // The runtime env wrapper is represented by a placeholder, never dumped verbatim.
    expect(out).toContain("nemoclaw-start");
    expect(out).toContain("<YOUR_RUNTIME_ENV>");
  });

  it("falls back to placeholder push commands when no built image tag is in the output", () => {
    printSandboxCreateRecoveryHints("failed to upload image tar into container", {
      platform: "linux",
      arch: "arm64",
    });
    expect(stderr()).toContain("<built-image>");
  });
});

describe("reconstructImageRefCreateCommand", () => {
  it("swaps --from to the registry ref and masks the temporary --policy value", () => {
    const cmd = reconstructImageRefCreateCommand(
      ["--from", "/tmp/x/Dockerfile", "--name", "asst", "--policy", "/tmp/p.yaml", "--gpus", "all"],
      "localhost:5000/openshell/sandbox:tag",
    );
    expect(cmd).toBe(
      "openshell sandbox create --from localhost:5000/openshell/sandbox:tag --name asst " +
        "--policy <your-policy-file> --gpus all -- env <YOUR_RUNTIME_ENV> nemoclaw-start",
    );
  });

  it("handles a trailing --from with no following value without crashing", () => {
    // Defensive: a malformed args array must not throw or duplicate the ref.
    const cmd = reconstructImageRefCreateCommand(["--name", "asst", "--from"], "registry/ref:1");
    expect(cmd).toBe("openshell sandbox create --name asst --from -- env <YOUR_RUNTIME_ENV> nemoclaw-start");
  });
});

describe("extractBuiltImageRef", () => {
  it("reads the ref from a 'Successfully tagged' line", () => {
    expect(extractBuiltImageRef("Successfully tagged openshell/sandbox:tag1")).toBe(
      "openshell/sandbox:tag1",
    );
  });

  it("reads the ref from a '  Built image' line", () => {
    expect(extractBuiltImageRef("  Built image openshell/sandbox-from-nemoclaw:abcd1234")).toBe(
      "openshell/sandbox-from-nemoclaw:abcd1234",
    );
  });

  it("returns null when no built image line is present", () => {
    expect(extractBuiltImageRef("nothing relevant here")).toBeNull();
    expect(extractBuiltImageRef("")).toBeNull();
  });
});
