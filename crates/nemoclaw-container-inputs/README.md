<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Protected container input publisher

This fixed Rust helper publishes bounded credential files and a nonsecret connection
descriptor into one owned application volume. It is not an application installer,
gateway, credential issuer, or continuously running operator.

## Accepted scope

San Dang accepted this helper on October 6, 2026, in the installer implementation
conversation. The reason is that Docker archive extraction cannot verify POSIX ACLs
or reliably change the mounted root's ownership before credentials cross the boundary.
Placement: this crate, `image/container-inputs`, and the generic container-input
provider. Accountable NemoClaw maintainer: San Dang. Validation: deterministic
protocol, custody, ownership and recovery tests; Linux filesystem/ACL tests; and
an opt-in Docker integration check. Image publication and live deployments are
not authorized by this decision. VoiceClaw support and joint qualification require
their own accepted ownership and evidence.

## Custody and protocol

The provider requires a preloaded immutable setup image with the fixed entrypoint
and `io.nemoclaw.container-inputs=1` label. It creates a root initializer with one
owned volume, no network, a read-only root filesystem, bounded resources, and only
`CHOWN`, `FOWNER`, and `DAC_OVERRIDE` capabilities. These capabilities permit
initialization and validation of the non-root application's private tree.

`install <uid> <gid>` validates the root's ownership, mode, and Linux ACLs before
writing the constant `ready\n` to stdout. Only then does the provider send the
bounded JSON request over attached stdin. Credentials are not arguments, Docker
environment variables, labels, state attributes, or logged output. The helper
does not invoke a shell. It requires private owned directories (`0700`), regular
single-link files (`0600`), descriptor-relative no-follow traversal, stable reads,
and no extended/default POSIX ACLs. An unavailable ACL check fails closed.

Files are published atomically; a completion marker is written last. It contains
only the public input-reference revision and sandbox identity, not secret hashes.
The intended application UID can modify its own files: the consumer must validate
them before use and must not rewrite installer-owned inputs. This is not read-only
storage against that UID.

Completed unchanged setup is not rewritten or restarted. Credentials behind
unchanged references are not automatically rotated. A failed or uncertain mutation
retains the owned helper binding and volume with `complete=false`. An explicit apply
may replace a confirmed stopped failed helper only while the application is stopped;
it never replays credentials into an unconfirmed running helper. Reads and health
checks do not publish files or start the initializer.

See [manual qualification](../../image/container-inputs/README.md). macOS tests
exercise path, ownership and mode handling with an explicitly test-only ACL stub;
they do not qualify Linux ACL enforcement or Docker delivery.
