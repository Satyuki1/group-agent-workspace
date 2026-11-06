#!/usr/bin/env python3
"""Restore the newest encrypted backup into disposable, isolated test targets."""
import hashlib,json,os,pathlib,shutil,subprocess,tarfile,tempfile,uuid
from cryptography.hazmat.primitives.ciphers import Cipher,algorithms,modes
from backup import ROOT,KEY,MAGIC
def decrypt(source,destination,key):
    with source.open('rb') as stream:
        if stream.read(len(MAGIC))!=MAGIC:raise RuntimeError('Invalid backup header')
        nonce=stream.read(12);stream.seek(-16,os.SEEK_END);tag=stream.read(16);stream.seek(len(MAGIC)+12)
        remaining=source.stat().st_size-len(MAGIC)-28
        cipher=Cipher(algorithms.AES(key),modes.GCM(nonce,tag)).decryptor();cipher.authenticate_additional_data(MAGIC)
        with destination.open('xb') as output:
            destination.chmod(0o600)
            while remaining:
                chunk=stream.read(min(1024*1024,remaining))
                if not chunk:raise RuntimeError('Truncated backup')
                remaining-=len(chunk);output.write(cipher.update(chunk))
            output.write(cipher.finalize())
def extract(source,destination):
    links=[]
    with tarfile.open(source,'r:gz') as archive:
        for member in archive:
            path=pathlib.PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts:raise RuntimeError('Unsafe archive path')
            target=destination/path
            if member.isdir():target.mkdir(parents=True,exist_ok=True,mode=0o700)
            elif member.isfile():
                target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
                with archive.extractfile(member) as incoming,target.open('xb') as output:shutil.copyfileobj(incoming,output)
                target.chmod(0o600)
            elif member.issym() or member.islnk():links.append((member,target))
            else:raise RuntimeError('Unsupported archive node')
    # Resolve links only after every regular file exists. No extraction traverses one.
    for member,target in links:
        relative=pathlib.Path(member.linkname)
        resolved=(target.parent/relative).resolve() if member.issym() else (destination/relative).resolve()
        if relative.is_absolute() or not resolved.is_relative_to(destination):raise RuntimeError('Unsafe archive link')
        if member.issym():target.symlink_to(relative)
        else:os.link(resolved,target)
def command(*args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def query(database,sql):return subprocess.check_output(['docker','exec','group-agent-postgres-1','psql','-U','buzz','-d',database,'-Atc',sql],text=True).strip()
def main():
    manifest_path=sorted((ROOT/'backups').glob('*.json'))[-1];manifest=json.loads(manifest_path.read_text())
    temporary=pathlib.Path(tempfile.mkdtemp(prefix='.restore-',dir=ROOT/'backups'));created=[]
    try:
        archive=temporary/'data.tar.gz';decrypt(ROOT/'backups'/manifest['archives'][0],archive,KEY.read_bytes())
        restored=temporary/'files';restored.mkdir(mode=0o700);extract(archive,restored)
        counts={}
        for database in manifest['databases']:
            name='ga_restore_'+uuid.uuid4().hex[:16]
            command('docker','exec','group-agent-postgres-1','createdb','-U','buzz',name,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE);created.append(name)
            with (restored/manifest['stage']/(database+'.dump')).open('rb') as stream:
                command('docker','exec','-i','group-agent-postgres-1','pg_restore','-U','buzz','--no-owner','--no-acl','-d',name,stdin=stream,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            counts[database]=int(query(name,"SELECT count(*) FROM pg_tables WHERE schemaname='public'"))
            if counts[database]<5:raise RuntimeError('Restored schema unexpectedly empty')
            if database=='group_agent':
                if int(query(name,'SELECT count(*) FROM users'))<3:raise RuntimeError('Restored users missing')
                query(name,"UPDATE settings SET value='false'::jsonb WHERE key='ops.backup'")
        p=json.loads((ROOT/'data/host/p1-provision.json').read_text())
        relative=pathlib.Path('spaces')/p['spaceId']/'work/p1-from-chat.md'
        hashfile=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
        if hashfile(ROOT/relative)!=hashfile(restored/relative):raise RuntimeError('Workspace artifact differs from the backup')
        # Authenticate the separately encrypted key archive without exposing it.
        decrypt(ROOT/'backups'/manifest['archives'][1],temporary/'secrets.tar.gz',KEY.read_bytes())
        print(json.dumps({'backup':manifest['createdAt'],'restoredPublicTables':counts,'sharedArtifactVerified':True,'separateSecretsArchiveVerified':True}))
    finally:
        for name in created:command('docker','exec','group-agent-postgres-1','dropdb','-U','buzz',name,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        shutil.rmtree(temporary)
if __name__=='__main__':main()
