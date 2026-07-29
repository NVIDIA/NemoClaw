// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Ajv from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  DCODE_VALIDATION_PROFILE_SCHEMA_VERSION,
  type DcodeValidationProfile,
  dcodeValidationProfileDigest,
  decodeDcodeValidationProfile,
  encodeDcodeValidationProfile,
  loadDcodeValidationProfile,
  parseDcodeValidationProfile,
} from "../../domain/dcode-validation-profile";

function profile(): DcodeValidationProfile {
  const content = {
    schemaVersion: DCODE_VALIDATION_PROFILE_SCHEMA_VERSION,
    sandboxName: "validation-sandbox",
    taskIdentity: "issue-7774",
    sourceIdentity: `sha256:${"a".repeat(64)}`,
    workingDirectoryRoots: ["/sandbox/workspace"],
    commands: [
      {
        id: "unit-tests",
        argv: ["/usr/bin/npm", "test", "--", "--runInBand"],
        workingDirectory: "/sandbox/workspace/repo",
        environment: ["CI", "HOME", "LANG"],
        timeoutSeconds: 600,
        maxOutputBytes: 1_048_576,
        maxInvocations: 2,
      },
    ],
  };
  return { ...content, contentDigest: dcodeValidationProfileDigest(content) };
}

describe("DCode validation profiles", () => {
  it("accepts a digest-bound exact command contract and round-trips the internal handoff (#7774)", () => {
    const parsed = parseDcodeValidationProfile(profile(), "validation-sandbox");
    expect(parsed).toEqual(profile());
    expect(
      decodeDcodeValidationProfile(encodeDcodeValidationProfile(parsed), "validation-sandbox"),
    ).toEqual(parsed);
  });

  it("publishes a JSON Schema that accepts the runtime profile shape (#7774)", () => {
    const schema = JSON.parse(readFileSync("schemas/dcode-validation-profile.schema.json", "utf8"));
    const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
    expect(validate(profile()), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    [
      "near-match argument",
      (value: DcodeValidationProfile) => value.commands[0]?.argv.push("--watch"),
    ],
    ["shell metacharacter", (value: DcodeValidationProfile) => value.commands[0]?.argv.push(";")],
    [
      "credential environment",
      (value: DcodeValidationProfile) => value.commands[0]?.environment.push("GITHUB_TOKEN"),
    ],
    [
      "path escape",
      (value: DcodeValidationProfile) => {
        value.commands[0]!.workingDirectory = "/sandbox/elsewhere";
      },
    ],
    [
      "alternate sandbox",
      (value: DcodeValidationProfile) => {
        value.sandboxName = "other";
      },
    ],
  ])("rejects a %s after the immutable digest is issued (#7774)", (_label, mutate) => {
    const value = profile();
    mutate(value);
    expect(() => parseDcodeValidationProfile(value, "validation-sandbox")).toThrow(
      /Invalid DCode validation profile/,
    );
  });

  it("rejects an argv secret even when the digest is recomputed (#7774)", () => {
    const value = profile();
    value.commands[0]?.argv.push("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    const { contentDigest: _contentDigest, ...content } = value;
    value.contentDigest = dcodeValidationProfileDigest(content);
    expect(() => parseDcodeValidationProfile(value)).toThrow(/secret material/);
  });

  it.each([
    [
      "task identity",
      (value: DcodeValidationProfile, secret: string) => {
        value.taskIdentity = secret;
      },
    ],
    [
      "command id",
      (value: DcodeValidationProfile, secret: string) => {
        value.commands[0]!.id = secret;
      },
    ],
    [
      "working directory",
      (value: DcodeValidationProfile, secret: string) => {
        value.workingDirectoryRoots = [`/sandbox/${secret}`];
        value.commands[0]!.workingDirectory = `/sandbox/${secret}/repo`;
      },
    ],
  ])("rejects a secret-shaped receipt-visible %s (#7774)", (_label, mutate) => {
    const value = profile();
    mutate(value, "ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    const { contentDigest: _contentDigest, ...content } = value;
    value.contentDigest = dcodeValidationProfileDigest(content);
    expect(() => parseDcodeValidationProfile(value)).toThrow(/secret material/);
  });

  it("allows a command to inherit no ambient environment values (#7774)", () => {
    const value = profile();
    value.commands[0]!.environment = [];
    const { contentDigest: _contentDigest, ...content } = value;
    value.contentDigest = dcodeValidationProfileDigest(content);
    expect(parseDcodeValidationProfile(value).commands[0]?.environment).toEqual([]);
  });

  it.each([
    "LD_PRELOAD",
    "PYTHONPATH",
    "NODE_OPTIONS",
    "GIT_CONFIG_GLOBAL",
  ])("rejects process-control environment name %s even with a valid digest (#7774)", (name) => {
    const value = profile();
    value.commands[0]!.environment.push(name);
    const { contentDigest: _contentDigest, ...content } = value;
    value.contentDigest = dcodeValidationProfileDigest(content);
    expect(() => parseDcodeValidationProfile(value)).toThrow(/controls child execution/);
  });

  it("loads only a regular non-symlink host file with a matching sandbox binding (#7774)", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-dcode-profile-"));
    try {
      const file = join(directory, "profile.json");
      const link = join(directory, "profile-link.json");
      writeFileSync(file, JSON.stringify(profile()), { mode: 0o600 });
      symlinkSync(file, link);
      expect(loadDcodeValidationProfile(file, "validation-sandbox")).toEqual(profile());
      expect(() => loadDcodeValidationProfile(link, "validation-sandbox")).toThrow(/cannot open/);
      expect(() => loadDcodeValidationProfile(file, "other")).toThrow(
        /does not match rebuild target/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
