#!/usr/bin/env python3
"""Print the canonical node spec JSON emitted by the TypeScript helper."""
from __future__ import annotations

import subprocess
from pathlib import Path


def main() -> None:
    repo = Path(__file__).resolve().parents[1]
    print(
        subprocess.check_output(
            ["npx", "tsx", "scripts/dump-node-spec.ts"],
            cwd=repo,
            text=True,
        ),
        end="",
    )


if __name__ == "__main__":
    main()
