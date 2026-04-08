"""Plugin interface for technology-specific TokenSaver extractors."""

from __future__ import annotations

from typing import Protocol

from tokensaver.core.models import ArtifactResult, BuildContext


class TokenSaverPlugin(Protocol):
    name: str
    frameworks: set[str]

    def build_artifacts(self, ctx: BuildContext) -> list[ArtifactResult]:
        """Build technology-specific artifacts for a repository."""
