<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Operability and recovery

## Purpose

Determine whether maintainers can complete, stop, diagnose, resume, and recover the changed system.

## Review method

Follow deployment, startup, normal use, partial success, failure, retry, cancellation, cleanup, upgrade, rollback, and removal where they apply.

## Own

- Actionable diagnostics and visible abnormal states.
- Retry safety, idempotence, reconciliation, and partial success.
- Cancellation, cleanup, resource identity, and resource ownership.
- Installation, deployment, packaging, generated artifacts, upgrade, and rollback.
- Bounded time, memory, disk, logs, polling, locks, fan-out, and external calls.
- Recovery procedures and removal of abandoned work.

## Do not own

Do not report security consequences, ordinary semantic correctness, architecture without an operational effect, or writing without operational impact.

## Review principles

Preserve flow. Expose waiting, rework, excess work in progress, hidden inventory, and unsafe repetition. Make abnormal conditions and standard recovery actions visible.

## Report a finding when

Repository evidence shows that the change introduces or worsens a state that can become stuck, leak or orphan resources, hide the cause or affected object, repeat an unsafe operation, wait without a bound, or leave partial work without reconciliation. Name the operational state, effect, and smallest reliable recovery change. Distinguish a defect from missing evidence. State material uncertainty without requiring exhaustive proof.
