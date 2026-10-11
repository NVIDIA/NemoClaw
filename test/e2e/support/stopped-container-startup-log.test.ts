// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { STOPPED_CONTAINER_STARTUP_LOG_READER } from "../fixtures/stopped-container-startup-log.ts";

function archive(name: string, text: string, type = "0", link = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(text.length.toString(8).padStart(11, "0"), 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write(link, 157);
  header.write(
    header
      .reduce((sum, value) => sum + value, 0)
      .toString(8)
      .padStart(6, "0"),
    148,
  );
  header[154] = 0;
  return Buffer.concat([
    header,
    Buffer.from(text),
    Buffer.alloc((512 - (text.length % 512)) % 512),
    Buffer.alloc(1024),
  ]);
}

function read(input: Buffer) {
  const result = spawnSync("python3", ["-I", "-c", STOPPED_CONTAINER_STARTUP_LOG_READER], {
    input,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 128 * 1024,
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, output: JSON.parse(result.stdout) };
}

it("retains the complete regular startup log for downstream credential redaction", () => {
  const log = 'startup failed\nfixture-"credential\\value\n';
  expect(read(archive("nemoclaw-start.log", log))).toEqual({
    status: 0,
    output: { file: "/tmp/nemoclaw-start.log", log, truncated: false },
  });
});

it("keeps maximally JSON-escaped accepted logs complete", () => {
  const log = "\u0001".repeat(16384);
  expect(read(archive("nemoclaw-start.log", log))).toEqual({
    status: 0,
    output: { file: "/tmp/nemoclaw-start.log", log, truncated: false },
  });
});

it.each([
  ["symlink", archive("nemoclaw-start.log", "", "2", "/etc/passwd")],
  ["hard link", archive("nemoclaw-start.log", "", "1", "/etc/passwd")],
  ["wrong path", archive("../nemoclaw-start.log", "fixture-secret")],
  ["oversized log", archive("nemoclaw-start.log", "x".repeat(16385))],
  ["oversized archive", Buffer.alloc(65537)],
  ["truncated archive", archive("nemoclaw-start.log", "fixture-secret").subarray(0, 1024)],
  ["malformed archive", Buffer.from("fixture-secret")],
  [
    "multiple entries",
    Buffer.concat([
      archive("nemoclaw-start.log", "fixture-secret").subarray(0, 1024),
      archive("another.log", "fixture-secret"),
    ]),
  ],
])("omits unsafe %s without emitting partial contents", (_label, input) => {
  expect(read(input as Buffer)).toEqual({
    status: 1,
    output: { file: "/tmp/nemoclaw-start.log", logOmitted: "unsafe-or-incomplete-archive" },
  });
});
