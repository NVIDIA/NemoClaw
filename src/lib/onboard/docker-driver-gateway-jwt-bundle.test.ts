// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  expectEd25519BundleSignsAndVerifies,
  jwtBundlePaths,
  writeGatewayConfig,
} from "../../../test/support/openshell-gateway-config-helpers";
import { ensureDockerDriverGatewayJwtBundle } from "./docker-driver-gateway-jwt-bundle";

const CONCURRENT_CALLER_COUNT = 12;

function spawnConcurrentJwtBundleCaller(
  stateDir: string,
  startPath: string,
): {
  ready: Promise<void>;
  done: Promise<{ code: number | null; stderr: string; stdout: string }>;
} {
  const script = String.raw`
const crypto = (await import("node:crypto")).default;
const fs = (await import("node:fs")).default;

const loaded = await import("./src/lib/onboard/docker-driver-gateway-jwt-bundle.ts");
const ensureDockerDriverGatewayJwtBundle =
  (loaded.default ?? loaded).ensureDockerDriverGatewayJwtBundle;
process.stdout.write("READY\n");
const waitView = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 15_000;
while (!fs.existsSync(process.env.NEMOCLAW_TEST_JWT_START)) {
  if (Date.now() >= deadline) throw new Error("timed out waiting for concurrent JWT start");
  Atomics.wait(waitView, 0, 0, 5);
}
const bundle = ensureDockerDriverGatewayJwtBundle(process.env.NEMOCLAW_TEST_JWT_STATE_DIR);
const signingKeyHash = crypto
  .createHash("sha256")
  .update(fs.readFileSync(bundle.signingKeyPath))
  .digest("hex");
const kid = fs.readFileSync(bundle.kidPath, "utf8").trim();
process.stdout.write("RESULT " + JSON.stringify({ kid, signingKeyHash }) + "\n");
`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: {
        ...process.env,
        NEMOCLAW_TEST_JWT_START: startPath,
        NEMOCLAW_TEST_JWT_STATE_DIR: stateDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let readyTimeout!: NodeJS.Timeout;
  const ready = Promise.race([
    once(child.stdout, "data").then(() => undefined),
    once(child, "close").then(() => {
      throw new Error(`JWT child exited before ready: ${stderr}`);
    }),
    new Promise<void>((_resolve, reject) => {
      readyTimeout = setTimeout(
        () => reject(new Error(`JWT child did not become ready: ${stderr}`)),
        15_000,
      );
    }),
  ]).finally(() => clearTimeout(readyTimeout));
  const done = new Promise<{ code: number | null; stderr: string; stdout: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(readyTimeout);
        resolve({ code, stderr, stdout });
      });
    },
  );
  return { ready, done };
}

