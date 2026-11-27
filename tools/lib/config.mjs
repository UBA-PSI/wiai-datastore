// wds-verify.json: the developer's hints for the dynamic run. An object { "locale"?, "steps"?, "afterReload"?, "seed"? }; nothing else.
// seed: { "page": "old-app.html", "steps": [...], "keep"?: [...] } tests the migration of old local data (page: the old local-only app, relative to this file;
// keep: localStorage keys and "database/store" names that the migration legitimately leaves in the old storage; everything else that the old app filled must be gone).
const FORMS = '{"click": selector}, {"fill": [selector, text]}, {"select": [selector, value]}, {"press": [selector, key]}, '
  + '{"upload": [selector]} or {"upload": [selector, path]}, {"download": selector} or {"wait": ms}';
// In the text of a fill step, this becomes a unique generated token (a canary the tool searches for).
export const CANARY_PLACEHOLDER = '{canary}';
export const OBJECT_FORM = '{ "locale": "de-DE", "steps": [ {"click": "#tab"}, {"fill": ["#title", "a unique text"]}, {"click": "#save"} ], "afterReload": [ {"click": "#tab"} ] }';
const KEYS = ['locale', 'steps', 'afterReload', 'seed'];

const str = (x) => typeof x === 'string' && x.length > 0;
function stepOk(s) {
  const keys = s && typeof s === 'object' && !Array.isArray(s) ? Object.keys(s) : [];
  if (keys.length !== 1) return false;
  const k = keys[0], v = s[k];
  switch (k) {
    case 'click': case 'download': return str(v);
    case 'fill': return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'string') && str(v[0]);
    case 'select': return Array.isArray(v) && v.length === 2 && v.every(str);
    case 'press': return Array.isArray(v) && v.length === 2 && v.every(str);
    case 'upload': return Array.isArray(v) && v.length >= 1 && v.length <= 2 && v.every(str);
    case 'wait': return Number.isFinite(v) && v >= 0 && v <= 60000;
    default: return false;
  }
}
function checkList(list, name) {
  if (!Array.isArray(list)) throw new Error('wds-verify.json "' + name + '" must be an array of steps: ' + FORMS);
  list.forEach((s, i) => {
    if (!stepOk(s)) throw new Error('wds-verify.json ' + (name === 'steps' ? '' : name + ' ') + 'step ' + (i + 1) + ' is not one of ' + FORMS + ': ' + JSON.stringify(s));
  });
  return list;
}

function checkSeed(seed) {
  const form = '"seed": { "page": "old-app.html", "steps": [ {"fill": ["#title", "{canary}"]}, {"click": "#save"} ] }';
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) throw new Error('wds-verify.json "seed" must be an object like ' + form);
  for (const k of Object.keys(seed)) if (!['page', 'steps', 'keep'].includes(k)) throw new Error('wds-verify.json "seed" has an unknown key "' + k + '" (allowed: page, steps, keep)');
  if (seed.keep !== undefined && !(Array.isArray(seed.keep) && seed.keep.every(str))) throw new Error('wds-verify.json "seed.keep" must be an array of localStorage keys and "database/store" names that the migration leaves in the old storage on purpose');
  if (!str(seed.page)) throw new Error('wds-verify.json "seed.page" must be the path of the old app\'s HTML file, relative to wds-verify.json: ' + form);
  if (seed.steps === undefined) throw new Error('wds-verify.json "seed.steps" is missing: the steps put values into the old app (at least one fill or upload step) ' + form);
  const steps = checkList(seed.steps, 'seed.steps');
  if (!steps.some((s) => s.fill || s.upload)) throw new Error('wds-verify.json "seed.steps" needs at least one fill or upload step: they create the values that the tool looks for after the migration');
  return { page: seed.page, steps, ...(seed.keep ? { keep: seed.keep } : {}) };
}

// Parse and validate. Returns { locale: string|null, steps: [], afterReload: [], seed: {page, steps}|null }; throws Error with a message for the developer.
export function parseConfig(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error('wds-verify.json is not valid JSON: ' + e.message); }
  if (Array.isArray(doc)) throw new Error('wds-verify.json must be an object, not a bare array. Write ' + OBJECT_FORM.replace(/^\{ "locale": "de-DE", /, '{ ') + ' (the steps go under "steps")');
  if (!doc || typeof doc !== 'object') throw new Error('wds-verify.json must be an object like ' + OBJECT_FORM);
  for (const k of Object.keys(doc)) if (!KEYS.includes(k)) throw new Error('wds-verify.json has an unknown key "' + k + '" (allowed: ' + KEYS.join(', ') + ')');
  let locale = null;
  if (doc.locale !== undefined) {
    try { locale = typeof doc.locale === 'string' ? Intl.getCanonicalLocales(doc.locale)[0] : null; } catch (e) { locale = null; }
    if (!locale) throw new Error('wds-verify.json "locale" must be a BCP 47 language tag such as "de-DE" or "en-US", got ' + JSON.stringify(doc.locale));
  }
  return { locale, steps: doc.steps === undefined ? [] : checkList(doc.steps, 'steps'), afterReload: doc.afterReload === undefined ? [] : checkList(doc.afterReload, 'afterReload'),
    seed: doc.seed === undefined ? null : checkSeed(doc.seed) };
}
