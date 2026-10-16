// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { guidanceOrigin } from "../src/origins.js";

test("source grouping uses the most specific path without changing navigation order", () => {
  const broad = { id: "tools", name: "Tools", paths: ["tools/"] };
  const advisor = { id: "advisor", name: "Advisor", paths: ["tools/advisor/"] };
  const file = { id: "prompt", name: "Prompt", paths: ["tools/advisor/prompt.ts"] };
  const origins = [broad, file, advisor];
  assert.equal(guidanceOrigin("tools/advisor/prompt.ts", origins).id, "prompt");
  assert.equal(guidanceOrigin("tools/advisor/context.ts", origins).id, "advisor");
  assert.equal(guidanceOrigin("tools/other.ts", origins).id, "tools");
  assert.equal(guidanceOrigin("toolshed/prompt.ts", origins).id, "other");
  assert.equal(guidanceOrigin("README.md", []).id, "other");
  assert.deepEqual(
    origins.map((o) => o.id),
    ["tools", "prompt", "advisor"],
  );
});
