<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# LangChain Deep Agents Code Dependency Review

This file records the reviewed dependency baseline for the Deep Agents Code sandbox base image.
Update it whenever `requirements.lock` changes.

- Lockfile: `agents/langchain-deepagents-code/requirements.lock`
- Lockfile SHA-256: `d8b01f36a0f325f38d18b4dc2cfdf452125987571a86ca58d9c93e08b7b06a14`
- Audit command: `uv tool run --python 3.13 pip-audit -r agents/langchain-deepagents-code/requirements.lock --progress-spinner off --disable-pip`
- Audit date: 2026-07-07
- Audit result: `No known vulnerabilities found`

The Dockerfile installs this lockfile with `pip3 install --require-hashes`, so this review covers the exact package versions selected for the managed image install.

## Managed `fetch_url` Proxy Adapter

Deep Agents Code `0.1.34` deliberately disables ambient proxies and resolves
destination DNS locally before pinning the address used by `fetch_url`. That is
the wrong transport inside a NemoClaw-managed sandbox: ordinary egress and
destination resolution must pass through the policy proxy, so the direct path
fails even when the same approved URL works through the managed route.

NemoClaw owns the managed image, launchers, and policy boundary, but not the
hash-locked third-party `fetch_url` implementation. The exact-version build
patch therefore delegates only managed launches to a proxy URL independently
derived from the image's root-owned host and port files. The runtime rejects a
missing, unsafe, or mismatched file/environment contract, disables Requests'
ambient proxy, `NO_PROXY`, netrc, and CA discovery, and supplies the verified
proxy explicitly on every redirect hop. It separately validates the fixed,
root-owned CA-bundle mount injected into the sandbox and passes it as explicit
TLS transport trust; that bundle cannot select a proxy or authorize a
destination. Imports outside the managed launcher retain the upstream direct
DNS-pinning behavior.

Focused tests patch the released wheel, exercise managed and unmanaged paths,
reject forged proxy environments and malformed redirects, and prove that
credential-bearing URLs are not reflected. The live Deep Agents Code egress
check requires a nonempty 2xx response from an approved raw GitHub URL and
denial for an unapproved host, cloud metadata, and loopback. Remove this adapter
rather than refreshing it when a pinned Deep Agents Code release exposes a
supported policy-proxy transport with equivalent redirect and fail-closed
behavior.

## Released Nemotron 3 Ultra Profile

Deep Agents Code `0.1.34` pins `deepagents==0.7.0a6`, whose official wheel
contains the Nemotron 3 Ultra harness profile merged in Deep Agents PR #4192.
NemoClaw no longer vendors or overlays that source.

- Native profile SHA-256: `c8e8dd2b0182334b54be4f46ff0c7b45fbb95dc13bd9a92c249eb47a14fa13d7`
- Unmodified built-in bootstrap SHA-256: `005a91e7fc4ca6b21220673dd9d02d6686bf63e1e4f1102d124b01f96886efcf`
- Managed-alias bootstrap SHA-256: `9d9e817143b330fd45345fcfa8276ea6fe5d6bc5a396f0438b0899a450e4744b`

The build patch verifies those official artifacts, then registers the native
profile under the two `openai:` model keys used by NemoClaw's managed
OpenAI-compatible `ChatOpenAI` route. It is atomic, idempotent, and fails closed
on version, source, bootstrap, or partial-state drift. The image build applies
the patch and runs the complete profile and dispatch validator against the
installed hash-locked wheels, while focused fixtures cover failure states.
This build-time site-packages mutation is the deliberate managed-image adapter;
the released package is never changed at runtime. The deleted source-backport
license path, `LICENSE.langchain-deepagents`, is not staged into the image, and
the image regression tests enforce that absence.

Deep Agents Code `0.1.34` is the released consumer; prerelease risk is limited
to its exact `deepagents==0.7.0a6` SDK pin. That risk is accepted because the
consumer and SDK are hash locked, the dependency audit is clean, and all source,
version, middleware, graph, and dispatch checks fail closed.

The exact version and source-hash gates are also the executable lifecycle
tracker for the alias bridge: any dependency change stops the image build with
an explicit instruction to check for native managed-alias support, and requires
this review to be updated. The admin-maintainer override for this
source-of-truth decision records that the review is satisfied on the ancestor
containing this policy
([PR review](https://github.com/NVIDIA/NemoClaw/pull/6416#pullrequestreview-4649633900)).
That approval accepts this mandatory dependency-review gate as sufficient
removal accountability, so no standalone removal issue is used. When Deep
Agents natively recognizes both managed keys, the dependency review removes the
bridge instead of updating its versions or hashes.
