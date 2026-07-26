// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const GATEWAY_JWT_DIR_NAME = "jwt";
const GATEWAY_JWT_TMP_PREFIX = ".jwt-tmp-";
const GATEWAY_JWT_GENERATING_NAME = ".jwt-generating";
const GATEWAY_JWT_LOCK_WAIT_MS = 5_000;
const GATEWAY_JWT_LOCK_RETRY_MS = 20;
const GATEWAY_JWT_LOCK_WAIT_VIEW = new Int32Array(new SharedArrayBuffer(4));

export type DockerDriverGatewayJwtBundle = {
  signingKeyPath: string;
  publicKeyPath: string;
  kidPath: string;
};

function existingFileCount(paths: string[]): number {
  return paths.filter((candidate) => fs.existsSync(candidate)).length;
}

function writeRestrictedFile(filePath: string, value: string, mode = 0o600): void {
  fs.writeFileSync(filePath, value, { encoding: "utf-8", mode });
  fs.chmodSync(filePath, mode);
}

function dockerDriverGatewayJwtBundleForDir(jwtDir: string): DockerDriverGatewayJwtBundle {
  return {
    signingKeyPath: path.join(jwtDir, "signing.pem"),
    publicKeyPath: path.join(jwtDir, "public.pem"),
    kidPath: path.join(jwtDir, "kid"),
  };
}

function normalizeDockerDriverGatewayJwtBundlePermissions(
  bundle: DockerDriverGatewayJwtBundle,
): void {
  fs.chmodSync(path.dirname(bundle.signingKeyPath), 0o700);
  fs.chmodSync(bundle.signingKeyPath, 0o600);
  fs.chmodSync(bundle.publicKeyPath, 0o600);
  fs.chmodSync(bundle.kidPath, 0o600);
}

function dockerDriverGatewayJwtBundleIsValid(bundle: DockerDriverGatewayJwtBundle): boolean {
  try {
    const kid = fs.readFileSync(bundle.kidPath, "utf-8").trim();
    if (!kid) return false;
    const privateKey = createPrivateKey(fs.readFileSync(bundle.signingKeyPath, "utf-8"));
    const publicKey = createPublicKey(fs.readFileSync(bundle.publicKeyPath, "utf-8"));
    if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
      return false;
    }
    const payload = Buffer.from("nemoclaw-openshell-gateway-jwt-bundle-check", "utf-8");
    const signature = sign(null, payload, privateKey);
    return verify(null, payload, publicKey, signature);
  } catch (error) {
    if (!isExpectedJwtBundleValidationError(error)) throw error;
    return false;
  }
}

function isExpectedJwtBundleValidationError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as NodeJS.ErrnoException).code);
    if (code === "ENOENT" || code.startsWith("ERR_OSSL_")) return true;
  }
  if (!(error instanceof Error)) return false;
  return /PEM|ASN1|DECODER|unsupported/i.test(error.message);
}

function cleanupStaleDockerDriverGatewayJwtTempDirs(stateDir: string): void {
  for (const entry of fs.readdirSync(stateDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(GATEWAY_JWT_TMP_PREFIX)) {
      fs.rmSync(path.join(stateDir, entry.name), { recursive: true, force: true });
    }
  }
}