describe("docker-driver-gateway JWT bundle", () => {
  it("preserves a complete gateway JWT bundle across config rewrites", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    try {
      writeGatewayConfig(stateDir);
      const paths = jwtBundlePaths(stateDir);
      const firstSigningKey = fs.readFileSync(paths.signingKeyPath, "utf-8");
      expectEd25519BundleSignsAndVerifies(paths);

      writeGatewayConfig(stateDir);

      expect(fs.readFileSync(paths.signingKeyPath, "utf-8")).toBe(firstSigningKey);
      expectEd25519BundleSignsAndVerifies(paths);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "malformed signing key",
      corrupt: (paths: ReturnType<typeof jwtBundlePaths>) => {
        fs.writeFileSync(paths.signingKeyPath, "not a private key\n", { mode: 0o600 });
      },
    },
    {
      name: "empty kid",
      corrupt: (paths: ReturnType<typeof jwtBundlePaths>) => {
        fs.writeFileSync(paths.kidPath, "\n", { mode: 0o600 });
      },
    },
    {
      name: "mismatched public key",
      corrupt: (paths: ReturnType<typeof jwtBundlePaths>) => {
        const otherStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
        try {
          writeGatewayConfig(otherStateDir);
          fs.copyFileSync(jwtBundlePaths(otherStateDir).publicKeyPath, paths.publicKeyPath);
        } finally {
          fs.rmSync(otherStateDir, { recursive: true, force: true });
        }
      },
    },
  ])("regenerates a complete gateway JWT bundle when $name", ({ corrupt }) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    try {
      writeGatewayConfig(stateDir);
      const paths = jwtBundlePaths(stateDir);
      const firstSigningKey = fs.readFileSync(paths.signingKeyPath, "utf-8");

      corrupt(paths);
      writeGatewayConfig(stateDir);

      expect(fs.readFileSync(paths.signingKeyPath, "utf-8")).not.toBe(firstSigningKey);
      expectEd25519BundleSignsAndVerifies(paths);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("regenerates an incomplete gateway JWT bundle before writing config", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    try {
      const jwtDir = path.join(stateDir, "jwt");
      fs.mkdirSync(jwtDir, { recursive: true, mode: 0o700 });
      const signingKeyPath = path.join(jwtDir, "signing.pem");
      const publicKeyPath = path.join(jwtDir, "public.pem");
      const kidPath = path.join(jwtDir, "kid");
      fs.writeFileSync(signingKeyPath, "stale partial key\n", { mode: 0o600 });

      writeGatewayConfig(stateDir);

      const toml = fs.readFileSync(path.join(stateDir, "openshell-gateway.toml"), "utf-8");
      expect(fs.readFileSync(signingKeyPath, "utf-8")).not.toBe("stale partial key\n");
      expect(fs.existsSync(publicKeyPath)).toBe(true);
      expect(fs.existsSync(kidPath)).toBe(true);
      expect(fs.statSync(jwtDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(signingKeyPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(publicKeyPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(kidPath).mode & 0o777).toBe(0o600);
      expect(toml).toContain(`signing_key_path = "${signingKeyPath}"`);
      expect(toml).toContain(`public_key_path = "${publicKeyPath}"`);
      expect(toml).toContain(`kid_path = "${kidPath}"`);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("recovers after a crashed temp JWT bundle write without publishing partial files", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    try {
      const staleTmpDir = fs.mkdtempSync(path.join(stateDir, ".jwt-tmp-"));
      fs.writeFileSync(path.join(staleTmpDir, "signing.pem"), "stale temp key\n", {
        mode: 0o600,
      });

      writeGatewayConfig(stateDir);

      const paths = jwtBundlePaths(stateDir);
      const toml = fs.readFileSync(path.join(stateDir, "openshell-gateway.toml"), "utf-8");
      expect(fs.readdirSync(stateDir).filter((entry) => entry.startsWith(".jwt-tmp-"))).toEqual([]);
      expect(toml).toContain(`signing_key_path = "${paths.signingKeyPath}"`);
      expect(toml).not.toContain(staleTmpDir);
      expectEd25519BundleSignsAndVerifies(paths);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("supports a bounded no-wait policy while another process owns the JWT lock", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    try {
      fs.writeFileSync(path.join(stateDir, ".jwt-generating"), "other-process\n", {
        mode: 0o600,
      });

      expect(() => ensureDockerDriverGatewayJwtBundle(stateDir, { lockWaitMs: 0 })).toThrow(
        /JWT bundle generation is already in progress/,
      );
      expect(fs.existsSync(path.join(stateDir, "jwt"))).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("serializes 12 concurrent callers onto one valid gateway JWT bundle", {
    timeout: 30_000,
  }, async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    const startPath = path.join(stateDir, ".start-concurrent-callers");
    try {
      const callers = Array.from({ length: CONCURRENT_CALLER_COUNT }, () =>
        spawnConcurrentJwtBundleCaller(stateDir, startPath),
      );
      await Promise.all(callers.map((caller) => caller.ready));
      fs.writeFileSync(startPath, "start\n", { mode: 0o600 });

      const results = await Promise.all(callers.map((caller) => caller.done));
      expect(results.map((result) => result.code)).toEqual(Array(CONCURRENT_CALLER_COUNT).fill(0));
      expect(results.map((result) => result.stderr)).toEqual(
        Array(CONCURRENT_CALLER_COUNT).fill(""),
      );
      const published = results.map((result) => {
        const line = result.stdout.split("\n").find((candidate) => candidate.startsWith("RESULT "));
        expect(line, result.stdout).toBeDefined();
        return JSON.parse(line?.slice("RESULT ".length) ?? "{}") as {
          kid: string;
          signingKeyHash: string;
        };
      });
      expect(new Set(published.map((entry) => entry.kid)).size).toBe(1);
      expect(new Set(published.map((entry) => entry.signingKeyHash)).size).toBe(1);
      expectEd25519BundleSignsAndVerifies(jwtBundlePaths(stateDir));
      expect(fs.existsSync(path.join(stateDir, ".jwt-generating"))).toBe(false);
      expect(fs.readdirSync(stateDir).filter((entry) => entry.startsWith(".jwt-tmp-"))).toEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("recovers a gateway JWT generation lock left by a crashed process", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    const ownerPid = 424242;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(pid).toBe(ownerPid);
      expect(signal).toBe(0);
      const error = new Error("process does not exist") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });
    try {
      const lockPath = path.join(stateDir, ".jwt-generating");
      fs.writeFileSync(lockPath, `${ownerPid}\n`, { mode: 0o600 });

      writeGatewayConfig(stateDir);

      expect(killSpy).toHaveBeenCalledOnce();
      expect(fs.existsSync(lockPath)).toBe(false);
      expectEd25519BundleSignsAndVerifies(jwtBundlePaths(stateDir));
    } finally {
      killSpy.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves a replacement lock when its nonce changes during stale recovery", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    const lockPath = path.join(stateDir, ".jwt-generating");
    const ownerPid = 424242;
    const replacementOwner = `${ownerPid} replacement-nonce\n`;
    fs.writeFileSync(lockPath, `${ownerPid} stale-nonce\n`, { mode: 0o600 });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      fs.writeFileSync(lockPath, replacementOwner, { mode: 0o600 });
      const error = new Error("process does not exist") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });
    try {
      expect(() => ensureDockerDriverGatewayJwtBundle(stateDir, { lockWaitMs: 0 })).toThrow(
        /JWT bundle generation is already in progress/,
      );

      expect(killSpy).toHaveBeenCalledWith(ownerPid, 0);
      expect(fs.readFileSync(lockPath, "utf-8")).toBe(replacementOwner);
      expect(fs.existsSync(path.join(stateDir, "jwt"))).toBe(false);
    } finally {
      killSpy.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("treats the gateway config file as the final atomic commitment record", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    try {
      const staleTmpConfig = path.join(stateDir, ".openshell-gateway.toml.tmp-crashed");
      fs.writeFileSync(staleTmpConfig, "partial config\n", { mode: 0o600 });

      writeGatewayConfig(stateDir);

      const configPath = path.join(stateDir, "openshell-gateway.toml");
      const toml = fs.readFileSync(configPath, "utf-8");
      expect(fs.existsSync(staleTmpConfig)).toBe(false);
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      expect(toml).toContain("[openshell.gateway.gateway_jwt]");
      expect(toml).toContain("allow_unauthenticated_users = false");
      expectEd25519BundleSignsAndVerifies(jwtBundlePaths(stateDir));
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("surfaces unexpected JWT bundle read failures instead of silently regenerating", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    try {
      writeGatewayConfig(stateDir);
      const paths = jwtBundlePaths(stateDir);
      const originalReadFileSync = fs.readFileSync.bind(fs);
      const denied = new Error(
        "permission denied while reading signing key",
      ) as NodeJS.ErrnoException;
      denied.code = "EACCES";
      const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((
        filePath: fs.PathOrFileDescriptor,
        options?: Parameters<typeof fs.readFileSync>[1],
      ) => {
        const read = () => originalReadFileSync(filePath, options as never);
        const reject = () => {
          throw denied;
        };
        return filePath === paths.signingKeyPath ? reject() : read();
      }) as typeof fs.readFileSync);

      expect(() => writeGatewayConfig(stateDir)).toThrow(/permission denied/);
      readSpy.mockRestore();
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
