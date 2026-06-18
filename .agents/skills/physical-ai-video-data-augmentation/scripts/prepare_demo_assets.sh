#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

DEMO_DIR="${1:-/srv/sdg/data/vda_inputs}"
RAW_DIR="${DEMO_DIR%/}_raw"
HF_DEMO_DATASET_REPO="${HF_DEMO_DATASET_REPO:-nvidia/video-data-augmentation-demo}"
HF_DEMO_DATASET_REVISION="${HF_DEMO_DATASET_REVISION:-main}"
HF_DEMO_DATASET_SUBDIR="${HF_DEMO_DATASET_SUBDIR:-}"
DEFAULT_HF_DEMO_DATASET_REPO="nvidia/video-data-augmentation-demo"
ALLOW_NON_VDA_DEMO_DATASET="${ALLOW_NON_VDA_DEMO_DATASET:-0}"

if [[ "${HF_DEMO_DATASET_REPO}" != "${DEFAULT_HF_DEMO_DATASET_REPO}" && "${ALLOW_NON_VDA_DEMO_DATASET}" != "1" ]]; then
  echo "ERROR: Refusing non-VDA demo dataset '${HF_DEMO_DATASET_REPO}'." >&2
  echo "Use '${DEFAULT_HF_DEMO_DATASET_REPO}' or set ALLOW_NON_VDA_DEMO_DATASET=1 for an explicit override." >&2
  exit 1
fi

mkdir -p "${DEMO_DIR}" "${RAW_DIR}"

# Clean only previously flattened demo clips; keep other files intact.
rm -f "${DEMO_DIR}"/*.mp4

export DEMO_DIR RAW_DIR HF_DEMO_DATASET_REPO HF_DEMO_DATASET_REVISION HF_DEMO_DATASET_SUBDIR
tmp_clips_file="$(mktemp)"
if ! python3 - <<'PY' >"${tmp_clips_file}"
import json
import os
import urllib.parse
import urllib.request
from urllib.error import HTTPError, URLError

repo = os.environ["HF_DEMO_DATASET_REPO"]
revision = os.environ["HF_DEMO_DATASET_REVISION"]
subdir = os.environ.get("HF_DEMO_DATASET_SUBDIR", "").strip("/")
raw_dir = os.environ["RAW_DIR"]
demo_dir = os.environ["DEMO_DIR"]
token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or ""

headers = {}
if token:
    headers["Authorization"] = f"Bearer {token}"


def _request_json(url: str):
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code in (401, 403):
            raise SystemExit(
                "ERROR: Hugging Face denied demo dataset access. "
                f"Set HF_TOKEN with access to https://huggingface.co/datasets/{repo}"
            ) from exc
        body = exc.read().decode("utf-8", errors="ignore")
        raise SystemExit(
            f"ERROR: Hugging Face API request failed (HTTP {exc.code}) for {url}: {body[:200]}"
        ) from exc
    except URLError as exc:
        raise SystemExit(f"ERROR: Unable to reach Hugging Face ({url}): {exc}") from exc


def _list_files():
    queue = [subdir] if subdir else [""]
    seen = set()
    mp4_paths = []
    while queue:
        prefix = queue.pop(0)
        if prefix in seen:
            continue
        seen.add(prefix)
        api_url = f"https://huggingface.co/api/datasets/{repo}/tree/{revision}"
        if prefix:
            api_url = f"{api_url}/{urllib.parse.quote(prefix, safe='/')}"
        entries = _request_json(api_url)
        for entry in entries:
            entry_type = entry.get("type")
            path = entry.get("path")
            if not path:
                continue
            if entry_type == "directory":
                queue.append(path)
            elif entry_type == "file" and path.lower().endswith(".mp4"):
                mp4_paths.append(path)
    return sorted(set(mp4_paths))


files = _list_files()
if not files:
    raise SystemExit(
        f"ERROR: No .mp4 files found in dataset {repo}@{revision}"
        + (f" under {subdir}" if subdir else "")
    )

seen_basenames = {}
for rel_path in files:
    basename = os.path.basename(rel_path)
    previous = seen_basenames.get(basename)
    if previous and previous != rel_path:
        raise SystemExit(
            f"ERROR: Duplicate basename '{basename}' in demo dataset paths "
            f"'{previous}' and '{rel_path}'. Use HF_DEMO_DATASET_SUBDIR to scope the pull."
        )
    seen_basenames[basename] = rel_path

for path in sorted(files):
    print(path)
PY
then
  rm -f "${tmp_clips_file}"
  exit 1
fi

clips=()
while IFS= read -r clip; do
  clips+=("${clip}")
done < "${tmp_clips_file}"
rm -f "${tmp_clips_file}"

if [[ "${#clips[@]}" -eq 0 ]]; then
  echo "ERROR: No .mp4 files were prepared from Hugging Face dataset ${HF_DEMO_DATASET_REPO}@${HF_DEMO_DATASET_REVISION}" >&2
  exit 1
fi

hf_token="${HF_TOKEN:-${HUGGING_FACE_HUB_TOKEN:-}}"
curl_headers=()
if [[ -n "${hf_token}" ]]; then
  curl_headers+=(-H "Authorization: Bearer ${hf_token}")
fi

prepared=()
for rel_path in "${clips[@]}"; do
  encoded_path="$(python3 - <<'PY' "${rel_path}"
import sys
import urllib.parse
print(urllib.parse.quote(sys.argv[1], safe='/'))
PY
)"

  raw_target="${RAW_DIR}/${rel_path}"
  mkdir -p "$(dirname "${raw_target}")"
  download_url="https://huggingface.co/datasets/${HF_DEMO_DATASET_REPO}/resolve/${HF_DEMO_DATASET_REVISION}/${encoded_path}"

  # curl -L handles Hugging Face/LFS redirect chains more reliably than urllib here.
  if ! curl -fsSL --retry 3 --retry-delay 2 "${curl_headers[@]}" "${download_url}" -o "${raw_target}"; then
    echo "ERROR: Failed to download ${rel_path} from ${download_url}" >&2
    echo "Hint: verify HF_TOKEN access to https://huggingface.co/datasets/${HF_DEMO_DATASET_REPO}" >&2
    exit 1
  fi

  flat_target="${DEMO_DIR}/$(basename "${rel_path}")"
  cp -f "${raw_target}" "${flat_target}"
  prepared+=("${flat_target}")
done

echo "Prepared flat demo videos in ${DEMO_DIR} from ${HF_DEMO_DATASET_REPO}@${HF_DEMO_DATASET_REVISION}:"
printf '%s\n' "${prepared[@]}"

echo "Upload with file expansion to keep dataset root flat:"
echo "  osmo data upload <storage_url>/datasets/<name>/ \"${DEMO_DIR}\"/*.mp4"
