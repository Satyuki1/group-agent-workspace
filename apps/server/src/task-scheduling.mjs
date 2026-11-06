/** Cancellation is bounded control work and must not wait for model capacity. */
export function selectDispatchTasks(rows,jobs) {
  const active=[...jobs.values()];
  let capacity=3-active.filter(job=>!job.stopOnly).length;
  let slow=2-active.filter(job=>!job.stopOnly && job.lane==='slow').length;
  let stops=1-active.filter(job=>job.stopOnly).length;
  const chosen=[],bindings=new Set();
  for(const row of rows) {
    if(jobs.has(row.id) || bindings.has(row.session_binding_id))continue;
    if(row.cancel_requested){if(stops<=0)continue;stops--;}
    else {if(capacity<=0 || (row.lane==='slow' && slow<=0))continue;capacity--;if(row.lane==='slow')slow--;}
    chosen.push(row);bindings.add(row.session_binding_id);
  }
  return chosen;
}
