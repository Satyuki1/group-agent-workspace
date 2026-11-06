#!/usr/bin/env python3
"""Remote operator command: bounded NVMe WAL; never formats a physical device."""
import argparse, json, pathlib, shutil, subprocess
ROOT=pathlib.Path('/mnt/group-agent')
FAST=pathlib.Path('/var/lib/group-agent')
MOUNT=ROOT/'data/wal-fast'
UNIT=pathlib.Path('/etc/systemd/system/mnt-group\\x2dagent-data-wal\\x2dfast.mount')
IMAGE=FAST/'postgres-wal.img'
COMPOSE=['docker','compose','--env-file',str(ROOT/'secrets/compose.env'),'-f',str(ROOT/'releases/current/deploy/compose.yml')]
def run(*args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def output(*args):return subprocess.check_output(args,text=True).strip()
parser=argparse.ArgumentParser()
parser.add_argument('--initialized-postgres-only',action='store_true',help='Only for first deployment, after compose.initialize.yml initialized PostgreSQL')
args=parser.parse_args()
if not ROOT.is_dir() or output('hostname')=='':raise SystemExit('Use the designated server')
if shutil.disk_usage('/').free<64*1024**3:raise SystemExit('NVMe headroom below 64 GiB')
if IMAGE.exists() or UNIT.exists() or MOUNT.exists():raise SystemExit('Existing WAL setup: inspect/resume manually; refusing overwrite')
for name in ['postgres','relay','webhost']:
    exists=subprocess.run(['docker','inspect','group-agent-'+name+'-1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
    if not exists and args.initialized_postgres_only and name!='postgres':continue
    label=output('docker','inspect','-f','{{index .Config.Labels "com.docker.compose.project"}}','group-agent-'+name+'-1')
    if label!='group-agent':raise SystemExit('Container ownership mismatch')
ledger=output('docker','exec','group-agent-postgres-1','psql','-U','buzz','-d','group_agent','-Atc',"SELECT to_regclass('public.tasks')")
if ledger:
    busy=output('docker','exec','group-agent-postgres-1','psql','-U','buzz','-d','group_agent','-Atc',"SELECT count(*) FROM tasks WHERE status='running'")
    if busy!='0':raise SystemExit('Active tasks: defer WAL migration')
elif not args.initialized_postgres_only:raise SystemExit('Missing task ledger: inspect deployment first')
run(*COMPOSE,'config','--quiet')
FAST.mkdir(mode=0o700,exist_ok=True);MOUNT.mkdir(mode=0o700)
with IMAGE.open('xb') as f:IMAGE.chmod(0o600)
run('fallocate','-l','4G',str(IMAGE))
run('mkfs.ext4','-q','-F','-m','0','-L','group-agent-wal',str(IMAGE))
UNIT.write_text(f'''[Unit]
Description=Group Agent bounded NVMe PostgreSQL WAL
Before=docker.service

[Mount]
What={IMAGE}
Where={MOUNT}
Type=ext4
Options=loop,noatime,nodev,nosuid

[Install]
WantedBy=local-fs.target
''')
run('systemctl','daemon-reload')
run('systemctl','enable','--now',UNIT.name)
run(*COMPOSE,'stop','-t','35','webhost','relay','postgres')
# PostgreSQL is cleanly stopped. Its original WAL stays in place as a migration backup.
run('cp','-a',str(ROOT/'data/postgres/pg_wal'),str(MOUNT/'pg_wal'))
run(*COMPOSE,'up','-d','--no-deps',*(['postgres'] if args.initialized_postgres_only else ['postgres','redis','relay','webhost']))
print(json.dumps({'walVolumeGiB':4,'mountedAt':str(MOUNT),'originalWalRetained':True}))
