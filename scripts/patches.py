#!/usr/bin/env python3
"""Export/reapply the integration without committing vendored upstream source."""
import argparse,json,pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[1]
mode=argparse.ArgumentParser();mode.add_argument('action',choices=['export','apply']);args=mode.parse_args()
for name,source in json.loads((ROOT/'upstream-lock.json').read_text()).items():
    repo=ROOT/'upstream'/name;patch=ROOT/'patches'/(name+'.patch')
    def git(*argv,check=True):return subprocess.run(['git','-C',str(repo),*argv],check=check,capture_output=True)
    if git('rev-parse','HEAD').stdout.decode().strip()!=source['commit']:raise SystemExit(f'{name}: unexpected base revision')
    if args.action=='export':
        data=git('diff','--binary','HEAD').stdout
        for entry in git('ls-files','--others','--exclude-standard','-z').stdout.split(b'\0'):
            if not entry:continue
            path=entry.decode()
            pwa_assets={'public/team.webmanifest','public/team-sw.js','public/pwa/icon-192.png','public/pwa/icon-512.png'}
            if pathlib.Path(path).suffix not in ['.ts','.mts','.tsx','.css','.md','.json','.yml','.yaml','.mjs','.svg'] and not (name=='buzz-app' and path in pwa_assets):raise SystemExit(f'Review untracked upstream file before exporting: {name}/{path}')
            result=subprocess.run(['git','diff','--no-index','--binary','/dev/null',path],cwd=repo,capture_output=True)
            if result.returncode not in [0,1]:raise SystemExit(result.stderr.decode())
            data+=result.stdout
        patch.parent.mkdir(exist_ok=True);patch.write_bytes(data)
        print(f'{name}: exported {len(data)} bytes')
    elif patch.exists() and patch.stat().st_size:
        if git('apply','--reverse','--check',str(patch),check=False).returncode==0:print(f'{name}: already applied');continue
        git('apply','--check',str(patch));git('apply',str(patch));print(f'{name}: applied')
