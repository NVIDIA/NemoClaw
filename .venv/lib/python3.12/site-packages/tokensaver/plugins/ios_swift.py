"""iOS / Swift plugin — SwiftUI, UIKit.

Extracts SwiftUI Views and NavigationLink routes, UIKit ViewControllers
and segue identifiers, URLSession / Alamofire API calls,
UserDefaults / ProcessInfo env access, and Info.plist keys.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from tokensaver import SCHEMA_VERSION
from tokensaver.core.helpers import (
    add_api_file_entry,
    build_module_graph_artifact,
    finalize_api_files,
    finalize_route_files,
    match_with_lines,
    meta,
    module_name_for_file,
    timestamp,
)
from tokensaver.core.models import ArtifactResult, BuildContext

SWIFT_EXTS = {".swift"}

SWIFTUI_VIEW = re.compile(
    r"struct\s+(\w+)\s*:\s*(?:\w+,\s*)*View\b"
)
NAVIGATION_LINK = re.compile(
    r'NavigationLink\([^)]*destination:\s*(\w+)'
)
NAVIGATION_DESTINATION = re.compile(
    r'\.navigationDestination\([^)]*for:\s*(\w+)'
)
TABVIEW_TAB = re.compile(
    r'\.tabItem\s*\{[^}]*Label\(\s*["\']([^"\']+)["\']'
)
UIVIEWCONTROLLER = re.compile(
    r"class\s+(\w+)\s*:\s*(?:UI)?(?:View|Table|Collection|Navigation|Tab(?:Bar)?)Controller\b"
)
SEGUE_IDENTIFIER = re.compile(
    r'(?:performSegue|segue\.identifier)\s*.*?["\']([^"\']+)["\']'
)
URLSESSION_URL = re.compile(
    r'URL\(\s*string:\s*["\']([^"\']+)["\']'
)
ALAMOFIRE_REQUEST = re.compile(
    r'AF\.(request|get|post|put|delete|patch)\(\s*["\']([^"\']+)["\']'
)
URL_CONST = re.compile(
    r'(?:let|var)\s+(\w*(?:url|endpoint|baseURL|apiURL)\w*)\s*=\s*["\']([^"\']+https?://[^"\']+)["\']',
    re.IGNORECASE
)
USERDEFAULTS = re.compile(
    r'UserDefaults\.standard\.(?:string|integer|bool|double|object|value)\(\s*forKey:\s*["\']([^"\']+)["\']'
)
PROCESSINFO_ENV = re.compile(
    r'ProcessInfo\.processInfo\.environment\[\s*["\']([^"\']+)["\']'
)
BUNDLE_INFOPLIST = re.compile(
    r'Bundle\.main\.(?:infoDictionary|object)\s*.*?\[\s*["\']([^"\']+)["\']'
)
APPSTORAGE = re.compile(
    r'@AppStorage\(\s*["\']([^"\']+)["\']'
)


@dataclass(frozen=True)
class IOSSwiftPlugin:
    name: str = "ios_swift"
    frameworks: set[str] = frozenset({"ios_swift"})

    def build_artifacts(self, ctx: BuildContext) -> list[ArtifactResult]:
        return [
            build_module_graph(ctx),
            build_api_index(ctx),
            build_route_index(ctx),
            build_config_index(ctx),
        ]


def _swift_files(root: Path):
    for path in root.rglob("*.swift"):
        if ".git" in path.parts:
            continue
        if any(p in ("Pods", ".build", "DerivedData", "Build", "Tests", "UITests") for p in path.parts):
            continue
        yield path


def build_module_graph(ctx: BuildContext) -> ArtifactResult:
    return build_module_graph_artifact(ctx.root, ctx.scan.framework, ArtifactResult)


def build_api_index(ctx: BuildContext) -> ArtifactResult:
    api_files: dict = {}
    source_files: set[Path] = set()
    endpoint_count = 0

    for fp in _swift_files(ctx.root):
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        module = module_name_for_file(ctx.root, fp)
        file_has = False

        for _, url in match_with_lines(content, URLSESSION_URL, value_group=1):
            if "http" in url.lower():
                if add_api_file_entry(api_files, rel_path=rel, module=module, path=url, name="", method="URL"):
                    endpoint_count += 1
                    file_has = True

        for _, method, url in match_with_lines(content, ALAMOFIRE_REQUEST, method_group=1, path_group=2):
            if add_api_file_entry(api_files, rel_path=rel, module=module, path=url, name="", method=method.upper()):
                endpoint_count += 1
                file_has = True

        for _, name, url in match_with_lines(content, URL_CONST, method_group=1, path_group=2):
            if add_api_file_entry(api_files, rel_path=rel, module=module, path=url, name=name, method="BASE"):
                endpoint_count += 1
                file_has = True

        if file_has:
            source_files.add(fp)

    payload = {
        "_meta": {
            **meta(ctx.root, "ios_swift_api_index_v1", source_files),
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

    for fp in _swift_files(ctx.root):
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        file_has = False

        for view_match in SWIFTUI_VIEW.finditer(content):
            name = view_match.group(1)
            line_no = content.count("\n", 0, view_match.start()) + 1
            routes[f"view:{name}"] = {
                "path": f"view:{name}", "kind": "swiftui_view",
                "source": [{"file": rel, "line": line_no}],
                "usage_count": 0, "navigated_from": [], "screen": name,
            }
            file_has = True

        for _, dest in match_with_lines(content, NAVIGATION_LINK, value_group=1):
            entry = routes.setdefault(f"view:{dest}", {
                "path": f"view:{dest}", "kind": "swiftui_view",
                "source": [{"file": rel}], "usage_count": 0, "navigated_from": [],
            })
            entry["usage_count"] += 1
            file_has = True

        for _, dest in match_with_lines(content, NAVIGATION_DESTINATION, value_group=1):
            entry = routes.setdefault(f"destination:{dest}", {
                "path": f"destination:{dest}", "kind": "navigation_destination",
                "source": [{"file": rel}], "usage_count": 0, "navigated_from": [],
            })
            entry["usage_count"] += 1
            file_has = True

        for vc_match in UIVIEWCONTROLLER.finditer(content):
            name = vc_match.group(1)
            line_no = content.count("\n", 0, vc_match.start()) + 1
            routes[f"vc:{name}"] = {
                "path": f"vc:{name}", "kind": "view_controller",
                "source": [{"file": rel, "line": line_no}],
                "usage_count": 0, "navigated_from": [], "screen": name,
            }
            file_has = True

        for _, segue_id in match_with_lines(content, SEGUE_IDENTIFIER, value_group=1):
            entry = routes.setdefault(f"segue:{segue_id}", {
                "path": f"segue:{segue_id}", "kind": "segue",
                "source": [{"file": rel}], "usage_count": 0, "navigated_from": [],
            })
            entry["usage_count"] += 1
            file_has = True

        if file_has:
            source_files.add(fp)

    payload = {
        "_meta": {
            "schema_version": SCHEMA_VERSION,
            "generated_at": timestamp(),
            "extractor": "ios_swift_route_index_v1",
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

    for fp in _swift_files(ctx.root):
        content = fp.read_text(errors="ignore")
        rel = str(fp.relative_to(ctx.root))
        file_has = False

        for line_no, key in match_with_lines(content, USERDEFAULTS, value_group=1):
            entry = keys.setdefault(f"UserDefaults.{key}", {
                "name": f"UserDefaults.{key}", "types": {"user_defaults"}, "references": [],
                "extractor": "ios_userdefaults_v1", "confidence": 0.95,
            })
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        for line_no, key in match_with_lines(content, PROCESSINFO_ENV, value_group=1):
            entry = keys.setdefault(key, {
                "name": key, "types": {"environment"}, "references": [],
                "extractor": "ios_processinfo_env_v1", "confidence": 0.95,
            })
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        for line_no, key in match_with_lines(content, BUNDLE_INFOPLIST, value_group=1):
            entry = keys.setdefault(f"Info.plist.{key}", {
                "name": f"Info.plist.{key}", "types": {"info_plist"}, "references": [],
                "extractor": "ios_infoplist_v1", "confidence": 0.9,
            })
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        for line_no, key in match_with_lines(content, APPSTORAGE, value_group=1):
            entry = keys.setdefault(f"@AppStorage.{key}", {
                "name": f"@AppStorage.{key}", "types": {"app_storage"}, "references": [],
                "extractor": "ios_appstorage_v1", "confidence": 0.95,
            })
            entry["references"].append({"file": rel, "line": line_no})
            file_has = True

        if file_has:
            source_files.add(fp)

    payload = {
        "_meta": meta(ctx.root, "ios_swift_config_index_v1", source_files),
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


IOS_SWIFT_PLUGIN = IOSSwiftPlugin()
