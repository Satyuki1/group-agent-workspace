"""Publish the additive Agent Host change without restarting native workspaces."""
import pathlib, subprocess, datetime, shutil, time
root=pathlib.Path('/mnt/group-agent/releases/current')
def run(*args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def sql(query):return subprocess.check_output(['docker','exec','group-agent-postgres-1','psql','-U','buzz','-d','group_agent','-Atv','ON_ERROR_STOP=1','-c',query],text=True).strip()
source=root/'apps/server/src/agent-host.next.mjs';target=source.with_name('agent-host.mjs')
if not source.is_file():raise SystemExit('Staged Agent Host missing')
backup=pathlib.Path('/mnt/group-agent/backups')/('agent-handoff-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
backup.mkdir(mode=0o700);shutil.copy2(target,backup/'agent-host.mjs')
switched=False
sql("BEGIN; SELECT pg_advisory_xact_lock(71241107); INSERT INTO settings(key,value) VALUES('ops.backup','true'::jsonb) ON CONFLICT(key) DO UPDATE SET value='true'::jsonb; COMMIT;")
try:
 if sql("SELECT count(*) FROM tasks WHERE status='running'")!='0':raise SystemExit('Running work: retry deployment after tasks finish')
 source.replace(target);switched=True
 run('docker','restart','group-agent-webhost-1',stdout=subprocess.DEVNULL)
 for attempt in range(30):
  check=subprocess.run(['docker','exec','group-agent-webhost-1','node','-e','fetch("http://127.0.0.1:3001/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  if check.returncode==0:break
  time.sleep(1)
 else:raise RuntimeError('Updated host did not become healthy')
 print('Published Agent handoffs; native workspaces and existing data unchanged')
except BaseException:
 if switched:
  shutil.copy2(backup/'agent-host.mjs',target)
  run('docker','restart','group-agent-webhost-1',stdout=subprocess.DEVNULL)
 raise
finally:sql("UPDATE settings SET value='false'::jsonb,updated_at=now() WHERE key='ops.backup'")