function removeStaleDockerDriverGatewayJwtGenerationLock(lockPath: string): boolean {
  let observedOwner: string;
  try {
    observedOwner = fs.readFileSync(lockPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }

  const pidText = observedOwner.trim().split(/\s+/, 1)[0];
  if (!/^[1-9]\d*$/.test(pidText)) return false;
  const ownerPid = Number(pidText);
  if (!Number.isSafeInteger(ownerPid)) return false;

  try {
    process.kill(ownerPid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return false;
    if (code !== "ESRCH") throw error;
  }

  try {
    // A per-acquisition nonce keeps a replaced lock distinguishable even if
    // the operating system quickly reuses the previous owner's PID.
    if (fs.readFileSync(lockPath, "utf-8") !== observedOwner) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function acquireDockerDriverGatewayJwtGenerationLock(
  stateDir: string,
  lockWaitMs: number,
): () => void {
  const lockPath = path.join(stateDir, GATEWAY_JWT_GENERATING_NAME);
  const deadline = Date.now() + Math.max(0, lockWaitMs);

  while (true) {
    let fd: number | null = null;
    let created = false;
    const owner = `${process.pid} ${randomBytes(8).toString("hex")}\n`;
    try {
      fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      created = true;
      fs.writeSync(fd, owner);
      fs.closeSync(fd);
      fd = null;
      return () => {
        try {
          if (fs.readFileSync(lockPath, "utf-8") === owner) fs.unlinkSync(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (fd !== null) fs.closeSync(fd);
      if (created) fs.rmSync(lockPath, { force: true });
      if (
        (error as NodeJS.ErrnoException).code === "EEXIST" &&
        removeStaleDockerDriverGatewayJwtGenerationLock(lockPath)
      ) {
        continue;
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const remainingMs = deadline - Date.now();
        if (remainingMs > 0) {
          Atomics.wait(
            GATEWAY_JWT_LOCK_WAIT_VIEW,
            0,
            0,
            Math.min(GATEWAY_JWT_LOCK_RETRY_MS, remainingMs),
          );
          continue;
        }
        throw new Error(
          "OpenShell gateway JWT bundle generation is already in progress for this state directory; " +
            `it did not complete within ${Math.max(0, lockWaitMs)}ms.`,
        );
      }
      throw error;
    }
  }
}

function writeNewDockerDriverGatewayJwtBundle(
  bundle: DockerDriverGatewayJwtBundle,
): DockerDriverGatewayJwtBundle {
  fs.mkdirSync(path.dirname(bundle.signingKeyPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(bundle.signingKeyPath), 0o700);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeRestrictedFile(
    bundle.signingKeyPath,
    String(privateKey.export({ format: "pem", type: "pkcs8" })),
  );
  writeRestrictedFile(
    bundle.publicKeyPath,
    String(publicKey.export({ format: "pem", type: "spki" })),
  );
  writeRestrictedFile(bundle.kidPath, `${randomBytes(16).toString("hex")}\n`);

  if (!dockerDriverGatewayJwtBundleIsValid(bundle)) {
    throw new Error("OpenShell gateway JWT bundle generation produced an invalid keypair");
  }
  return bundle;
}

function createAtomicDockerDriverGatewayJwtBundle(
  stateDir: string,
  finalBundle: DockerDriverGatewayJwtBundle,
): DockerDriverGatewayJwtBundle {
  const finalDir = path.dirname(finalBundle.signingKeyPath);
  const tmpDir = fs.mkdtempSync(path.join(stateDir, GATEWAY_JWT_TMP_PREFIX));
  let promoted = false;
  try {
    writeNewDockerDriverGatewayJwtBundle(dockerDriverGatewayJwtBundleForDir(tmpDir));
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);
    promoted = true;
    normalizeDockerDriverGatewayJwtBundlePermissions(finalBundle);
    return finalBundle;
  } finally {
    if (!promoted) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function ensureDockerDriverGatewayJwtBundle(
  stateDir: string,
  options: { lockWaitMs?: number } = {},
): DockerDriverGatewayJwtBundle {
  const jwtDir = path.join(stateDir, GATEWAY_JWT_DIR_NAME);
  const bundle = dockerDriverGatewayJwtBundleForDir(jwtDir);
  const files = [bundle.signingKeyPath, bundle.publicKeyPath, bundle.kidPath];

  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  const releaseLock = acquireDockerDriverGatewayJwtGenerationLock(
    stateDir,
    options.lockWaitMs ?? GATEWAY_JWT_LOCK_WAIT_MS,
  );
  try {
    cleanupStaleDockerDriverGatewayJwtTempDirs(stateDir);

    const present = existingFileCount(files);
    if (present === files.length) {
      normalizeDockerDriverGatewayJwtBundlePermissions(bundle);
      if (dockerDriverGatewayJwtBundleIsValid(bundle)) {
        return bundle;
      }
      fs.rmSync(jwtDir, { recursive: true, force: true });
    } else if (present > 0) {
      // OpenShell loads these files as one Ed25519 gateway_jwt bundle. Replace
      // interrupted or manually edited partial state as one atomic unit.
      fs.rmSync(jwtDir, { recursive: true, force: true });
    }
    return createAtomicDockerDriverGatewayJwtBundle(stateDir, bundle);
  } finally {
    releaseLock();
  }
}
