---
title:
  page: "NemoClaw Credential Storage"
  nav: "Credential Storage"
description:
  main: "Learn where NemoClaw stores credentials, what protections it applies, and how to inspect or rotate stored secrets."
  agent: "Covers where NemoClaw stores provider credentials, why nothing is persisted to host disk, and how the OpenShell gateway acts as the single system of record. Use when reviewing how credentials are handled, locating a stored credential, or assessing the storage threat model."
keywords: ["nemoclaw credential storage", "openshell provider", "api key security"]
topics: ["generative_ai", "ai_agents"]
tags: ["security", "credentials", "openshell", "secrets"]
content:
  type: reference
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Credential Storage

NemoClaw does not persist provider credentials to host disk.
The OpenShell gateway is the only system of record for stored credentials.

When you provide a provider credential — interactively during `nemoclaw onboard` or via an environment variable — NemoClaw holds the value in memory only long enough to register it with the OpenShell gateway through `openshell provider create` or `openshell provider update`.
The gateway stores the credential and the OpenShell L7 proxy substitutes it into outbound requests at egress, so sandboxed agents see placeholders instead of the raw secret.

The sandbox-side OpenClaw gateway token is generated at container startup and is not rotated through provider credential commands.

## Where Credentials Live

Provider credentials live in the OpenShell gateway store.
List what is registered with:

```console
$ openshell provider list
```

Or, equivalently, through NemoClaw:

```console
$ nemoclaw credentials list
```

Both surface the provider names that the gateway holds credentials for. The values themselves cannot be read back from the CLI; this is a deliberate property of OpenShell.

NemoClaw still keeps non-secret operational state under `~/.nemoclaw/` (such as the sandbox registry).
That directory is created with mode `0700` and contains no credential material.

## Environment Variables Take Precedence

When a NemoClaw command needs a credential value during a single run (for example to forward it to an `openshell provider` registration), it reads from `process.env` first.
This means you can:

- Prefix any command with the credential to override the gateway-stored value: `NVIDIA_API_KEY=nvapi-... nemoclaw onboard`
- Use short-lived or rotated credentials in CI by exporting them once per pipeline run
- Avoid registering credentials in the gateway entirely if your environment supplies them

## Deploy Reads from Environment Only

`nemoclaw deploy` (which provisions a remote Brev box) cannot read secrets back from the gateway, so it requires every credential to be present in the host environment at invocation time.
A typical deploy invocation looks like:

```console
$ NVIDIA_API_KEY=nvapi-... \
    TELEGRAM_BOT_TOKEN=... \
    nemoclaw deploy my-instance
```

If a required credential is missing the deploy aborts before any remote work begins.

## GitHub Tokens

NemoClaw never persists `GITHUB_TOKEN` itself.
When a private repo requires authentication NemoClaw runs `gh auth token`, which returns whatever the GitHub CLI has stored — without caring about the storage backend.

The GitHub CLI prefers an OS keychain when one is reachable: macOS Keychain on macOS, Windows Credential Manager on Windows, and Linux Secret Service (libsecret + a running D-Bus session) on Linux.
On hosts where no keychain is reachable (CI runners, headless launches, WSL without a session bus, macOS contexts where Keychain access is blocked, etc.) `gh auth login` falls back to a `gh`-managed file under `~/.config/gh/` with mode `0600`.
NemoClaw treats both backends identically: `gh auth token` returns the value, and NemoClaw stages it in `process.env` for the current run only.

If `gh` is not installed or not logged in, NemoClaw prompts for a personal access token for that single run; the prompted value is held in process memory and is not written to host disk.
Run `gh auth login` if you want a persistent backing store (whichever one applies on your host) so future runs do not prompt.

## Migration From Earlier Releases

Earlier NemoClaw releases stored credentials as plaintext JSON in `~/.nemoclaw/credentials.json` with mode `0600`.
On first `nemoclaw onboard` after upgrading, NemoClaw automatically:

1. Reads the legacy file.
2. Stages allowlisted credential values into `process.env` for the rest of the run.
3. Re-registers each value with the OpenShell gateway through the normal onboarding path.
4. Securely overwrites and deletes `~/.nemoclaw/credentials.json` only after every staged value has been verified as migrated to the gateway.

You will see a one-line stderr notice the first time this happens.
Credential lookup paths such as rebuild also stage allowlisted legacy values so interrupted upgrades can keep working, but those staging-only paths do not delete the plaintext file because they cannot prove every legacy value was registered with the gateway.
If `~/.nemoclaw/credentials.json` remains after a rebuild or other credential lookup, run `nemoclaw onboard` to complete the verified gateway migration and cleanup.

## Rotate or Remove a Stored Credential

The simplest way to replace a stored value is to rerun onboarding with the new value in your environment:

```console
$ NVIDIA_API_KEY=nvapi-new-value nemoclaw onboard
```

To remove a credential from the gateway entirely:

```console
$ nemoclaw credentials reset <PROVIDER_NAME>
```

`<PROVIDER_NAME>` is the OpenShell provider name (run `nemoclaw credentials list` first if you are not sure).
On the next run NemoClaw prompts again unless the credential is supplied through the environment.

## Security Recommendations

1. Prefer short-lived or low-scope provider credentials where the upstream service supports them.
2. Rotate keys after suspected exposure, machine transfer, or account changes.
3. Prefer environment variables for ephemeral automation rather than registering long-lived secrets in the gateway.
4. Do not copy any host-side NemoClaw state into container images, Git repositories, bug reports, or support bundles. Even though credentials no longer live on disk, the surrounding configuration may reveal which providers you have registered.
5. Keep your home directory private and owned by your user account.

## Related Files

For the broader sandbox security model and operational trade-offs, see [Security Best Practices](./best-practices.md) and [Architecture](../reference/architecture.md).
