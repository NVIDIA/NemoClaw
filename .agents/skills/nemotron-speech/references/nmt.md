# Riva NMT NIM

> **Agent:** When walking the user through a multi-step workflow, announce each step before presenting it: **Step N/M — Step Title** (e.g., "**Step 1/4 — Deploy the Container**").
>
> **Source of truth.** This skill describes deployment mechanics, which are stable across releases. For anything that varies per release — model catalog, container IDs, supported language pairs, feature support, VRAM minimums — **fetch or open the canonical doc page and answer from that, not from this skill's text.** See [Looking up current information](#looking-up-current-information) below.

## Purpose

Deploy and run NVIDIA Riva NMT (neural machine translation) NIMs for bidirectional text translation. Covers container deployment, inference modes (basic, batch, do-not-translate tags), and Helm deployment.

## Looking up current information

This skill is **orientation, not catalog**. When a question depends on data that changes per release, fetch or open the relevant page and answer from that page:

| Question type | Fetch this page |
|---|---|
| Current models, container IDs, supported language pairs, VRAM minimums | https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/nmt.html |
| Function IDs for cloud (build.nvidia.com) inference | `https://api.nvcf.nvidia.com/v2/nvcf/functions` (auth with `NVIDIA_API_KEY`; filter by `name` and `status=="ACTIVE"`). For human browsing only: `https://build.nvidia.com/<org>/<model>/api` (JS-rendered, not suitable for non-browser fetch tools). |
| **Runtime feature support per model** — `<dnt>` tags, custom DNT dictionaries, max-length variation, batch translation, language code formats | https://docs.nvidia.com/nim/speech/latest/nmt/customization/customization.html |
| **gRPC proto contract** — `TranslateTextRequest`, `TranslateTextResponse`, `dnt_phrases`, language code conventions | https://docs.nvidia.com/nim/speech/latest/reference/api-references/nmt/protos.html |
| GPU / VRAM / driver minimums, OS prerequisites | https://docs.nvidia.com/nim/speech/latest/get-started/prerequisites.html |
| Latency / throughput benchmarks per model and GPU | https://docs.nvidia.com/nim/speech/latest/reference/performances/nmt/performance.html |

**Do not infer from this skill's text:** which models exist, which language pairs are supported, what `CONTAINER_ID` to use, which decoders honor `<dnt>` tags, or what VRAM is required. The docs are the contract. Always run `--list-models` against a running NIM to see the exact language codes that server accepts.

> **Naming caveat.** The same model can appear under different slugs across NVIDIA's catalogs: support-matrix label (e.g., "Megatron 1B NMT", "Riva Translate 1.6B"), `CONTAINER_ID`, NVCF function name (`ai-megatron-1b-nmt`, `ai-riva-translate-1_6b`), and build.nvidia.com URL slug. Do not assume they match — cross-reference each from its own catalog. The NVCF Functions API is the only catalog you can hit programmatically; use it to resolve function-ids at runtime rather than hardcoding.

## Workflow

Use this reference after model selection for NMT-specific commands: local deployment, readiness checks, language-pair discovery, translation, and optional Helm deployment.

## Prerequisites

- **Self-hosted:** complete [`setup.md`](setup.md) first — NVIDIA Container Toolkit, `NGC_API_KEY` exported, Docker logged in to `nvcr.io`. Driver, GPU, and VRAM minimums change per release — fetch the support matrix and prerequisites pages cited above before deploying.
- **Cloud (build.nvidia.com):** `pip install -U nvidia-riva-client` and a valid `NVIDIA_API_KEY`. The same NGC personal key works for both planes if it was issued with the **Cloud Functions** scope; most users export the same value to both `NVIDIA_API_KEY` and `NGC_API_KEY`. No GPU needed.

## Instructions

- Deploy the NMT container when using a self-hosted NIM.
- Verify server readiness before running clients.
- List available language pairs from the running server.
- Run translation with the selected source and target language codes.
- Use the Helm section only for production Kubernetes deployments.

