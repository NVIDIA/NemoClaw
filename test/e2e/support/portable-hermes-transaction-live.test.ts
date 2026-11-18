// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { portableHermesTransactionSandboxIsPresent } from "../fixtures/portable-hermes-transaction-live.ts";

const sandbox = {
  id: "sandbox-alpha",
  name: "alpha",
  labels: {},
  resource_version: 1,
  created_at: "2026-10-29T00:00:00Z",
  phase: "Ready",
  current_policy_version: 1,
};

it.each([
  { inventory: [sandbox], present: true },
  { inventory: [], present: false },
  { inventory: { sandboxes: [sandbox], next_page_token: "" }, present: true },
  { inventory: { sandboxes: [], next_page_token: "" }, present: false },
  {
    inventory: { sandboxes: [{ ...sandbox, name: "other" }], next_page_token: "" },
    present: false,
  },
])("reads complete transaction cleanup inventory $inventory (#12603)", ({ inventory, present }) => {
  expect(
    portableHermesTransactionSandboxIsPresent("alpha", {
      status: 0,
      stdout: JSON.stringify(inventory),
    }),
  ).toBe(present);
});

it.each([
  { status: 1, stdout: "[]" },
  { status: null, stdout: "[]" },
  { status: 0, stdout: "[]", error: new Error("transport lost") },
  { status: 0, stdout: "not-json" },
  { status: 0, stdout: JSON.stringify({ sandboxes: [], next_page_token: "more" }) },
  { status: 0, stdout: JSON.stringify({ sandboxes: [] }) },
  { status: 0, stdout: JSON.stringify([{ name: "alpha" }]) },
  { status: 0, stdout: JSON.stringify({ sandboxes: [sandbox, sandbox], next_page_token: "" }) },
])("refuses ambiguous transaction cleanup evidence $stdout (#12603)", (result) => {
  expect(() => portableHermesTransactionSandboxIsPresent("alpha", result)).toThrow(
    /cleanup observation|duplicate sandbox names/,
  );
});
