// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertHermesSlackApiProof,
  classifyHermesSlackApiProof,
} from "../live/hermes-slack-proof.ts";

describe("Hermes Slack API proof classification", () => {
  it("accepts both successful Slack API markers", () => {
    expect(
      classifyHermesSlackApiProof(
        "OK auth.test: status=200 error=None\nOK apps.connections.open: status=200 error=None\n",
      ),
    ).toEqual({ kind: "passed" });
  });

  it("rejects a provider timeout as incomplete required evidence", () => {
    expect(classifyHermesSlackApiProof("TIMEOUT auth.test: socket timeout\n")).toEqual({
      kind: "timeout",
      reason: "TIMEOUT auth.test: socket timeout",
    });
    expect(() => assertHermesSlackApiProof("TIMEOUT auth.test: socket timeout\n")).toThrow(
      "Slack API proof incomplete required evidence: TIMEOUT auth.test: socket timeout",
    );
  });

  it("accepts complete required evidence in the live assertion path", () => {
    expect(() =>
      assertHermesSlackApiProof(
        "OK auth.test: status=200 error=None\nOK apps.connections.open: status=200 error=None\n",
      ),
    ).not.toThrow();
  });

  it.each(["FAIL auth.test: status=403", "ERROR apps.connections.open: invalid response"])(
    "rejects an explicit probe failure: %s",
    (line) => {
      expect(classifyHermesSlackApiProof(`${line}\n`)).toEqual({
        kind: "failed",
        reason: line,
      });
    },
  );

  it.each([
    {
      output: "OK auth.test: status=200 error=None\n",
      reason: "missing successful probe marker: apps.connections.open",
    },
    {
      output: "OK apps.connections.open: status=200 error=None\n",
      reason: "missing successful probe marker: auth.test",
    },
    {
      output: "unstructured output\n",
      reason: "missing successful probe marker: auth.test, apps.connections.open",
    },
  ])("rejects incomplete success evidence", ({ output, reason }) => {
    expect(classifyHermesSlackApiProof(output)).toEqual({ kind: "failed", reason });
  });
});
