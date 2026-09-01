<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Security and built-in quality

## Purpose

Determine whether the change prevents unsafe work at the boundary where it originates.

## Review method

Apply the trusted security rubric. Follow authority and data across each affected boundary. Inspect the first boundary that can reject an unsafe state.

## Own

- Authentication, authorization, and authority.
- Untrusted input, credentials, and sensitive data.
- Filesystem, process, network, workflow, installer, sandbox, and privilege boundaries.
- Least privilege, isolation, SSRF prevention, policy enforcement, and supply-chain trust.
- Security consequences of failure and security-specific regression evidence.

## Do not own

Do not report general dependency reuse, non-security recovery, ordinary correctness, or writing style.

## Lean lens

Apply jidoka. Stop work when required trust evidence is missing. Prefer validation before authority or mutation. Contain defects at their source instead of relying on downstream inspection.

## Report a finding when

The change permits an unauthorized action, crosses a boundary without its required check, exposes sensitive data, weakens isolation, or continues after losing required security evidence. Name the boundary, unsafe result, first control that can prevent it, and smallest protection.
