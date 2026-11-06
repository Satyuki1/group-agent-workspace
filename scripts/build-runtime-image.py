#!/usr/bin/env python3
"""Build the project-only runtime with its real Unix account; no dependency download."""
import pathlib, subprocess, hashlib, os

root = pathlib.Path('/mnt/group-agent')
if not root.is_dir(): raise SystemExit('Run on the designated server')
dockerfile = root/'releases/current/deploy/Dockerfile.runtime'
version = hashlib.sha256(dockerfile.read_bytes()).hexdigest()[:16]
tag = 'group-agent-runtime:' + version
subprocess.run(['docker','build','--network=none','-f',str(dockerfile),'-t',tag,str(dockerfile.parent)],check=True)
image = subprocess.check_output(['docker','image','inspect',tag,'--format','{{.Id}}'],text=True).strip()
destination = root/'data/host/runtime-image-id'
destination.write_text(image+'\n'); destination.chmod(0o644)
print('Pinned project runtime image built with the existing 996:995 account')
