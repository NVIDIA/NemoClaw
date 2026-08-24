<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Trust

Determine whether the change preserves security at each boundary it affects.

A good trust review reaches a clear conclusion about who or what the changed code trusts, what authority it grants, and how it handles untrusted input and sensitive data. It follows data and control across the affected process, filesystem, network, workflow, sandbox, and privilege boundaries. It checks that failure denies unauthorized access, retains least privilege, preserves isolation, and protects sensitive data.

Report a finding when the current code permits an unauthorized action, crosses a boundary without the required check, exposes sensitive data, weakens isolation, or grants more authority after failure. Explain the boundary, the resulting risk, and the smallest change that restores the required protection.
