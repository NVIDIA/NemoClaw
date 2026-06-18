# Install NeMo Retriever Library

One-time bootstrap to make the `retriever` CLI available. Skip if
`command -v retriever` already prints a path.

The recipe below detects the host capabilities and picks the right install:

- **GPU present and CUDA 13.x** → installs the local-GPU torch wheels from
  the `cu130` index plus the `[local]` extra, so the bundled
  `nvidia/llama-nemotron-embed-1b-v2` embedder can run locally on GPU.
- **No GPU, or a non-CUDA-13 driver** → installs the package without
  `[local]`. Torch is pulled from PyPI defaults; the local-GPU embedder is
  unavailable. Provide a remote NIM endpoint at query/ingest time via
  `--embed-invoke-url` (or set `EMBED_INVOKE_URL`).

## When to use this

- You're in a fresh container or host and `command -v retriever` returns
  nothing.
- You need to bump to a newer commit and want to reinstall from a fresh
  source tree.

## Recipe

```bash
# Use the current checkout if cwd is already the NeMo-Retriever repo; else
# clone to a shared cache. Override the cache path with NRL_SRC=... if needed.
if [ -f "pyproject.toml" ] && grep -q '^name = "nemo-retriever"' pyproject.toml; then
  NRL_PKG="$PWD"                              # already in nemo_retriever/
elif [ -f "nemo_retriever/pyproject.toml" ] && grep -q '^name = "nemo-retriever"' nemo_retriever/pyproject.toml; then
  NRL_PKG="$PWD/nemo_retriever"               # at repo root
else
  NRL_SRC="${NRL_SRC:-$HOME/.cache/nemo-retriever/source}"
  if [ ! -d "$NRL_SRC/.git" ]; then
    mkdir -p "$(dirname "$NRL_SRC")"
    git clone https://github.com/NVIDIA/NeMo-Retriever.git "$NRL_SRC"
  fi
  NRL_PKG="$NRL_SRC/nemo_retriever"
fi

# Detect GPU + CUDA 13 to choose the install flavor.
USE_LOCAL=0
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  CUDA_MAJOR=$(nvidia-smi | sed -n 's/.*CUDA Version: \([0-9]\+\)\..*/\1/p' | head -1)
  [ "$CUDA_MAJOR" = "13" ] && USE_LOCAL=1
fi
echo "use_local=$USE_LOCAL (cuda_major=${CUDA_MAJOR:-none})"

uv python install 3.12
uv venv retriever --python 3.12
VENV=$PWD/retriever
(
  cd "$NRL_PKG"
  EPOCH=$(date +%s)
  if [ "$USE_LOCAL" = "1" ]; then
    env SOURCE_DATE_EPOCH=$EPOCH uv pip install -q --python "$VENV/bin/python" "torch~=2.11.0" "torchvision>=0.26.0,<0.27" -i https://download.pytorch.org/whl/cu130
    env SOURCE_DATE_EPOCH=$EPOCH uv pip install -q --python "$VENV/bin/python" ".[local]"
  else
    env SOURCE_DATE_EPOCH=$EPOCH uv pip install -q --python "$VENV/bin/python" "."
  fi
)
echo "RETRIEVER_VENV=$VENV"   # record this absolute path — substitute it for <RETRIEVER_VENV> in every later example
```

## Notes

- `SOURCE_DATE_EPOCH` is passed inline via `env` so uv forwards it to the
  PEP-517 build subprocess; a bare `export` was being dropped and the
  resulting dev-suffix mismatch between wheel filename and metadata broke
  the install.
- `-q` keeps `uv pip install` silent on the happy path; errors and a
  non-zero exit code still surface.
- The cache path defaults to `$HOME/.cache/nemo-retriever/source` so every
  cwd you launch from shares one copy. The block intentionally does *not*
  `git fetch` on reuse, so installs are reproducible — run
  `git -C ~/.cache/nemo-retriever/source pull` manually to bump.
- Only add further extras (`[nemotron-parse]`, `[multimedia]`, `[llm]`) when
  a later step actually demands one — append them inside the brackets,
  e.g. `".[local,multimedia]"`.

In the examples in `SKILL.md` and other reference docs, substitute
`<RETRIEVER_VENV>` with the absolute path printed by the final `echo`
(e.g. `/workspace/retriever`).

## Optional extras (install only when the user's input demands it)

| Input | Extra / dep | Install (run inside `$NRL_PKG`) |
|---|---|---|
| `.docx` `.pptx` | libreoffice (host pkg) | `sudo apt-get install -y libreoffice` |
| `.mp3` `.wav` `.m4a` / `.mp4` `.mov` `.mkv` | `[multimedia]` + ffmpeg (host pkg) | `sudo apt-get install -y ffmpeg && env SOURCE_DATE_EPOCH=$(date +%s) uv pip install -q --python "$VENV/bin/python" ".[multimedia]"` |

Stack extras with the base flavor, e.g. `".[local,multimedia]"`. Base install already covers PDF, image, HTML, TXT.
