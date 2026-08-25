// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CI_CA_ENDPOINTS,
  CI_CA_SYSTEM_BUNDLE,
  MAX_CI_CA_CERTIFICATES,
  MAX_CI_CA_ENCODED_BYTES,
  normalizeCompactRootBundle,
  type OpenSslRunner,
  selectCiEndpointCaRoots,
  writeCiEndpointCaRootsOutput,
} from "../../scripts/checks/select-ci-endpoint-ca-roots.mts";
import { LEAF_PEM, PEM, tmpDir } from "../../src/lib/onboard/__test-helpers__/corporate-ca-fixtures";

const hasOpenSsl = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;

function openssl(args: readonly string[], cwd: string): void {
  const result = spawnSync("openssl", [...args], {
    cwd,
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: 10_000,
  });
  expect(result.status, `OpenSSL fixture command failed: ${args[0]}`).toBe(0);
}

function createEndpointCertificate(directory: string): {
  chain: string;
  crossSignedRoot: string;
  root: string;
} {
  fs.writeFileSync(
    path.join(directory, "root.ext"),
    [
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign,cRLSign",
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=keyid,issuer",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(directory, "leaf.ext"),
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=${CI_CA_ENDPOINTS.map((endpoint) => `DNS:${endpoint}`).join(",")}`,
      "",
    ].join("\n"),
  );
  openssl(
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=NemoClaw CI Root",
      "-keyout",
      "root.key",
      "-out",
      "root.pem",
      "-days",
      "2",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    directory,
  );
  openssl(
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=NemoClaw Alternate Root",
      "-keyout",
      "alternate-root.key",
      "-out",
      "alternate-root.pem",
      "-days",
      "2",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    directory,
  );
  openssl(
    ["req", "-new", "-key", "root.key", "-subj", "/CN=NemoClaw CI Root", "-out", "root.csr"],
    directory,
  );
  openssl(
    [
      "x509",
      "-req",
      "-in",
      "root.csr",
      "-CA",
      "alternate-root.pem",
      "-CAkey",
      "alternate-root.key",
      "-CAcreateserial",
      "-out",
      "root-cross-signed.pem",
      "-days",
      "2",
      "-extfile",
      "root.ext",
    ],
    directory,
  );
  openssl(
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${CI_CA_ENDPOINTS[0]}`,
      "-keyout",
      "leaf.key",
      "-out",
      "leaf.csr",
    ],
    directory,
  );
  openssl(
    [
      "x509",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      "root.pem",
      "-CAkey",
      "root.key",
      "-CAcreateserial",
      "-out",
      "leaf.pem",
      "-days",
      "2",
      "-extfile",
      "leaf.ext",
    ],
    directory,
  );
  const leaf = fs.readFileSync(path.join(directory, "leaf.pem"), "utf8").trim();
  const crossSignedRoot = fs
    .readFileSync(path.join(directory, "root-cross-signed.pem"), "utf8")
    .trim();
  return {
    chain: `${leaf}\n${crossSignedRoot}\n`,
    crossSignedRoot,
    root: fs.readFileSync(path.join(directory, "root.pem"), "utf8"),
  };
}

