// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareWslNvidiaCdi, type WslNvidiaCdiDeps } from "./prepare";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const nvidia = { Source: "cdi", ID: "nvidia.com/gpu=all" };
function fixture(desktopName: unknown = "Docker Desktop 4.97.0 (12345)") {
  const info = {
    ID: "test-engine-id",
    OperatingSystem: "Docker Desktop",
    Architecture: "aarch64",
    DockerRootDir: "/var/lib/docker",
    DiscoveredDevices: [] as (typeof nvidia)[],
  };
  const dockerCapture = vi
    .fn<NonNullable<WslNvidiaCdiDeps["dockerCapture"]>>()
    .mockImplementation(() => JSON.stringify(info))
    .mockImplementationOnce(() => JSON.stringify(info))
    .mockReturnValueOnce(JSON.stringify(desktopName));
  const runCapture = vi
    .fn<NonNullable<WslNvidiaCdiDeps["runCapture"]>>()
    .mockReturnValueOnce("nat\n")
    .mockImplementation(() => {
      info.DiscoveredDevices = [nvidia];
      return "NEMOCLAW_CDI_PREPARED\n";
    });
  return {
    info,
    deps: {
      dockerCapture,
      runCapture,
      isWsl: () => true,
      arch: "arm64" as const,
      env: { PATH: "/usr/bin:/bin", DOCKER_HOST: "unix:///var/run/docker.sock" },
      realpath: vi.fn(() => "/run/docker.sock"),
    },
  };
}

describe("Docker Desktop NVIDIA CDI release gate", () => {
  it.each([
    "Docker Desktop 4.97.0",
    "Docker Desktop 4.97.0 (123)",
    "Docker Desktop 4.97.1",
    "Docker Desktop 4.98.0",
    "Docker Desktop 4.98.1",
    "Docker Desktop 4.99.0",
  ])("allows missing CDI preparation on %s", (name) => {
    const { deps, info } = fixture(name);
    expect(prepareWslNvidiaCdi(deps)).toBe(true);
    expect(deps.runCapture).toHaveBeenCalledTimes(2);
    expect(info.DiscoveredDevices).toEqual([nvidia]);
  });
  it.each(["4.94.0", "4.96.0", "4.96.99"])(
    "gives bounded upgrade advice for Desktop %s before any generation",
    (version) => {
      const { deps } = fixture(`Docker Desktop ${version}`);
      expect(() => prepareWslNvidiaCdi(deps)).toThrow(
        `NVIDIA CDI is missing and Docker Desktop ${version} is below the workaround's minimum version. ` +
          "Upgrade Docker Desktop to version 4.97.0 through 4.99.0 and retry GPU setup.",
      );
      expect(deps.runCapture.mock.calls.map(([args]) => args)).toEqual([
        ["wslinfo", "--networking-mode"],
      ]);
    },
  );
  it.each(["4.99.1", "4.100.0", "5.0.0", "29.9.2"])(
    "stops missing CDI preparation on unreviewed Desktop %s",
    (version) => {
      const { deps } = fixture(`Docker Desktop ${version}`);
      expect(() => prepareWslNvidiaCdi(deps)).toThrow(
        `NVIDIA CDI is missing on Docker Desktop ${version}, outside the workaround range ` +
          "4.97.0 through 4.99.0. No CDI file was generated. " +
          "Report the Docker Desktop version and missing NVIDIA CDI inventory for compatibility review.",
      );
      expect(deps.runCapture).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    null,
    4.97,
    "29.9.2",
    "Docker Desktop",
    "Docker Desktop 4.97.0-beta",
    "Docker Desktop 04.97.0",
    "Docker Desktop 4.97.0; touch /tmp/unsafe",
    "Docker Desktop 9007199254740992.97.0",
  ])("rejects ambiguous product identity %j before generation", (name) => {
    const { deps } = fixture(name);
    expect(() => prepareWslNvidiaCdi(deps)).toThrow();
    expect(deps.runCapture).toHaveBeenCalledTimes(1);
  });
});