For **runtime feature questions** (`<dnt>` tags, custom dictionaries, max-length variation, supported language pairs): fetch or open the customization page from the routing table above before answering.

## Step 1 — Deploy the Container

Fetch the current `CONTAINER_ID` from the support matrix.

```bash
export CONTAINER_ID=<container-id-from-support-matrix>
export LOCAL_NIM_CACHE=~/.cache/nim
mkdir -p $LOCAL_NIM_CACHE && sudo chown 1000:1000 $LOCAL_NIM_CACHE

docker run -it --rm --name=$CONTAINER_ID \
  --runtime=nvidia \
  --gpus '"device=0"' \
  --shm-size=8GB \
  -e NGC_API_KEY \
  -e NIM_HTTP_API_PORT=9000 \
  -e NIM_GRPC_API_PORT=50051 \
  -p 9000:9000 \
  -p 50051:50051 \
  -v $LOCAL_NIM_CACHE:/opt/nim/.cache \
  nvcr.io/nim/nvidia/$CONTAINER_ID:latest
```

`NIM_TAGS_SELECTOR` is optional for NMT — the container selects the best profile for your GPU automatically.

> **Security note:** Environment variables passed via `-e` to Docker are visible in `docker inspect` output and process listings. For production, use Docker secrets or a secrets manager instead of passing credentials as env vars.

## Step 2 — Verify Readiness

If you started the container yourself, the HTTP probe is enough:

```bash
curl -fsS http://localhost:9000/v1/health/ready    # expect {"status":"ready"}
```

If a container was already running when you arrived (shared dev box, mystery process), the HTTP check is not sufficient — a host-mapped gRPC port can route to a container with **nothing bound inside**, and connections silently drop mid-RPC. Confirm an NMT model is actually being served with this inline probe (needs only `pip install nvidia-riva-client`):

```bash
python3 - <<'PY'
import sys, riva.client
auth = riva.client.Auth(uri="0.0.0.0:50051")
nmt = riva.client.NeuralMachineTranslationClient(auth)
try:
    cfg = nmt.get_config("")    # empty model name returns all loaded models
except Exception as e:
    print(f"UNHEALTHY: {e}"); sys.exit(2)
if not cfg.languages:
    print("UNHEALTHY: server responded but exposes no NMT models"); sys.exit(2)
print(f"OK: {len(cfg.languages)} model(s)")
for name, langs in cfg.languages.items():
    s = ",".join(list(langs.src_lang)[:5])
    t = ",".join(list(langs.tgt_lang)[:5])
    print(f"  - {name}  src=[{s}...]  tgt=[{t}...]")
PY
```

An empty model list or `UNAVAILABLE: Socket closed` means the server is not actually running NMT — restart the NIM rather than continuing.

## Step 3 — List Available Models and Language Pairs

The set of supported language pairs is per-model and discovered at runtime:

```bash
python3 "$PY_CLIENTS/scripts/nmt/nmt.py" \
  --server 0.0.0.0:50051 \
  --list-models
```

Use these codes verbatim in `--source-language-code` / `--target-language-code` — the documented codes may use slightly different casing or hyphenation than what the server returns.

## Step 4 — Run Translation

### Quick path — inline (no separate scripts, no upstream coupling)

This recipe uses only the `nvidia-riva-client` pip package — no `python-clients` clone, no `docker exec`, no vendored scripts. It travels with this SKILL.md, so any update to the skill includes the latest recipe.

**Cloud — discover function-id, then translate:**

First, discover the function-id. Pick a **specific** model rather than relying on a broad regex — multiple NMT functions are typically active and some may be paused or returning 502 at any given time. To list everything currently active:

