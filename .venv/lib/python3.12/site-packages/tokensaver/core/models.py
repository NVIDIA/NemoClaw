"""Shared data models for TokenSaver build orchestration."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from tokensaver.scanner import ScanResult


@dataclass
class ArtifactResult:
    name: str
    file_name: str
    payload: dict
    source_files: set[Path]
    entity_count: int
    output_tokens: int = 0

    @property
    def path(self) -> str:
        return self.file_name


@dataclass(frozen=True)
class BuildContext:
    root: Path
    scan: ScanResult
