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

"""JSON data formatting and structure building."""

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from docutils import nodes
from sphinx.application import Sphinx
from sphinx.util import logging

from ..utils import get_document_url, get_setting
from .document_discovery import DocumentDiscovery
from .global_metadata import get_global_metadata

if TYPE_CHECKING:
    from .builder import JSONOutputBuilder

logger = logging.getLogger(__name__)


def _normalize_description_fields(metadata: dict[str, Any]) -> tuple[str, str]:
    """Parse description from frontmatter: nested main/agent or legacy flat string."""
    raw = metadata.get("description")
    if isinstance(raw, dict):
        main = str(raw.get("main") or "").strip()
        agent = str(raw.get("agent") or "").strip()
        if main and not agent:
            agent = main
        elif agent and not main:
            main = agent
        return main, agent
    if raw is not None and not isinstance(raw, dict):
        text = str(raw).strip()
        if text:
            return text, text
    return "", ""


class JSONFormatter:
    """Handles JSON data structure building and formatting."""

    def __init__(self, app: Sphinx, json_builder: "JSONOutputBuilder"):
        self.app = app
        self.env = app.env
        self.config = app.config
        self.json_builder = json_builder
        self._global_metadata: dict[str, Any] | None = None

    @property
    def global_metadata(self) -> dict[str, Any]:
        """Get cached global metadata from conf.py."""
        if self._global_metadata is None:
            self._global_metadata = get_global_metadata(self.config)
        return self._global_metadata

    def add_metadata_fields(self, data: dict[str, Any], metadata: dict[str, Any]) -> None:
        """Add all metadata fields to JSON data structure.

        Supports both new nested schema and legacy flat fields for backwards compatibility.
        New schema: topics, tags, industry, content.type, content.learning_level, content.audience, facets.modality
        Legacy schema: categories, personas, difficulty, content_type, modality
        """
        # Basic metadata fields — nested description.main / description.agent or legacy string
        main_desc, agent_desc = _normalize_description_fields(metadata)
        if main_desc:
            data["description"] = main_desc
        if agent_desc and agent_desc != main_desc:
            data["description_agent"] = agent_desc

        # Tags (same in both schemas)
        if metadata.get("tags"):
            data["tags"] = metadata["tags"] if isinstance(metadata["tags"], list) else [metadata["tags"]]

        # Topics (new schema) or categories (legacy)
        topics = metadata.get("topics") or metadata.get("categories")
        if topics:
            data["topics"] = topics if isinstance(topics, list) else [topics]

        # Industry verticals
        if metadata.get("industry"):
            industry = metadata["industry"]
            data["industry"] = industry if isinstance(industry, list) else [industry]

        if metadata.get("author"):
            data["author"] = metadata["author"]

        # Content classification - support nested and flat structures
        content = metadata.get("content", {})

        # Content type: content.type (new) or content_type (legacy)
        content_type = content.get("type") if isinstance(content, dict) else None
        content_type = content_type or metadata.get("content_type")
        if content_type:
            data["content_type"] = content_type

        # Learning level: content.learning_level (new) or content.difficulty/difficulty (legacy)
        learning_level = content.get("learning_level") if isinstance(content, dict) else None
        learning_level = learning_level or content.get("difficulty") if isinstance(content, dict) else None
        learning_level = learning_level or metadata.get("learning_level") or metadata.get("difficulty")
        if learning_level:
            data["learning_level"] = learning_level

        # Audience: content.audience (new) or personas (legacy)
        audience = content.get("audience") if isinstance(content, dict) else None
        audience = audience or metadata.get("personas")
        if audience:
            data["audience"] = audience if isinstance(audience, list) else [audience]

        # Keywords from frontmatter (takes priority over auto-extraction)
        if metadata.get("keywords"):
            keywords = metadata["keywords"]
            data["keywords"] = keywords if isinstance(keywords, list) else [keywords]

        # Product-specific facets - dynamically extract all facet keys
        facets = metadata.get("facets", {})
        if isinstance(facets, dict) and facets:
            # Include all facets as a nested object
            data["facets"] = facets
            # Also flatten facets to top level for backwards compatibility and easier filtering
            for facet_key, facet_value in facets.items():
                data[facet_key] = facet_value

        # Legacy flat modality support (if not already set via facets)
        if "modality" not in data and metadata.get("modality"):
            data["modality"] = metadata["modality"]

        # Content gating
        if metadata.get("only"):
            data["only"] = metadata["only"]

    def build_child_json_data(self, docname: str, include_content: bool | None = None) -> dict[str, Any]:
        """Build optimized JSON data for child documents (LLM/search focused)."""
        if include_content is None:
            include_content = get_setting(self.config, "include_child_content", True)

        # Get document title
        title = self.env.titles.get(docname, nodes.title()).astext() if docname in self.env.titles else ""

        # Extract metadata for tags/categories
        metadata = self.json_builder.extract_document_metadata(docname)
        content_data = self.json_builder.extract_document_content(docname) if include_content else {}

        # Build optimized data structure for search engines
        data = {
            "id": docname,  # Use 'id' for search engines
            "title": title,
            "url": get_document_url(self.app, docname),
        }

        # Add global metadata from conf.py (book, product, site)
        self._add_global_metadata(data)

        # Add metadata fields from frontmatter
        self.add_metadata_fields(data, metadata)

        # Add search-specific fields
        if include_content:
            self._add_content_fields(data, content_data, docname, title)

        return data

    def build_json_data(self, docname: str) -> dict[str, Any]:
        """Build optimized JSON data structure for LLM/search use cases."""
        # Get document title
        title = self.env.titles.get(docname, nodes.title()).astext() if docname in self.env.titles else ""

        # Extract metadata and content
        metadata = self.json_builder.extract_document_metadata(docname)
        content_data = self.json_builder.extract_document_content(docname)

        # Build data structure
        data = {
            "id": docname,
            "title": title,
            "url": get_document_url(self.app, docname),
            "last_modified": datetime.now(timezone.utc).isoformat(),
        }

        # Add global metadata from conf.py (book, product, site)
        self._add_global_metadata(data)

        # Add metadata fields from frontmatter
        self.add_metadata_fields(data, metadata)

        # Add content
        if content_data.get("content"):
            data["content"] = content_data["content"]
            data["format"] = content_data.get("format", "text")

        if content_data.get("summary"):
            data["summary"] = content_data["summary"]

        if content_data.get("headings"):
            data["headings"] = [{"text": h["text"], "level": h["level"]} for h in content_data["headings"]]

        return data

    def _add_global_metadata(self, data: dict[str, Any]) -> None:
        """Inject global site/book/product metadata from conf.py."""
        for key, value in self.global_metadata.items():
            if value:  # Only add non-empty values
                data[key] = value

    def _add_content_fields(self, data: dict[str, Any], content_data: dict[str, Any], docname: str, title: str) -> None:
        """Add content-related fields to JSON data."""
        self._add_primary_content(data, content_data)
        self._add_summary_content(data, content_data)
        self._add_headings_content(data, content_data)
        self._add_optional_features(data, content_data)
        self._add_document_metadata(data, content_data, docname, title)

    def _add_primary_content(self, data: dict[str, Any], content_data: dict[str, Any]) -> None:
        """Add primary content with length limits."""
        if not content_data.get("content"):
            return

        content_max_length = get_setting(self.config, "content_max_length", 50000)
        content = content_data["content"]

        if content_max_length > 0 and len(content) > content_max_length:
            content = content[:content_max_length] + "..."

        data["content"] = content
        data["format"] = content_data.get("format", "text")
        data["content_length"] = len(content_data["content"])  # Original length
        data["word_count"] = len(content_data["content"].split()) if content_data["content"] else 0

    def _add_summary_content(self, data: dict[str, Any], content_data: dict[str, Any]) -> None:
        """Add summary with length limits."""
        if not content_data.get("summary"):
            return

        summary_max_length = get_setting(self.config, "summary_max_length", 500)
        summary = content_data["summary"]

        if summary_max_length > 0 and len(summary) > summary_max_length:
            summary = summary[:summary_max_length] + "..."

        data["summary"] = summary

    def _add_headings_content(self, data: dict[str, Any], content_data: dict[str, Any]) -> None:
        """Add headings for structure/navigation."""
        if not content_data.get("headings"):
            return

        # Simplify headings for LLM use
        data["headings"] = [
            {"text": h["text"], "level": h["level"], "id": h.get("id", "")} for h in content_data["headings"]
        ]
        # Add searchable heading text
        data["headings_text"] = " ".join([h["text"] for h in content_data["headings"]])

    def _add_optional_features(self, data: dict[str, Any], content_data: dict[str, Any]) -> None:
        """Add optional search enhancement features."""
        # Keywords: frontmatter takes priority, then auto-extraction
        if "keywords" not in data:  # Not already set from frontmatter
            if get_setting(self.config, "extract_keywords", True) and "keywords" in content_data:
                keywords_max_count = get_setting(self.config, "keywords_max_count", 50)
                keywords = (
                    content_data["keywords"][:keywords_max_count]
                    if keywords_max_count > 0
                    else content_data["keywords"]
                )
                data["keywords"] = keywords

        if get_setting(self.config, "extract_code_blocks", True) and "code_blocks" in content_data:
            data["code_blocks"] = content_data["code_blocks"]

        if get_setting(self.config, "extract_links", True) and "links" in content_data:
            data["links"] = content_data["links"]

        if get_setting(self.config, "extract_images", True) and "images" in content_data:
            data["images"] = content_data["images"]

    def _add_document_metadata(
        self, data: dict[str, Any], content_data: dict[str, Any], docname: str, title: str
    ) -> None:
        """Add document type and section metadata."""
        if get_setting(self.config, "include_doc_type", True):
            discovery = DocumentDiscovery(self.app, self.json_builder)
            data["doc_type"] = discovery.detect_document_type(docname, title, content_data.get("content", ""))

        if get_setting(self.config, "include_section_path", True):
            discovery = DocumentDiscovery(self.app, self.json_builder)
            data["section_path"] = discovery.get_section_path(docname)