describe("CI endpoint CA root selection", () => {
  it("keeps the endpoint set and build-argument limits fixed", () => {
    expect(CI_CA_SYSTEM_BUNDLE).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(CI_CA_ENDPOINTS).toEqual(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]);
    expect(MAX_CI_CA_CERTIFICATES).toBe(24);
    expect(MAX_CI_CA_ENCODED_BYTES).toBe(65_536);
  });

  it("deduplicates CA roots and rejects leaf certificates or oversized output", () => {
    expect(normalizeCompactRootBundle([PEM, PEM])).toBe(PEM);
    expect(() => normalizeCompactRootBundle([LEAF_PEM])).toThrow(/CA:TRUE root/u);
    expect(() =>
      normalizeCompactRootBundle([PEM], { certificates: 0, encodedBytes: 65_536 }),
    ).toThrow(/exceeds 0 certificates/u);
    expect(() => normalizeCompactRootBundle([PEM], { certificates: 24, encodedBytes: 1 })).toThrow(
      /exceeds 1 encoded bytes/u,
    );
  });

  it("validates each CA output identity before truncating it", () => {
    const output = path.join(tmpDir(), "compact.pem");
    fs.writeFileSync(output, "unchanged", { mode: 0o644 });
    const calls: string[] = [];
    const realLstatSync = fs.lstatSync.bind(fs);
    const realOpenSync = fs.openSync.bind(fs);
    const realFstatSync = fs.fstatSync.bind(fs);
    const realFtruncateSync = fs.ftruncateSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation((file) => {
      calls.push("lstat");
      return realLstatSync(file);
    });
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      calls.push("open");
      return realOpenSync(file, flags, mode);
    });
    vi.spyOn(fs, "fstatSync").mockImplementation((descriptor) => {
      calls.push("fstat");
      expect(fs.readFileSync(output, "utf8")).toBe("unchanged");
      return realFstatSync(descriptor);
    });
    vi.spyOn(fs, "ftruncateSync").mockImplementation((descriptor, length) => {
      calls.push("truncate");
      expect(fs.readFileSync(output, "utf8")).toBe("unchanged");
      return realFtruncateSync(descriptor, length);
    });

    writeCiEndpointCaRootsOutput(output, "replacement");

    expect(calls).toEqual(["open", "fstat", "lstat", "truncate"]);
    expect(fs.readFileSync(output, "utf8")).toBe("replacement");
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO CA output without truncating it", () => {
    const output = path.join(tmpDir(), "compact.pem");
    const created = spawnSync("mkfifo", [output], { encoding: "utf8", timeout: 5_000 });
    expect(created.status, created.stderr).toBe(0);
    const openSync = vi.spyOn(fs, "openSync");
    const ftruncateSync = vi.spyOn(fs, "ftruncateSync");

    expect(() => writeCiEndpointCaRootsOutput(output, "replacement")).toThrow(
      "output must be an existing regular file that is not a symlink",
    );

    expect(openSync).toHaveBeenCalledOnce();
    expect(ftruncateSync).not.toHaveBeenCalled();
    expect(fs.lstatSync(output).isFIFO()).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked CA output without opening its target",
    () => {
      const directory = tmpDir();
      const target = path.join(directory, "target.pem");
      const output = path.join(directory, "compact.pem");
      fs.writeFileSync(target, "target", { mode: 0o640 });
      fs.symlinkSync(target, output);
      const openSync = vi.spyOn(fs, "openSync");
      const ftruncateSync = vi.spyOn(fs, "ftruncateSync");

      expect(() => writeCiEndpointCaRootsOutput(output, "replacement")).toThrow(
        "output must be an existing regular file that is not a symlink",
      );

      expect(openSync).toHaveBeenCalledOnce();
      expect(ftruncateSync).not.toHaveBeenCalled();
      expect(fs.lstatSync(output).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("target");
      expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a device CA output without truncating it",
    () => {
      const ftruncateSync = vi.spyOn(fs, "ftruncateSync");
      const writeFileSync = vi.spyOn(fs, "writeFileSync");
      const fchmodSync = vi.spyOn(fs, "fchmodSync");

      expect(() => writeCiEndpointCaRootsOutput("/dev/null", "replacement")).toThrow(
        "output must remain the same regular file with exactly one link",
      );

      expect(ftruncateSync).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(fchmodSync).not.toHaveBeenCalled();
    },
  );

  it
    .skipIf(process.platform === "win32")
    .each([{ scenario: "output path" }, { scenario: "hard-linked path" }])(
    "rejects a hard-linked CA output without changing either path [$scenario]",
    ({ scenario }) => {
      const directory = tmpDir();
      const output = path.join(directory, "compact.pem");
      const linked = path.join(directory, "linked.pem");
      fs.writeFileSync(output, "unchanged", { mode: 0o640 });
      fs.linkSync(output, linked);
      const openSync = vi.spyOn(fs, "openSync");
      const ftruncateSync = vi.spyOn(fs, "ftruncateSync");

      expect(() => writeCiEndpointCaRootsOutput(output, "replacement")).toThrow(
        "output must remain the same regular file with exactly one link",
      );

      expect(openSync).toHaveBeenCalledOnce();
      expect(ftruncateSync).not.toHaveBeenCalled();
      const file = ({ "output path": output, "hard-linked path": linked } as const)[scenario]!;
      expect(fs.readFileSync(file, "utf8")).toBe("unchanged");
      expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    },
  );

  it("rejects a substituted CA output without changing either file", () => {
    const directory = tmpDir();
    const output = path.join(directory, "compact.pem");
    const original = path.join(directory, "original.pem");
    const replacement = path.join(directory, "replacement.pem");
    fs.writeFileSync(output, "original", { mode: 0o640 });
    fs.writeFileSync(replacement, "replacement", { mode: 0o604 });
    const realFstatSync = fs.fstatSync.bind(fs);
    vi.spyOn(fs, "fstatSync").mockImplementation((descriptor) => {
      const stat = realFstatSync(descriptor);
      fs.renameSync(output, original);
      fs.renameSync(replacement, output);
      return stat;
    });
    const ftruncateSync = vi.spyOn(fs, "ftruncateSync");

    expect(() => writeCiEndpointCaRootsOutput(output, "written")).toThrow(
      "output must remain the same regular file with exactly one link",
    );

    expect(ftruncateSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(original, "utf8")).toBe("original");
    expect(fs.statSync(original).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(output, "utf8")).toBe("replacement");
    expect(fs.statSync(output).mode & 0o777).toBe(0o604);
  });

  it.skipIf(!hasOpenSsl).each(CI_CA_ENDPOINTS)(
    "selects a self-signed system root when the server sends its cross-signed form [case %#]",
    (endpoint) => {
      const directory = tmpDir();
      const output = path.join(directory, "compact.pem");
      fs.writeFileSync(output, "", { mode: 0o600 });
      const fixture = createEndpointCertificate(directory);
      const systemRoot = new X509Certificate(fixture.root);
      const crossSignedRoot = new X509Certificate(fixture.crossSignedRoot);
      expect(crossSignedRoot.subject).toBe(systemRoot.subject);
      expect(crossSignedRoot.issuer).not.toBe(crossSignedRoot.subject);
      expect(crossSignedRoot.publicKey.export({ format: "der", type: "spki" })).toEqual(
        systemRoot.publicKey.export({ format: "der", type: "spki" }),
      );
      expect(crossSignedRoot.verify(crossSignedRoot.publicKey)).toBe(false);
      const realReadFile = fs.readFileSync.bind(fs);
      vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...args) =>
        file === CI_CA_SYSTEM_BUNDLE
          ? fixture.root
          : realReadFile(file, ...args)) as typeof fs.readFileSync);

      const connections: string[][] = [];
      const runConnection: OpenSslRunner = (args) => {
        connections.push([...args]);
        return {
          status: 0,
          stderr: "",
          stdout: `${fixture.chain}Verify return code: 0 (ok)\n`,
        };
      };
      const runActualOpenSsl: OpenSslRunner = (args) => {
        const result = spawnSync("openssl", [...args], {
          encoding: "utf8",
          killSignal: "SIGKILL",
          timeout: 10_000,
        });
        return {
          error: result.error,
          status: result.status,
          stderr: result.stderr ?? "",
          stdout: result.stdout ?? "",
        };
      };
      const runner: OpenSslRunner = (args) =>
        args[0] === "s_client" ? runConnection(args) : runActualOpenSsl(args);

      expect(selectCiEndpointCaRoots(output, runner)).toEqual({
        certificates: 1,
        encodedBytes: Buffer.from(fixture.root).toString("base64").length,
      });
      expect(fs.readFileSync(output, "utf8")).toBe(fixture.root);
      expect(connections).toHaveLength(CI_CA_ENDPOINTS.length * 2);

      const endpointConnections = connections.filter((args) => args.includes(`${endpoint}:443`));
      expect(endpointConnections).toEqual([
        [
          "s_client",
          "-connect",
          `${endpoint}:443`,
          "-servername",
          endpoint,
          "-verify_hostname",
          endpoint,
          "-verify_return_error",
          "-CAfile",
          CI_CA_SYSTEM_BUNDLE,
          "-no-CApath",
          "-no-CAstore",
          "-showcerts",
        ],
        [
          "s_client",
          "-connect",
          `${endpoint}:443`,
          "-servername",
          endpoint,
          "-verify_hostname",
          endpoint,
          "-verify_return_error",
          "-CAfile",
          expect.stringMatching(/\/compact\.pem$/u),
          "-no-CApath",
          "-no-CAstore",
        ],
      ]);

      fs.writeFileSync(output, "unchanged", { mode: 0o600 });
      const rejectCompactVerification: OpenSslRunner = (args) =>
        args[0] === "s_client" && !args.includes("-showcerts")
          ? { status: 1, stderr: "verification failed", stdout: "" }
          : runner(args);
      expect(() => selectCiEndpointCaRoots(output, rejectCompactVerification)).toThrow(
        /compact CA verification for registry\.npmjs\.org failed/u,
      );
      expect(fs.readFileSync(output, "utf8")).toBe("unchanged");
    },
  );
});
