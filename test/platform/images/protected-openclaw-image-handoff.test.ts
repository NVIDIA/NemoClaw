// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  exportOpenClawImage,
  restoreOpenClawImage,
  type OpenClawImageIdentity,
} from "../../../scripts/checks/protected-openclaw-image-handoff.mts";

const identity: OpenClawImageIdentity = {
  revision: "a".repeat(40),
  workflowSha: "b".repeat(40),
  cohort: "protected-123-1",
  platform: "linux/amd64",
  runtimeUser: "sandbox",
  baseReference: `ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:${"c".repeat(64)}`,
};
let reference: string;
const tag = `localhost:5000/nemoclaw-managed-protected/openclaw:${identity.revision}`;
let root: string;
let directory: string;
let configDigest: string;
let manifest: string;

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
function calls(): string[][] {
  const log = path.join(root, "calls");
  return fs.existsSync(log)
    ? fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
function clearCalls() {
  fs.writeFileSync(path.join(root, "calls"), "");
}
function changeReceipt(changes: Record<string, unknown>) {
  const filename = path.join(directory, "receipt.json");
  const receipt = JSON.parse(fs.readFileSync(filename, "utf8"));
  fs.writeFileSync(filename, JSON.stringify({ ...receipt, ...changes }));
}
function exported() {
  exportOpenClawImage(directory, identity, reference);
  clearCalls();
}

function addOciLayout() {
  const archive = path.join(root, "archive");
  const blobs = path.join(archive, "blobs", "sha256");
  fs.mkdirSync(blobs, { recursive: true });
  fs.copyFileSync(
    path.join(archive, `${configDigest.slice(7)}.json`),
    path.join(blobs, configDigest.slice(7)),
  );
  fs.writeFileSync(path.join(blobs, hash(manifest)), manifest);
  fs.writeFileSync(
    path.join(archive, "oci-layout"),
    JSON.stringify({ imageLayoutVersion: "1.0.0" }),
  );
  fs.writeFileSync(
    path.join(archive, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: `sha256:${hash(manifest)}`,
          size: Buffer.byteLength(manifest),
          annotations: {
            "io.containerd.image.name": tag,
            "org.opencontainers.image.ref.name": identity.revision,
          },
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(archive, "manifest.json"),
    JSON.stringify([
      { Config: `blobs/sha256/${configDigest.slice(7)}`, RepoTags: [tag], Layers: [] },
    ]),
  );
}

function repack() {
  const archive = path.join(root, "archive");
  const files = fs
    .readdirSync(archive, { recursive: true })
    .map(String)
    .filter((file) => fs.statSync(path.join(archive, file)).isFile());
  execFileSync("tar", ["-cf", path.join(directory, "image.tar"), "-C", archive, ...files]);
  const bytes = fs.readFileSync(path.join(directory, "image.tar"));
  changeReceipt({ archiveSha256: hash(bytes), archiveSize: bytes.length });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-image-handoff-"));
  directory = path.join(root, "handoff");
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "archive"));
  const config = {
    User: "sandbox",
    Labels: {
      "org.opencontainers.image.source": "https://github.com/NVIDIA/NemoClaw",
      "org.opencontainers.image.revision": identity.revision,
      "io.nvidia.nemoclaw.agent": "openclaw",
      "io.nvidia.nemoclaw.managed-image.contract": "1",
      "io.nvidia.nemoclaw.managed-image.platform": identity.platform,
      "io.nvidia.nemoclaw.managed-image.startup-profile": "1",
      "io.nvidia.nemoclaw.managed-image.capabilities": "1",
      "io.nvidia.nemoclaw.managed-image.cohort": identity.cohort,
    },
  };
  const bytes = JSON.stringify({
    architecture: "amd64",
    os: "linux",
    config,
    rootfs: { type: "layers", diff_ids: [] },
  });
  configDigest = `sha256:${hash(bytes)}`;
  fs.writeFileSync(path.join(root, "archive", `${configDigest.slice(7)}.json`), bytes);
  fs.writeFileSync(
    path.join(root, "archive", "manifest.json"),
    JSON.stringify([{ Config: `${configDigest.slice(7)}.json`, RepoTags: [tag], Layers: [] }]),
  );
  fs.writeFileSync(
    path.join(root, "image.json"),
    JSON.stringify([{ Id: configDigest, Os: "linux", Architecture: "amd64", Config: config }]),
  );
  manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      digest: configDigest,
      size: Buffer.byteLength(bytes),
      mediaType: "application/vnd.oci.image.config.v1+json",
    },
    layers: [],
  });
  reference = `localhost:5000/nemoclaw-managed-protected/openclaw@sha256:${hash(manifest)}`;
  fs.writeFileSync(path.join(root, "manifest.json"), manifest);
  fs.writeFileSync(
    path.join(root, "bin", "docker"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const root = process.env.NEMOCLAW_TEST_HANDOFF_ROOT;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify(args)+'\\n');
if (fs.existsSync(path.join(root, 'fail')) && args[1] === fs.readFileSync(path.join(root, 'fail'), 'utf8')) process.exit(42);
if (args[0] === 'image' && args[1] === 'inspect') {
  if (args[2] === ${JSON.stringify(tag)} && !fs.existsSync(path.join(root, 'tagged'))) process.exit(1);
  const filename = args[2] === ${JSON.stringify(tag)} && fs.existsSync(path.join(root, 'tag-image.json')) ? 'tag-image.json' : 'image.json';
  process.stdout.write(fs.readFileSync(path.join(root, filename)));
}
else if (args[0] === 'image' && args[1] === 'tag') fs.writeFileSync(path.join(root, 'tagged'), args[2]);
else if (args[0] === 'image' && args[1] === 'save') cp.execFileSync('tar', ['-cf', args[3], '-C', path.join(root, 'archive'), ...fs.readdirSync(path.join(root, 'archive'), {recursive:true}).filter(p => fs.statSync(path.join(root, 'archive', p)).isFile())]);
else if (args[0] === 'buildx') process.stdout.write(fs.readFileSync(path.join(root, 'manifest.json')));
else if (args[1] === 'ls' && fs.existsSync(path.join(root, 'occupied'))) process.stdout.write('occupied');
else if (!['load', 'ls', 'push'].includes(args[1])) process.exit(99);
`,
    { mode: 0o755 },
  );
  vi.stubEnv("NEMOCLAW_TEST_HANDOFF_ROOT", root);
  vi.stubEnv("PATH", `${path.join(root, "bin")}:${process.env.PATH}`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

it("transfers the CPU image and pins the republished manifest without rebuilding", () => {
  exportOpenClawImage(directory, identity, reference);
  expect(calls()).toContainEqual([
    "image",
    "save",
    "--output",
    path.join(directory, "image.tar"),
    tag,
  ]);
  expect(fs.readFileSync(path.join(root, "tagged"), "utf8")).toBe(reference);
  clearCalls();
  expect(restoreOpenClawImage(directory, identity)).toBe(`sha256:${hash(manifest)}`);
  expect(calls()).toEqual([
    ["image", "ls", "--quiet", "--no-trunc", tag],
    ["image", "load", "--input", path.join(directory, "image.tar")],
    ["image", "inspect", tag],
    ["image", "push", `localhost:5000/nemoclaw-managed-protected/openclaw:${identity.revision}`],
    [
      "buildx",
      "imagetools",
      "inspect",
      `localhost:5000/nemoclaw-managed-protected/openclaw:${identity.revision}`,
      "--raw",
    ],
  ]);
});

it("refuses to replace a revision tag that points at another image", () => {
  fs.writeFileSync(path.join(root, "occupied"), "yes");
  fs.writeFileSync(path.join(root, "tagged"), "unrelated");
  const entries = JSON.parse(fs.readFileSync(path.join(root, "image.json"), "utf8"));
  entries[0].Id = `sha256:${"f".repeat(64)}`;
  fs.writeFileSync(path.join(root, "tag-image.json"), JSON.stringify(entries));
  expect(() => exportOpenClawImage(directory, identity, reference)).toThrow("revision tag changed");
  expect(calls().some((args) => ["tag", "save"].includes(args[1]))).toBe(false);
});

it("stops without exporting when Docker cannot create the revision tag", () => {
  fs.writeFileSync(path.join(root, "fail"), "tag");
  expect(() => exportOpenClawImage(directory, identity, reference)).toThrow();
  expect(calls().filter((args) => args[1] === "tag")).toHaveLength(1);
  expect(calls().some((args) => args[1] === "save")).toBe(false);
});

it.each([
  { revision: "e".repeat(40) },
  { workflowSha: "e".repeat(40) },
  { cohort: "protected-124-1" },
  { cohort: "protected-123-2" },
  { platform: "linux/arm64" },
  { runtimeUser: "root" },
  { baseReference: `ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:${"e".repeat(64)}` },
  { configDigest: "latest" },
  { sourceReference: "localhost:5000/nemoclaw-managed-protected/openclaw:latest" },
  { archiveSha256: "e".repeat(64) },
  { archiveSize: 1 },
  { version: 2 },
])("rejects a mismatched receipt before Docker mutation: %j", (changes) => {
  exported();
  changeReceipt(changes);
  expect(() => restoreOpenClawImage(directory, identity)).toThrow();
  expect(calls()).toEqual([]);
});

it("keeps the offline rebuild for a verified earlier attempt without loading its old cohort", () => {
  exported();
  expect(
    restoreOpenClawImage(directory, { ...identity, cohort: "protected-123-2" }),
  ).toBeUndefined();
  expect(calls()).toEqual([]);
});

it.each(["image.tar", "receipt.json"])(
  "rejects a symlinked %s before Docker mutation",
  (filename) => {
    exported();
    fs.renameSync(path.join(directory, filename), path.join(root, filename));
    fs.symlinkSync(path.join(root, filename), path.join(directory, filename));
    expect(() => restoreOpenClawImage(directory, identity)).toThrow();
    expect(calls()).toEqual([]);
  },
);

it("rejects changed archive bytes before loading an image", () => {
  exported();
  fs.appendFileSync(path.join(directory, "image.tar"), "modified");
  expect(() => restoreOpenClawImage(directory, identity)).toThrow("does not match its receipt");
  expect(calls()).toEqual([]);
});

it("rejects an unrelated tag even when its transport hash matches the receipt", () => {
  exported();
  fs.writeFileSync(
    path.join(root, "archive", "manifest.json"),
    JSON.stringify([
      { Config: `${configDigest.slice(7)}.json`, RepoTags: ["unrelated:latest"], Layers: [] },
    ]),
  );
  execFileSync("tar", [
    "-cf",
    path.join(directory, "image.tar"),
    "-C",
    path.join(root, "archive"),
    "manifest.json",
    `${configDigest.slice(7)}.json`,
  ]);
  const bytes = fs.readFileSync(path.join(directory, "image.tar"));
  changeReceipt({ archiveSha256: hash(bytes), archiveSize: bytes.length });
  expect(() => restoreOpenClawImage(directory, identity)).toThrow("revision tag");
  expect(calls()).toEqual([]);
});

it("rejects an altered config despite a matching transport hash and config filename", () => {
  exported();
  fs.writeFileSync(path.join(root, "archive", `${configDigest.slice(7)}.json`), "{}");
  execFileSync("tar", [
    "-cf",
    path.join(directory, "image.tar"),
    "-C",
    path.join(root, "archive"),
    "manifest.json",
    `${configDigest.slice(7)}.json`,
  ]);
  const bytes = fs.readFileSync(path.join(directory, "image.tar"));
  changeReceipt({ archiveSha256: hash(bytes), archiveSize: bytes.length });
  expect(() => restoreOpenClawImage(directory, identity)).toThrow("config does not match");
  expect(calls()).toEqual([]);
});

it("rejects a loaded image with the wrong runtime user before publishing", () => {
  exported();
  const file = path.join(root, "image.json");
  const image = JSON.parse(fs.readFileSync(file, "utf8"));
  image[0].Config.User = "root";
  fs.writeFileSync(file, JSON.stringify(image));
  expect(() => restoreOpenClawImage(directory, identity)).toThrow("runtime user");
  expect(calls().some((args) => ["tag", "push"].includes(args[1]))).toBe(false);
});

it.each(["load", "push"])("propagates a Docker %s failure without retrying", (operation) => {
  exported();
  fs.writeFileSync(path.join(root, "fail"), operation);
  expect(() => restoreOpenClawImage(directory, identity)).toThrow();
  expect(calls().filter((args) => args[1] === operation)).toHaveLength(1);
  expect(calls().some((args) => args[0] === "buildx")).toBe(false);
});

it("rejects publication of a different image content ID", () => {
  exported();
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify({ config: { digest: `sha256:${"f".repeat(64)}` } }),
  );
  expect(() => restoreOpenClawImage(directory, identity)).toThrow("changed its config digest");
});

it("accepts one OCI image when the daemon ID differs from its config digest", () => {
  addOciLayout();
  const filename = path.join(root, "image.json");
  const image = JSON.parse(fs.readFileSync(filename, "utf8"));
  image[0].Id = `sha256:${hash(manifest)}`;
  fs.writeFileSync(filename, JSON.stringify(image));
  exported();
  expect(restoreOpenClawImage(directory, identity)).toBe(`sha256:${hash(manifest)}`);
  expect(calls().some((args) => args[1] === "load")).toBe(true);
});

type OciIndex = {
  manifests: { mediaType: string; annotations: Record<string, string>; urls?: string[] }[];
};
const invalidOciChanges: [string, (index: OciIndex) => void][] = [
  ["extra image", (index) => index.manifests.push({ ...index.manifests[0] })],
  [
    "alias",
    (index) => {
      index.manifests[0].annotations["io.containerd.image.name"] = "unrelated:latest";
    },
  ],
  [
    "nested index",
    (index) => {
      index.manifests[0].mediaType = "application/vnd.oci.image.index.v1+json";
    },
  ],
  [
    "external content",
    (index) => {
      index.manifests[0].urls = ["https://example.com/other-image"];
    },
  ],
  [
    "changed manifest",
    () => {
      fs.writeFileSync(path.join(root, "archive", "blobs", "sha256", hash(manifest)), "{}");
    },
  ],
];
it.each(invalidOciChanges)("rejects a hybrid archive with %s before loading", (_change, mutate) => {
  addOciLayout();
  exported();
  const filename = path.join(root, "archive", "index.json");
  const index = JSON.parse(fs.readFileSync(filename, "utf8"));
  mutate(index);
  fs.writeFileSync(filename, JSON.stringify(index));
  repack();
  expect(() => restoreOpenClawImage(directory, identity)).toThrow();
  expect(calls()).toEqual([]);
});

it("refuses to overwrite a destination tag already on the runner", () => {
  exported();
  fs.writeFileSync(path.join(root, "occupied"), "yes");
  expect(() => restoreOpenClawImage(directory, identity)).toThrow("already exists");
  expect(calls()).toEqual([["image", "ls", "--quiet", "--no-trunc", tag]]);
});

it.each([
  ["oci-layout/", "0"],
  ["index.json/", "0"],
  ["manifest.json/", "5"],
  ["oci-layout", "2"],
  ["index.json", "1"],
  ["../index.json", "0"],
  ["index\n.json", "0"],
])("rejects archive member %j with type %s before loading", (name, type) => {
  exported();
  const filename = path.join(directory, "image.tar");
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write("00000000000\0", 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  const bytes = Buffer.concat([header, fs.readFileSync(filename)]);
  fs.writeFileSync(filename, bytes);
  changeReceipt({ archiveSha256: hash(bytes), archiveSize: bytes.length });
  expect(() => restoreOpenClawImage(directory, identity)).toThrow();
  expect(calls()).toEqual([]);
});
