"""Next.js-specific TokenSaver plugin.

Extracts file-based routes (App Router + Pages Router), API routes,
middleware, next.config settings, and server actions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from tokensaver import SCHEMA_VERSION
from tokensaver.core.helpers import (
    ENV_PATTERNS,
    add_api_file_entry,
    all_code_files,
    build_module_graph_artifact,
    finalize_api_files,
    finalize_route_files,
    match_with_lines,
    meta,
    module_name_for_file,
    timestamp,
)
from tokensaver.core.models import ArtifactResult, BuildContext

JS_EXTS = {".js", ".jsx", ".ts", ".tsx"}

NEXTJS_API_HANDLER = re.compile(
    r"export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b"
)
NEXTJS_PAGES_API_HANDLER = re.compile(
    r"export\s+default\s+(?:async\s+)?function\s+(?:handler|[\w]+)\s*\("
)
NEXT_REDIRECT = re.compile(r"\bredirect\s*\(\s*['\"]([^'\"]+)['\"]")
NEXT_REWRITE = re.compile(r"destination\s*:\s*['\"]([^'\"]+)['\"]")
SERVER_ACTION_MARKER = re.compile(r"['\"]use server['\"]")
NEXT_CONFIG_KEY = re.compile(r"^\s*(\w+)\s*:", re.MULTILINE)


@dataclass(frozen=True)
class NextjsPlugin:
    name: str = "nextjs"
    frameworks: set[str] = frozenset({"nextjs"})

    def build_artifacts(self, ctx: BuildContext) -> list[ArtifactResult]:
        return [
            build_module_graph(ctx),
            build_api_index(ctx),
            build_route_index(ctx),
            build_config_index(ctx),
        ]


def _is_app_router(root: Path) -> bool:
    return (root / "app").is_dir() or (root / "src" / "app").is_dir()


def _app_dir(root: Path) -> Path | None:
    for candidate in (root / "app", root / "src" / "app"):
        if candidate.is_dir():
            return candidate
    return None


def _pages_dir(root: Path) -> Path | None:
    for candidate in (root / "pages", root / "src" / "pages"):
        if candidate.is_dir():
            return candidate
    return None


def _file_to_route(base: Path, file_path: Path) -> str | None:
    rel = file_path.relative_to(base)
    stem = rel.stem
    parts = list(rel.parent.parts)

    if stem in ("layout", "loading", "error", "not-found", "template", "default"):
        return None

    if stem == "page":
        route = "/" + "/".join(parts) if parts else "/"
    elif stem == "index":
        route = "/" + "/".join(parts) if parts else "/"
    elif stem == "route":
        route = "/" + "/".join(parts) if parts else "/"
    else:
        parts.append(stem)
        route = "/" + "/".join(parts)

    route = re.sub(r"\([\w-]+\)/", "", route)
    route = re.sub(r"\[(\.{3})?(\w+)\]", r":\2", route)
    route = route.replace("//", "/")
    return route or "/"


def build_module_graph(ctx: BuildContext) -> ArtifactResult:
    return build_module_graph_artifact(ctx.root, ctx.scan.framework, ArtifactResult)


def build_api_index(ctx: BuildContext) -> ArtifactResult:
    api_files: dict = {}
    source_files: set[Path] = set()
    endpoint_count = 0

    app = _app_dir(ctx.root)
    if app:
        api_base = app / "api"
        if api_base.is_dir():
            for fp in api_base.rglob("route.*"):
                if fp.suffix not in JS_EXTS:
                    continue
                content = fp.read_text(errors="ignore")
                rel = str(fp.relative_to(ctx.root))
                module = module_name_for_file(ctx.root, fp)
                route_path = _file_to_route(app, fp) or "/api"
                for _, method in match_with_lines(content, NEXTJS_API_HANDLER, value_group=1):
                    if add_api_file_entry(api_files, rel_path=rel, module=module, path=route_path, name="", method=method):
                        endpoint_count += 1
                source_files.add(fp)

    pages = _pages_dir(ctx.root)
    if pages:
        pages_api = pages / "api"
        if pages_api.is_dir():
            for fp in pages_api.rglob("*"):
                if fp.suffix not in JS_EXTS:
                    continue
                content = fp.read_text(errors="ignore")
                rel = str(fp.relative_to(ctx.root))
                module = module_name_for_file(ctx.root, fp)
                route = _file_to_route(pages_api, fp)
                api_path = f"/api{route}" if route else "/api"
                if NEXTJS_PAGES_API_HANDLER.search(content):
                    if add_api_file_entry(api_files, rel_path=rel, module=module, path=api_path, name="handler", method="ALL"):
                        endpoint_count += 1
                    source_files.add(fp)

    for fp in all_code_files(ctx.root):
        if "test" in fp.parts or fp.suffix not in JS_EXTS:
            continue
        if not SERVER_ACTION_MARKER.search(fp.read_text(errors="ignore")):
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        module = module_name_for_file(ctx.root, fp)
        fn_pattern = re.compile(r"export\s+(?:async\s+)?function\s+(\w+)")
        for _, fn_name in match_with_lines(content, fn_pattern, value_group=1):
            if add_api_file_entry(api_files, rel_path=rel, module=module, path=f"action:{fn_name}", name=fn_name, method="ACTION"):
                endpoint_count += 1
        source_files.add(fp)

    payload = {
        "_meta": {
            **meta(ctx.root, "nextjs_api_index_v1", source_files),
            "entry_schema": ["path", "name", "method"],
            "group_schema": ["file", "module", "entries"],
        },
        "files": finalize_api_files(api_files),
    }
    return ArtifactResult(
        name="api_index",
        file_name="API_INDEX.json",
        payload=payload,
        source_files=source_files,
        entity_count=endpoint_count,
    )


def build_route_index(ctx: BuildContext) -> ArtifactResult:
    routes: dict = {}
    source_files: set[Path] = set()

    app = _app_dir(ctx.root)
    if app:
        for fp in app.rglob("page.*"):
            if fp.suffix not in JS_EXTS:
                continue
            route = _file_to_route(app, fp)
            if not route:
                continue
            rel = str(fp.relative_to(ctx.root))
            routes[route] = {
                "path": route,
                "kind": "ui_route",
                "source": [{"file": rel}],
                "usage_count": 1,
                "navigated_from": [],
                "router": "app",
            }
            source_files.add(fp)

    pages = _pages_dir(ctx.root)
    if pages:
        for fp in pages.rglob("*"):
            if fp.suffix not in JS_EXTS:
                continue
            if fp.relative_to(pages).parts[0:1] == ("api",):
                continue
            route = _file_to_route(pages, fp)
            if not route:
                continue
            rel = str(fp.relative_to(ctx.root))
            if route not in routes:
                routes[route] = {
                    "path": route,
                    "kind": "ui_route",
                    "source": [{"file": rel}],
                    "usage_count": 1,
                    "navigated_from": [],
                    "router": "pages",
                }
                source_files.add(fp)

    for fp in all_code_files(ctx.root):
        if fp.suffix not in JS_EXTS:
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        for _, target in match_with_lines(content, NEXT_REDIRECT, value_group=1):
            if target.startswith("/"):
                entry = routes.setdefault(target, {
                    "path": target,
                    "kind": "ui_route",
                    "source": [{"file": rel}],
                    "usage_count": 0,
                    "navigated_from": [],
                })
                entry["usage_count"] = entry.get("usage_count", 0) + 1
                source_files.add(fp)

    payload = {
        "_meta": {
            "schema_version": SCHEMA_VERSION,
            "generated_at": timestamp(),
            "extractor": "nextjs_route_index_v1",
            "entry_schema": ["path", "screen", "usage_count", "aliases", "navigated_from"],
            "group_schema": ["file", "entries"],
        },
        "files": finalize_route_files(routes),
    }
    return ArtifactResult(
        name="route_index",
        file_name="ROUTE_INDEX.json",
        payload=payload,
        source_files=source_files,
        entity_count=len(routes),
    )


def build_config_index(ctx: BuildContext) -> ArtifactResult:
    keys: dict = {}
    source_files: set[Path] = set()

    for fp in all_code_files(ctx.root):
        if "test" in fp.parts or fp.suffix not in JS_EXTS:
            continue
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        file_has_keys = False

        for extractor, pattern in ENV_PATTERNS:
            for line_no, key in match_with_lines(content, pattern, value_group=1):
                entry = keys.setdefault(key, {
                    "name": key, "types": set(), "references": [],
                    "extractor": extractor, "confidence": 0.95,
                })
                entry["references"].append({"file": rel, "line": line_no})
                file_has_keys = True

        if file_has_keys:
            source_files.add(fp)

    next_config_names = ("next.config.js", "next.config.mjs", "next.config.ts")
    for cfg_name in next_config_names:
        cfg_path = ctx.root / cfg_name
        if not cfg_path.exists():
            continue
        content = cfg_path.read_text(errors="ignore")
        rel = cfg_name
        for line_no, key in match_with_lines(content, NEXT_CONFIG_KEY, value_group=1):
            if key in ("module", "const", "export", "default", "require", "import", "if", "else", "return"):
                continue
            entry = keys.setdefault(f"next.config.{key}", {
                "name": f"next.config.{key}", "types": set(), "references": [],
                "extractor": "nextjs_config_v1", "confidence": 0.9,
            })
            entry["references"].append({"file": rel, "line": line_no})
        source_files.add(cfg_path)

    for env_name in (".env", ".env.local", ".env.development", ".env.production", ".env.example"):
        env_path = ctx.root / env_name
        if not env_path.exists():
            continue
        try:
            content = env_path.read_text(errors="ignore")
        except OSError:
            continue
        for line_no, line in enumerate(content.splitlines(), start=1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key = line.split("=", 1)[0].strip()
            if not key or not key.replace("_", "").isalnum():
                continue
            is_public = key.startswith("NEXT_PUBLIC_")
            entry = keys.setdefault(key, {
                "name": key, "types": set(), "references": [],
                "extractor": "nextjs_env_v1",
                "confidence": 0.95 if is_public else 0.85,
            })
            if is_public:
                entry["types"].add("public")
            entry["references"].append({"file": env_name, "line": line_no})
        source_files.add(env_path)

    payload = {
        "_meta": meta(ctx.root, "nextjs_config_index_v1", source_files),
        "config_keys": [
            {
                "name": item["name"],
                "types": sorted(item["types"]) if item["types"] else ["unknown"],
                "references": item["references"],
                "source": item["references"],
                "extractor": item["extractor"],
                "confidence": item["confidence"],
            }
            for item in sorted(keys.values(), key=lambda v: v["name"])
        ],
    }
    return ArtifactResult(
        name="config_index",
        file_name="CONFIG_INDEX.json",
        payload=payload,
        source_files=source_files,
        entity_count=len(keys),
    )


NEXTJS_PLUGIN = NextjsPlugin()
