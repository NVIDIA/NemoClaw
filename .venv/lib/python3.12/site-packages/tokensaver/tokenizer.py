"""Exact token counting using tiktoken."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Dict, Tuple

import tiktoken

DEFAULT_ENCODING = "o200k_base"
_FILE_TOKEN_CACHE: Dict[Tuple[str, int, int], int] = {}


@lru_cache(maxsize=1)
def _encoding():
    return tiktoken.get_encoding(DEFAULT_ENCODING)


def tokenizer_name() -> str:
    return DEFAULT_ENCODING


def count_text_tokens(text: str) -> int:
    return len(_encoding().encode(text))


def count_file_tokens(path: str | Path, text: str | None = None) -> int:
    if text is None:
        path = Path(path)
        stat = path.stat()
        cache_key = (str(path.resolve()), stat.st_mtime_ns, stat.st_size)
        if cache_key in _FILE_TOKEN_CACHE:
            return _FILE_TOKEN_CACHE[cache_key]
        text = path.read_text(errors="ignore")
        tokens = count_text_tokens(text)
        _FILE_TOKEN_CACHE[cache_key] = tokens
        return tokens
    return count_text_tokens(text)
