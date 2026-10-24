// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { X509Certificate, createPrivateKey, generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createPrivateShareRoot } from "./native-private-share.mts";
import { preflightNativeGatewayConfig } from "./native-gateway-preflight.mts";
import { readOpenedRegularFile } from "./native-security.mts";
import {
  allowlistedWindowsEnvironment,
  requiredFile,
  removeDirectory,
  stopChild,
} from "./run-installed-native-turn.mts";

type TlsMaterial = {
  schemaVersion: 1;
  caCertificate: string;
  serverCertificate: string;
  serverPrivateKey: string;
  clientCertificate: string;
  clientPrivateKey: string;
};

function fail(message: string): never {
  throw new Error(`Native gateway session failed: ${message}`);
}

function readGatewayReceipt(file: string) {
  const text = readOpenedRegularFile(file, {
    encoding: "utf8",
    maxBytes: 512,
    rejectLinks: true,
    rejectHardLinks: true,
  });
  if (text === null) fail("the gateway receipt is missing");
  return JSON.parse(text);
}

function parseMaterial(bytes: Buffer): TlsMaterial {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1)
      throw new Error();
    const keys = [
      "caCertificate",
      "clientCertificate",
      "clientPrivateKey",
      "schemaVersion",
      "serverCertificate",
      "serverPrivateKey",
    ];
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) throw new Error();
    for (const key of keys.filter((key) => key !== "schemaVersion"))
      if (typeof value[key] !== "string" || value[key].length > 4096) throw new Error();
    const ca = new X509Certificate(value.caCertificate);
    const server = new X509Certificate(value.serverCertificate);
    const client = new X509Certificate(value.clientCertificate);
    if (
      !ca.ca ||
      server.ca ||
      client.ca ||
      !ca.verify(ca.publicKey) ||
      !server.checkIssued(ca) ||
      !client.checkIssued(ca) ||
      !server.verify(ca.publicKey) ||
      !client.verify(ca.publicKey) ||
      !server.checkPrivateKey(createPrivateKey(value.serverPrivateKey)) ||
      !client.checkPrivateKey(createPrivateKey(value.clientPrivateKey)) ||
      server.checkIP("127.0.0.1") !== "127.0.0.1" ||
      server.checkHost("localhost") !== "localhost" ||
      !client.subject.split("\n").includes("OU=openshell-user") ||
      client.subject.split("\n").filter((line) => line.startsWith("OU=")).length !== 1 ||
      JSON.stringify(server.keyUsage) !== JSON.stringify(["1.3.6.1.5.5.7.3.1"]) ||
      JSON.stringify(client.keyUsage) !== JSON.stringify(["1.3.6.1.5.5.7.3.2"])
    )
      throw new Error();
    for (const certificate of [ca, server, client]) {
      if (
        certificate.publicKey.asymmetricKeyType !== "ec" ||
        certificate.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
        !(
          Date.parse(certificate.validFrom) <= Date.now() &&
          Date.parse(certificate.validTo) > Date.now()
        )
      )
        throw new Error();
    }
    return value as TlsMaterial;
  } catch {
    // Parse and crypto errors can contain input bytes. Never propagate their cause.
    fail("the certificate helper returned invalid material");
  }
}

