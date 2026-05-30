<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Offline Setup and Secure Keys

This guide prepares a local NemoClaw checkout for offline documentation access, local development, and secure service authorization.

## 1) Update the repository

```bash
git pull --rebase --autostash
```

## 2) Install project dependencies

On Windows, the root `prepare` script uses POSIX shell syntax. Use `--ignore-scripts` for local setup, then build modules directly.

```bash
npm install --ignore-scripts
cd nemoclaw
npm install --ignore-scripts
npm run build
cd ..
```

## 3) Build offline documentation

When Sphinx is available, generate static docs into `docs/_build/html`.

```bash
uv sync --group docs
uv run --group docs sphinx-build -b html docs docs/_build/html
```

Open `docs/_build/html/index.html` in a browser for offline docs.

## 4) Use the NemoClaw API key keeper

NemoClaw stores credentials in `~/.nemoclaw/credentials.json` and restricts file permissions.

For isolated testing, set `NEMOCLAW_CREDENTIALS_FILE` (or `NEMOCLAW_CREDENTIALS_DIR`) to use a temporary credential store and avoid touching real user keys.

List keys:

```bash
nemoclaw keys list
```

Store or update a key:

```bash
nemoclaw keys set NVIDIA_API_KEY
nemoclaw keys set BRAVE_API_KEY --value "your-key"
```

Remove a key:

```bash
nemoclaw keys remove BRAVE_API_KEY
```

Show storage path:

```bash
nemoclaw keys path
```

Recommended service keys for onboarding flows:

- `NVIDIA_API_KEY`
- `GITHUB_TOKEN`
- `BRAVE_API_KEY`
- `DISCORD_BOT_TOKEN`
- `SLACK_BOT_TOKEN`
- `TELEGRAM_BOT_TOKEN`

Authorization order for a clean setup:

1. `NVIDIA_API_KEY` (required for NVIDIA-hosted inference setup)
2. `GITHUB_TOKEN` (required only for private GitHub package access/deploy paths)
3. `BRAVE_API_KEY` (optional web search)
4. Messaging keys (`DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`) as needed

## 5) Begin onboarding

With required keys stored, start guided onboarding:

```bash
nemoclaw onboard
```

For CI-style runs:

```bash
nemoclaw onboard --non-interactive --yes-i-accept-third-party-software
```
