#!/usr/bin/env python3
"""Bounded host-side provisioner. No Docker socket is mounted into Web Host."""
import json, pathlib, subprocess, time, os

ROOT=pathlib.Path('/mnt/group-agent/releases/current')
if not ROOT.is_dir(): raise SystemExit('Run on the designated server')
COMMAND=['docker','exec','-w','/workspace','group-agent-webhost-1','node','--import','tsx','scripts/runtime-job.mjs']
def job(*args):
    return subprocess.run([*COMMAND,*args],capture_output=True,text=True,check=True,timeout=45).stdout

while True:
    plan=None
    try:
        plan=json.loads(job('next'))
        if plan:
            if plan['state']=='starting':
                subprocess.run(['python3',str(ROOT/'scripts/start-p1-runtime.py')],input=json.dumps(plan),text=True,
                    env={**os.environ,'PROVISION_RECORD':'-'},capture_output=True,check=True,timeout=45)
            initialized=False
            for _ in range(20):
                try: job('initialize',plan['spaceId']); initialized=True; break
                except subprocess.SubprocessError: time.sleep(2)
            if not initialized: raise RuntimeError('Runtime initialization failed')
            print(json.dumps({'ready':plan['spaceId']}),flush=True)
    except Exception as error:
        # Captured command output can contain internal credentials. Never log it.
        print(json.dumps({'error':type(error).__name__,'space':plan.get('spaceId') if plan else None}),flush=True)
        if plan:
            try: job('fail',plan['spaceId'])
            except subprocess.SubprocessError: pass
    time.sleep(3)
