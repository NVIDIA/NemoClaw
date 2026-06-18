---
name: ngc-api-key-registry-login
description: Obtain an NGC API key and log in to nvcr.io so Docker can pull the vss-video-analytics-api image. Use when the image pull fails with 401/403 or NGC_CLI_API_KEY is unset.
---

# NGC Access — API Key + Registry Login

The standalone `vss-video-analytics-api` deploy needs only an NGC API key so Docker can pull the container image from `nvcr.io`. It does not use the `ngc` CLI to download NGC resources, so the full NGC CLI install / verify flow is out of scope here.

## Check current state

```bash
echo "NGC_CLI_API_KEY: ${NGC_CLI_API_KEY:+SET}${NGC_CLI_API_KEY:-NOT SET}"
```

## Get an API key (if you don't have one)

1. Go to https://ngc.nvidia.com → sign in.
2. Top-right → **Setup** → **API Keys** → **Generate Personal Key**.
3. Permissions: **NGC Catalog**.
4. Copy the key immediately (it is shown only once).

## Export the key

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

## Log in to nvcr.io so Docker can pull the image

```bash
printf '%s' "$NGC_CLI_API_KEY" | docker login --username '$oauthtoken' --password-stdin nvcr.io
```

`$oauthtoken` is the literal username for NGC registry auth — use it verbatim, do not substitute your own username. After login, `docker compose ... up` (or a direct `docker pull nvcr.io/nvidia/vss-core/vss-video-analytics-api:<tag>`) can pull the image.

**Common error:** `401 Unauthorized` / `403` on pull → the key is missing, expired, or not scoped to the **NGC Catalog**. Regenerate the key, re-export `NGC_CLI_API_KEY`, and re-run `docker login`.
