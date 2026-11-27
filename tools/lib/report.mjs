// The report of wds-verify: the Markdown text and the "Not tested" lines.
import { basename } from 'node:path';
import { UsageError } from './targets.mjs';

const ICON = { pass: 'pass', fail: '**FAIL**', warn: 'warn', info: 'info' };

// What this run cannot know: one line each, phrased as what the developer's Claude has to try by hand.
export function notTested({ info = {}, config = {}, html = '', target = {} }) {
  const out = [];
  if (target.name === 'static') out.push('Everything the dynamic part checks was not run (no browser): the canary search in requests and storage, saving, and the reload. Run wds-verify without --static-only (or with --target sandbox) before you finish.');
  out.push('A second device and conflicts: open the app in two browsers with the same vault, change the same record in both, and look at what a person sees (the conflict dialog or your onConflict handler; no entry may get lost).');
  out.push('A read-only member: invite a member with the role "read" (store.openVault()), and check that every control that writes is hidden or disabled for them and that no error shows.');
  const unpressed = info.unpressed && info.unpressed.length ? ' This run saw: ' + info.unpressed.map((t) => '"' + t + '"').join(', ') + '.' : '';
  out.push('Buttons the tool does not press: delete, export, download, import, lock, and everything that the save word list, data-wds-verify="save" or a click step does not match. Press each by hand.' + unpressed);
  if (info.fileInputs && !(info.stepCount && info.stepCount.upload)) out.push('File inputs (' + info.fileInputs + ') without an upload step were not used: add {"upload": [selector]} steps, or try the upload by hand.');
  if (!info.stepCount || info.hiddenFields) out.push('Fields in views no step opens (tabs, panels, dialogs of the app)' + (info.hiddenFields ? ': ' + info.hiddenFields + ' hidden field(s) were seen but not filled' : '') + '. Fill them by hand, or add steps (click the tab, fill the field, click save) and afterReload steps.');
  if (config.seed) out.push('The old data is found only when the new app is opened from the same origin as the old one (Chromium: any file:// page shares storage with any other; Firefox and Safari: only the same file, so the new file needs the same name in the same folder). The tool opens both in one Chromium and cannot show this. The sandbox never deletes old data: the deletion is covered by the library\'s own tests.');
  else if (/migrat|oldData|old data/i.test(html)) out.push('The migration of old local data was not tested: the page mentions a migration, but wds-verify.json has no "seed" (porting.md, section 5).');
  if ((info.appDialogs || /<dialog\b|role\s*=\s*["']dialog|aria-modal/i.test(html)) && !(config.steps && config.steps.length)) out.push('The app has dialogs of its own and wds-verify.json has no steps for them: the tool finds no stable selectors in them. Add steps that open them and fill their fields, or test them by hand.');
  return out;
}

// With --strict a warning counts as a failure and is shown as one (under "Failures", marked "(warn, fails with --strict)").
export function headingLevel(flag) {
  if (flag === undefined) return 1;
  const n = typeof flag === 'string' && /^\d+$/.test(flag) ? Number(flag) : NaN;
  if (!(n >= 1 && n <= 5)) throw new UsageError('--heading-level needs a number from 1 to 5 (the title gets that many #, its sections one more), not "' + flag + '"');
  return n;
}

export function renderReport({ appPath, findings, info, strict, target, notTestedLines, headingLevel: level = 1 }) {
  const h = (depth) => '#'.repeat(level + depth) + ' ';   // depth 0: the title, 1: its sections
  const failed = findings.filter((f) => f.level === 'fail' || (strict && f.level === 'warn'));
  const warned = strict ? [] : findings.filter((f) => f.level === 'warn');
  const mark = (f) => (strict && f.level === 'warn' ? '**FAIL** (warn, fails with --strict)' : ICON[f.level]);
  const out = [];
  out.push(h(0) + 'wds-verify report: ' + basename(appPath), '');
  if (target) out.push('Target: **' + target.name + '** (' + target.reason + ')', '');
  const unavailable = info && info.unavailable;
  out.push('**Result: ' + (unavailable ? 'NOT RUN, sandbox unavailable' : failed.length ? 'FAILED' : 'passed') + '** (' + findings.filter((f) => f.level === 'pass').length + ' checks passed, ' + failed.length + ' failed, '
    + warned.length + ' warning' + (warned.length === 1 ? '' : 's') + ')', '');
  out.push('This is a smoke test, not a proof. It catches the usual mistakes (plaintext in storage or requests, wrong script tag, wide CSP); it cannot see what it did not trigger.', '');
  const section = (title, items) => {
    if (!items.length) return;
    out.push(h(1) + title, '');
    for (const f of items) {
      out.push('- **' + f.title + '** (' + mark(f) + ')' + (f.detail ? ': ' + f.detail.split('\n')[0] : ''));
      f.detail.split('\n').slice(1).forEach((l) => out.push('  ' + l));
    }
    out.push('');
  };
  section('Failures', failed);
  section('Warnings', warned);
  out.push(h(1) + 'All checks', '', '| Check | Result | Details |', '|---|---|---|');
  for (const f of findings) out.push('| ' + f.title + ' | ' + mark(f) + ' | ' + f.detail.replace(/\|/g, '\\|').replace(/\n/g, '<br>').slice(0, 300) + ' |');
  out.push('');
  if (info && info.durationMs) out.push('Dynamic run: ' + (info.durationMs / 1000).toFixed(1) + ' s, ' + (info.fields || 0) + ' canary field(s), ' + (info.recordWrites || 0) + ' record write(s).', '');
  if (notTestedLines) {
    out.push(h(1) + 'Not tested', '', 'This run cannot see the following. Test each by hand before you hand the app over:', '');
    for (const l of notTestedLines) out.push('- ' + l);
    out.push('');
  }
  return out.join('\n');
}