async function readMaterial(executable: string, ownProcess: (child: ChildProcess) => void) {
  const child = spawn(executable, ["--gateway-tls-material"], {
    env: allowlistedWindowsEnvironment(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  ownProcess(child);
  return await new Promise<TlsMaterial>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let rejected = false;
    const erase = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const failure = () => {
      rejected = true;
      erase();
      reject(
        new Error(
          "Native gateway session failed: certificate helper failed or exceeded its bounds",
        ),
      );
    };
    const timer = setTimeout(() => {
      child.kill();
      failure();
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (rejected || length > 16 * 1024) {
        chunk.fill(0);
        child.kill();
        failure();
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      chunk.fill(0);
      child.kill();
      failure();
    });
    child.once("error", () => {
      clearTimeout(timer);
      failure();
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (rejected || code !== 0) return failure();
      const bytes = Buffer.concat(chunks, length);
      try {
        resolve(parseMaterial(bytes));
      } catch (error) {
        reject(error);
      } finally {
        bytes.fill(0);
        erase();
      }
    });
  });
}

/** Owns gateway credentials outside both the workload share and ordinary logs. */
export class NativeGatewaySession {
  readonly root: string;
  private readonly children = new Set<ChildProcess>();
  private readonly commands = new Set<ChildProcess>();
  private owned = false;
  private prepared = false;
  private disposed = false;
  private readonly installation: string;
  private gateway: ChildProcess | null = null;
  private gatewayDrained = false;
  private readonly stopNonce = randomBytes(24).toString("hex");

  constructor(installation: string, runRoot: string) {
    this.installation = path.resolve(installation);
    const run = path.resolve(runRoot);
    if (run === path.parse(run).root) fail("the run directory cannot be a drive root");
    // A sibling is not removed by the launcher's ordinary run-root cleanup if a
    // creator or gateway cannot stop. This owner retains it and reports failure.
    this.root = `${run}-gateway-private`;
  }

  spawnGateway(executable: string, arguments_: string[], options: SpawnOptions): ChildProcess {
    if (!this.prepared || this.disposed) fail("the gateway session is not ready");
    if (this.gateway) fail("the gateway session already owns a gateway");
    if (options.shell || options.detached) fail("the gateway owner cannot use a shell or detach");
    if (
      path.resolve(executable).toLowerCase() !==
      path.join(this.installation, "bin", "openshell-gateway.exe").toLowerCase()
    )
      fail("the gateway executable is not the installed gateway");
    const helper = requiredFile(
      path.join(this.installation, "native-ui", "NemoClaw.Bootstrapper.exe"),
      "gateway owner",
    );
    this.gateway = spawn(
      helper,
      [
        "--gateway-process",
        path.join(this.root, "gateway.stop"),
        path.join(this.root, "gateway-stopped.json"),
        this.stopNonce,
        ...arguments_,
      ],
      options,
    );
    return this.gateway;
  }

  async stopGateway(): Promise<boolean> {
    if (this.gatewayDrained) return true;
    const child = this.gateway;
    if (!child?.pid) return true;
    if (child.exitCode === null && child.signalCode === null) {
      const stop = path.join(this.root, "gateway.stop");
      try {
        // Publish only complete bytes. A direct write exposes an empty or partial
        // nonce to the native reader. Linking also refuses an existing stop file.
        const pending = stop + ".pending";
        fs.writeFileSync(pending, this.stopNonce, { flag: "wx", mode: 0o600 });
        fs.linkSync(pending, stop);
      } catch {
        try {
          if (fs.readFileSync(stop, "utf8") !== this.stopNonce) {
            child.kill();
            return false;
          }
        } catch {
          child.kill();
          return false;
        }
      }
      const exited = await new Promise<boolean>((resolve) => {
        const onExit = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          child.off("exit", onExit);
          resolve(false);
        }, 5000);
        child.once("exit", onExit);
        if (child.exitCode !== null || child.signalCode !== null) {
          child.off("exit", onExit);
          onExit();
        }
      });
      if (!exited) {
        child.kill();
        return false;
      }
    }
    // Even forced termination kills the job, but only the live owner can prove
    // it drained. Missing/invalid evidence retains the private credentials.
    try {
      const file = path.join(this.root, "gateway-stopped.json");
      const receipt = readGatewayReceipt(file);
      this.gatewayDrained =
        receipt.schemaVersion === 1 &&
        receipt.nonce === this.stopNonce &&
        receipt.stopped === true &&
        receipt.activeProcesses === 0 &&
        typeof receipt.requested === "boolean" &&
        Number.isInteger(receipt.gatewayExitCode) &&
        receipt.gatewayExitCode >= 0 &&
        receipt.gatewayExitCode <= 0xffffffff;
      return this.gatewayDrained;
    } catch {
      return false;
    }
  }

  get gatewayProcessId(): number {
    if (!this.gateway || this.disposed) fail("the gateway session is not running");
    try {
      const file = path.join(this.root, "gateway-stopped.json.started");
      const receipt = readGatewayReceipt(file);
      if (
        receipt.schemaVersion !== 1 ||
        receipt.nonce !== this.stopNonce ||
        !Number.isInteger(receipt.gatewayProcessId) ||
        receipt.gatewayProcessId < 1 ||
        receipt.gatewayProcessId > 0xffffffff
      )
        throw new Error();
      return receipt.gatewayProcessId;
    } catch {
      fail("the gateway process identity is not available");
    }
  }

  async prepare(): Promise<void> {
    if (this.prepared || this.owned || this.disposed) fail("the gateway session cannot be reused");
    const executable = requiredFile(
      path.join(this.installation, "native-ui", "NemoClaw.Bootstrapper.exe"),
      "gateway certificate helper",
    );
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) fail("Windows system root is missing");
    await createPrivateShareRoot(
      this.root,
      systemRoot,
      (child) => this.children.add(child),
      () => {
        this.owned = true;
      },
    );
    const material = await readMaterial(executable, (child) => this.children.add(child));
    for (const directory of [
      "tls",
      "tls/server",
      "tls/client",
      "tls/jwt",
      "config",
      "state",
      "mxc",
    ])
      fs.mkdirSync(path.join(this.root, directory));
    const jwt = generateKeyPairSync("ed25519");
    const files: [string, string | Buffer][] = [
      ["tls/ca.crt", material.caCertificate],
      ["tls/server/tls.crt", material.serverCertificate],
      ["tls/server/tls.key", material.serverPrivateKey],
      ["tls/client/tls.crt", material.clientCertificate],
      ["tls/client/tls.key", material.clientPrivateKey],
      ["tls/jwt/signing.pem", jwt.privateKey.export({ type: "pkcs8", format: "pem" })],
      ["tls/jwt/public.pem", jwt.publicKey.export({ type: "spki", format: "pem" })],
      ["tls/jwt/kid", randomBytes(16).toString("hex") + "\n"],
    ];
    for (const [relative, content] of files)
      fs.writeFileSync(path.join(this.root, relative), content, { flag: "wx", mode: 0o600 });
    this.prepared = true;
  }

  get environment(): NodeJS.ProcessEnv {
    if (!this.prepared || this.disposed) fail("the gateway session is not ready");
    return {
      OPENSHELL_LOCAL_TLS_DIR: path.join(this.root, "tls"),
      XDG_CONFIG_HOME: path.join(this.root, "config"),
      XDG_STATE_HOME: path.join(this.root, "state"),
    };
  }

  get ownCommandProcess(): (child: ChildProcess) => void {
    if (this.disposed) fail("the gateway session is disposed");
    return (child) => {
      this.children.add(child);
      this.commands.add(child);
      child.once("close", () => {
        this.children.delete(child);
        this.commands.delete(child);
      });
    };
  }

  preflightConfiguration(file: string): void {
    if (this.disposed || this.gateway)
      fail("configuration validation must precede gateway startup");
    preflightNativeGatewayConfig(this.installation, file, this.root);
  }

  configuration(template: string): string {
    if (this.disposed) fail("the gateway session is disposed");
    if (
      /openshell\.gateway|^\s*(?:allow_driver_config|state_dir|supervisor_binary_path|sandbox_binary_path)\s*=/mu.test(
        template,
      )
    )
      fail("the gateway template cannot override session-owned authentication or state");
    const quote = (value: string) => JSON.stringify(value).replace(/\u007f/gu, "\\u007f");
    const driver = [
      // MXC requires command/cwd in driver_config. Only this session's
      // authenticated CLI can submit them; workload policy remains mandatory.
      "allow_driver_config = true",
      `state_dir = ${quote(path.join(this.root, "mxc"))}`,
      `supervisor_binary_path = ${quote(path.join(this.installation, "bin", "openshell-supervisor.exe"))}`,
      `sandbox_binary_path = ${quote(path.join(this.installation, "bin", "openshell-windows-sandbox.exe"))}`,
    ].join("\n");
    const rendered = template.replace(
      /^(\s*\[\s*openshell\.drivers\.mxc\s*\]\s*(?:#.*)?)$/mu,
      (header) => `${header}\n${driver}`,
    );
    if (rendered === template) fail("the MXC driver section is missing");
    return (
      rendered +
      "\n[openshell.gateway]\ndisable_tls = false\n" +
      "\n[openshell.gateway.auth]\nallow_unauthenticated_users = false\n" +
      "\n[openshell.gateway.mtls_auth]\nenabled = true\n"
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    let stopped = await this.stopGateway();
    for (const child of this.children) {
      // A spawn error has no PID and therefore no process to terminate.
      if (child.pid && !(await stopChild(child))) stopped = false;
    }
    if (!stopped) fail("an owned process did not stop; private gateway state is retained");
    if (this.commands.size !== 0)
      fail("owned command pipes did not close; private gateway state is retained");
    if (this.owned && !(await removeDirectory(this.root)))
      fail("private gateway state could not be removed");
    if (!this.owned && fs.existsSync(this.root))
      fail("the private gateway directory is unowned and was retained");
    this.disposed = true;
  }
}