describe("WSL NVIDIA CDI preparation", () => {
  it("leaves x86 WSL hosts on their existing route without host preparation", () => {
    const { deps } = fixture();
    expect(prepareWslNvidiaCdi({ ...deps, arch: "x64" })).toBe(false);
    expect(deps.realpath).not.toHaveBeenCalled();
    expect(deps.dockerCapture).not.toHaveBeenCalled();
    expect(deps.runCapture).not.toHaveBeenCalled();
  });
  it("rejects an active transaction even when Docker already discovers its device", () => {
    const { info, deps } = fixture();
    info.DiscoveredDevices = [nvidia];
    deps.runCapture.mockImplementation(() => {
      throw new Error("active transaction");
    });
    expect(() => prepareWslNvidiaCdi(deps)).toThrow("active transaction");
    expect(deps.dockerCapture).toHaveBeenCalledTimes(1);
  });
  it.each([
    "/run/docker.sock",
    "/mnt/wsl/docker-desktop/shared-sockets/guest-services/docker.sock",
    "/mnt/wsl/docker-desktop/shared-sockets/host-services/docker.proxy.sock",
  ])("prepares a missing device through %s and confirms the selected daemon", (socket) => {
    const { deps } = fixture();
    deps.realpath.mockReturnValue(socket);
    expect(prepareWslNvidiaCdi(deps)).toBe(true);
    expect(deps.runCapture.mock.calls[1][0]).toEqual([
      "wsl.exe",
      "--distribution",
      "docker-desktop",
      "--user",
      "root",
      "--exec",
      "/bin/sh",
      "-s",
      "--",
      "test-engine-id",
      "1",
    ]);
    expect(
      deps.dockerCapture.mock.calls.every(
        ([args]) => args[0] === "--host" && args[1] === deps.env.DOCKER_HOST,
      ),
    ).toBe(true);
  });
  it.each(["4.96.0", "4.99.1", "5.0.0", "unknown"])(
    "preserves existing NVIDIA CDI on Desktop %s without looking up its version",
    (version) => {
      const { info, deps } = fixture(`Docker Desktop ${version}`);
      info.DiscoveredDevices = [nvidia];
      deps.dockerCapture.mockReset().mockImplementation(() => JSON.stringify(info));
      expect(prepareWslNvidiaCdi(deps)).toBe(true);
      expect(deps.runCapture).toHaveBeenCalledTimes(2);
      expect(deps.runCapture.mock.calls[1][0].at(-1)).toBe("0");
      expect(deps.dockerCapture).toHaveBeenCalledTimes(2);
      expect(deps.dockerCapture.mock.calls[0][0]).not.toContain("version");
    },
  );
  it.each([undefined, null])("prepares when Docker omits empty inventory %j", (inventory) => {
    const { deps, info } = fixture();
    deps.dockerCapture
      .mockReset()
      .mockReturnValueOnce(JSON.stringify({ ...info, DiscoveredDevices: inventory }))
      .mockReturnValueOnce(JSON.stringify("Docker Desktop 4.97.0"))
      .mockReturnValue(JSON.stringify({ ...info, DiscoveredDevices: [nvidia] }));
    expect(prepareWslNvidiaCdi(deps)).toBe(true);
    expect(deps.runCapture.mock.calls[1][0].at(-1)).toBe("1");
  });
  it.each([undefined, null])("rejects missing post-install inventory %j", (inventory) => {
    const { deps, info } = fixture();
    deps.dockerCapture
      .mockReset()
      .mockReturnValueOnce(JSON.stringify(info))
      .mockReturnValueOnce(JSON.stringify("Docker Desktop 4.97.0"))
      .mockReturnValue(JSON.stringify({ ...info, DiscoveredDevices: inventory }));
    expect(() => prepareWslNvidiaCdi(deps)).toThrow(/inventory is unavailable/);
    expect(deps.runCapture).toHaveBeenCalledTimes(2);
  });
  it.each(["invalid", {}, [null], [{ Source: "cdi" }]])(
    "rejects malformed CDI inventory %j",
    (inventory) => {
      const { deps, info } = fixture();
      deps.dockerCapture
        .mockReset()
        .mockReturnValue(JSON.stringify({ ...info, DiscoveredDevices: inventory }));
      expect(() => prepareWslNvidiaCdi(deps)).toThrow(/inventory is unavailable/);
      expect(deps.runCapture).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["mirrored", "virtioproxy", "", "unknown"])(
    "rejects networking mode %s without changing it",
    (mode) => {
      const { deps } = fixture();
      deps.runCapture.mockReset().mockReturnValue(mode);
      expect(() => prepareWslNvidiaCdi(deps)).toThrow(/requires NAT/);
      expect(deps.runCapture.mock.calls.map(([args]) => args)).toEqual([
        ["wslinfo", "--networking-mode"],
      ]);
    },
  );
  it.each(["tcp://remote:2375", "ssh://remote", "npipe:////./pipe/docker_engine"])(
    "rejects remote or unsupported endpoint %s",
    (endpoint) => {
      const { deps } = fixture();
      deps.env.DOCKER_HOST = endpoint;
      expect(() => prepareWslNvidiaCdi(deps)).toThrow(/Remote Docker/);
      expect(deps.runCapture).not.toHaveBeenCalled();
    },
  );
  it("rejects a local socket outside Docker Desktop's integration", () => {
    const { deps } = fixture();
    deps.realpath.mockReturnValue("/run/user/1000/docker.sock");
    expect(() => prepareWslNvidiaCdi(deps)).toThrow(/recognized local/);
    expect(deps.dockerCapture).not.toHaveBeenCalled();
  });
  it.each([
    { Architecture: "x86_64" },
    { OperatingSystem: "Linux" },
    { DockerRootDir: "/other" },
    { ID: "bad\nidentity" },
  ])("rejects an unqualified daemon %j", (overrides) => {
    const { info, deps } = fixture();
    Object.assign(info, overrides);
    expect(() => prepareWslNvidiaCdi(deps)).toThrow(/expected ARM64/);
    expect(deps.runCapture).not.toHaveBeenCalled();
  });
  it("does not pass contributor credentials to WSL commands", () => {
    const { deps } = fixture();
    const runCapture = vi.fn(deps.runCapture);
    prepareWslNvidiaCdi({
      ...deps,
      runCapture,
      env: {
        ...deps.env,
        NVIDIA_API_KEY: "fake-secret",
        WSLENV: "NVIDIA_API_KEY/u",
        SSH_AUTH_SOCK: "/fake/agent",
      },
    });
    expect(
      runCapture.mock.calls.map(([, options]) => ({
        replaceEnv: options?.replaceEnv,
        env: options?.env,
      })),
    ).toEqual([
      { replaceEnv: true, env: { PATH: "/usr/bin:/bin" } },
      { replaceEnv: true, env: { PATH: "/usr/bin:/bin" } },
    ]);
  });
  it("stops after a generation command fails without retry or fallback", () => {
    const { deps } = fixture();
    deps.runCapture.mockImplementation(() => {
      throw new Error("preparation failed");
    });
    expect(() => prepareWslNvidiaCdi(deps)).toThrow("preparation failed");
    expect(deps.runCapture).toHaveBeenCalledTimes(2);
  });
  it("reports a real host command's recovery cause without its credentials or unbounded output", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cdi-host-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "wslinfo"), "#!/bin/sh\nprintf 'nat\\n'\n", { mode: 0o700 });
    fs.writeFileSync(
      path.join(root, "wsl.exe"),
      `#!/bin/sh
printf 'called\\n' >> "\${0%/*}/calls"
printf '%s\\n' 'CDI preparation is active or interrupted; inspect its lock before retrying' >&2
printf '%s\\n' 'NVIDIA_API_KEY=fixture-private-value https://user:fixture-password@example.invalid/' >&2
printf '%s\\n' '${"x".repeat(500)}' >&2
exit 1
`,
      { mode: 0o700 },
    );
    const { deps } = fixture();
    let error: unknown;
    try {
      prepareWslNvidiaCdi({ ...deps, runCapture: undefined, env: { PATH: root } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("active or interrupted; inspect its lock");
    expect(message).toContain("wsl.exe");
    expect(message).toContain("no retry was attempted");
    expect(message).not.toContain("fixture-private-value");
    expect(message).not.toContain("fixture-password");
    expect(message.length).toBeLessThan(350);
    expect(fs.readFileSync(path.join(root, "calls"), "utf8")).toBe("called\n");
    expect(deps.dockerCapture).toHaveBeenCalledTimes(2);
  });
  it("identifies a missing host executable without attempting generation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cdi-host-"));
    roots.push(root);
    const { deps } = fixture();
    expect(() =>
      prepareWslNvidiaCdi({ ...deps, runCapture: undefined, env: { PATH: root } }),
    ).toThrow(/wslinfo.*ENOENT/);
    expect(deps.dockerCapture).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["same daemon, missing inventory", {}],
    ["changed daemon", { ID: "different", DiscoveredDevices: [nvidia] }],
  ])("rejects inconclusive post-install verification: %s", (_kind, overrides) => {
    const { info, deps } = fixture();
    deps.runCapture.mockImplementation(() => {
      Object.assign(info, overrides);
      return "NEMOCLAW_CDI_PREPARED";
    });
    expect(() => prepareWslNvidiaCdi(deps)).toThrow(/discovery was not confirmed/);
  });
});
