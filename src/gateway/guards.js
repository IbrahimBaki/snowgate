// URL guards for the gateway's browser (PLAN §15 A2, D2/D3).
//
// The lock is token-based over the fully decoded URL (and request body), not a
// path match on the top-level page. That covers, without knowing every route:
//   - classic UI records in the gsft_main iframe (every frame request is seen);
//   - Next Experience wrappers: /now/nav/ui/classic/params/target/<encoded>;
//   - nav_to.do?uri=<encoded>, sysparm_referring_url / sysparm_target params;
//   - GlideAjax processors posted to xmlhttp.do (UpdateSet* processors);
//   - the Table API reached from the browser session.
//
// The exact ServiceNow processor names are hypotheses until observed on a
// confirmed instance; the token list errs on the side of locking.
export const LOCKED_TOKENS = [
  'sys_remote_update_set',
  'sys_update_set',
  'sys_update_preview',
  'sys_update_xml',
  'sys_upgrade_history',
  'update_set',
  'updateset',
  'upload.do',
];

// Repeatedly URI-decode (bounded) so double-encoded targets are visible.
export function deepDecode(value, rounds = 4) {
  let current = String(value ?? '');
  for (let i = 0; i < rounds; i += 1) {
    let next;
    try {
      next = decodeURIComponent(current.replace(/\+/g, ' '));
    } catch {
      break;
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

export function lockedToken(...parts) {
  const text = parts.map((p) => deepDecode(p).toLowerCase()).join('\n');
  return LOCKED_TOKENS.find((t) => text.includes(t)) ?? null;
}

// Requests the browser may make: same origin as the confirmed target only.
// Browser-internal schemes carry no network request to another host.
const INTERNAL = /^(about|data|blob):/i;

export function classifyRequest(url, { origin, body = '' } = {}) {
  if (INTERNAL.test(url)) return { allowed: true };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'unparseable URL' };
  }
  if (parsed.origin !== origin) return { allowed: false, reason: `off-target origin ${parsed.origin}`, code: 'HOST_LOCKED' };
  const token = lockedToken(parsed.pathname + parsed.search, body);
  if (token) return { allowed: false, reason: `locked update-set surface (${token})`, code: 'URL_LOCKED' };
  return { allowed: true };
}

// A path or URL the agent asked to open: resolved against the target origin.
export function resolveTargetUrl(input, origin) {
  if (typeof input !== 'string' || !input.trim()) return null;
  try {
    return new URL(input.trim(), `${origin}/`).toString();
  } catch {
    return null;
  }
}
