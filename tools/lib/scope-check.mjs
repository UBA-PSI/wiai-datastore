// The scope check: the public scope document of the app's real scope against what the page says (PLAN 9.6; spec 3.2).
import { getJson, serviceBase, offline } from './targets.mjs';
import { connectAllows, hasBreachNote, mentionsBreachService, BREACH_NOTE } from './static-checks.mjs';

const HIBP = 'https://api.pwnedpasswords.com';
const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(n % 1048576 ? 1 : 0) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' bytes');
const ENROLL = { join_code: 'a join code is needed to create a vault', open: 'anybody with the app can create a vault', closed: 'no new vaults can be created' };

// scopeId: from WDS.connect in the page (or null); csp: the page's policy text (or null); baseUrl: the service the page names in
// WDS.connect({ baseUrl }) (or null: the production service). WDS_VERIFY_SERVICE (a test hook) wins over both. Returns findings.
// page: { html, readme } of the app (optional): for the breach-check sentence.
export async function scopeCheck(scopeId, csp, baseUrl, page = null) {
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
    + (d.hibp ? 'on' : 'off') + '; limits (1 MB = 1,048,576 bytes): ' + [lim.max_value_bytes && size(lim.max_value_bytes) + ' per record', lim.vault_bytes && size(lim.vault_bytes) + ' per vault', lim.history_versions && lim.history_versions + ' versions per record'].filter(Boolean).join(', ') + '.');
  if (d.hibp && page && !hasBreachNote(page.html || '', page.readme || '')) add('breach-check-note', 'info', 'Breach check: sentence for the privacy text', 'The scope checks new passphrases against known data breaches (the Pwned Passwords service, USA), but ' + (mentionsBreachService(page.html || '', page.readme || '') ? 'the page or README names the service without the official sentence (the sentence must stand word for word)' : 'neither the page nor the README next to it says so') + '. Wherever the app describes its privacy, add this sentence (English: "' + BREACH_NOTE[0] + '"; German: "' + BREACH_NOTE[1] + '"), right after the official privacy sentence.');
  if (d.status && d.status !== 'active') add('scope-status', 'warn', 'Scope status', 'The scope "' + scopeId + '" has the status "' + d.status + '"; people cannot use it normally.');
  if (csp) {
    const allowed = connectAllows(csp, HIBP);
    if (d.hibp && !allowed) add('scope-hibp', 'fail', 'Breach check and CSP', 'The scope checks new passphrases against ' + HIBP + ' but connect-src of the page does not allow it, so every vault creation shows an error. Use the recommended policy of integration.md, which has it.');
    else add('scope-hibp', 'pass', 'Breach check and CSP', 'connect-src allows the breach-check host, as the one recommended policy does (the scope has the check ' + (d.hibp ? 'on' : 'off') + ').');
  }
  return findings;
}
