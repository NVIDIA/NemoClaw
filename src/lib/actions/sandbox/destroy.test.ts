// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { classifyDestroyContainerIdentity } from "./destroy-container-identity";
import { assertUnambiguousDestroyContainerIdentity, cleanupSandboxServices } from "./destroy";

const SANDBOX = "mybox";
const mainPidDir = path.resolve("/tmp", `nemoclaw-services-${SANDBOX}`);
const googlechatPidDir = `${mainPidDir}-googlechat`;

describe("cleanupSandboxServices Google Chat tunnel cleanup (#7317)", () => {
  it("fails closed before later cleanup when the Google Chat tunnel cannot stop", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rmSync = vi.fn();
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const stopAll = vi.fn();
    const getSandbox = vi.fn(() => null);
    const googlechatWebhookTunnelPidDir = vi.fn(() => googlechatPidDir);
    const stopGooglechatWebhookTunnel = vi.fn(() => {
      throw new Error("cloudflared refused to stop");
    });

    expect(() =>
      cleanupSandboxServices(
        SANDBOX,
        { stopHostServices: true },
        {
          stopAll,
          getSandbox,
          rmSync,
          runOpenshell,
          stopGooglechatWebhookTunnel,
          googlechatWebhookTunnelPidDir,
        },
      ),
    ).toThrow(/public Google Chat webhook endpoint may still be running/);

    expect(googlechatWebhookTunnelPidDir).toHaveBeenCalledWith(mainPidDir);
    // Preserve both PID directories and refuse every later side effect so a
    // repeated destroy can still prove and stop the public endpoint.
    expect(rmSync).not.toHaveBeenCalled();
    expect(stopAll).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it("removes the Google Chat PID directory after a successful tunnel stop", () => {
    const rmSync = vi.fn();
    const stopGooglechatWebhookTunnel = vi.fn(() => googlechatPidDir);
    const googlechatWebhookTunnelPidDir = vi.fn(() => googlechatPidDir);

    cleanupSandboxServices(
      SANDBOX,
      { stopHostServices: true },
      {
        stopAll: vi.fn(),
        getSandbox: vi.fn(() => null),
        rmSync,
        runOpenshell: vi.fn(() => ({ status: 0 })),
        stopGooglechatWebhookTunnel,
        googlechatWebhookTunnelPidDir,
      },
    );

    expect(rmSync).toHaveBeenCalledWith(googlechatPidDir, { recursive: true, force: true });
  });
});

describe("assertUnambiguousDestroyContainerIdentity (#8999)", () => {
  const dockerSandbox = { openshellDriver: "docker" } as { openshellDriver: string | null };

  it("refuses destroy when a foreign container shares the sandbox-name label", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const classify = vi.fn(() => ({
      status: "ambiguous" as const,
      sandboxName: "destroytest",
      reason: "a foreign container carries the label",
      foreign: [{ id: "ffff", managedBy: "", workspace: "foreign", sandboxId: "" }],
      managed: [{ id: "aaaa", managedBy: "openshell", workspace: "default", sandboxId: "sb" }],
    }));

    const probe = vi.fn(() => ({ status: "ok" as const, rows: [] }));
    const proceed = assertUnambiguousDestroyContainerIdentity("destroytest", {
      getSandbox: vi.fn(() => dockerSandbox) as never,
      probe: probe as never,
      classify: classify as never,
    });

    expect(proceed).toBe(false);
    expect(probe).toHaveBeenCalledWith("destroytest");
    expect(classify).toHaveBeenCalledWith("destroytest", { status: "ok", rows: [] });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("proceeds for a clear single managed identity", () => {
    const classify = vi.fn(() => ({ status: "clear" as const }));
    expect(
      assertUnambiguousDestroyContainerIdentity("destroytest", {
        getSandbox: vi.fn(() => dockerSandbox) as never,
        probe: vi.fn(() => ({ status: "ok" as const, rows: [] })) as never,
        classify: classify as never,
      }),
    ).toBe(true);
  });

  it("does not probe or block a non-Docker runtime provider", () => {
    const probe = vi.fn();
    const classify = vi.fn();
    const proceed = assertUnambiguousDestroyContainerIdentity("destroytest", {
      getSandbox: vi.fn(() => ({ openshellDriver: "podman" })) as never,
      probe: probe as never,
      classify: classify as never,
    });
    expect(proceed).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it("fails closed when the Docker probe cannot prove identity (#8999)", () => {
    const warn = vi.fn();
    const probe = vi.fn(() => ({ status: "probe-failed" as const, detail: "daemon down" }));
    const proceed = assertUnambiguousDestroyContainerIdentity("destroytest", {
      getSandbox: vi.fn(() => dockerSandbox) as never,
      probe: probe as never,
      classify: classifyDestroyContainerIdentity,
      warn,
    });
    expect(proceed).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("daemon down"));
  });

  it("treats an unknown/null driver as Docker (the default) and still guards", () => {
    const probe = vi.fn(() => ({ status: "ok" as const, rows: [] }));
    const classify = vi.fn(() => ({ status: "clear" as const }));
    assertUnambiguousDestroyContainerIdentity("destroytest", {
      getSandbox: vi.fn(() => ({ openshellDriver: null })) as never,
      probe: probe as never,
      classify: classify as never,
    });
    expect(probe).toHaveBeenCalledWith("destroytest");
    expect(classify).toHaveBeenCalledWith("destroytest", { status: "ok", rows: [] });
  });
});
