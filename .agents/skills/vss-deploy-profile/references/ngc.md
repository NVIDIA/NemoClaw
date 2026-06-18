---
name: ngc
description: Install, configure, or verify NVIDIA NGC CLI and API key access. Use when NGC CLI is missing, the NGC API key needs to be set or tested, or NGC resource access fails.
---

# NGC CLI — Install, Configure, Verify

Manages NVIDIA NGC CLI setup and API key access. Required before deploying any VSS profile.

## When to Use

Use this skill when:

- NGC CLI is not installed (`ngc: command not found`)
- NGC API key is missing or needs to be verified
- An NGC resource pull fails with auth errors
- User asks to set up or reconfigure NGC access

## Check Current State

```bash
# Is NGC CLI installed?
ngc --version

# Is key in environment?
if [[ -n "${NGC_CLI_API_KEY:-}" ]]; then
  echo "NGC_CLI_API_KEY: SET"
else
  echo "NGC_CLI_API_KEY: NOT SET"
fi
```

---

## Install NGC CLI (if missing)

**AMD64 Linux:**

```bash
curl -sLo /tmp/ngccli.zip \
  https://api.ngc.nvidia.com/v2/resources/nvidia/ngc-apps/ngc_cli/versions/4.10.0/files/ngccli_linux.zip
sudo mkdir -p /usr/local/lib
sudo unzip -qo /tmp/ngccli.zip -d /usr/local/lib
sudo chmod +x /usr/local/lib/ngc-cli/ngc
sudo ln -sfn /usr/local/lib/ngc-cli/ngc /usr/local/bin/ngc
ngc --version
```

**ARM64 Linux:**

```bash
curl -sLo /tmp/ngccli.zip \
  https://api.ngc.nvidia.com/v2/resources/nvidia/ngc-apps/ngc_cli/versions/4.10.0/files/ngccli_arm64.zip
```

_(then same install steps as above)_

---

## Configure NGC API Key

If the user doesn't have a key yet, guide them:

1. Go to https://ngc.nvidia.com → sign in
2. Top-right → **Setup** → **API Keys** → **Generate Personal Key**
3. Set permissions: **NGC Catalog**
4. Copy the key immediately (shown only once)

Once they have the key:

```bash
read -rsp "NGC API key: " NGC_CLI_API_KEY
echo
export NGC_CLI_API_KEY
```

> Security note: Prefer a current-session handoff: enter the key with `read -rs`,
> inject it from a secrets manager, and pass it to `docker login` with
> `--password-stdin`. Do not pass the raw key as a CLI argument, write it to any
> workspace file or shell profile such as `~/.bashrc`, or commit it to version
> control. If an env file is unavoidable, keep it outside the repo and restrict
> it with `chmod 600`.

---

## Verify Access

```bash
ngc registry resource info nvidia/vss-developer/dev-profile-sample-data
```

Should return resource info (including the latest version) without errors.

> **Why this check?** `dev-profile-sample-data` is a published artifact in the `nvidia/vss-developer` catalog — the same sample-data bundle the deploy pulls for its sample videos — so reaching it confirms the API key and org are scoped to the public VSS catalog (where the `nvcr.io/nvidia/vss-core/...` images also live).
>
> **Why no version pin?** A bare `resource info` (no `:tag`) already proves access and returns the latest version on its own, so the check survives release bumps (`3.2.0` → `3.2.x` / `3.3.0`) instead of going stale. A resource is also a steadier target than an image — `dev-profile-sample-data` is cut per release line (`3.0.0` → `3.1.0` → `3.2.0`), while image tags churn on every patch. Pin a `:tag` only to confirm a specific version exists.

**Common error:** `Missing org — If Authenticated, org is also required.`
→ Fix: run `ngc config set` and ensure the org matches the one selected when generating the key.

---

## Quick Config via ngc CLI

```bash
ngc config set
# prompts for API key, org, team, format
```
