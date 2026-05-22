#!/usr/bin/env python3
"""
One-shot cleanup of cache files whose slug body ends in `--<disambiguator>`.

Background: the chip-JIT path was passing a parent-context string as
`disambiguator`, which makeSlug() folds into the slug body. The result was
that the agent stored e.g. `artist:pupajim--roster-of-label-stand-high-records`
while parent nodes' edges referenced bare `artist:pupajim`. Chips therefore
appeared as dangling → triggered a fresh JIT every cycle, even after the
"materialized" node was on disk.

This script:
  1. Scans every node JSON.
  2. Builds the old-slug → bare-slug rewrite map for files whose body has `--`.
  3. Rewrites every edge.slug throughout the cache to its bare form.
  4. Merges multiple disambiguated nodes that fold to the same bare slug
     (union of edges; node body taken from the one with most edges).
  5. Deletes the now-redundant disambiguated files.

Idempotent: re-running on a clean cache is a no-op.
"""
from __future__ import annotations
import json
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/odyssey-music/cache/nodes")

def load_node_spec() -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    repo = Path(__file__).resolve().parents[1]
    raw = subprocess.check_output(
        ["npx", "tsx", "scripts/dump-node-spec.ts"],
        cwd=repo,
        text=True,
    )
    spec = json.loads(raw)
    return spec["listEdgesByType"], spec["singularEdgesByType"]


LIST_EDGES, SINGULAR_EDGES = load_node_spec()
DISAMBIG_RE = re.compile(r"^(.+?)--.+$")


def bare_slug(slug: str) -> str:
    t, _, body = slug.partition(":")
    m = DISAMBIG_RE.match(body)
    return f"{t}:{m.group(1)}" if m else slug


def edge_count(node: dict, type_name: str) -> int:
    n = 0
    for fld in LIST_EDGES.get(type_name, []):
        v = node.get(fld)
        if isinstance(v, list):
            n += len(v)
    return n


def rewrite_edges(node: dict, type_name: str, rewrite_map: dict[str, str]) -> dict:
    """Return node with every edge.slug rewritten through rewrite_map."""
    for fld in LIST_EDGES.get(type_name, []):
        for e in node.get(fld, []) or []:
            old = e.get("slug")
            if old and old in rewrite_map:
                e["slug"] = rewrite_map[old]
    for fld in SINGULAR_EDGES.get(type_name, []):
        e = node.get(fld)
        if e and isinstance(e, dict) and e.get("slug") in rewrite_map:
            e["slug"] = rewrite_map[e["slug"]]
    return node


def main() -> None:
    if not ROOT.exists():
        print(f"missing {ROOT}")
        sys.exit(1)

    # === PASS 1: build rewrite map ===
    rewrite_map: dict[str, str] = {}
    disambig_files: list[tuple[str, str, Path]] = []  # (type, bare_slug, path)
    type_dirs = sorted(p for p in ROOT.iterdir() if p.is_dir())
    for type_dir in type_dirs:
        t = type_dir.name
        if t not in LIST_EDGES:
            continue
        for f in type_dir.glob("*.json"):
            body = f.stem
            m = DISAMBIG_RE.match(body)
            if not m:
                continue
            bare_body = m.group(1)
            old = f"{t}:{body}"
            new = f"{t}:{bare_body}"
            rewrite_map[old] = new
            disambig_files.append((t, new, f))

    print(f"==> {len(rewrite_map)} disambiguated slugs to collapse")

    # === PASS 2: rewrite every node's edges ===
    rewrite_count = 0
    for type_dir in type_dirs:
        t = type_dir.name
        if t not in LIST_EDGES:
            continue
        for f in type_dir.glob("*.json"):
            try:
                node = json.load(open(f))
            except Exception:
                continue
            before = json.dumps(node, sort_keys=True)
            node = rewrite_edges(node, t, rewrite_map)
            after = json.dumps(node, sort_keys=True)
            if before != after:
                with open(f, "w") as out:
                    json.dump(node, out, indent=2)
                rewrite_count += 1
    print(f"==> rewrote edges in {rewrite_count} node files")

    # === PASS 3: merge duplicates per bare slug ===
    groups: dict[tuple[str, str], list[Path]] = defaultdict(list)
    for t, bare, path in disambig_files:
        groups[(t, bare)].append(path)
    # Also include any existing bare file at that target
    for (t, bare), paths in list(groups.items()):
        bare_body = bare.split(":", 1)[1]
        bare_path = ROOT / t / f"{bare_body}.json"
        if bare_path.exists() and bare_path not in paths:
            paths.insert(0, bare_path)

    for (t, bare), paths in sorted(groups.items()):
        bare_body = bare.split(":", 1)[1]
        target = ROOT / t / f"{bare_body}.json"
        nodes: list[tuple[Path, dict]] = []
        for p in paths:
            try:
                nodes.append((p, json.load(open(p))))
            except Exception:
                pass
        if not nodes:
            continue
        nodes.sort(key=lambda x: -edge_count(x[1], t))
        canonical = nodes[0][1]
        canonical["slug"] = bare
        canonical.pop("disambiguator", None)

        # Union edges across all duplicates.
        for fld in LIST_EDGES[t]:
            seen = set()
            merged: list[dict] = []
            for _, n in nodes:
                for e in n.get(fld, []) or []:
                    s = e.get("slug")
                    if not s or s in seen:
                        continue
                    seen.add(s)
                    merged.append(e)
            canonical[fld] = merged
        for fld in SINGULAR_EDGES[t]:
            if not canonical.get(fld):
                for _, n in nodes:
                    v = n.get(fld)
                    if v:
                        canonical[fld] = v
                        break

        with open(target, "w") as out:
            json.dump(canonical, out, indent=2)
        for p, _ in nodes:
            if p != target:
                p.unlink()
        if len(paths) > 1:
            print(f"  merged {len(paths):>2}× -> {bare}")
        else:
            print(f"  renamed      -> {bare}")

    print("==> done")


if __name__ == "__main__":
    main()
