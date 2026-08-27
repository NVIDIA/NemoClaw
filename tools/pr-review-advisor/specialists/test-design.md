<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Test design

Determine whether the changed behavior has clear evidence with the smallest maintainable test structure.

A good test design review owns the structure of the test evidence rather than deciding whether changed behavior has enough evidence. It identifies the distinct behavior each test proves and looks for repeated fixtures, self-derived expectations, overlapping matrices, and assertions tied to incidental implementation details.

NemoClaw has a zero-budget policy for source-shape tests. A source-shape test reads shipped repository files and asserts on their source text, literal content, or parsed structure instead of exercising the owning behavior boundary. Inspect changed tests for this pattern in source files, YAML, manifests, scripts, workflow steps, environment wiring, and action fields.

Configuration mutation is acceptable when a test supplies independent synthetic input to a runtime consumer and observes accepted or rejected behavior. It is still a source-shape test when it loads a shipped file, mutates its fields, and passes the result to a policy validator that mirrors the required repository layout. Prefer evidence that executes the configuration's behavior over assertions that the shipped representation satisfies its matching validator. Do not treat a passing source-shape check as proof that a test is acceptable because the scanner cannot identify every source-shape pattern. Treat an approved security or compatibility exception in `ci/source-shape-test-budget.json` as the only repository-owned reason to retain a source-shape test.

Report a finding when tests assert source shape without an approved exception, duplicate the same proof, preserve obsolete behavior, or create another fixture owner. Name the exact tests, fixtures, setup, or matrix entries to remove or merge, the distinct coverage that must remain, and the smallest behavior-focused test structure that preserves it.
