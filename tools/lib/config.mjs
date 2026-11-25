// wds-verify.json: the developer's hints for the dynamic run. An object { "locale"?, "steps"?, "afterReload"? }; nothing else.
const FORMS = '{"click": selector}, {"fill": [selector, text]}, {"select": [selector, value]}, {"press": [selector, key]}, '
  + '{"upload": [selector]} or {"upload": [selector, path]}, {"download": selector} or {"wait": ms}';
export const OBJECT_FORM = '{ "locale": "de-DE", "steps": [ {"click": "#tab"}, {"fill": ["#title", "a unique text"]}, {"click": "#save"} ], "afterReload": [ {"click": "#tab"} ] }';
const KEYS = ['locale', 'steps', 'afterReload'];

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

// Parse and validate. Returns { locale: string|null, steps: [], afterReload: [] }; throws Error with a message for the developer.
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
  return { locale, steps: doc.steps === undefined ? [] : checkList(doc.steps, 'steps'), afterReload: doc.afterReload === undefined ? [] : checkList(doc.afterReload, 'afterReload') };
}
