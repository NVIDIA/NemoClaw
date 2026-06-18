# NGC Setup Reference

How to configure NGC CLI once, store it safely, and reuse on every run.

> **⚠ Prerequisite — this file's flow is CONDITIONAL.** The deploy skill
> must only enter the NGC credential flow if at least one asset in
> `RESOURCE_PLAN` has source `ngc` (the `NEEDS_NGC=1` flag from Step
> 1.f). If every asset is local or RTSP-only (`NEEDS_NGC=0`), **skip this
> file entirely** — do NOT ask for an API key, do NOT check
> `~/.ngc/config`. See `resource-plan.md` for the
> decision logic.
>
> **Host-only.** NGC creds are read on the host by
> `scripts/fetch_resources.sh` for `ngc registry download-version`. The
> container never receives a `~/.ngc` mount — it reads the staged data
> from `~/rtvicv-storage:/opt/storage`.

## Placeholders

| Placeholder | Description |
|---|---|
| `<NGC_API_KEY>` | Personal NGC API key (generate at https://ngc.nvidia.com > Setup > API Key) |
| `<NGC_ORG>` | NGC organization |
| `<NGC_TEAM>` | NGC team (optional — blank if not used) |

---

## Credential Persistence (ask ONCE per system)

NGC credentials should be **collected once and cached** in the standard NGC
config location. The agent must always check for an existing config first and
reuse it silently — never re-prompt a user who is already set up.

### Canonical storage

| Context | Path | Permissions |
|---|---|---|
| Host (if the agent runs `ngc` on the host) | `~/.ngc/config` | `600` |
| Container (`ngc` inside the RTVI-CV container) | `/root/.ngc/config` (or `~/.ngc/config`) | `600` |

Both locations store the same INI-style file:

```ini
[CURRENT]
apikey = <NGC_API_KEY>
format_type = ascii
org = <NGC_ORG>
team = <NGC_TEAM>
```

### Persisting across container runs

Since the container is `--rm` (ephemeral), the `~/.ngc/config` written inside
will be lost when the container exits. Mount the host config into the container
to persist it:

```bash
# On the HOST, once.
mkdir -p $HOME/.ngc
chmod 700 $HOME/.ngc
# After writing the config (see below), chmod 600 ~/.ngc/config

# Add this to every docker run:
```

With this mount, every container session reads the host's `~/.ngc/config` and
no re-configuration is ever needed.

---

## Agent Workflow (the decision tree)

```
1. Check for existing config on HOST:
     if [[ -f ~/.ngc/config ]] && grep -q '^apikey' ~/.ngc/config; then
         -> REUSE (print: "Using existing NGC config for org <ORG>")
         -> skip to resource download
     fi

2. Config missing or empty:
     -> Ask user ONCE:
          - NGC API Key (masked input)
          - NGC Org (prompt, no list — user-specific)
          - NGC Team (optional)
     -> Write ~/.ngc/config with chmod 600 (see "Non-interactive config" below)
     -> Verify with `ngc config current`
     -> Cache succeeds: do NOT ask again in future sessions

3. Verification failed (bad key / wrong org):
     -> Print the error
     -> Back up the bad config (mv ~/.ngc/config ~/.ngc/config.bak)
     -> Re-ask the user
```

The key rule: **if `~/.ngc/config` exists and contains a valid-looking API key,
reuse it without asking**. Only re-prompt if the file is missing or the next
`ngc` command returns an auth error.

---

## Non-interactive config (preferred for agents)

Write the config file directly — skip the `ngc config set` prompts:

```bash
mkdir -p ~/.ngc
chmod 700 ~/.ngc
cat > ~/.ngc/config <<EOF
[CURRENT]
apikey = <NGC_API_KEY>
format_type = ascii
org = <NGC_ORG>
team = <NGC_TEAM>
EOF
chmod 600 ~/.ngc/config
```

### Verify

```bash
ngc config current
```

Should print the org/team and a masked API key. If it errors with
"authentication failed", the API key or org is wrong — re-prompt.

---

## Security Guidelines

- Always `chmod 600 ~/.ngc/config` after writing (owner read/write only)
- Never echo or log the API key in full — mask it (e.g. `sk-****...****1234`)
- Never commit `~/.ngc/config` to git
- Never pass the API key on the command line (it shows up in `ps` and shell history) — always via the config file or via `-e NGC_CLI_API_KEY` environment variable
- If the user shares their screen, the masked `apikey` shown by `ngc config current` is safe; the raw file content is not

---

## Alternative: environment-variable mode (stateless)

If the user prefers not to persist credentials on disk, the agent can pass them
per-invocation via env vars:

```bash
export NGC_CLI_API_KEY=<NGC_API_KEY>
export NGC_CLI_ORG=<NGC_ORG>
export NGC_CLI_TEAM=<NGC_TEAM>
ngc registry ...
```

In this mode the user must provide the key every session. Prefer file-based
persistence unless the user explicitly opts out.

---

## Check Already-Downloaded Resources

Before re-downloading, check what's already under `$RESOURCES`:

```bash
ls -1 $RESOURCES/ 2>/dev/null
```

Compare directory names against expected NGC resource prefixes. If a match is
found, ask the user whether to reuse or re-download — do NOT silently re-download
(NGC resources can be large, 10+ GB).

---

## Download Commands per Use Case

### Warehouse (2D and 3D share the same resource)

```bash
cd $RESOURCES
ngc registry resource download-version <WAREHOUSE_APP_DATA_NGC>
cd <downloaded_dir> && tar -xvf *.tar.gz
```

### Smart City RT-DETR

```bash
cd $RESOURCES

# Model
ngc registry model download-version <RTDETR_MODEL_NGC>

# Videos
ngc registry resource download-version <SMARTCITY_APP_DATA_NGC>
cd <downloaded_dir> && tar -xvf *.tar.gz
cd $RESOURCES

# ReID for tracker (stable URL, not version-pinned)
mkdir -p /opt/nvidia/deepstream/deepstream/samples/models/Tracker/
wget 'https://api.ngc.nvidia.com/v2/models/nvidia/tao/reidentificationnet/versions/deployable_v1.0/files/resnet50_market1501.etlt' \
  -O /opt/nvidia/deepstream/deepstream/samples/models/Tracker/resnet50_market1501.etlt
```

### Smart City GDINO

Requires everything from RT-DETR (videos + ReID) **plus**:

```bash
cd $RESOURCES
ngc registry model download-version <GDINO_MODEL_NGC>
```

---

## Resource Resolution Pattern

NGC resources extract to directories whose names include the version, e.g.:

```
$RESOURCES/
├── <resource-name>_v<version>/
│   └── <actual-content>/
├── <model-name>_v<version>/
│   └── <model-files>
```

**The agent should NOT hard-code names** — neither the extracted top-level directory nor its internal layout. Step 4.a of the deploy flow does all discovery via `find` constrained only by extension / filename and dispatches on the candidate count (0 → error, 1 → use, >1 → ask the user). See `apply-config.md § 4.a` for the `resolve_or_ask` helper and per-asset patterns.

```bash
# Layout-agnostic discovery — see apply-config.md § 4.a for the full helper.
ONNX=$(resolve_or_ask 'ONNX model' "$RESOURCES" -type f -name '*.onnx')
LABELS=$(resolve_or_ask 'labels' "$RESOURCES" -type f -name 'labels.txt')
ANCHOR=$(resolve_or_ask 'anchor'  "$RESOURCES" -type f -name '*.npy')
```

Pass discovered paths into configs via `common.sh` helpers (`update_yaml_flat`, `update_ds_config`). The helpers substitute the shipped `<PATH_TO_*>` placeholders with the absolute paths.
