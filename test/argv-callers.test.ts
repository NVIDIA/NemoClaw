import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

type PreflightModule = typeof import("../dist/lib/preflight.js");

function resolveCjsModule<T extends object>(module: T & { default?: unknown }): T {
  const defaultExport = module.default;
  return (defaultExport && typeof defaultExport === "object" ? defaultExport : module) as T;
}

async function importPreflightModule(): Promise<PreflightModule> {
  vi.resetModules();
  const module = await import("../dist/lib/preflight.js");
  return resolveCjsModule(module as PreflightModule & { default?: unknown });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../dist/lib/runner.js");
});

describe("argv callsites", () => {
  it("assessHost uses argv commands for host probes", async () => {
    const seen: Array<string | readonly string[]> = [];
    const preflight = await importPreflightModule();

    const assessment = preflight.assessHost({
      platform: "linux",
      env: {},
      release: "6.6.0",
      procVersion: "Linux version 6.6.0",
      readFileImpl: () => {
        throw new Error("no daemon config");
      },
      runCaptureImpl: (
        command: string | readonly string[],
        options?: { ignoreError?: boolean },
      ) => {
        seen.push(command);
        const key = Array.isArray(command) ? command.join(" ") : command;
        if (key === "which docker") return "/usr/bin/docker\n";
        if (key === "which node") return "/usr/bin/node\n";
        if (key === "which openshell") return "/usr/bin/openshell\n";
        if (key === "which nvidia-smi") return "";
        if (key === "which apt-get") return "/usr/bin/apt-get\n";
        if (key === "which systemctl") return "/usr/bin/systemctl\n";
        if (key === "docker info --format {{json .}}")
          return '{"ServerVersion":"27.0.0","OperatingSystem":"Docker Engine"}';
        if (key === "systemctl is-active docker") return "active\n";
        if (key === "systemctl is-enabled docker") return "enabled\n";
        if (options?.ignoreError) return "";
        throw new Error(`unexpected command in test stub: ${key}`);
      },
    });

    expect(assessment.dockerInstalled).toBe(true);
    expect(assessment.nodeInstalled).toBe(true);
    expect(assessment.openshellInstalled).toBe(true);
    expect(assessment.packageManager).toBe("apt");
    expect(assessment.dockerReachable).toBe(true);
    expect(seen).toContainEqual(["which", "docker"]);
    expect(seen).toContainEqual(["docker", "info", "--format", "{{json .}}"]);
    expect(seen).toContainEqual(["systemctl", "is-active", "docker"]);
    expect(seen).toContainEqual(["systemctl", "is-enabled", "docker"]);
    expect(
      seen.some((command) => typeof command === "string" && command.includes("command -v")),
    ).toBe(false);
  });

  it("probeContainerDns defaults to argv docker run", async () => {
    const seen: Array<string | readonly string[]> = [];
    const { probeContainerDns } = await importPreflightModule();

    const result = probeContainerDns({
      runCaptureImpl: (
        command: string | readonly string[],
        opts?: { ignoreError?: boolean; timeout?: number },
      ) => {
        seen.push(command);
        expect(opts?.ignoreError).toBe(true);
        expect(opts?.timeout).toBe(20_000);
        return "Server:\t1.1.1.1\nName:\tregistry.npmjs.org\nAddress: 104.16.25.35\n";
      },
    });

    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([
      [
        "docker",
        "run",
        "--rm",
        "--pull=missing",
        "busybox:latest",
        "nslookup",
        "registry.npmjs.org",
      ],
    ]);
  });

  it("getDockerBridgeGatewayIp uses argv docker inspect", async () => {
    const { getDockerBridgeGatewayIp } = await importPreflightModule();
    const seen: Array<string | readonly string[]> = [];

    const gateway = getDockerBridgeGatewayIp((command: string | readonly string[]) => {
      seen.push(command);
      return "172.17.0.1fd00:abcd::1\n";
    });

    expect(gateway).toBe("172.17.0.1");
    expect(seen).toEqual([
      [
        "docker",
        "network",
        "inspect",
        "bridge",
        "--format",
        "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
      ],
    ]);
  });

  it("getGatewayClusterContainerState uses argv docker inspect", () => {
    const onboardSrc = fs.readFileSync(new URL("../dist/lib/onboard.js", import.meta.url), "utf-8");

    expect(onboardSrc).toMatch(
      /runCapture\(\[\s*"docker",\s*"inspect",\s*"--type",\s*"container",\s*"--format",\s*"\{\{\.State\.Status\}\}\{\{if \.State\.Health\}\} \{\{\.State\.Health\.Status\}\}\{\{end\}\}",\s*containerName,\s*\], \{ ignoreError: true \}\)/,
    );
  });
});
