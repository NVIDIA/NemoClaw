<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# VoiceClaw R0 contract fixtures

These files are the portable `nemoclaw-voice-r0/2` fixture bundle from
[NemoClaw issue #11747](https://github.com/NVIDIA/NemoClaw/issues/11747).

`fixtures.json`, `fixture_server.py`, `test_fixture.py`, `test_probe_fixture.py`, and
`REVISION-2.md` are copied byte-for-byte from revision 2. The fixture JSON SHA-256 is
`3e5f88079f5f8967008243b7a56b9916482a4655eb8f790a79320b097ec59c82`.

The Python server uses a synthetic dispatch counter. It does not prove native-agent reachability or
live deployment behavior.
