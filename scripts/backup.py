#!/usr/bin/env python3
"""Encrypted remote backups. Brief project-only maintenance, never host shutdown."""
import datetime,json,os,pathlib,shutil,subprocess,tempfile,sys
from cryptography.hazmat.primitives.ciphers import Cipher,algorithms,modes
ROOT=pathlib.Path('/mnt/group-agent')
KEY=pathlib.Path('/var/lib/group-agent/backup.key')
STATE=KEY.parent/'backup-state.json'
MAGIC=b'GROUP-AGENT-BACKUP-1\n'
def run(*args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def output(*args):return subprocess.check_output(args,text=True).strip()
def sql(statement):return output('docker','exec','group-agent-postgres-1','psql','-U','buzz','-d','group_agent','-v','ON_ERROR_STOP=1','-Atc',statement)
def save_state(stopped,paused):
    temporary=STATE.with_suffix('.tmp');temporary.write_text(json.dumps({'stopped':stopped,'paused':paused}));temporary.chmod(0o600);temporary.replace(STATE)
def recover():
    if not STATE.exists():return
    state=json.loads(STATE.read_text());failures=[]
    for name in state['paused']:
        if not name.startswith('ga-space-'):raise RuntimeError('Invalid recovery container')
        if output('docker','inspect','-f','{{.State.Paused}}',name)=='true':
            result=subprocess.run(['docker','unpause',name],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            if result.returncode:failures.append(name)
    for name in reversed(state['stopped']):
        if name not in ['group-agent-webhost-1','group-agent-relay-1']:raise RuntimeError('Invalid recovery service')
        result=subprocess.run(['docker','start',name],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        if result.returncode:failures.append(name)
    sql("UPDATE settings SET value='false'::jsonb,updated_at=now() WHERE key='ops.backup'")
    if failures:raise RuntimeError('Project service recovery incomplete: '+','.join(failures))
    STATE.unlink()
def encrypt_archive(target,paths,key):
    nonce=os.urandom(12);cipher=Cipher(algorithms.AES(key),modes.GCM(nonce)).encryptor();cipher.authenticate_additional_data(MAGIC)
    command=['tar','-C',str(ROOT),'-czf','-',*paths]
    process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        with target.open('xb') as stream:
            target.chmod(0o600);stream.write(MAGIC+nonce)
            while chunk:=process.stdout.read(1024*1024):stream.write(cipher.update(chunk))
            stream.write(cipher.finalize());stream.write(cipher.tag);stream.flush();os.fsync(stream.fileno())
        if process.wait()!=0:raise RuntimeError('Archive creation failed; inspect project backup journal')
    finally:process.stdout.close();process.stderr.close()
def main():
    if not ROOT.is_dir():raise SystemExit('Run on the designated server')
    recover()
    KEY.parent.mkdir(mode=0o700,exist_ok=True)
    if not KEY.exists():
        with KEY.open('xb') as file:KEY.chmod(0o600);file.write(os.urandom(32))
    key=KEY.read_bytes()
    if len(key)!=32:raise RuntimeError('Invalid backup key')
    backups=ROOT/'backups';backups.mkdir(mode=0o700,exist_ok=True)
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    stage=pathlib.Path(tempfile.mkdtemp(prefix='.stage-',dir=backups));stopped=[];paused=[];files=[]
    try:
        save_state(stopped,paused)
        sql("BEGIN; SELECT pg_advisory_xact_lock(71241107); INSERT INTO settings(key,value) VALUES('ops.backup','true'::jsonb) ON CONFLICT(key) DO UPDATE SET value='true'::jsonb; COMMIT;")
        if sql("SELECT count(*) FROM tasks WHERE status='running'")!='0':raise SystemExit(75)
        for name in ['group-agent-webhost-1','group-agent-relay-1']:
            if output('docker','inspect','-f','{{.State.Running}}',name)=='true':
                stopped.append(name);save_state(stopped,paused);run('docker','stop','-t','35',name,stdout=subprocess.DEVNULL)
        runtimes=output('docker','ps','--filter','label=com.group-agent.managed=true','--format','{{.Names}}').splitlines()
        for name in runtimes:
            if name.startswith('ga-space-') and output('docker','inspect','-f','{{.State.Paused}}',name)=='false':
                paused.append(name);save_state(stopped,paused);run('docker','pause',name,stdout=subprocess.DEVNULL)
        for database in ['buzz','group_agent']:
            with (stage/(database+'.dump')).open('wb') as stream:
                run('docker','exec','group-agent-postgres-1','pg_dump','-U','buzz','-Fc',database,stdout=stream,stderr=subprocess.PIPE)
        data=backups/(stamp+'.data.gab');secrets=backups/(stamp+'.secrets.gab')
        for target,paths in [(data,[str(stage.relative_to(ROOT)),'spaces','data/objects','data/host']),
                             (secrets,['secrets','data/caddy/caddy/pki'])]:
            files.append(target);encrypt_archive(target,paths,key)
        manifest={'createdAt':stamp,'databases':['buzz','group_agent'],'stage':str(stage.relative_to(ROOT)),
                  'archives':[f.name for f in files],'encryption':'AES-256-GCM','keyLocation':str(KEY)}
        (backups/(stamp+'.json')).write_text(json.dumps(manifest,indent=2))
        # Remove only complete backups created by this script. Never business data.
        manifests=sorted(backups.glob('*.json'))
        for old in manifests[:-7]:
            value=json.loads(old.read_text())
            for filename in value.get('archives',[]):
                if pathlib.Path(filename).name==filename and filename.endswith('.gab'):(backups/filename).unlink(missing_ok=True)
            old.unlink()
        print(json.dumps({'backup':stamp,'archives':len(files),'encryptedBytes':sum(f.stat().st_size for f in files)}))
    except BaseException:
        for file in files:file.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(stage)
        recover()
if __name__=='__main__':recover() if '--recover' in sys.argv else main()
