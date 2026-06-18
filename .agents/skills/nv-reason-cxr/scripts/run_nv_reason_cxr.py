#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Run NV-Reason-CXR-3B inference on a PNG/JPEG chest X-ray image.

The live path follows the upstream Hugging Face Transformers example.
The mock path exists for CI and evidence-pack wiring checks; it never calls
the model and should not be treated as clinical or model output.
"""

from __future__ import annotations

import argparse
import binascii
import hashlib
import importlib.metadata
import json
import math
import mimetypes
import os
import struct
import sys
import time
import uuid
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEFAULT_MODEL = "nvidia/NV-Reason-CXR-3B"
HF_SPACE_URL = "https://nvidia-nv-reason-cxr.hf.space"
HF_SPACE_API_TIMEOUT_SECONDS = 300
DEFAULT_PROMPT = "Find abnormalities and support devices."
PROMPT_PRESETS = {
    "findings": "Find abnormalities and support devices.",
    "comprehensive": "Provide a comprehensive image analysis, and list all abnormalities.",
    "educational": (
        "Examine the chest X-ray and explain the reasoning for each visible "
        "finding. State uncertainty explicitly."
    ),
    "structured": (
        "Write a concise structured response with sections: image quality, "
        "support devices, findings, impression, and uncertainties."
    ),
}
GENERATED_IMAGE_SENTINELS = {
    "generated://synthetic_chest_xray",
    "generated://synthetic_cxr",
}
TRUTHY = {"1", "true", "yes", "on"}
LIMITATIONS = [
    "Output is engineering evidence only; it is not a diagnosis or treatment recommendation.",
    "NV-Reason-CXR-3B can hallucinate, miss findings, or produce overconfident prose.",
    "A qualified professional must review any medical workflow use.",
]


class SkillError(Exception):
    """Input, dependency, or runtime error that should be shown cleanly."""


@dataclass(frozen=True)
class ImageInfo:
    format: str
    width: int
    height: int
    sha256: str


@dataclass(frozen=True)
class InputSpec:
    image_path: Path
    source: str
    prompt: str
    case_id: str
    fixture_mock: bool
    fixture_mock_response: str | None


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in TRUTHY


def _package_status(import_name: str, dist_name: str | None = None) -> dict:
    dist_name = dist_name or import_name
    try:
        version = importlib.metadata.version(dist_name)
    except importlib.metadata.PackageNotFoundError:
        return {"installed": False, "version": None}
    try:
        __import__(import_name)
        importable = True
    except Exception:
        importable = False
    return {"installed": True, "importable": importable, "version": version}


def _cuda_report() -> dict:
    try:
        import torch
    except Exception as e:
        return {"available": False, "error": f"torch import failed: {e}", "devices": []}
    available = bool(torch.cuda.is_available())
    devices = []
    if available:
        for idx in range(torch.cuda.device_count()):
            props = torch.cuda.get_device_properties(idx)
            devices.append(
                {
                    "index": idx,
                    "name": props.name,
                    "memory_total_mb": round(props.total_memory / int("1024") / int("1024")),
                }
            )
    return {
        "available": available,
        "device_count": len(devices),
        "devices": devices,
        "torch_cuda_version": getattr(torch.version, "cuda", None),
    }


def _model_cache_report(model_id: str) -> dict:
    try:
        from huggingface_hub import scan_cache_dir
    except Exception as e:
        return {"inspectable": False, "cached": False, "error": str(e)}
    try:
        cache = scan_cache_dir()
    except Exception as e:
        return {"inspectable": False, "cached": False, "error": str(e)}

    for repo in cache.repos:
        if repo.repo_id != model_id or repo.repo_type != "model":
            continue
        files = []
        for revision in repo.revisions:
            files.extend(f.file_name for f in revision.files)
        return {
            "inspectable": True,
            "cached": True,
            "repo_id": repo.repo_id,
            "revisions": len(repo.revisions),
            "size_on_disk_mb": round(repo.size_on_disk / int("1024") / int("1024")),
            "has_config": "config.json" in files,
            "has_preprocessor_config": "preprocessor_config.json" in files,
            "has_generation_config": "generation_config.json" in files,
            "has_safetensors": any(name.endswith(".safetensors") for name in files),
        }
    return {
        "inspectable": True,
        "cached": False,
        "repo_id": model_id,
        "revisions": 0,
        "size_on_disk_mb": 0,
        "has_config": False,
        "has_preprocessor_config": False,
        "has_generation_config": False,
        "has_safetensors": False,
    }


def _setup_report(model_id: str) -> dict:
    dependencies = {
        "torch": _package_status("torch"),
        "torchvision": _package_status("torchvision"),
        "transformers": _package_status("transformers"),
        "Pillow": _package_status("PIL", "Pillow"),
        "huggingface_hub": _package_status("huggingface_hub"),
    }
    optional_dependencies = {
        "accelerate": _package_status("accelerate"),
    }
    cuda = _cuda_report()
    cache = _model_cache_report(model_id)
    missing_required = [
        name
        for name in ("torch", "transformers", "Pillow")
        if not dependencies[name].get("installed") or not dependencies[name].get("importable", True)
    ]
    if missing_required:
        recommendation = "install_required_dependencies"
    elif not cuda.get("available"):
        recommendation = "use_cuda_or_pass_explicit_cpu_flags_for_slow_testing"
    elif not cache.get("has_safetensors"):
        recommendation = "download_model_weights_or_run_without_local_files_only"
    else:
        recommendation = "ready_for_live_cuda_inference"
    return {
        "skill": "nv_reason_cxr",
        "setup": {
            "python": sys.executable,
            "model": model_id,
            "recommended_torch_dtype": "bfloat16_on_cuda_float32_on_cpu",
            "dependencies": dependencies,
            "optional_dependencies": optional_dependencies,
            "cuda": cuda,
            "model_cache": cache,
            "recommendation": recommendation,
        },
    }


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(int("1024") * int("1024")), b""):
            h.update(block)
    return h.hexdigest()


def _png_info(path: Path) -> tuple[int, int]:
    with path.open("rb") as f:
        header = f.read(int("24"))
    if len(header) < int("24") or not header.startswith(b"\x89PNG\r\n\x1a\n"):
        raise SkillError(f"unsupported image format for {path}: expected PNG or JPEG")
    width, height = struct.unpack(">II", header[int("16") : int("24")])
    if width <= 0 or height <= 0:
        raise SkillError(f"invalid PNG dimensions for {path}: {width}x{height}")
    return width, height


def _jpeg_info(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if not data.startswith(b"\xff\xd8"):
        raise SkillError(f"unsupported image format for {path}: expected PNG or JPEG")

    i = 2
    sof_markers = {
        int("0xC0", 0),
        int("0xC1", 0),
        int("0xC2", 0),
        int("0xC3", 0),
        int("0xC5", 0),
        int("0xC6", 0),
        int("0xC7", 0),
        int("0xC9", 0),
        int("0xCA", 0),
        int("0xCB", 0),
        int("0xCD", 0),
        int("0xCE", 0),
        int("0xCF", 0),
    }
    while i < len(data):
        while i < len(data) and data[i] == int("0xFF", 0):
            i += 1
        if i >= len(data):
            break
        marker = data[i]
        i += 1
        if marker in (int("0xD8", 0), int("0xD9", 0)):
            continue
        if i + 2 > len(data):
            break
        segment_len = int.from_bytes(data[i : i + 2], "big")
        if segment_len < 2 or i + segment_len > len(data):
            break
        if marker in sof_markers:
            if segment_len < int("7"):
                break
            height = int.from_bytes(data[i + int("3") : i + int("5")], "big")
            width = int.from_bytes(data[i + int("5") : i + int("7")], "big")
            if width <= 0 or height <= 0:
                break
            return width, height
        i += segment_len
    raise SkillError(f"could not read JPEG dimensions for {path}")


def _image_info(path: Path) -> ImageInfo:
    if not path.exists():
        raise SkillError(f"image not found: {path}")
    if not path.is_file():
        raise SkillError(f"image path is not a file: {path}")

    with path.open("rb") as f:
        magic = f.read(int("12"))
    suffix = path.suffix.lower()
    if magic.startswith(b"\x89PNG\r\n\x1a\n"):
        width, height = _png_info(path)
        fmt = "png"
    elif magic.startswith(b"\xff\xd8"):
        width, height = _jpeg_info(path)
        fmt = "jpeg"
    else:
        raise SkillError(
            f"unsupported image format for {path}: expected PNG or JPEG, got suffix {suffix!r}"
        )
    return ImageInfo(format=fmt, width=width, height=height, sha256=_sha256(path))


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", binascii.crc32(tag + data) & int("0xFFFFFFFF", 0))
    )


def _write_synthetic_png(path: Path, *, width: int = int("96"), height: int = int("96")) -> None:
    """Write a tiny generated x-ray-like PNG without storing medical data."""
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # filter byte
        yn = (y - height * float("0.53")) / (height * float("0.36"))
        for x in range(width):
            xn = (x - width * float("0.5")) / (width * float("0.5"))
            value = int("24")
            left_lung = ((x - width * float("0.36")) / (width * float("0.18"))) ** 2 + yn**2 < 1.0
            right_lung = ((x - width * float("0.64")) / (width * float("0.18"))) ** 2 + yn**2 < 1.0
            if left_lung or right_lung:
                value = int("62")
            if abs(x - width * float("0.5")) < int("3"):
                value = max(value, int("98"))
            for rib in range(int("7")):
                curve_y = height * float("0.22") + rib * float("7.0") + float("9.0") * (xn**2)
                if abs(y - curve_y) < float("0.75") and float("0.12") < abs(xn) < float("0.9"):
                    value = max(value, int("132"))
            if (x - width * float("0.5")) ** 2 + (y - height * float("0.88")) ** 2 < (
                width * float("0.1")
            ) ** 2:
                value = max(value, int("112"))
            vignette = int(
                int("22") * math.sqrt(xn**2 + ((y - height * float("0.5")) / height) ** 2)
            )
            value = max(0, min(int("255"), value - vignette))
            rows.extend([value, value, value])

    ihdr = struct.pack(">IIBBBBB", width, height, int("8"), 2, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(bytes(rows), level=int("9")))
        + _png_chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def _load_json_fixture(path: Path, out_dir: Path | None, cli_prompt: str | None) -> InputSpec:
    try:
        fixture = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        raise SkillError(f"fixture is not valid JSON: {path}: {e}") from e
    if not isinstance(fixture, dict):
        raise SkillError(f"fixture must be a JSON object: {path}")

    image_value = str(fixture.get("image_path") or fixture.get("image") or "").strip()
    prompt = cli_prompt or str(fixture.get("prompt") or DEFAULT_PROMPT)
    case_id = str(fixture.get("case_id") or path.stem)
    fixture_mock = bool(fixture.get("mock", False))
    fixture_mock_response = fixture.get("mock_response")
    if fixture_mock_response is not None and not isinstance(fixture_mock_response, str):
        raise SkillError("fixture field mock_response must be a string when present")

    if image_value in GENERATED_IMAGE_SENTINELS:
        if out_dir is None:
            raise SkillError(
                "--out-dir is required when a JSON fixture requests "
                "generated://synthetic_chest_xray"
            )
        image_path = out_dir / "input_synthetic_chest_xray.png"
        _write_synthetic_png(image_path)
        return InputSpec(
            image_path=image_path,
            source="generated_fixture",
            prompt=prompt,
            case_id=case_id,
            fixture_mock=fixture_mock,
            fixture_mock_response=fixture_mock_response,
        )
    if not image_value:
        raise SkillError("fixture must include image_path or use generated://synthetic_chest_xray")

    image_path = Path(image_value)
    if not image_path.is_absolute():
        image_path = (path.parent / image_path).resolve()
    return InputSpec(
        image_path=image_path,
        source="fixture_file",
        prompt=prompt,
        case_id=case_id,
        fixture_mock=fixture_mock,
        fixture_mock_response=fixture_mock_response,
    )


def _load_input(path: Path, out_dir: Path | None, cli_prompt: str | None) -> InputSpec:
    if not path.exists():
        raise SkillError(f"input not found: {path}")
    if path.suffix.lower() == ".json":
        return _load_json_fixture(path, out_dir, cli_prompt)
    return InputSpec(
        image_path=path.resolve(),
        source="file",
        prompt=cli_prompt or DEFAULT_PROMPT,
        case_id=path.stem,
        fixture_mock=False,
        fixture_mock_response=None,
    )


def _mock_response(spec: InputSpec, info: ImageInfo) -> str:
    if spec.fixture_mock_response:
        return spec.fixture_mock_response
    return (
        "Mock NV-Reason-CXR response for image "
        f"{spec.case_id!r} ({info.format}, {info.width}x{info.height}). "
        "This deterministic response verifies input loading, prompt wiring, "
        "and JSON output only; it does not assert clinical findings."
    )


def _select_device(requested: str, *, allow_cpu: bool) -> str:
    if requested == "cpu":
        if not allow_cpu:
            raise SkillError(
                "CPU live inference is very slow. Pass --allow-cpu to confirm "
                "that you intentionally want CPU inference, or use --mock for "
                "a wiring check."
            )
        return "cpu"
    if requested == "cuda":
        try:
            import torch

            if not torch.cuda.is_available():
                raise SkillError("requested --device cuda but torch.cuda.is_available() is false")
        except SkillError:
            raise
        except Exception as e:
            raise SkillError(f"requested --device cuda but torch import/probe failed: {e}") from e
        return "cuda"
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    if allow_cpu:
        return "cpu"
    raise SkillError(
        "CUDA is not available for live inference. Use a CUDA host, pass "
        "--allow-cpu for a slow explicit CPU run, or use --mock for setup checks."
    )


def _select_torch_dtype(torch_module: Any, dtype_name: str, device: str) -> Any:
    if dtype_name == "auto":
        return torch_module.bfloat16 if device == "cuda" else torch_module.float32
    return {
        "float16": torch_module.float16,
        "bfloat16": torch_module.bfloat16,
        "float32": torch_module.float32,
    }[dtype_name]


def _run_transformers_inference(
    *,
    image_path: Path,
    prompt: str,
    model_id: str,
    device_request: str,
    allow_cpu: bool,
    torch_dtype_name: str,
    max_new_tokens: int,
    local_files_only: bool,
) -> tuple[str, dict[str, str | int | bool | None]]:
    try:
        import torch
        import transformers
        from PIL import Image
        from transformers import AutoModelForImageTextToText, AutoProcessor
    except Exception as e:
        raise SkillError(
            "live inference requires torch, transformers, and Pillow. "
            "Install the SKILL.md prerequisites or use --mock for a wiring check. "
            f"Import error: {e}"
        ) from e

    device = _select_device(device_request, allow_cpu=allow_cpu)
    dtype = _select_torch_dtype(torch, torch_dtype_name, device)
    token = os.environ.get("HF_TOKEN") or None

    try:
        image = Image.open(image_path).convert("RGB")
    except Exception as e:
        raise SkillError(f"Pillow could not open image {image_path}: {e}") from e

    try:
        try:
            model = AutoModelForImageTextToText.from_pretrained(
                model_id,
                dtype=dtype,
                local_files_only=local_files_only,
                token=token,
            ).eval()
        except TypeError as e:
            if "dtype" not in str(e):
                raise
            model = AutoModelForImageTextToText.from_pretrained(
                model_id,
                torch_dtype=dtype,
                local_files_only=local_files_only,
                token=token,
            ).eval()
        model = model.to(device)
        processor = AutoProcessor.from_pretrained(
            model_id,
            use_fast=True,
            local_files_only=local_files_only,
            token=token,
        )
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": prompt},
                ],
            }
        ]
        text = processor.apply_chat_template(messages, add_generation_prompt=True)
        inputs = processor(text=text, images=[image], return_tensors="pt")
        inputs = inputs.to(model.device)
        with torch.inference_mode():
            generated_ids = model.generate(**inputs, max_new_tokens=max_new_tokens)
        trimmed_ids = [
            out_ids[len(in_ids) :] for in_ids, out_ids in zip(inputs.input_ids, generated_ids)
        ]
        generated_tokens = int(trimmed_ids[0].shape[-1]) if trimmed_ids else 0
        generated_text = processor.batch_decode(
            trimmed_ids,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False,
        )[0]
    except Exception as e:
        raise SkillError(f"NV-Reason-CXR inference failed: {e}") from e

    runtime = {
        "device": str(getattr(model, "device", device)),
        "torch_dtype": str(dtype).replace("torch.", ""),
        "transformers_version": getattr(transformers, "__version__", None),
        "torch_version": getattr(torch, "__version__", None),
        "generated_tokens": generated_tokens,
        "truncated_by_max_new_tokens": generated_tokens >= max_new_tokens,
    }
    return generated_text, runtime


# Normalize HTTP and network errors from Gradio API calls.
def _http_fetch(
    url: str,
    *,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int,
) -> bytes:
    try:
        with urlopen(Request(url, data=data, headers=headers or {}), timeout=timeout) as response:
            return response.read()
    except HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise SkillError(f"HTTP {e.code}: {detail}") from e
    except URLError as e:
        raise SkillError(f"network error: {e.reason}") from e


# Upload the local image and shape the response as Gradio FileData.
def _hf_space_image_payload(base_url: str, image_path: Path, *, timeout: int) -> dict[str, Any]:
    boundary = f"----gradio-upload-{uuid.uuid4().hex}"
    mime = mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
    filename = image_path.name.replace('"', "%22")
    body = (
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="files"; filename="{filename}"\r\n'
            f"Content-Type: {mime}\r\n\r\n"
        ).encode()
        + image_path.read_bytes()
        + f"\r\n--{boundary}--\r\n".encode()
    )
    headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    uploaded = json.loads(
        _http_fetch(
            f"{base_url}/gradio_api/upload", data=body, headers=headers, timeout=timeout
        ).decode("utf-8", "replace")
    )

    item = uploaded[0] if isinstance(uploaded, list) and uploaded else uploaded
    payload = dict(item) if isinstance(item, dict) else {"path": item}
    payload.setdefault("orig_name", image_path.name)
    payload.setdefault("size", image_path.stat().st_size)
    payload.setdefault("mime_type", mime)
    payload.setdefault("is_stream", False)
    payload.setdefault("meta", {"_type": "gradio.FileData"})
    return payload


# Resolve the current Gradio function id for the fixed chat endpoint.
def _hf_space_chat_fn_index(base_url: str, *, timeout: int) -> int:
    config = json.loads(
        _http_fetch(f"{base_url}/config", timeout=timeout).decode("utf-8", "replace")
    )
    target = "chat"
    for index, dependency in enumerate(config.get("dependencies", [])):
        if str(dependency.get("api_name", "")).lstrip("/") == target:
            return int(dependency.get("id", index))
    raise SkillError(f"could not find /{target} in Gradio config")


# Reassemble server-sent Gradio chunks into the full model response text.
def _stream_hf_space_response(response: Any) -> str:
    event_lines: list[str] = []
    chunks: list[str] = []

    for raw in response:
        line = raw.decode("utf-8", "replace").rstrip("\r\n")
        if line:
            event_lines.append(line)
            continue
        if not event_lines:
            continue

        data = "\n".join(
            line.split(":", 1)[1].lstrip() for line in event_lines if line.startswith("data:")
        )
        event_lines = []
        if not data:
            continue

        message = json.loads(data)
        msg = message.get("msg")
        if msg == "process_generating":
            output = message.get("output", {}).get("data", [])
            patches = output[0] if isinstance(output, list) and output else []
            if not isinstance(patches, list):
                continue
            for patch in patches:
                if isinstance(patch, list) and len(patch) >= 3 and patch[0] == "append":
                    chunk = patch[2]
                    if isinstance(chunk, str):
                        chunks.append(chunk)
        elif msg == "process_completed":
            if not message.get("success", False):
                raise SkillError(json.dumps(message, ensure_ascii=False))
            if chunks:
                return "".join(chunks)
            output = message.get("output", {})
            result = output.get("data") if isinstance(output, dict) else output
            if isinstance(result, list) and result:
                result = result[0]
            if isinstance(result, str):
                return result
            if result is not None:
                return json.dumps(result, ensure_ascii=False, indent=2)
            return ""
        elif msg == "close_stream":
            break

    if chunks:
        return "".join(chunks)
    raise SkillError("Gradio stream closed before completion")


# Submit the uploaded image and prompt to the Space queue and stream the result.
def _call_hf_space_endpoint(
    *,
    base_url: str,
    prompt: str,
    image_payload: dict[str, Any],
    timeout: int,
) -> str:
    session_hash = uuid.uuid4().hex
    payload = {
        "data": [prompt, [], image_payload],
        "fn_index": _hf_space_chat_fn_index(base_url, timeout=timeout),
        "session_hash": session_hash,
    }
    body = json.dumps(payload, ensure_ascii=False).encode()
    headers = {"Content-Type": "application/json"}
    joined = json.loads(
        _http_fetch(
            f"{base_url}/gradio_api/queue/join",
            data=body,
            headers=headers,
            timeout=timeout,
        ).decode("utf-8", "replace")
    )
    if not joined.get("event_id"):
        raise SkillError(f"missing Gradio event_id: {joined!r}")

    stream_url = f"{base_url}/gradio_api/queue/data?{urlencode({'session_hash': session_hash})}"
    try:
        with urlopen(Request(stream_url), timeout=timeout) as response:
            return _stream_hf_space_response(response)
    except HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise SkillError(f"HTTP {e.code}: {detail}") from e
    except URLError as e:
        raise SkillError(f"network error: {e.reason}") from e


# Run the fixed public Space backend and return text plus remote runtime metadata.
def _run_hf_space_api_inference(
    *,
    image_path: Path,
    prompt: str,
) -> tuple[str, dict[str, str | int | bool | None]]:
    try:
        timeout = HF_SPACE_API_TIMEOUT_SECONDS
        base_url = HF_SPACE_URL
        image_payload = _hf_space_image_payload(base_url, image_path, timeout=timeout)
        response_text = _call_hf_space_endpoint(
            base_url=base_url,
            prompt=prompt,
            image_payload=image_payload,
            timeout=timeout,
        )
    except SkillError:
        raise
    except Exception as e:
        raise SkillError(f"HF Space API inference failed: {e}") from e
    if not response_text:
        raise SkillError("HF Space API returned empty response")

    runtime = {
        "device": "remote",
        "torch_dtype": "remote",
        "transformers_version": None,
        "torch_version": None,
        "generated_tokens": None,
        "truncated_by_max_new_tokens": None,
    }
    return response_text, runtime


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run NV-Reason-CXR-3B inference on a PNG/JPEG chest X-ray image."
    )
    parser.add_argument(
        "image_or_fixture",
        nargs="?",
        type=Path,
        help="PNG/JPEG image path, or JSON fixture for eval harness smoke tests.",
    )
    parser.add_argument("--prompt", default=None, help="Text prompt for the model.")
    parser.add_argument(
        "--prompt-preset",
        choices=sorted(PROMPT_PRESETS),
        default=None,
        help="Optional prompt preset used when --prompt is not supplied.",
    )
    parser.add_argument(
        "--backend",
        choices=["local", "hf-space-api"],
        default="local",
        help="Inference backend. Defaults to local Hugging Face Transformers.",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help=(
            "Optional artifact directory. Required for generated JSON fixtures; "
            "the eval harness passes this explicitly."
        ),
    )
    parser.add_argument(
        "--model-id",
        default=os.environ.get("NV_REASON_CXR_MODEL", DEFAULT_MODEL),
        help=f"Hugging Face model id (default: {DEFAULT_MODEL}).",
    )
    parser.add_argument("--device", choices=["auto", "cuda", "cpu"], default="auto")
    parser.add_argument(
        "--allow-cpu",
        action="store_true",
        help="Permit intentionally slow live CPU inference.",
    )
    parser.add_argument(
        "--torch-dtype",
        choices=["auto", "float16", "bfloat16", "float32"],
        default="auto",
    )
    parser.add_argument("--max-new-tokens", type=int, default=int("2048"))
    parser.add_argument("--local-files-only", action="store_true")
    parser.add_argument("--mock", action="store_true", help="Skip model call.")
    parser.add_argument(
        "--check-setup",
        action="store_true",
        help="Print dependency/GPU/cache readiness JSON and exit.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.max_new_tokens < 1:
        print("error: --max-new-tokens must be >= 1", file=sys.stderr)
        return 2
    if args.backend == "hf-space-api" and args.local_files_only:
        print(
            "error: --local-files-only is only valid with --backend local",
            file=sys.stderr,
        )
        return 2

    try:
        if args.check_setup:
            print(json.dumps(_setup_report(args.model_id), indent=2, sort_keys=True))
            return 0
        if args.image_or_fixture is None:
            print(
                "error: image_or_fixture is required unless --check-setup is used", file=sys.stderr
            )
            return 2

        out_dir = args.out_dir.resolve() if args.out_dir is not None else None
        if out_dir is not None:
            out_dir.mkdir(parents=True, exist_ok=True)
        prompt = args.prompt
        if prompt is None and args.prompt_preset:
            prompt = PROMPT_PRESETS[args.prompt_preset]
        spec = _load_input(args.image_or_fixture.resolve(), out_dir, prompt)
        info = _image_info(spec.image_path)
        local_files_only = bool(
            args.backend == "local"
            and (
                args.local_files_only
                or _truthy(os.environ.get("TRANSFORMERS_OFFLINE"))
                or _truthy(os.environ.get("HF_HUB_OFFLINE"))
            )
        )
        mock = bool(args.mock or spec.fixture_mock or _truthy(os.environ.get("MOCK_NV_REASON_CXR")))

        t0 = time.perf_counter()
        if mock:
            response_text = _mock_response(spec, info)
            runtime_extra = {
                "device": "none",
                "torch_dtype": "none",
                "transformers_version": None,
                "torch_version": None,
                "generated_tokens": 0,
                "truncated_by_max_new_tokens": False,
            }
            mode = "mock"
        elif args.backend == "local":
            response_text, runtime_extra = _run_transformers_inference(
                image_path=spec.image_path,
                prompt=spec.prompt,
                model_id=args.model_id,
                device_request=args.device,
                allow_cpu=args.allow_cpu,
                torch_dtype_name=args.torch_dtype,
                max_new_tokens=args.max_new_tokens,
                local_files_only=local_files_only,
            )
            mode = "hf_transformers"
        else:
            response_text, runtime_extra = _run_hf_space_api_inference(
                image_path=spec.image_path,
                prompt=spec.prompt,
            )
            mode = "hf_space_api"
        elapsed = time.perf_counter() - t0

        payload = {
            "skill": "nv_reason_cxr",
            "input": {
                "case_id": spec.case_id,
                "prompt": spec.prompt,
                "image": {
                    "path": str(spec.image_path),
                    "source": spec.source,
                    "format": info.format,
                    "width": info.width,
                    "height": info.height,
                    "sha256": info.sha256,
                },
            },
            "output": {
                "response_text": response_text,
                "text_chars": len(response_text),
            },
            "runtime": {
                "model": args.model_id if args.backend == "local" else DEFAULT_MODEL,
                "mode": mode,
                "mock": mock,
                "device": str(runtime_extra["device"]),
                "torch_dtype": str(runtime_extra["torch_dtype"]),
                "max_new_tokens": args.max_new_tokens if args.backend == "local" else None,
                "inference_seconds": round(elapsed, int("6")),
                "local_files_only": local_files_only,
                "transformers_version": runtime_extra["transformers_version"],
                "torch_version": runtime_extra["torch_version"],
                "generated_tokens": runtime_extra["generated_tokens"],
                "truncated_by_max_new_tokens": runtime_extra["truncated_by_max_new_tokens"],
            },
            "limitations": LIMITATIONS,
        }
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0
    except SkillError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
