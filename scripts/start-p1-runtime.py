#!/usr/bin/env python3
"""Remote-only operator provisioning; no Docker socket enters application containers."""
import json, os, pathlib, subprocess, sys, re

ROOT = pathlib.Path('/mnt/group-agent')
if not ROOT.is_dir(): raise SystemExit('Run on the designated server')
record=os.environ.get('PROVISION_RECORD','p1-provision.json')
if record=='-':
    plan=json.load(sys.stdin)
    import uuid
    if str(uuid.UUID(plan['spaceId']))!=plan['spaceId']:raise SystemExit('Invalid space identity')
    if plan.get('sessionId') is not None and str(uuid.UUID(plan['sessionId']))!=plan['sessionId']:raise SystemExit('Invalid session identity')
    if not isinstance(plan['publicKey'],str) or not plan['publicKey'].startswith('-----BEGIN PUBLIC KEY-----'):raise SystemExit('Invalid public key')
    if not isinstance(plan['token'],str) or not plan['token'].isalnum() and not all(c.isalnum() or c in '_-' for c in plan['token']):raise SystemExit('Invalid token')
    models=plan['models']
    if not models or not all(isinstance(x,str) and 0<len(x)<100 for x in models):raise SystemExit('Invalid models')
    containers=subprocess.check_output(['docker','ps','-a','--filter','label=com.group-agent.managed=true','--format','{{.Names}}']).decode().splitlines()
    if 'ga-space-'+plan['spaceId'] not in containers and len([x for x in containers if re.fullmatch(r'ga-space-[0-9a-f-]{36}',x)])>=6:raise SystemExit('Runtime capacity reached')
else:
    if record not in ['p1-provision.json','p1-private.json']:raise SystemExit('Unknown provisioning record')
    plan = json.loads((ROOT/'data/host'/record).read_text())
    models = json.loads((ROOT/'data/host/p1-models.json').read_text())['models']
space = ROOT/'spaces'/plan['spaceId']
space.mkdir(mode=0o750, exist_ok=True)
for child in ['home', 'work', 'config']:
    path=space/child; path.mkdir(mode=0o750,exist_ok=True);os.chown(path,996,995)
public = space/'config/bridge.pub'; public.write_text(plan['publicKey']);public.chmod(0o644)
runtime_env=space/'config/runtime.env'
runtime_env.write_text('\n'.join([
    'DSH_HOME=/home/dsh/.dsh', 'HOME=/home/dsh',
    'DSH_DISABLE_TELEMETRY=1', 'GROUP_AGENT_SPACE_ID='+plan['spaceId'],
    'GROUP_AGENT_WORKSPACE=/work', 'GROUP_AGENT_BRIDGE_PUBLIC_KEY_FILE=/run/space/bridge.pub',
    'DEEPSEEK_API_KEY='+plan['token'], 'DEEPSEEK_BASE_URL=http://webhost:3301/anthropic',
])+'\n'); runtime_env.chmod(0o600)
patch=[
    {'id':'client-hmr','disabled':True},
    {'id':'ui-open-in-app','disabled':True},
    {'id':'cordis-client-runner','disabled':True},
    {'id':'ui-cordis','disabled':True},
    {'id':'web-runtime','config':{'openBrowser':False,'printUrl':False,'surfaceContext':False}},
    {'id':'llm-deepseek','config':{'baseURL':'http://webhost:3301/anthropic','apiKeyEnv':'DEEPSEEK_API_KEY','models':[{'id':x} for x in models],'maxTokens':8192,'reasoningEffort':'low'}},
    {'id':'ui-sidebar-browser','disabled':False},
    {'id':'agent-preset-registry','config':{'default':'group-collaborator'}},
    {'insert':[
        {'id':'preset-group-collaborator','name':'@deepseek-ai/dsh-agent-preset','config':{
            'id':'group-collaborator','name':'群协作助手','plugins':[
                {'id':'persona','name':'@deepseek-ai/dsh-persona','config':{'prefix':'你是工作群里的协作助手。使用当前群授权的资料，完成明确的群内任务，并用中文给出简洁结果。'}},
                {'id':'tool-fs','name':'@deepseek-ai/dsh-tool-fs','config':{'applyPatch':False}},
                {'id':'time-context','name':'@deepseek-ai/dsh-time-context'},
                {'id':'group-workspace-tools','name':'/workspace/integrations/dsh-bridge/workspace-tools.mjs'},
            ]}},
        {'id':'group-agent-bridge','name':'/workspace/integrations/dsh-bridge/index.mjs','config':{'port':3200}}
    ]},
]
patchfile=space/'config/cordis.patch.yml';patchfile.write_text(json.dumps(patch,ensure_ascii=False,indent=2));patchfile.chmod(0o644)
def run(*args, **kwargs): return subprocess.run(args,check=True,**kwargs)
network='group-agent-spaces'
if subprocess.run(['docker','network','inspect',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
    run('docker','network','create','--internal','--subnet','10.253.77.0/24','--label','com.group-agent.managed=true',network,stdout=subprocess.DEVNULL)
attached=json.loads(subprocess.check_output(['docker','inspect','group-agent-webhost-1']))[0]['NetworkSettings']['Networks']
if network not in attached: run('docker','network','connect','--alias','webhost',network,'group-agent-webhost-1')
name='ga-space-'+plan['spaceId']
exists=subprocess.run(['docker','inspect',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
if exists:
    run('docker','start',name,stdout=subprocess.DEVNULL)
else:
    run('docker','run','-d','--name',name,'--label','com.group-agent.managed=true',
        '--network',network,'--restart','unless-stopped','--user','996:995',
        '--cpus','1','--memory','1536m','--pids-limit','128','--read-only',
        '--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,nosuid,exec,size=128m',
        '--log-opt','max-size=20m','--log-opt','max-file=3',
        '--env-file',str(runtime_env),'-w','/work',
        '-v',str(ROOT/'releases/current')+':/workspace:ro',
        '-v',str(space/'home')+':/home/dsh', '-v',str(space/'work')+':/work',
        '-v',str(space/'config')+':/run/space:ro',
        (ROOT/'data/host/runtime-image-id').read_text().strip(),
        'node','/workspace/upstream/deepseek-harness/apps/cli/lib/bin.js',
        '--profile','web','--patch','/run/space/cordis.patch.yml','--no-open',stdout=subprocess.DEVNULL)
print(json.dumps({'started':name,'network':network,'memoryMiB':1536}))
