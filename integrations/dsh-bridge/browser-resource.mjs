/** A published browser resource is a URL, never executable code or credentials. */
export function browserResource(value) {
  let args;
  try { args = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { return; }
  if (typeof args?.url !== 'string' || args.url.length > 4096) return;
  try {
    const url = new URL(args.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) return;
    return {kind: 'browser', url: url.href};
  } catch { return; }
}
