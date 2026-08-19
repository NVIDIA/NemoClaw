<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Code Change Considerations

Use these questions while planning, implementing, and reviewing a code change. Apply them to the
current lifecycle stage; do not turn them into a separate report when the workflow already owns an
output format.

## Authority

Current code, tests, workflows, and active `AGENTS.md` files own implementation details. Derive
paths, commands, test mappings, selectors, and architecture from the current checkout rather than
recording them here.

## Questions

- What accepted outcome and current consumer require the change?
- What current code owns the behavior, and can that owner be extended directly?
- What current code, branch, parameter, owner, fixture, or file becomes unnecessary and can be
  deleted or merged in this change?
- Would the change duplicate an existing structure or create another source of truth?
- Can the completed source-and-test change be neutral or negative in total lines? If not, what
  current correctness, security, or accepted-scope contract requires the growth?
- If the change adds a helper, abstraction, configuration, registry, fallback, or compatibility
  path, which current consumers adopt it now, what old structure does it remove, and is the whole
  result smaller or simpler?
- What state, success, failure, and partial-failure behavior must remain coherent?
- What ordering or concurrency can change the result or bypass a guarantee?
- How do absent values, defaults, retries, recovery, and cleanup behave?
- Which alternate entry, error, cached, resumed, or compatibility paths can bypass the change?
- Can code or configuration be removed, or can an existing or native mechanism replace new code?
- What shortest stable test proves the changed behavior, including the relevant negative path?
- Can that evidence extend or consolidate current fixtures, matrices, and assertions instead of
  creating another test owner or a one-use test helper?
- Does a real process, network, filesystem, container, hardware, or service boundary require deeper
  runtime or end-to-end evidence?
- Which active issues, pull requests, or recent changes overlap, conflict, or affect delivery order?