```bash
curl -fsS -H "Authorization: Bearer $NVIDIA_API_KEY" \
  "https://api.nvcf.nvidia.com/v2/nvcf/functions?visibility=public,authorized" \
  | python3 -c "
import sys, json, re
pat = re.compile(r'nmt|translate|megatron-nmt|seamless', re.I)
for f in json.load(sys.stdin).get('functions', []):
    if f.get('status') == 'ACTIVE' and pat.search(f.get('name','')):
        print(f['id'], f['name'])
"
```

Pick the `id` of the function whose `name` matches your model. Function IDs rotate per release — never hardcode them; always resolve fresh via this API.

For interactive browsing only: `https://build.nvidia.com/<org>/<model>/api`. That page is JS-rendered and not suitable for non-browser fetch tools.

Then anchor on a specific name (replace `riva-translate-1_6b` with whichever you picked):

```bash
FID=$(curl -fsS -H "Authorization: Bearer $NVIDIA_API_KEY" \
  "https://api.nvcf.nvidia.com/v2/nvcf/functions?visibility=public,authorized" \
  | python3 -c "
import sys, json
for f in json.load(sys.stdin).get('functions', []):
    if f.get('status') == 'ACTIVE' and f.get('name','').removeprefix('ai-') == 'riva-translate-1_6b':
        print(f['id']); break
")

TEXT="Hello, how are you today?" SRC=en TGT=de SERVER=grpc.nvcf.nvidia.com:443 FID=$FID python3 - <<'PY'
import os, riva.client
server = os.environ["SERVER"]
is_cloud = "nvcf" in server
md = None
if is_cloud:
    md = [["function-id", os.environ["FID"]],
          ["authorization", f"Bearer {os.environ['NVIDIA_API_KEY']}"]]
auth = riva.client.Auth(uri=server, use_ssl=is_cloud, metadata_args=md)
nmt = riva.client.NeuralMachineTranslationClient(auth)
resp = nmt.translate(
    texts=[os.environ["TEXT"]],
    model="",
    source_language=os.environ["SRC"],
    target_language=os.environ["TGT"],
)
for t in resp.translations:
    print(t.text)
PY
```

**Self-hosted:** drop `FID=...` and set `SERVER=0.0.0.0:50051` — the heredoc auto-skips the cloud metadata. Pass `model="<model-name-from-probe>"` if the running NIM serves more than one NMT model.

For language codes accepted by a specific server, use the inline probe from Step 2 — codes are server-defined and may differ from documented values.

### Alternative — upstream `python-clients` CLI

`https://github.com/nvidia-riva/python-clients` ships a canonical `nmt.py` with richer CLI flags (batch translation from file, `--dnt-phrases-file`, `--max-len-variation`, `--list-models`). Useful for one-off interactive exploration:

```bash
PY_CLIENTS=~/.cache/riva-skills/python-clients
[ -d "$PY_CLIENTS" ] || git clone --depth 1 https://github.com/nvidia-riva/python-clients "$PY_CLIENTS"

python3 "$PY_CLIENTS/scripts/nmt/nmt.py" \
  --server 0.0.0.0:50051 \
  --text "This will become German words." \
  --source-language-code en-US \
  --target-language-code de-DE
```

Output has a `##` prefix added by the client script (not the model).

> **Note.** `python-clients` tags are stale (last tag is `r2.19.0` while pip ships much newer) — always use `main`, which `git clone --depth 1` pulls by default. If `main` briefly outpaces your installed `nvidia-riva-client` and a script fails with `ImportError`, fall back to the inline Quick path above (it depends only on the pip package).

### Protect Terms from Translation (`<dnt>` tags)

Wrap terms in `<dnt>...</dnt>` to prevent them from being translated. **`<dnt>` tag support is per-model** — verify on the customization page before relying on it.

```bash
python3 "$PY_CLIENTS/scripts/nmt/nmt.py" \
  --server 0.0.0.0:50051 \
  --text "<dnt>NVIDIA NIM</dnt> provides optimized inference." \
  --source-language-code en-US \
  --target-language-code fr-FR
```

For a list of phrases to protect, use a custom dictionary file with `--dnt-phrases-file`.

