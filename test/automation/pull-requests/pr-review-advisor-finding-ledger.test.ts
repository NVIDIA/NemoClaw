// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import {
  buildAdvisorFindingLedger,
  createAdvisorFindingToolController,
  parseAdvisorFindingLedger,
  writeAdvisorFindingLedger,
  MAX_FINDING_LEDGER_BYTES,
} from "../../../tools/pr-review-advisor/finding-ledger.mts";

const identity = { headSha: "a".repeat(40), interest: "security-standard-work" };
const blocker = {
  severity: "P1" as const,
  kind: "security" as const,
  summary: "The fallback exposes a credential.",
  path: "src/lib/example.ts",
  line: 42,
  impact: "A diagnostic includes the credential value.",
  smallestSafeFix: "Remove the credential from the diagnostic.",
  regressionTest: "Assert that the diagnostic contains no credential value.",
  exclusions: ["security-sensitive", "credential-access"] as const,
};
const clear = { findings: [], noFindingsReason: "No P0/P1 blocker remains in the reviewed area." };
const build = (input: Parameters<typeof buildAdvisorFindingLedger>[0]["input"]) =>
  buildAdvisorFindingLedger({ ...identity, input });

it.each([
  ["clear", clear],
  ["excluded-blocker", { findings: [blocker], noFindingsReason: null }],
] as const)("matches the producer-generated %s ledger fixture (#11489)", (name, input) => {
  const ledger = build(input);
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "test/fixtures", `review-queue-findings-${name}.json`),
      "utf8",
    ),
  );
  expect(ledger).toEqual(fixture);
  expect(parseAdvisorFindingLedger(fixture, identity)).toEqual(ledger);
  expect(ledger.status).toBe(name === "clear" ? "clear" : "findings");
  expect(ledger.findings).toHaveLength(name === "clear" ? 0 : 1);
});

it("normalizes text and exclusions before deriving stable finding IDs (#11489)", () => {
  const first = build({ findings: [blocker], noFindingsReason: null });
  const second = build({
    findings: [
      {
        ...blocker,
        summary: `  ${blocker.summary}\n`,
        exclusions: [...blocker.exclusions].reverse(),
      },
    ],
    noFindingsReason: null,
  });
  expect(second).toEqual(first);
  expect(first.findings[0]!.exclusions).toEqual(["credential-access", "security-sensitive"]);
});

it.each([
  { findings: [], noFindingsReason: null },
  { findings: [], noFindingsReason: "  " },
  { findings: [blocker], noFindingsReason: "No blockers" },
  { findings: [blocker, blocker], noFindingsReason: null },
  { findings: Array.from({ length: 21 }, () => blocker), noFindingsReason: null },
  { findings: [{ ...blocker, path: "../outside" }], noFindingsReason: null },
  { findings: [{ ...blocker, path: "/absolute" }], noFindingsReason: null },
  { findings: [{ ...blocker, severity: "P2" }], noFindingsReason: null },
  { findings: [{ ...blocker, line: 0 }], noFindingsReason: null },
  { findings: [{ ...blocker, summary: "x\u0000y" }], noFindingsReason: null },
  { findings: [{ ...blocker, summary: "é".repeat(251) }], noFindingsReason: null },
  { ...clear, unexpected: true },
])("rejects invalid finding input %j (#11489)", (input) => {
  expect(() => build(input as Parameters<typeof build>[0])).toThrow();
});

it.each([
  { version: 2 },
  { revision: 2 },
  { identity: "stale" },
  { headSha: "b".repeat(40) },
  { interest: "other" },
  { status: "findings" },
  { noFindingsReason: ` ${clear.noFindingsReason}` },
  { extra: true },
])("rejects stale or noncanonical ledger fields %j (#11489)", (change) => {
  expect(() => parseAdvisorFindingLedger({ ...build(clear), ...change }, identity)).toThrow();
});

it.each([{ id: "F-forged" }, { interest: "other" }, { exclusions: [...blocker.exclusions] }])(
  "rejects forged or noncanonical finding fields %j (#11489)",
  (change) => {
    const ledger = build({ findings: [blocker], noFindingsReason: null });
    expect(() =>
      parseAdvisorFindingLedger(
        { ...ledger, findings: [{ ...ledger.findings[0], ...change }] },
        identity,
      ),
    ).toThrow();
  },
);

it("sorts multiple findings and rejects a reordered ledger (#11489)", () => {
  const ledger = build({ findings: [blocker, { ...blocker, line: 43 }], noFindingsReason: null });
  expect(ledger.findings.map(({ id }) => id)).toEqual(ledger.findings.map(({ id }) => id).sort());
  expect(() =>
    parseAdvisorFindingLedger({ ...ledger, findings: [...ledger.findings].reverse() }, identity),
  ).toThrow("not canonical");
});

it("requires a successful recording and permits correction of rejected input (#11489)", async () => {
  const controller = createAdvisorFindingToolController(identity);
  const record = controller.tools[0]!;
  expect(() => controller.snapshot()).toThrow("did not commit");
  await expect(
    record.execute(
      "bad",
      { findings: [], noFindingsReason: null },
      undefined,
      undefined,
      undefined as never,
    ),
  ).rejects.toThrow();
  expect(() => controller.snapshot()).toThrow("did not commit");
  const result = await record.execute("clear", clear, undefined, undefined, undefined as never);
  expect(result).toMatchObject({ terminate: true });
  expect(controller.snapshot()).toEqual(build(clear));
  await expect(
    record.execute("again", clear, undefined, undefined, undefined as never),
  ).rejects.toThrow("already has");
});

it("writes a private ledger without replacing an existing file or symlink (#11489)", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-ledger-"));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledger = build(clear);
  expect(() =>
    writeAdvisorFindingLedger(directory, identity.interest, {
      ...ledger,
      noFindingsReason: "x".repeat(MAX_FINDING_LEDGER_BYTES),
    }),
  ).toThrow("size limit");
  const file = writeAdvisorFindingLedger(directory, identity.interest, ledger);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(ledger);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(() => writeAdvisorFindingLedger(directory, identity.interest, ledger)).toThrow();
  fs.unlinkSync(file);
  const target = path.join(directory, "target");
  fs.writeFileSync(target, "unchanged");
  fs.symlinkSync(target, file);
  expect(() => writeAdvisorFindingLedger(directory, identity.interest, ledger)).toThrow();
  expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
});

it("keeps recorded exclusions immutable after the finding ID is derived (#11489)", async () => {
  const controller = createAdvisorFindingToolController(identity);
  await controller.tools[0]!.execute(
    "record",
    { findings: [blocker], noFindingsReason: null },
    undefined,
    undefined,
    undefined as never,
  );
  const snapshot = controller.snapshot();
  const exclusions = snapshot.findings[0]!.exclusions as string[];
  expect(() => exclusions.push("external-mutation")).toThrow(TypeError);
  expect(controller.snapshot()).toEqual(snapshot);
  expect(parseAdvisorFindingLedger(controller.snapshot(), identity)).toEqual(snapshot);
});
