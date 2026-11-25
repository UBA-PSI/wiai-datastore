// The scope check: the public scope document of the app's real scope against what the page says (PLAN 9.6; spec 3.2).
import { getJson, serviceBase, offline } from './targets.mjs';
import { connectAllows } from './static-checks.mjs';

const HIBP = 'https://api.pwnedpasswords.com';
const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(n % 1048576 ? 1 : 0) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' bytes');
const ENROLL = { join_code: 'a join code is needed to create a vault', open: 'anybody with the app can create a vault', closed: 'no new vaults can be created' };

// scopeId: from WDS.connect in the page (or null); csp: the page's policy text (or null); baseUrl: the service the page names in
// WDS.connect({ baseUrl }) (or null: the production service). WDS_VERIFY_SERVICE (a test hook) wins over both. Returns findings.
export async function scopeCheck(scopeId, csp, baseUrl) {
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
  add('scope-settings', 'info', 'Current scope settings', 'Scope ' + scopeId + (d.name ? ' ("' + d.name + '")' : '') + ': enrollment ' + (ENROLL[d.enrollment] || d.enrollment) + '; breach check of passphrases '
    + (d.hibp ? 'on' : 'off') + '; limits: ' + [lim.max_value_bytes && size(lim.max_value_bytes) + ' per record', lim.vault_bytes && size(lim.vault_bytes) + ' per vault', lim.history_versions && lim.history_versions + ' versions per record'].filter(Boolean).join(', ') + '.');
  if (d.status && d.status !== 'active') add('scope-status', 'warn', 'Scope status', 'The scope "' + scopeId + '" has the status "' + d.status + '"; people cannot use it normally.');
  if (csp) {
    const allowed = connectAllows(csp, HIBP);
    if (d.hibp && !allowed) add('scope-hibp', 'fail', 'Breach check and CSP', 'The scope checks new passphrases against ' + HIBP + ' but connect-src of the page does not allow it, so every vault creation shows an error. Add ' + HIBP + ' to connect-src (the recommended policy has it).');
    else if (!d.hibp && allowed) add('scope-hibp', 'warn', 'Breach check and CSP', 'The scope has the breach check switched off, but connect-src of the page still allows ' + HIBP + '. Remove it from connect-src: the page needs no access to that host.');
    else add('scope-hibp', 'pass', 'Breach check and CSP', 'connect-src matches the breach-check setting of the scope (' + (d.hibp ? 'on' : 'off') + ').');
  }
  return findings;
}
