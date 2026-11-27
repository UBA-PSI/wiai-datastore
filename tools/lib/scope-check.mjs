// The scope check: the public scope document of the app's real scope against what the page says (PLAN 9.6; spec 3.2).
import { getJson, serviceBase, offline } from './targets.mjs';

const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(n % 1048576 ? 1 : 0) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' bytes');

// scopeId: from WDS.connect in the page (or null); baseUrl: the service the page names in WDS.connect({ baseUrl }) (or null: the
// production service). WDS_VERIFY_SERVICE (a test hook) wins over both. Returns findings.
export async function scopeCheck(scopeId, baseUrl) {
  const findings = [];
  const add = (id, level, title, detail) => findings.push({ id, level, title, detail: detail || '' });
  if (!scopeId) { add('scope-settings', 'info', 'Current scope settings', 'Not checked: no WDS.connect({ scope: "..." }) with a literal scope ID found in the page.'); return findings; }
  if (offline()) { add('scope-settings', 'info', 'Current scope settings', 'Scope settings not checked (WDS_VERIFY_OFFLINE is set).'); return findings; }
  const service = process.env.WDS_VERIFY_SERVICE || !baseUrl ? serviceBase() : baseUrl.replace(/\/+$/, '');
  const r = await getJson(service + '/api/v1/scopes/' + encodeURIComponent(scopeId), 4000);
  if (r.error) { add('scope-settings', 'info', 'Current scope settings', 'Scope settings not checked: the service is not reachable (' + r.error + ').'); return findings; }
  if (r.status === 404) { add('scope-unknown', 'fail', 'Scope exists', 'The service does not know the scope "' + scopeId + '". Copy the scope ID from the dashboard of the scope (a typo, or a scope that was never created).'); return findings; }
  if (r.status !== 200 || !r.json) { add('scope-settings', 'info', 'Current scope settings', 'Scope settings not checked: the service answered HTTP ' + r.status + '.'); return findings; }
  const d = r.json, lim = d.limits || {};
  add('scope-settings', 'info', 'Current scope settings', 'Scope ' + scopeId + (d.name ? ' ("' + d.name + '")' : '') + ': limits (1 MB = 1,048,576 bytes): '
    + [lim.max_value_bytes && size(lim.max_value_bytes) + ' per record', lim.vault_bytes && size(lim.vault_bytes) + ' per vault', lim.history_versions && lim.history_versions + ' versions per record'].filter(Boolean).join(', ') + '.');
  if (d.status && d.status !== 'active') add('scope-status', 'warn', 'Scope status', 'The scope "' + scopeId + '" has the status "' + d.status + '"; people cannot use it normally.');
  return findings;
}