### Batch Translation from File

Translate multiple lines (one input per line in the file):

```bash
python3 "$PY_CLIENTS/scripts/nmt/nmt.py" \
  --server 0.0.0.0:50051 \
  --text-file input_text.txt \
  --source-language-code en \
  --target-language-code de \
  --batch-size 8
```

### Morphologically Complex Languages

For target languages that produce longer output than the source (Arabic, Turkish, Finnish, Hungarian, etc.), increase `--max-len-variation` to prevent truncation. The exact recommended values per language live on the customization page; tune empirically:

```bash
python3 "$PY_CLIENTS/scripts/nmt/nmt.py" \
  --server 0.0.0.0:50051 \
  --text "Despite numerous challenges, several countries committed to net-zero by 2050." \
  --source-language-code en-US \
  --target-language-code ar-AR \
  --max-len-variation 150
```

Default is 20; range is 0–256. Higher values allow longer output but can increase latency.

## Key Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `--server` | gRPC endpoint | `0.0.0.0:50051` |
| `--text` | Text to translate | — |
| `--text-file` | File with one input per line | — |
| `--source-language-code` | Source language (use codes from `--list-models`) | `en-US` |
| `--target-language-code` | Target language (use codes from `--list-models`) | `en-US` |
| `--batch-size` | Parallel inputs (with `--text-file`) | `8` |
| `--max-len-variation` | Max output/input token ratio (0–256) | `20` |
| `--dnt-phrases-file` | File of terms to protect from translation | — |
| `--model-name` | Specific model name | `""` (default) |
| `--list-models` | List models + language pairs, then exit | — |

For the full flag list, run `nmt.py --help`.

## Helm Deployment (Kubernetes)

```yaml
# custom-values.yaml
image:
  repository: nvcr.io/nim/nvidia/<container-id-from-support-matrix>
  pullPolicy: IfNotPresent
  tag: latest
nim:
  ngcAPISecret: ngc-api
imagePullSecrets:
  - name: ngc-secret
envVars:
  NIM_TAGS_SELECTOR: "name=<container-id-from-support-matrix>"
```

```bash
helm install riva-nmt <chart> -f custom-values.yaml
```

## Examples

**Translate English to German:**

```bash
python3 "$PY_CLIENTS/scripts/nmt/nmt.py" \
  --server 0.0.0.0:50051 \
  --text "Hello, world." \
  --source-language-code en-US \
  --target-language-code de-DE
```

**Protect a brand name from translation:**

```bash
python3 "$PY_CLIENTS/scripts/nmt/nmt.py" \
  --server 0.0.0.0:50051 \
  --text "<dnt>NVIDIA NIM</dnt> provides optimized inference." \
  --source-language-code en-US \
  --target-language-code fr-FR
```

**Runtime feature lookup — agent flow:** When a user asks "does Riva NMT support Hindi?" or "can I use a DNT dictionary?", the agent should:
1. Fetch or open the support matrix (for language pairs) or the customization page (for feature behavior)
2. Answer based on the fetched content

Do not answer language-pair or feature questions from this skill's text alone.

## Troubleshooting

- **`--text` and `--text-file` are mutually exclusive** — use one or the other; they cannot be combined.
- **`##` prefix in output** — added by the client script, not the model; strip programmatically if needed.
- **Truncation on long output** — increase `--max-len-variation` (try 100–200 for Arabic, Turkish, Finnish).
- **Language code rejected** — codes are server-defined; run `--list-models` and use the values it returns verbatim. Documented codes may differ from server-accepted codes between releases.
- **Container ID not recognized** — fetch the current value from the support matrix. Names rotate between releases.

## Limitations

- x86_64 architecture only; NVIDIA AI Enterprise license required for self-hosting
- Morphologically complex languages may require a higher `--max-len-variation` value (see Troubleshooting)
- Language pair availability and DNT support are per-model — verify on the support matrix and customization page before assuming a pair / feature is available
