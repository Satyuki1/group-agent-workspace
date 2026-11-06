#!/usr/bin/env python3
"""Fetch exact upstream revisions without overwriting existing local changes."""
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]

def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout.strip()

for name, source in json.loads((ROOT / "upstream-lock.json").read_text()).items():
    target = ROOT / "upstream" / name
    target.mkdir(parents=True, exist_ok=True)
    if not (target / ".git").exists():
        run("git", "init", "-q", str(target))
        run("git", "-C", str(target), "remote", "add", "origin", source["repository"])
    if run("git", "-C", str(target), "status", "--porcelain"):
        raise SystemExit(f"Refusing to overwrite changes: {name}")
    run("git", "-C", str(target), "fetch", "--depth=1", "origin", source["commit"])
    run("git", "-C", str(target), "checkout", "--detach", source["commit"])
    print(f"{name}: {source['commit']}")
