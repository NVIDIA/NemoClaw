<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Root-Cause and Sensitive-Workflow State Checks

Apply these checks while planning, implementing, and reviewing a change. Record the results in the
output that the current workflow already owns; do not produce a separate report. State why a check
does not apply when the omission could hide risk.

## Authority

Current code, tests, workflows, and active `AGENTS.md` files own implementation details. Derive the
operations, sibling paths, and states from the current checkout rather than recording them here.

## Root-Cause Sibling Paths

Name the operation and failure class that the change belongs to.
Inspect adjacent paths that implement the same operation or failure class.
Record which sibling paths were checked and whether each one needs the same change.
A change that repairs one path and leaves a sibling path unchanged keeps the same defect reachable.

## Sensitive-Workflow State Matrix

Build a sensitive-workflow state matrix as working analysis for a flow that handles credentials,
remote execution, billable resources, destructive cleanup, security policy, or public writes. Use
only the rows and columns required to cover the changed contract. Classify these outcomes when they
apply:

| Phase | Success | Command Failure | Transport Ambiguity | Verification Failure |
|---|---|---|---|---|
| Input or credential acquisition | Result and custody | Removal or rollback | Assume possible remote effect | Rejected input |
| Execution | Expected state | Failure classification | Confirmation requirement | Acceptance criteria not met |
| Cleanup | Confirmed removal | Recovery action | Ownership and absence check | Retention and rotation |
| External write | Accepted write set | Partial-write report | Assume a possible write and re-read external state | Report a partial or inconclusive result |

For each credential, name its location, access, lifetime, and removal. For each failure cell, record
the result and required action separately. Classify the result as an infrastructure failure or
inconclusive verification when applicable. Classify the action as rollback, retry, or stop. Ask the
user before choosing a behavior that changes security, data safety, cost, or a supported contract.

The [Security Rubric](security-rubric.md) owns the authentication and authorization category and its
evidence expectations. For a public or external write, record the positive and negative evidence that
authorization is enforced for the resource and action.
