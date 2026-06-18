#!/usr/bin/env python3

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
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

"""Route Nemotron Speech prompts to the right bundled reference file.

This helper is intentionally small and deterministic. It does not fetch current
model catalogs or product facts; the skill still requires the agent to consult
the canonical NVIDIA docs for release-specific details.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from typing import Iterable


SKILL_NAME = "nemotron-speech"


@dataclass(frozen=True)
class Route:
    name: str
    reference: str
    reason: str
    patterns: tuple[str, ...]
    next_steps: tuple[str, ...]


DOMAIN_CUES = (
    r"\briva\b",
    r"\bnemotron speech\b",
    r"\bspeech nim\b",
    r"\basr nim\b",
    r"\btts nim\b",
    r"\bnmt nim\b",
    r"\bparakeet\b",
    r"\bcanary\b",
    r"\bmagpie\b",
    r"\briva-build\b",
    r"\briva-deploy\b",
    r"\bnemo2riva\b",
    r"\brmir\b",
    r"\briva\.client\b",
    r"\bnvcr\.io/nim/nvidia\b",
    r"\bgrpc\.nvcf\.nvidia\.com\b",
    r"\bbuild\.nvidia\.com\b",
    r"\bforce_eou\b",
    r"\bsilero vad\b",
    r"\bsortformer\b",
)


ROUTES: tuple[Route, ...] = (
    Route(
        name="asr-custom",
        reference="references/asr-custom.md",
        reason="Custom ASR model packaging or deployment request.",
        patterns=(
            r"\bnemo2riva\b",
            r"\briva-build\b",
            r"\briva-deploy\b",
            r"\brmir\b",
            r"\.nemo\b",
            r"\.riva\b",
            r"\bfine[- ]tuned\b",
            r"\bcustom (?:asr|model)\b",
        ),
        next_steps=(
            "Read references/asr-custom.md.",
            "Verify the exact base image, model family, and riva-build inline block from current NVIDIA docs.",
            "Keep commands and artifacts named Riva unless upstream docs say otherwise.",
        ),
    ),
    Route(
        name="pipelines",
        reference="references/pipelines.md",
        reason="Advanced ASR pipeline configuration request.",
        patterns=(
            r"\bsilero\b",
            r"\bvad\b",
            r"\bdiari[sz]ation\b",
            r"\bsortformer\b",
            r"\blanguage model\b",
            r"\barpa\b",
            r"\bkenlm\b",
            r"\bchunk size\b",
            r"\bendpoint(?:ing)?\b",
            r"\bforce_eou\b",
            r"\bstop_history\b",
            r"\bruntime_config\b",
            r"\bcustom_configuration\b",
            r"\bflashlight\b",
        ),
        next_steps=(
            "Read references/pipelines.md.",
            "Separate build-time riva-build settings from runtime custom_configuration values.",
            "Verify parameter names against the current ASR pipeline configuration docs.",
        ),
    ),
    Route(
        name="readiness",
        reference="references/deployment-readiness-checks.md",
        reason="System compatibility, GPU, container, or health-check request.",
        patterns=(
            r"\bcan my .*(?:gpu|system|machine|server)\b",
            r"\bgpu\b",
            r"\bvram\b",
            r"\bcompute capability\b",
            r"\bdriver\b",
            r"\bcontainer toolkit\b",
            r"\bhealth\b",
            r"\bready\b",
            r"\bcompatib(?:le|ility)\b",
            r"\brequirements?\b",
            r"\bfails? to (?:start|become ready|load)\b",
            r"\bwsl2\b",
            r"\bpodman\b",
        ),
        next_steps=(
            "Read references/deployment-readiness-checks.md.",
            "Check architecture, driver, GPU capability, VRAM, container toolkit, and NGC auth.",
            "Fetch the current support matrix before giving minimums or model-specific requirements.",
        ),
    ),
    Route(
        name="setup",
        reference="references/setup.md",
        reason="Environment setup or prerequisite installation request.",
        patterns=(
            r"\bsetup\b",
            r"\bset up\b",
            r"\bget started\b",
            r"\binstall\b",
            r"\bprereq",
            r"\bdocker login\b",
            r"\bngc api key\b",
            r"\bnvidia container toolkit\b",
            r"\briva client\b",
            r"\bnvidia-riva-client\b",
        ),
        next_steps=(
            "Read references/setup.md.",
            "Walk through drivers, Docker, NVIDIA Container Toolkit, NGC credentials, and the Python client.",
            "Never echo, log, or ask the user to paste an API key value into chat.",
        ),
    ),
    Route(
        name="model-selection",
        reference="references/model-selection.md",
        reason="Model choice or cloud-vs-self-hosted routing request.",
        patterns=(
            r"\bwhich\b.*\bmodel\b",
            r"\bbest\b.*\bmodel\b",
            r"\bchoose\b.*\bmodel\b",
            r"\brecommend\b.*\bmodel\b",
            r"\bmodel selection\b",
            r"\bparakeet\b.*\bcanary\b",
            r"\bcanary\b.*\bparakeet\b",
            r"\bvoice cloning\b",
            r"\blow[- ]latency\b",
            r"\breal[- ]time\b",
            r"\bcloud\b.*\bself[- ]host",
        ),
        next_steps=(
            "Read references/model-selection.md.",
            "Detect NVIDIA_API_KEY and reusable local NIMs before recommending a deployment path when local context is available.",
            "Fetch current support matrices or build.nvidia.com model pages before naming exact model IDs.",
        ),
    ),
    Route(
        name="tts",
        reference="references/tts.md",
        reason="Text-to-speech or voice synthesis request.",
        patterns=(
            r"\btts\b",
            r"\btext[- ]to[- ]speech\b",
            r"\bspeech synthesis\b",
            r"\bsynthesi[sz]e\b",
            r"\bvoice\b",
            r"\bmagpie\b",
            r"\bssml\b",
        ),
        next_steps=(
            "Read references/tts.md.",
            "Choose cloud or self-hosted flow based on the user's environment and privacy constraints.",
            "Fetch current voices and model support before hardcoding voice names.",
        ),
    ),
    Route(
        name="nmt",
        reference="references/nmt.md",
        reason="Translation or neural machine translation request.",
        patterns=(
            r"\bnmt\b",
            r"\btranslate\b",
            r"\btranslation\b",
            r"\blanguage pairs?\b",
            r"\bdnt\b",
            r"\bdo[- ]not[- ]translate\b",
            r"<dnt>",
        ),
        next_steps=(
            "Read references/nmt.md.",
            "Verify the requested language pair against the current support matrix.",
            "Use DNT tags for protected terms when requested.",
        ),
    ),
    Route(
        name="asr",
        reference="references/asr.md",
        reason="Automatic speech recognition deployment or inference request.",
        patterns=(
            r"\basr\b",
            r"\bspeech[- ]to[- ]text\b",
            r"\btranscri(?:be|ption)\b",
            r"\boffline\b",
            r"\bstreaming\b",
            r"\bwebsocket\b",
            r"\bhttp\b",
            r"\bgrpc\b",
            r"\bparakeet\b",
            r"\bcanary\b",
            r"\bwhisper\b",
            r"\bword boosting\b",
            r"\bpunctuation\b",
        ),
        next_steps=(
            "Read references/asr.md.",
            "Select cloud, self-hosted, streaming, offline, gRPC, HTTP, or WebSocket path from the user context.",
            "Verify current model names, function IDs, and feature support before giving release-specific values.",
        ),
    ),
)


def any_match(patterns: Iterable[str], text: str) -> bool:
    return any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in patterns)


def score_route(route: Route, text: str) -> int:
    return sum(1 for pattern in route.patterns if re.search(pattern, text, flags=re.IGNORECASE))


def classify(question: str) -> dict[str, object]:
    text = " ".join(question.strip().split())
    if not text:
        return {
            "expected_skill": None,
            "route": None,
            "reference": None,
            "confidence": "low",
            "reason": "Empty prompt.",
            "next_steps": ["Do not activate nemotron-speech without a concrete Riva/Nemotron Speech task."],
        }

    if not any_match(DOMAIN_CUES, text):
        return {
            "expected_skill": None,
            "route": None,
            "reference": None,
            "confidence": "low",
            "reason": "No Nemotron Speech, Riva, or Speech NIM cue was found.",
            "next_steps": ["Keep the nemotron-speech skill silent and use a more relevant workflow."],
        }

    scored = [(score_route(route, text), index, route) for index, route in enumerate(ROUTES)]
    scored.sort(key=lambda item: (-item[0], item[1]))
    score, _, route = scored[0]

    confidence = "high" if score >= 2 else "medium"
    return {
        "expected_skill": SKILL_NAME,
        "route": route.name,
        "reference": route.reference,
        "confidence": confidence,
        "reason": route.reason,
        "next_steps": list(route.next_steps),
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("question", nargs="*", help="User prompt to classify.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    question = " ".join(args.question) if args.question else sys.stdin.read()
    result = classify(question)
    print(json.dumps(result, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
