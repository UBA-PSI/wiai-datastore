/*!
 * wds-ui.js - WIAI Datastore: dialogs and the high-level WDS.connect() API on top of wds-core.js.
 *
 * Loaded after wds-core.js (the build concatenates hash-wasm, wds-core.js and this file into one script). In Node the
 * module exports the pure helpers only (passphrase rules, ZIP writer, texts) for the unit tests.
 *
 * App code uses:
 *   const store = WDS.connect({ scope, baseUrl?, locale?, notify?, watch?, label? });
 *   await store.unlock();                         // dialog: create vault / unlock / redeem invite / key file
 *   store.onLock(fn(reason)) / store.onUnlock(fn(status))    // register once, outside start(); reasons: user, revoked, expired
 *   await store.get(name, {fresh?}) / getMany(names, {concurrency, fresh}) / set(name, value, {mime?}) / list(prefix) / getBlob(name)
 *   await store.remove(name)                      // -> {name, deleted, resolution: deleted|absent|mine|theirs, value?}
 *   store.autosave(name, () => state, { delayMs, onStatus, onError, onReplaced })   // -> {changed(), flush(), stop(), status, error, stopReason, name}
 *   const notes = store.collection("notes/", { meta?, index? })   // load, refresh, items, has, get, getAll, add(value, {id, meta, mime, created}), set(id, value, {meta, mime, created}), remove, autosave, flush, rebuild, onChange
 *   store.onConflict(c => c.keepMine() | c.keepTheirs() | c.merge(fn) | await c.ask())   // global
 *   store.onConflict("notes/", handler) / store.onConflict("settings", handler)           // prefix or exact name -> unsubscribe
 *   await store.history(name) / restore(name, version) / showHistory(name, { title })
 *   await store.share(); await store.exportAll(); store.lock(); store.status() (with sandbox: boolean)
 * Typed errors: WDS.errors.{ConflictError, OfflineError, QuotaError, AuthError, IntegrityError, VersionError}. An index write of a collection that
 * failed after the item was stored rejects with err.stored = true, err.id and err.record (the record name).
 *
 * Stable attributes: every button, input, select, textarea and summary inside .wds-root has data-wds="<name>", every dialog has
 * data-wds-view="<view>" (updated on every view switch), toasts have data-wds-toast="<key>" with buttons toast-action and toast-dismiss.
 *   all dialogs: close, form-error, sandbox-banner (sandbox only); page: sandbox-bar (sandbox only)
 *   loading, error: retry
 *   unlock: access-id-input, keyfile, keyfile-button, passphrase, show-passphrase, unlock-submit, to-create, to-redeem
 *   create: join-code, passphrase, passphrase-repeat, show-passphrase, recovery-contact-toggle, recovery-contact, create-submit, back
 *   redeem: invite-code-input, passphrase, passphrase-repeat, show-passphrase, redeem-submit, back
 *   sheet: access-id, recovery-code, sheet-keyfile, sheet-print, sheet-download, sheet-confirm, sheet-continue
 *   conflict: conflict-theirs, conflict-mine, conflict-download
 *   history: history-version (data-wds-version), history-preview, history-restore
 *   share: person, person-escrow, member-role, cancel-invite, revoke, invite-role, invite-expiry, invite-label, invite-create, invite-code, invite-copy,
 *          invite-another, me-keyfile, me-renew, me-lock, me-passphrase-toggle, passphrase, passphrase-repeat, show-passphrase, me-passphrase-submit,
 *          recovery-cancel, recovery-keep, recovered-ack, rekey-continue
 *   revoke: revoke-confirm, revoke-cancel, revoke-id;  notice: recovery-cancel, recovery-keep, recovered-ack
 * Dialogs use the class prefix "wds-" and CSS custom properties "--wds-*"; no Shadow DOM; nothing hands the passphrase
 * to app code. Never use innerHTML here: all text goes through textContent.
 */
(function (root, factory) {
  'use strict';
  var Core = root.WDSCore || (typeof require === 'function' ? require('./wds-core.js') : null);
  var api = factory(root, Core);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.WDS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, Core) {
  'use strict';

  var UI_VERSION = '1.0.0';
  var HIBP_URL = 'https://api.pwnedpasswords.com/range/';
  var INTERNAL_PREFIX = '.wds/';          // record names reserved for the library (member labels)
  var LABELS_RECORD = INTERNAL_PREFIX + 'labels';

  // ------------------------------------------------------------------------------------------------------------
  // 1. Small helpers
  // ------------------------------------------------------------------------------------------------------------
  var uidCounter = 0;
  function uid(p) { uidCounter += 1; return (p || 'wds-id') + '-' + uidCounter; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Let the browser paint before a long synchronous computation (Argon2id).
  function nextPaint() {
    return new Promise(function (resolve) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { setTimeout(resolve, 30); });
      else setTimeout(resolve, 30);
    });
  }
  function utf8(s) { return new TextEncoder().encode(s); }
  function hexUpper(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s.toUpperCase();
  }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  }
  function fmt(s, params) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) { return params && params[k] !== undefined ? params[k] : m; });
  }
  function fileSafe(s) {
    var out = String(s).replace(/[\x00-\x1f\x7f<>:"\\|?*]/g, '_').replace(/\/+/g, '/').split('/').map(function (seg) {
      return seg === '' || seg === '.' || seg === '..' ? '_' : seg;
    }).join('/');
    return out.length > 180 ? out.slice(0, 180) : out;
  }

  // DOM builder. Strings become text nodes; "html" is deliberately not supported.
  function el(tag, props, kids) {
    var e = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (k === 'value') e.value = v;
        else if (k === 'checked') e.checked = !!v;
        else if (k === 'disabled') e.disabled = !!v;
        else e.setAttribute(k, v === true ? '' : String(v));
      });
    }
    append(e, kids);
    return e;
  }
  function append(parent, kids) {
    if (kids === undefined || kids === null || kids === false) return parent;
    if (Array.isArray(kids)) { kids.forEach(function (k) { append(parent, k); }); return parent; }
    parent.appendChild(typeof kids === 'string' || typeof kids === 'number' ? document.createTextNode(String(kids)) : kids);
    return parent;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 15000);
  }
  function downloadText(text, filename, type) { downloadBlob(new Blob([text], { type: type || 'text/plain;charset=utf-8' }), filename); }

  // ------------------------------------------------------------------------------------------------------------
  // 2. Texts (English and German; German uses the formal "Sie")
  // ------------------------------------------------------------------------------------------------------------
  var TEXT = {
    en: {
      'common.close': 'Close', 'common.cancel': 'Cancel', 'common.continue': 'Continue', 'common.copy': 'Copy',
      'common.copied': 'Copied', 'common.dismiss': 'Dismiss', 'common.retry': 'Try again',
      'common.loading': 'Connecting to the storage service…',
      'common.notifications': 'Notifications',

      'unlock.title': 'Unlock your data',
      'unlock.app': 'App: {name}',
      'unlock.intro': 'Enter your access ID and your passphrase. Your data is encrypted on this device before it is stored.',
      'unlock.accessId': 'Access ID',
      'unlock.accessId.hint': 'Five groups of four characters. You find it on your access sheet or in your key file.',
      'unlock.keyfile.choose': 'Choose key file…',
      'unlock.keyfile.hint': 'Drop your key file anywhere on this window, or choose it. It fills in the access ID.',
      'unlock.keyfile.loaded': 'Key file loaded.',
      'unlock.passphrase': 'Passphrase',
      'unlock.submit': 'Unlock',
      'unlock.busy': 'Deriving your key. This takes a moment…',
      'unlock.toCreate': 'Create a new vault',
      'unlock.toRedeem': 'I have an invite code',
      'unlock.recoveryEntered': 'This looks like a recovery code, not an access ID. Recovery codes are only for the faculty recovery procedure.',

      'create.title': 'Create your vault',
      'create.intro': 'Your data is encrypted on this device with a key derived from your passphrase. Only you and the people you invite can open it.',
      'create.joinCode': 'Join code',
      'create.joinCode.hint': 'You get the join code from the person who runs this app.',
      'create.passphrase': 'Passphrase',
      'create.repeat': 'Repeat passphrase',
      'create.passphrase.hint': 'At least 12 characters. Four or more unrelated words work well. The server cannot reset a forgotten passphrase.',
      'create.contact': 'Recovery contact (optional)',
      'create.contact.label': 'E-mail address',
      'create.contact.hint': 'If you lose the passphrase and the recovery code, the faculty can only help if an address is stored here. It is stored on the server unencrypted, and recovery then takes 7 days.',
      'create.escrow.title': 'Who can read your data?',
      'create.escrow.text': 'The server stores only encrypted data. One exception exists by design: the faculty keeps a recovery key. If you lose your passphrase, the faculty can restore access after a documented procedure and a waiting period of 72 hours, and the holder of that key could technically decrypt every vault.',
      'create.privacy': 'Privacy information',
      'create.submit': 'Create vault',
      'create.busy': 'Creating your vault. This takes a moment…',
      'create.closed': 'New vaults cannot be created for this app at the moment.',
      'create.suspended': 'This app is paused by the faculty. New vaults cannot be created.',
      'create.back': 'I already have a vault',

      'pw.show': 'Show passphrase',
      'pw.tooShort': 'At least 12 characters are required ({n} so far).',
      'pw.mismatch': 'The two passphrases are different.',
      'pw.common': 'This passphrase is on lists of very common passwords. Choose another one.',
      'pw.weak': 'This passphrase is too easy to guess. Use several unrelated words.',
      'pw.weak.noBreachCheck': 'This passphrase is not strong enough: the check against known data breaches is not available, so a stronger passphrase is needed. Use more, longer and unrelated words.',
      'pw.pwned': 'This passphrase appears {count} times in known data breaches. Choose another one.',
      'pw.hibp.unavailable': 'The breach check could not be reached, so this passphrase was not checked against known breaches.',
      'pw.hibp.checking': 'Checking against known data breaches…',
      'pw.hibp.note': 'The breach check sends only the first 5 characters of a hash of your passphrase to api.pwnedpasswords.com, a US service. The passphrase itself never leaves this device.',
      'pw.strength': 'Strength: {label}',
      'pw.label.0': 'very weak', 'pw.label.1': 'weak', 'pw.label.2': 'fair', 'pw.label.3': 'good', 'pw.label.4': 'strong',
      'pw.empty': 'Enter a passphrase.',

      'sheet.title': 'Save your access sheet',
      'sheet.intro.owner': 'You need the access ID and your passphrase to open your data on another device. The recovery code is the only way back if you forget your passphrase.',
      'sheet.intro.member': 'You need the access ID and your passphrase to open the data on another device.',
      'sheet.app': 'App', 'sheet.accessId': 'Access ID', 'sheet.recovery': 'Recovery code', 'sheet.created': 'Created',
      'sheet.service': 'Service', 'sheet.access': 'Access',
      'sheet.keyfile': 'Download key file',
      'sheet.print': 'Print access sheet',
      'sheet.download': 'Download access sheet (HTML)',
      'sheet.keyfile.hint': 'The key file holds no secret, only the app and your access ID. Drop it into the app on a new device instead of typing the ID.',
      'sheet.passphrase.note': 'Your passphrase is not on this sheet. Remember it, or keep it in a password manager.',
      'sheet.recovery.note': 'Keep the sheet apart from this computer. Whoever holds the recovery code can start a recovery request; you are told about such a request when you unlock and can cancel it during the 72-hour waiting period.',
      'sheet.confirm.owner': 'I have saved the access sheet and the recovery code.',
      'sheet.confirm.member': 'I have saved my access ID.',
      'sheet.hibp.skipped': 'Note: the breach check was not available, so your passphrase was not checked against known breaches.',
      'sheet.escrow.title': 'Faculty recovery key',
      'sheet.escrow.text': 'The server stores only encrypted data. By design, the faculty keeps a recovery key: after a documented procedure and a waiting period it can restore access for whoever holds the recovery code, and the holder of the key could technically decrypt every vault.',
      'sheet.page.title': 'Access sheet',
      'sheet.page.print': 'Print this page',

      'redeem.title': 'Join with an invite code',
      'redeem.intro': 'Enter the invite code you received and choose your own passphrase. An invite code works only once.',
      'redeem.code': 'Invite code',
      'redeem.code.hint': '48 characters in groups of four.',
      'redeem.submit': 'Join',
      'redeem.busy': 'Joining. This takes a moment…',
      'redeem.done': 'You now have access',
      'redeem.role.write': 'You can read and change the data.',
      'redeem.role.read': 'You can read the data but not change it.',
      'redeem.back': 'I already have an access ID',

      'role.owner': 'Owner', 'role.write': 'Can edit', 'role.read': 'Read only',

      'err.notFound': 'This access ID is unknown, or the access was removed.',
      'err.badId': 'This access ID is not valid. Check it for typing errors.',
      'err.wrongPass': 'The passphrase does not match this access ID.',
      'err.revoked': 'The owner of the data removed this access.',
      'err.expired': 'This invite has expired. Ask the owner for a new one.',
      'err.vaultDeleted': 'This vault was deleted. It is removed for good after 30 days. If that was a mistake, contact the person who runs this app.',
      'err.alreadyRedeemed': 'This invite was already used. Unlock with your access ID and passphrase instead.',
      'err.rate': 'Too many attempts. Wait a moment and try again.',
      'err.offline': 'The storage service cannot be reached. Check your internet connection and try again.',
      'err.integrity': 'A security check failed: the data from the server does not match what this device expects ({code}). Do not enter new data and contact the person who runs this app.',
      'err.rollback': 'The server showed older data than this device has seen before. This can be a fault or an attack. Do not continue and contact the person who runs this app.',
      'err.generic': 'Something went wrong: {message}',
      'err.keyfile.invalid': 'This is not a valid key file.',
      'err.keyfile.other': 'This key file belongs to a different app or service.',
      'err.invite.invalid': 'This invite code is not valid. It has 48 characters; check it for typing errors.',
      'err.joinCode': 'The join code is not correct.',
      'err.joinCode.missing': 'Enter the join code.',
      'err.vaultLimit': 'This app cannot take new users at the moment. Contact the person who runs it.',
      'err.noPins': 'This build of the storage library is missing the faculty key. Contact the author of the app.',
      'err.accessId.missing': 'Enter your access ID.',
      'err.passphrase.missing': 'Enter your passphrase.',
      'err.contact.invalid': 'This is not a valid e-mail address.',
      'err.scope': 'This app is not registered with the storage service.',

      'note.advisory': 'This app uses an outdated version of the storage library. Please ask its author for an update.',
      'note.newDevice': 'This device is new to your vault. That is normal.',
      'note.stateInvalid': 'The safety record kept on this device was damaged or changed and has been reset.',
      'note.readOnly': 'The storage service is in read-only mode. Changes cannot be saved at the moment.',
      'note.suspended': 'This app is paused by the faculty. You can read your data but not save changes.',
      'note.redeemed.one': 'An invitation was redeemed.',
      'note.redeemed.other': '{n} invitations were redeemed.',
      'note.review': 'Review',
      'note.rekey': 'Re-encrypting stored data after a revocation: {done} done, {left} left.',
      'note.rekey.done': 'Re-encryption finished. Revoked access can no longer open any stored data.',
      'note.rekey.failed': 'Re-encryption was interrupted. It continues the next time you unlock.',
      'note.stale': 'Newer versions were saved elsewhere: {names}. Reload to see them.',
      'note.stale.many': 'Newer versions of {n} entries were saved elsewhere. Reload to see them.',
      'note.offline': 'Saving failed: the storage service cannot be reached. Your latest changes exist only in this window.',
      'note.backup': 'Download backup',
      'note.backup.none': 'There is nothing to back up yet.',
      'note.quota': 'Saving failed: {message}',
      'note.revoked': 'Your access to this vault was removed. The data on this device is locked.',
      'note.integrity': 'A security check failed ({code}). The data from the server cannot be trusted. Do not enter new data and contact the person who runs this app.',
      'note.forbidden': 'This access is read-only, so the change was not saved.',
      'note.sessionExpired': 'Your session is no longer valid, for example because the passphrase was changed on another device. Unlock again.',
      'note.exporting': 'Exporting: {done} of {total}',
      'note.exported': 'Export finished: {n} records.',
      'note.version': 'This app needs a newer version of the storage library: {message}',

      'conflict.title': 'Another device or person saved a newer version',
      'conflict.intro': '"{name}" was changed after you last loaded it. Choose which version to keep. Nothing is lost: the version you do not keep stays in the history.',
      'conflict.theirs': 'Their version', 'conflict.mine': 'Your version (not saved yet)',
      'conflict.saved': 'saved {time}',
      'conflict.theirsDeleted': 'This entry was deleted by someone else.',
      'conflict.mineDeleted': 'You wanted to delete this entry.',
      'conflict.noTheirs': 'There is no saved version.',
      'conflict.keepTheirs': 'Keep theirs', 'conflict.keepMine': 'Keep mine', 'conflict.downloadBoth': 'Download both',
      'conflict.file': 'File ({mime}), {size}',
      'conflict.truncated': '(shortened)',
      'conflict.delete.title': 'This entry was changed in the meantime',
      'conflict.delete.intro': '"{name}" was changed after you last loaded it, and you wanted to delete it. Delete it anyway, or keep the newer version?',
      'conflict.delete.keepMine': 'Delete anyway', 'conflict.delete.keepTheirs': 'Keep the entry',

      'history.title': 'History of "{name}"',
      'history.intro': 'The service keeps the most recent versions. Restoring saves an old version again as the newest one.',
      'history.version': 'Version {n}', 'history.current': 'current', 'history.deleted': 'deleted',
      'history.preview': 'Preview', 'history.restore': 'Restore', 'history.empty': 'There are no versions yet.',
      'history.unavailable': 'This version is no longer available.',

      'share.title': 'Sharing and access',
      'share.people': 'People with access',
      'share.you': 'You', 'share.member': 'Member',
      'share.escrow': 'Faculty recovery key',
      'share.escrow.badge': 'Faculty, recovery only',
      'share.escrow.hint': 'Part of every vault and cannot be removed. It lets the faculty restore access after a documented recovery procedure.',
      'share.status.active': 'Active',
      'share.status.invited': 'Invite not used yet, valid until {time}',
      'share.status.expired': 'Invite expired',
      'share.status.redeemed': 'Joined {time}',
      'share.status.renewal': 'New keys waiting for approval',
      'share.status.new': 'New: invite redeemed',
      'share.addedByFaculty': 'Added by the faculty during a recovery',
      'share.revoke': 'Revoke', 'share.cancelInvite': 'Cancel invite', 'share.role': 'Access of {label}',
      'share.status.opened': 'Invite opened with its code, not redeemed yet, valid until {time}',
      'share.revoke.invite.text': 'The code for {label} has already been used to open the invite, so it can no longer be withdrawn quietly. To make the code worthless, all stored data, including the history, is re-encrypted with a new key. This can take a while: keep this window open. If it is interrupted, it continues the next time you unlock.',
      'share.invite.title': 'Invite someone',
      'share.invite.role': 'Access', 'share.invite.expiry': 'Valid for', 'share.invite.label': 'Label (optional)',
      'share.invite.label.hint': 'A note for you, for example a first name. It is stored encrypted in this vault.',
      'share.invite.create': 'Create invite code',
      'share.expiry.sandbox': 'Until tonight ({time})',
      'share.invite.sandboxLate': 'The sandbox is emptied at {time}. An invite must be valid for at least one hour, so none can be created now.',
      'share.invite.busy': 'Creating the invite…',
      'share.invite.result': 'Invite code',
      'share.invite.until': 'Valid until {time}.',
      'share.invite.hint': 'Hand the code over in person, or through a different channel than the one the data of this app is about. Whoever holds the code can join once. You can cancel it until it is used.',
      'share.invite.another': 'Create another invite',
      'share.expiry.1': '1 day', 'share.expiry.2': '2 days (default)', 'share.expiry.7': '7 days', 'share.expiry.14': '14 days',
      'share.revoke.title': 'Revoke access?',
      'share.revoke.text': '{label} loses access immediately. All stored data, including the history, is then re-encrypted with a new key. This can take a while: keep this window open. If it is interrupted, it continues the next time you unlock.',
      'share.revoke.confirm': 'Revoke access',
      'share.slotId': 'ID {id}', 'share.otherOwner': 'Other owner',
      'share.labels.hint': 'Names are notes kept inside the vault. Anyone with write access can change them, so check the ID before you revoke someone.',
      'share.revoke.id': 'ID of this access: {id}. Compare it with the list before you confirm.',
      'share.revoke.owner.text': '{label} loses access immediately, including the right to manage who has access. All stored data, including the history, is then re-encrypted with a new key. Continue only if this access was added by mistake or can no longer be trusted. This can take a while: keep this window open. If it is interrupted, it continues the next time you unlock.',
      'share.revoke.progress': 'Re-encrypting: {done} of {total}',
      'share.revoke.starting': 'Preparing the new key…',
      'share.revoke.done': 'Access revoked. All data is re-encrypted.',
      'share.revoke.partial': 'Access revoked. The re-encryption continues the next time you unlock.',
      'share.rekey.pending': 'Re-encryption of older data is not finished.',
      'share.rekey.continue': 'Continue now',
      'share.recovered.title': 'The faculty added an owner access',
      'share.recovered.text': 'After a recovery request, the faculty added a new owner access to this vault. If you did not expect this, contact the faculty. Your own access stays valid, and you can revoke the added owner access in the sharing dialog. You have to confirm before you can change who has access.',
      'share.recovered.ack': 'I know about this',
      'share.recovery.title': 'A recovery of this vault was requested',
      'share.recovery.text': 'Requested {time}. After {ready} the faculty can restore access for the requester. If nobody asked on your behalf, cancel the request now.',
      'share.recovery.cancel': 'Cancel the request', 'share.recovery.keep': 'Leave it as it is',
      'share.recovery.cancelled': 'The recovery request was cancelled.',
      'share.me.title': 'My access',
      'share.me.role': 'You have access as: {role}.',
      'share.me.onlyOwner': 'Only the owner can invite people or change who has access.',
      'share.me.passphrase': 'Change passphrase',
      'share.me.passphrase.new': 'New passphrase',
      'share.me.passphrase.submit': 'Change passphrase',
      'share.me.passphrase.done': 'Passphrase changed. Use the new one from now on.',
      'share.me.renew': 'Renew my keys',
      'share.me.renew.hint': 'Replaces the keys of this access with fresh ones. Do this if you suspect that somebody else saw your invite code.',
      'share.me.renew.done': 'Keys renewed.',
      'share.me.keyfile': 'Download key file',
      'share.me.lock': 'Lock now',
      'share.me.keyfile.hint': 'For a new device: the file holds no secret, only the app and your access ID. Your passphrase is still needed.',
      'share.me.lock.hint': 'Removes all data from the memory of this page. Unlocking needs your passphrase.',
      'share.error.recoveryAck': 'Confirm the notice about the faculty access first.',
      'share.error.generic': 'This did not work: {message}',

      'sandbox.prefix': 'Sandbox: ',
      'sandbox.banner': 'Sandbox for testing. Anyone can create a vault here, and all vaults are deleted every night (next: {time}). Do not store real data.',
      'sandbox.bar': 'Sandbox – data is deleted tonight',
      'sandbox.share.escrow': 'Part of every vault and cannot be removed. The sandbox offers no recovery.',
      'sandbox.create.escrow': 'The server stores only encrypted data. The faculty\'s recovery key is part of every vault here too, but the sandbox offers no recovery: a lost passphrase means the vault is gone (it is deleted tonight anyway).',
      'sandbox.create.submit': 'Create sandbox vault',
      'sandbox.sheet.title': 'Sandbox access (deleted tonight)',
      'sandbox.sheet.note': 'No recovery in the sandbox; this vault is deleted tonight.',
      'sandbox.emptied': 'The sandbox was emptied on {date}. Create a new vault.',
      'sandbox.nightly': 'The sandbox is emptied every night.',
      'err.sandboxDisabled': 'The sandbox is not available at the moment.',
      'note.unsavedDropped': 'Unsaved changes of the previously open vault could not be saved.'
    },
    de: {
      'common.close': 'Schließen', 'common.cancel': 'Abbrechen', 'common.continue': 'Weiter', 'common.copy': 'Kopieren',
      'common.copied': 'Kopiert', 'common.dismiss': 'Ausblenden', 'common.retry': 'Erneut versuchen',
      'common.loading': 'Verbindung zum Speicherdienst wird aufgebaut …',
      'common.notifications': 'Hinweise',

      'unlock.title': 'Daten entsperren',
      'unlock.app': 'App: {name}',
      'unlock.intro': 'Geben Sie Ihre Zugangskennung und Ihre Passphrase ein. Ihre Daten werden auf diesem Gerät verschlüsselt, bevor sie gespeichert werden.',
      'unlock.accessId': 'Zugangskennung',
      'unlock.accessId.hint': 'Fünf Gruppen mit je vier Zeichen. Sie steht auf Ihrem Zugangsblatt und in Ihrer Schlüsseldatei.',
      'unlock.keyfile.choose': 'Schlüsseldatei wählen …',
      'unlock.keyfile.hint': 'Ziehen Sie Ihre Schlüsseldatei auf dieses Fenster oder wählen Sie sie aus. Die Zugangskennung wird dann eingetragen.',
      'unlock.keyfile.loaded': 'Schlüsseldatei geladen.',
      'unlock.passphrase': 'Passphrase',
      'unlock.submit': 'Entsperren',
      'unlock.busy': 'Ihr Schlüssel wird berechnet. Das dauert einen Moment …',
      'unlock.toCreate': 'Neuen Tresor anlegen',
      'unlock.toRedeem': 'Ich habe einen Einladungscode',
      'unlock.recoveryEntered': 'Das sieht nach einem Wiederherstellungscode aus, nicht nach einer Zugangskennung. Wiederherstellungscodes werden nur für das Wiederherstellungsverfahren der Fakultät gebraucht.',

      'create.title': 'Tresor anlegen',
      'create.intro': 'Ihre Daten werden auf diesem Gerät mit einem Schlüssel verschlüsselt, der aus Ihrer Passphrase abgeleitet wird. Nur Sie und die Personen, die Sie einladen, können sie öffnen.',
      'create.joinCode': 'Beitrittscode',
      'create.joinCode.hint': 'Den Beitrittscode erhalten Sie von der Person, die diese App betreibt.',
      'create.passphrase': 'Passphrase',
      'create.repeat': 'Passphrase wiederholen',
      'create.passphrase.hint': 'Mindestens 12 Zeichen. Vier oder mehr unzusammenhängende Wörter eignen sich gut. Der Server kann eine vergessene Passphrase nicht zurücksetzen.',
      'create.contact': 'Kontakt zur Wiederherstellung (optional)',
      'create.contact.label': 'E-Mail-Adresse',
      'create.contact.hint': 'Wenn Sie Passphrase und Wiederherstellungscode verlieren, kann die Fakultät nur helfen, wenn hier eine Adresse hinterlegt ist. Sie wird unverschlüsselt auf dem Server gespeichert; die Wiederherstellung dauert dann 7 Tage.',
      'create.escrow.title': 'Wer kann Ihre Daten lesen?',
      'create.escrow.text': 'Der Server speichert nur verschlüsselte Daten. Eine Ausnahme besteht absichtlich: Die Fakultät verwahrt einen Wiederherstellungsschlüssel. Wenn Sie Ihre Passphrase verlieren, kann die Fakultät nach einem dokumentierten Verfahren und einer Wartezeit von 72 Stunden den Zugang wiederherstellen, und wer diesen Schlüssel besitzt, könnte technisch jeden Tresor entschlüsseln.',
      'create.privacy': 'Datenschutzinformationen',
      'create.submit': 'Tresor anlegen',
      'create.busy': 'Ihr Tresor wird angelegt. Das dauert einen Moment …',
      'create.closed': 'Für diese App können derzeit keine neuen Tresore angelegt werden.',
      'create.suspended': 'Diese App ist von der Fakultät pausiert. Neue Tresore können nicht angelegt werden.',
      'create.back': 'Ich habe schon einen Tresor',

      'pw.show': 'Passphrase anzeigen',
      'pw.tooShort': 'Mindestens 12 Zeichen sind nötig (bisher {n}).',
      'pw.mismatch': 'Die beiden Passphrasen sind verschieden.',
      'pw.common': 'Diese Passphrase steht auf Listen sehr häufiger Passwörter. Wählen Sie eine andere.',
      'pw.weak': 'Diese Passphrase ist zu leicht zu erraten. Nehmen Sie mehrere unzusammenhängende Wörter.',
      'pw.weak.noBreachCheck': 'Diese Passphrase ist nicht stark genug: Die Prüfung auf bekannte Datenlecks ist nicht verfügbar, deshalb braucht es eine stärkere Passphrase. Nehmen Sie mehr, längere und unzusammenhängende Wörter.',
      'pw.pwned': 'Diese Passphrase kommt {count}-mal in bekannten Datenlecks vor. Wählen Sie eine andere.',
      'pw.hibp.unavailable': 'Die Prüfung auf Datenlecks war nicht erreichbar, daher wurde diese Passphrase nicht gegen bekannte Datenlecks geprüft.',
      'pw.hibp.checking': 'Prüfung auf bekannte Datenlecks …',
      'pw.hibp.note': 'Die Prüfung auf Datenlecks sendet nur die ersten 5 Zeichen eines Hashwerts Ihrer Passphrase an api.pwnedpasswords.com, einen US-Dienst. Die Passphrase selbst verlässt dieses Gerät nie.',
      'pw.strength': 'Stärke: {label}',
      'pw.label.0': 'sehr schwach', 'pw.label.1': 'schwach', 'pw.label.2': 'mittel', 'pw.label.3': 'gut', 'pw.label.4': 'stark',
      'pw.empty': 'Geben Sie eine Passphrase ein.',

      'sheet.title': 'Zugangsblatt sichern',
      'sheet.intro.owner': 'Zugangskennung und Passphrase brauchen Sie, um Ihre Daten auf einem anderen Gerät zu öffnen. Der Wiederherstellungscode ist der einzige Weg zurück, wenn Sie die Passphrase vergessen.',
      'sheet.intro.member': 'Zugangskennung und Passphrase brauchen Sie, um die Daten auf einem anderen Gerät zu öffnen.',
      'sheet.app': 'App', 'sheet.accessId': 'Zugangskennung', 'sheet.recovery': 'Wiederherstellungscode', 'sheet.created': 'Angelegt',
      'sheet.service': 'Dienst', 'sheet.access': 'Zugriff',
      'sheet.keyfile': 'Schlüsseldatei herunterladen',
      'sheet.print': 'Zugangsblatt drucken',
      'sheet.download': 'Zugangsblatt herunterladen (HTML)',
      'sheet.keyfile.hint': 'Die Schlüsseldatei enthält kein Geheimnis, nur die App und Ihre Zugangskennung. Ziehen Sie sie auf einem neuen Gerät in die App, statt die Kennung abzutippen.',
      'sheet.passphrase.note': 'Ihre Passphrase steht nicht auf diesem Blatt. Merken Sie sie sich oder verwahren Sie sie in einem Passwortmanager.',
      'sheet.recovery.note': 'Bewahren Sie das Blatt getrennt von diesem Rechner auf. Wer den Wiederherstellungscode hat, kann eine Wiederherstellung beantragen; Sie erfahren davon beim Entsperren und können sie während der Wartezeit von 72 Stunden abbrechen.',
      'sheet.confirm.owner': 'Ich habe das Zugangsblatt und den Wiederherstellungscode gesichert.',
      'sheet.confirm.member': 'Ich habe meine Zugangskennung gesichert.',
      'sheet.hibp.skipped': 'Hinweis: Die Prüfung auf Datenlecks war nicht erreichbar, daher wurde Ihre Passphrase nicht gegen bekannte Datenlecks geprüft.',
      'sheet.escrow.title': 'Wiederherstellungsschlüssel der Fakultät',
      'sheet.escrow.text': 'Der Server speichert nur verschlüsselte Daten. Absichtlich verwahrt die Fakultät einen Wiederherstellungsschlüssel: Nach einem dokumentierten Verfahren und einer Wartezeit kann sie den Zugang für den Inhaber des Wiederherstellungscodes wiederherstellen, und wer den Schlüssel besitzt, könnte technisch jeden Tresor entschlüsseln.',
      'sheet.page.title': 'Zugangsblatt',
      'sheet.page.print': 'Diese Seite drucken',

      'redeem.title': 'Mit Einladungscode beitreten',
      'redeem.intro': 'Geben Sie den erhaltenen Einladungscode ein und wählen Sie Ihre eigene Passphrase. Ein Einladungscode funktioniert nur einmal.',
      'redeem.code': 'Einladungscode',
      'redeem.code.hint': '48 Zeichen in Vierergruppen.',
      'redeem.submit': 'Beitreten',
      'redeem.busy': 'Der Beitritt läuft. Das dauert einen Moment …',
      'redeem.done': 'Sie haben jetzt Zugriff',
      'redeem.role.write': 'Sie können die Daten lesen und ändern.',
      'redeem.role.read': 'Sie können die Daten lesen, aber nicht ändern.',
      'redeem.back': 'Ich habe schon eine Zugangskennung',

      'role.owner': 'Eigentümer', 'role.write': 'Darf bearbeiten', 'role.read': 'Nur lesen',

      'err.notFound': 'Diese Zugangskennung ist unbekannt, oder der Zugang wurde entfernt.',
      'err.badId': 'Diese Zugangskennung ist ungültig. Prüfen Sie sie auf Tippfehler.',
      'err.wrongPass': 'Die Passphrase passt nicht zu dieser Zugangskennung.',
      'err.revoked': 'Die Eigentümerin oder der Eigentümer der Daten hat diesen Zugang entfernt.',
      'err.expired': 'Diese Einladung ist abgelaufen. Bitten Sie um eine neue.',
      'err.vaultDeleted': 'Dieser Tresor wurde gelöscht. Er wird nach 30 Tagen endgültig entfernt. Wenden Sie sich an die Person, die die App betreibt, falls das ein Versehen war.',
      'err.alreadyRedeemed': 'Diese Einladung wurde schon benutzt. Entsperren Sie stattdessen mit Zugangskennung und Passphrase.',
      'err.rate': 'Zu viele Versuche. Warten Sie einen Moment und versuchen Sie es erneut.',
      'err.offline': 'Der Speicherdienst ist nicht erreichbar. Prüfen Sie Ihre Internetverbindung und versuchen Sie es erneut.',
      'err.integrity': 'Eine Sicherheitsprüfung ist fehlgeschlagen: Die Daten des Servers passen nicht zu dem, was dieses Gerät erwartet ({code}). Geben Sie keine neuen Daten ein und wenden Sie sich an die Person, die diese App betreibt.',
      'err.rollback': 'Der Server hat ältere Daten gezeigt, als dieses Gerät schon gesehen hat. Das kann ein Fehler oder ein Angriff sein. Machen Sie nicht weiter und wenden Sie sich an die Person, die diese App betreibt.',
      'err.generic': 'Etwas ist schiefgegangen: {message}',
      'err.keyfile.invalid': 'Das ist keine gültige Schlüsseldatei.',
      'err.keyfile.other': 'Diese Schlüsseldatei gehört zu einer anderen App oder einem anderen Dienst.',
      'err.invite.invalid': 'Dieser Einladungscode ist ungültig. Er hat 48 Zeichen; prüfen Sie ihn auf Tippfehler.',
      'err.joinCode': 'Der Beitrittscode ist nicht korrekt.',
      'err.joinCode.missing': 'Geben Sie den Beitrittscode ein.',
      'err.vaultLimit': 'Diese App kann derzeit keine neuen Nutzenden aufnehmen. Wenden Sie sich an die Person, die sie betreibt.',
      'err.noPins': 'In diesem Build der Speicherbibliothek fehlt der Schlüssel der Fakultät. Wenden Sie sich an die Autorin oder den Autor der App.',
      'err.accessId.missing': 'Geben Sie Ihre Zugangskennung ein.',
      'err.passphrase.missing': 'Geben Sie Ihre Passphrase ein.',
      'err.contact.invalid': 'Das ist keine gültige E-Mail-Adresse.',
      'err.scope': 'Diese App ist beim Speicherdienst nicht registriert.',

      'note.advisory': 'Diese App nutzt eine veraltete Version der Speicherbibliothek. Bitten Sie die Autorin oder den Autor um eine Aktualisierung.',
      'note.newDevice': 'Dieses Gerät ist neu für Ihren Tresor. Das ist normal.',
      'note.stateInvalid': 'Der auf diesem Gerät gespeicherte Sicherheitsvermerk war beschädigt oder verändert und wurde zurückgesetzt.',
      'note.readOnly': 'Der Speicherdienst ist im Nur-Lese-Modus. Änderungen können derzeit nicht gespeichert werden.',
      'note.suspended': 'Diese App ist von der Fakultät pausiert. Sie können Ihre Daten lesen, aber keine Änderungen speichern.',
      'note.redeemed.one': 'Eine Einladung wurde eingelöst.',
      'note.redeemed.other': '{n} Einladungen wurden eingelöst.',
      'note.review': 'Ansehen',
      'note.rekey': 'Gespeicherte Daten werden nach einem Zugriffsentzug neu verschlüsselt: {done} erledigt, {left} offen.',
      'note.rekey.done': 'Neuverschlüsselung abgeschlossen. Entzogene Zugänge können keine gespeicherten Daten mehr öffnen.',
      'note.rekey.failed': 'Die Neuverschlüsselung wurde unterbrochen. Sie läuft beim nächsten Entsperren weiter.',
      'note.stale': 'Anderswo wurden neuere Versionen gespeichert: {names}. Laden Sie neu, um sie zu sehen.',
      'note.stale.many': 'Anderswo wurden neuere Versionen von {n} Einträgen gespeichert. Laden Sie neu, um sie zu sehen.',
      'note.offline': 'Speichern fehlgeschlagen: Der Speicherdienst ist nicht erreichbar. Ihre letzten Änderungen gibt es nur in diesem Fenster.',
      'note.backup': 'Sicherung herunterladen',
      'note.backup.none': 'Es gibt noch nichts zu sichern.',
      'note.quota': 'Speichern fehlgeschlagen: {message}',
      'note.revoked': 'Ihr Zugang zu diesem Tresor wurde entfernt. Die Daten auf diesem Gerät sind gesperrt.',
      'note.integrity': 'Eine Sicherheitsprüfung ist fehlgeschlagen ({code}). Den Daten des Servers kann nicht vertraut werden. Geben Sie keine neuen Daten ein und wenden Sie sich an die Person, die diese App betreibt.',
      'note.forbidden': 'Dieser Zugang ist nur lesend, die Änderung wurde nicht gespeichert.',
      'note.sessionExpired': 'Ihre Sitzung ist nicht mehr gültig, zum Beispiel weil die Passphrase auf einem anderen Gerät geändert wurde. Entsperren Sie erneut.',
      'note.exporting': 'Export läuft: {done} von {total}',
      'note.exported': 'Export abgeschlossen: {n} Datensätze.',
      'note.version': 'Diese App braucht eine neuere Version der Speicherbibliothek: {message}',

      'conflict.title': 'Ein anderes Gerät oder eine andere Person hat eine neuere Version gespeichert',
      'conflict.intro': '„{name}“ wurde geändert, nachdem Sie es zuletzt geladen haben. Wählen Sie, welche Version bleibt. Nichts geht verloren: Die Version, die Sie nicht behalten, bleibt im Verlauf.',
      'conflict.theirs': 'Die andere Version', 'conflict.mine': 'Ihre Version (noch nicht gespeichert)',
      'conflict.saved': 'gespeichert {time}',
      'conflict.theirsDeleted': 'Dieser Eintrag wurde von jemand anderem gelöscht.',
      'conflict.mineDeleted': 'Sie wollten diesen Eintrag löschen.',
      'conflict.noTheirs': 'Es gibt keine gespeicherte Version.',
      'conflict.keepTheirs': 'Andere behalten', 'conflict.keepMine': 'Meine behalten', 'conflict.downloadBoth': 'Beide herunterladen',
      'conflict.file': 'Datei ({mime}), {size}',
      'conflict.truncated': '(gekürzt)',
      'conflict.delete.title': 'Dieser Eintrag wurde zwischenzeitlich geändert',
      'conflict.delete.intro': '„{name}“ wurde geändert, nachdem Sie es zuletzt geladen haben, und Sie wollten es löschen. Trotzdem löschen oder die neuere Version behalten?',
      'conflict.delete.keepMine': 'Trotzdem löschen', 'conflict.delete.keepTheirs': 'Eintrag behalten',

      'history.title': 'Verlauf von „{name}“',
      'history.intro': 'Der Dienst bewahrt die letzten Versionen auf. Beim Wiederherstellen wird eine alte Version erneut als neueste gespeichert.',
      'history.version': 'Version {n}', 'history.current': 'aktuell', 'history.deleted': 'gelöscht',
      'history.preview': 'Vorschau', 'history.restore': 'Wiederherstellen', 'history.empty': 'Es gibt noch keine Versionen.',
      'history.unavailable': 'Diese Version ist nicht mehr verfügbar.',

      'share.title': 'Teilen und Zugriff',
      'share.people': 'Personen mit Zugriff',
      'share.you': 'Sie', 'share.member': 'Mitglied',
      'share.escrow': 'Wiederherstellungsschlüssel der Fakultät',
      'share.escrow.badge': 'Fakultät, nur zur Wiederherstellung',
      'share.escrow.hint': 'Gehört zu jedem Tresor und kann nicht entfernt werden. Damit kann die Fakultät nach einem dokumentierten Verfahren den Zugang wiederherstellen.',
      'share.status.active': 'Aktiv',
      'share.status.invited': 'Einladung noch nicht benutzt, gültig bis {time}',
      'share.status.expired': 'Einladung abgelaufen',
      'share.status.redeemed': 'Beigetreten {time}',
      'share.status.renewal': 'Neue Schlüssel warten auf Bestätigung',
      'share.status.new': 'Neu: Einladung eingelöst',
      'share.addedByFaculty': 'Von der Fakultät bei einer Wiederherstellung hinzugefügt',
      'share.revoke': 'Entziehen', 'share.cancelInvite': 'Einladung zurückziehen', 'share.role': 'Zugriff von {label}',
      'share.status.opened': 'Einladung mit ihrem Code geöffnet, noch nicht eingelöst, gültig bis {time}',
      'share.revoke.invite.text': 'Der Code für {label} wurde bereits benutzt, um die Einladung zu öffnen. Deshalb lässt sie sich nicht mehr unbemerkt zurückziehen. Damit der Code wertlos wird, werden alle gespeicherten Daten samt Verlauf mit einem neuen Schlüssel neu verschlüsselt. Das kann dauern: Lassen Sie dieses Fenster geöffnet. Bei einer Unterbrechung läuft es beim nächsten Entsperren weiter.',
      'share.invite.title': 'Jemanden einladen',
      'share.invite.role': 'Zugriff', 'share.invite.expiry': 'Gültig für', 'share.invite.label': 'Bezeichnung (optional)',
      'share.invite.label.hint': 'Eine Notiz für Sie, zum Beispiel ein Vorname. Sie wird verschlüsselt in diesem Tresor gespeichert.',
      'share.invite.create': 'Einladungscode erzeugen',
      'share.expiry.sandbox': 'Bis heute Nacht ({time})',
      'share.invite.sandboxLate': 'Die Testumgebung wird um {time} geleert. Eine Einladung muss mindestens eine Stunde gültig sein, deshalb kann jetzt keine erzeugt werden.',
      'share.invite.busy': 'Die Einladung wird erzeugt …',
      'share.invite.result': 'Einladungscode',
      'share.invite.until': 'Gültig bis {time}.',
      'share.invite.hint': 'Geben Sie den Code persönlich weiter oder über einen anderen Kanal als den, um dessen Daten es in dieser App geht. Wer den Code hat, kann einmal beitreten. Sie können ihn zurückziehen, solange er nicht benutzt wurde.',
      'share.invite.another': 'Weitere Einladung erzeugen',
      'share.expiry.1': '1 Tag', 'share.expiry.2': '2 Tage (Standard)', 'share.expiry.7': '7 Tage', 'share.expiry.14': '14 Tage',
      'share.revoke.title': 'Zugriff entziehen?',
      'share.revoke.text': '{label} verliert sofort den Zugriff. Alle gespeicherten Daten samt Verlauf werden danach mit einem neuen Schlüssel neu verschlüsselt. Das kann dauern: Lassen Sie dieses Fenster geöffnet. Bei einer Unterbrechung läuft es beim nächsten Entsperren weiter.',
      'share.revoke.confirm': 'Zugriff entziehen',
      'share.slotId': 'ID {id}', 'share.otherOwner': 'Weiterer Eigentümer',
      'share.labels.hint': 'Namen sind Notizen im Tresor. Wer Schreibzugriff hat, kann sie ändern. Prüfen Sie deshalb die ID, bevor Sie jemandem den Zugriff entziehen.',
      'share.revoke.id': 'ID dieses Zugangs: {id}. Vergleichen Sie sie mit der Liste, bevor Sie bestätigen.',
      'share.revoke.owner.text': '{label} verliert sofort den Zugriff, auch das Recht, den Zugriff anderer zu verwalten. Alle gespeicherten Daten samt Verlauf werden danach mit einem neuen Schlüssel neu verschlüsselt. Fahren Sie nur fort, wenn dieser Zugang irrtümlich hinzugefügt wurde oder nicht mehr vertrauenswürdig ist. Das kann dauern: Lassen Sie dieses Fenster geöffnet. Bei einer Unterbrechung läuft es beim nächsten Entsperren weiter.',
      'share.revoke.progress': 'Neuverschlüsselung: {done} von {total}',
      'share.revoke.starting': 'Der neue Schlüssel wird vorbereitet …',
      'share.revoke.done': 'Zugriff entzogen. Alle Daten sind neu verschlüsselt.',
      'share.revoke.partial': 'Zugriff entzogen. Die Neuverschlüsselung läuft beim nächsten Entsperren weiter.',
      'share.rekey.pending': 'Die Neuverschlüsselung älterer Daten ist nicht abgeschlossen.',
      'share.rekey.continue': 'Jetzt fortsetzen',
      'share.recovered.title': 'Die Fakultät hat einen Eigentümer-Zugang hinzugefügt',
      'share.recovered.text': 'Nach einem Wiederherstellungsantrag hat die Fakultät diesem Tresor einen neuen Eigentümer-Zugang hinzugefügt. Falls Sie damit nicht gerechnet haben, wenden Sie sich an die Fakultät. Ihr eigener Zugang bleibt gültig, und Sie können den hinzugefügten Eigentümer-Zugang im Teilen-Dialog entziehen. Sie müssen das bestätigen, bevor Sie ändern können, wer Zugriff hat.',
      'share.recovered.ack': 'Ich weiß Bescheid',
      'share.recovery.title': 'Für diesen Tresor wurde eine Wiederherstellung beantragt',
      'share.recovery.text': 'Beantragt {time}. Ab {ready} kann die Fakultät den Zugang für die antragstellende Person wiederherstellen. Falls niemand in Ihrem Auftrag gefragt hat, brechen Sie den Antrag jetzt ab.',
      'share.recovery.cancel': 'Antrag abbrechen', 'share.recovery.keep': 'So belassen',
      'share.recovery.cancelled': 'Der Wiederherstellungsantrag wurde abgebrochen.',
      'share.me.title': 'Mein Zugang',
      'share.me.role': 'Ihr Zugriff: {role}.',
      'share.me.onlyOwner': 'Nur die Eigentümerin oder der Eigentümer kann Personen einladen oder den Zugriff ändern.',
      'share.me.passphrase': 'Passphrase ändern',
      'share.me.passphrase.new': 'Neue Passphrase',
      'share.me.passphrase.submit': 'Passphrase ändern',
      'share.me.passphrase.done': 'Passphrase geändert. Verwenden Sie ab jetzt die neue.',
      'share.me.renew': 'Meine Schlüssel erneuern',
      'share.me.renew.hint': 'Ersetzt die Schlüssel dieses Zugangs durch frische. Tun Sie das, wenn Sie vermuten, dass jemand anderes Ihren Einladungscode gesehen hat.',
      'share.me.renew.done': 'Schlüssel erneuert.',
      'share.me.keyfile': 'Schlüsseldatei herunterladen',
      'share.me.lock': 'Jetzt sperren',
      'share.me.keyfile.hint': 'Für ein neues Gerät: Die Datei enthält kein Geheimnis, nur die App und Ihre Zugangskennung. Ihre Passphrase brauchen Sie trotzdem.',
      'share.me.lock.hint': 'Entfernt alle Daten aus dem Speicher dieser Seite. Zum Entsperren brauchen Sie Ihre Passphrase.',
      'share.error.recoveryAck': 'Bestätigen Sie zuerst den Hinweis zum Zugang der Fakultät.',
      'share.error.generic': 'Das hat nicht geklappt: {message}',

      'sandbox.prefix': 'Testumgebung: ',
      'sandbox.banner': 'Testumgebung. Hier kann jede Person einen Tresor anlegen, und alle Tresore werden jede Nacht gelöscht (das nächste Mal: {time}). Speichern Sie hier keine echten Daten.',
      'sandbox.bar': 'Testumgebung – Daten werden heute Nacht gelöscht',
      'sandbox.share.escrow': 'Gehört zu jedem Tresor und kann nicht entfernt werden. Die Testumgebung bietet keine Wiederherstellung.',
      'sandbox.create.escrow': 'Der Server speichert nur verschlüsselte Daten. Der Wiederherstellungsschlüssel der Fakultät gehört auch hier zu jedem Tresor, aber die Testumgebung bietet keine Wiederherstellung: Ist die Passphrase verloren, ist der Tresor verloren (er wird ohnehin heute Nacht gelöscht).',
      'sandbox.create.submit': 'Testtresor anlegen',
      'sandbox.sheet.title': 'Zugang zur Testumgebung (wird heute Nacht gelöscht)',
      'sandbox.sheet.note': 'Keine Wiederherstellung in der Testumgebung; dieser Tresor wird heute Nacht gelöscht.',
      'sandbox.emptied': 'Die Testumgebung wurde am {date} geleert. Legen Sie einen neuen Tresor an.',
      'sandbox.nightly': 'Die Testumgebung wird jede Nacht geleert.',
      'err.sandboxDisabled': 'Die Testumgebung ist im Moment nicht verfügbar.',
      'note.unsavedDropped': 'Nicht gespeicherte Änderungen des zuvor geöffneten Tresors konnten nicht gespeichert werden.'
    }
  };

  function detectLang(opt) {
    var l = opt || (typeof navigator !== 'undefined' && (navigator.language || (navigator.languages && navigator.languages[0]))) || 'en';
    return String(l).toLowerCase().indexOf('de') === 0 ? 'de' : 'en';
  }
  function makeT(lang) {
    var dict = TEXT[lang] || TEXT.en;
    return function t(key, params) {
      var s = dict[key];
      if (s === undefined) s = TEXT.en[key];
      if (s === undefined) return key;
      return params ? fmt(s, params) : s;
    };
  }
  function makeLocale(lang) { return lang === 'de' ? 'de-DE' : 'en-GB'; }
  function formatDate(sec, lang) {
    try { return new Date(sec * 1000).toLocaleDateString(makeLocale(lang), { dateStyle: 'medium' }); } catch (e) { return new Date(sec * 1000).toISOString().slice(0, 10); }
  }
  function formatTime(sec, lang) {
    try {
      return new Date(sec * 1000).toLocaleString(makeLocale(lang), { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) { return new Date(sec * 1000).toISOString(); }
  }

  // ------------------------------------------------------------------------------------------------------------
  // 3. Passphrase rules (PLAN 5.3): length, strength estimate, small common-password list, HIBP range check
  // ------------------------------------------------------------------------------------------------------------
  var MIN_PASSPHRASE = 12;
  var BLOCK_BITS = 40;   // estimates below this are refused
  var STRICT_BITS = 48;  // estimates below this are refused too when no breach check could be done (switched off, or unreachable)

  // Most common passwords (English and German, with typical leet and keyboard patterns). Used for exact matches.
  var COMMON_EXACT = ('password passwort passw0rd p@ssw0rd p@ssword pa55word pa55w0rd kennwort 123456 1234567 12345678 123456789 1234567890 ' +
    '12345678910 111111 000000 123123 654321 666666 121212 112233 987654321 123321 1q2w3e4r 1q2w3e4r5t 1qaz2wsx zaq12wsx q1w2e3r4 ' +
    'abc123 abcd1234 qwe123 qwerty qwertz qwertyuiop qwertzuiop asdfgh asdfghjkl yxcvbnm zxcvbnm azerty letmein welcome monkey dragon ' +
    'master sunshine princess football baseball shadow superman batman trustno1 iloveyou admin administrator login starwars hallo ' +
    'hallo123 hallowelt schatz schatzi fussball bayern geheim michael jordan harley ranger hunter ashley jennifer jessica ' +
    'charlie thomas daniel andrew joshua robert freedom whatever cheese secret changeme default test testtest testing guest ' +
    'internet computer samsung mustang soccer hockey killer pepper tigger buster ginger summer winter flower matrix naruto pokemon ' +
    // German: the most common choices (also without umlauts), love phrases, keyboard and club names; trailing digits are ignored
    'ichliebedich ichliebedichso ichhasseeuch ichbinich ichbinhier ichweissnicht ichwillnicht ichbindoof meinschatz meinschatzi meinpasswort ' +
    'meinpassword meinpasswort1 meingeheimnis geheimespasswort geheimnis passwort1234 passwortpasswort kennwort1234 hallo1234 hallowelt ' +
    'hallohallo guten gutenmorgen gutentag gutenabend sonnenschein sonnenblume regenbogen schmetterling einhorn mausebaer mausebaerchen ' +
    'schatzilein liebling lieblingsmensch mamaundpapa mutter vater familie deutschland deutschland1 fussballfan fcbayern fcbayernmuenchen ' +
    'bayernmuenchen borussia borussiadortmund werderbremen hamburgersv eintracht schalke04 sommer sommerferien winterzeit herbstwind ' +
    'fruehling sonne mond sterne wasserfall computer1 passwortmanager zugangscode zugangsdaten benutzer benutzername startseite uni ' +
    'unibamberg bamberg1 wiai wiaibamberg zeitnotizen testtesttest abc12345 abcdefgh abcdefghijkl qwertz123 qwertzuiop1 asdf1234 ' +
    'asdfghjkl1 yxcvbnm123 iloveyou1 ichliebedichmein dubistmeinschatz duundich wirliebenunsere').split(' ');

  // Common words (English and German) the estimate treats as cheap building blocks.
  var COMMON_WORDS = ('love hello welcome monkey dragon master sunshine princess football baseball shadow superman batman iloveyou ' +
    'admin login letmein secret trust summer winter spring autumn flower soccer hockey basketball computer internet freedom whatever ' +
    'cheese chocolate coffee banana orange apple lemon cookie butter hunter ranger tiger lion eagle wolf bear horse mustang ferrari ' +
    'porsche mercedes cowboy pirate ninja wizard magic secure killer maverick starwars matrix pokemon naruto harry potter jordan ' +
    'michael jennifer jessica ashley daniel thomas andrew joshua robert charlie buster hannah nicole samantha tigger snoopy pepper ' +
    'jesus angel silver golden purple yellow green black white blue red heaven hell money cash dollar friend family mother father ' +
    'sister brother happy lucky smile forever always never everything nothing someone anything people queen king prince knight castle ' +
    'dream night moon star stars sun rain snow fire water earth wind game gamer player lord god house home work school teacher ' +
    'student college office phone mobile email mail user guest test testing tester default change changeme passwort password pass word ' +
    'hallo geheim schatz schatzi liebe liebling sommer winter fruehling fruhling herbst sonne mond sterne blume blumen fussball fussball ' +
    'bayern muenchen munchen dortmund schalke hertha berlin hamburg koeln frankfurt stuttgart bamberg nuernberg nurnberg franken ' +
    'deutschland deutsch hund katze maus pferd baer adler drache ritter prinzessin koenig kaiser engel himmel hoelle teufel mutter vater ' +
    'schwester bruder oma opa freund freundin familie glueck gluecklich lachen immer niemals alles nichts haus auto fahrrad kuchen ' +
    'wasser feuer erde luft regen schnee nacht tag morgen abend montag dienstag mittwoch donnerstag freitag samstag sonntag januar ' +
    'februar maerz april mai juni juli august september oktober november dezember uni universitaet student studium professor wiai psi ' +
    'otto friedrich schule lehrer arbeit buero rechner tastatur handy telefon netz bier wein kaffee schokolade pizza nudeln mein meine ' +
    'dein deine bitte danke gut super toll cool echt klar blau rot gruen gelb schwarz weiss lila orange hallo hello hey hi ich du wir ' +
    'ihr sie und der die das ein eine mit von zum zur ist sind the and you your for with this that have not are was were ' +
    // German function words and everyday words that make up most weak phrases
    'dich mich dir mir uns euch ihn ihm liebe lieben lieb hab habe haben bin bist sein war wird will kann soll muss doch noch nicht nur auch ' +
    'aber oder wie was wer wo wann warum mal ja nein jetzt heute gestern morgen hier dort mein meinen meiner dein deinen sehr viel viele alle ' +
    'ganz gern gerne wirklich einfach immer nie niemals leben welt zeit mensch kind kinder frau mann junge maedchen baby hase baerchen ' +
    'schaf kuh ente fisch vogel tier katzen hunde auge hand herz kopf bauch kuss kuessen gluecklich traurig schoen schoene gross klein neu alt ' +
    'stark schnell langsam bunt dunkel hell warm kalt heiss rot gelb schnee eis berg meer see strand wald wiese garten stadt land strasse ' +
    'bruecke turm tor tuer fenster tisch stuhl bett lampe buch zeitung musik lied tanz spiel sport ball tor club verein').split(' ');
  var COMMON_SET = {}, WORD_SET = {};
  COMMON_EXACT.forEach(function (w) { COMMON_SET[w] = true; if (w.length >= 3) WORD_SET[w] = true; });
  COMMON_WORDS.forEach(function (w) { if (w.length >= 3) WORD_SET[w] = true; });
  var WORD_COUNT = Object.keys(WORD_SET).length;
  var KEY_ROWS = ['qwertzuiopue', 'qwertyuiop', 'asdfghjkl', 'yxcvbnm', 'zxcvbnm', '1234567890', 'azertyuiop', 'qaywsxedcrfvtgb', 'qazwsxedcrfvtgbyhn', '1q2w3e4r5t6z7u8i9o0p', '1q2w3e4r5t6y7u8i9o0p'];

  function deleet(s, ones) {
    var map = { '@': 'a', '4': 'a', '3': 'e', '0': 'o', '$': 's', '5': 's', '7': 't', '+': 't', '!': 'i', '8': 'b', '|': 'l', '1': ones };
    return s.replace(/[@43015$7+!8|]/g, function (c) { return map[c]; });
  }
  function dictLookup(seg) { // -> extra bits (0 = plain word, more for variants) or -1 when not a word
    if (WORD_SET[seg]) return 0;
    var a = deleet(seg, 'i'), b = deleet(seg, 'l');
    if (a !== seg && WORD_SET[a]) return 2;
    if (b !== seg && WORD_SET[b]) return 2;
    return -1;
  }
  function litCost(ch) {
    if (/[0-9]/.test(ch)) return 3.3;
    if (/[a-z]/.test(ch)) return 3.6;
    if (/[A-Z]/.test(ch)) return 4.7;
    if (ch.charCodeAt(0) < 128) return 4.8;
    return 4.5;
  }
  // Rough guessing-effort estimate in bits: cheapest way to build the passphrase from literal characters, dictionary
  // words, repeats, sequences, keyboard walks and years. A heuristic, not a proof; documented in PLAN 5.3.
  function estimate(pass) {
    var chars = Array.from(String(pass).slice(0, 200)), n = chars.length;
    var lower = chars.map(function (c) { return c.toLowerCase(); });
    var INF = 1e9, cost = new Array(n + 1), i, k, len;
    for (i = 0; i <= n; i++) cost[i] = INF;
    cost[0] = 0;
    function relax(to, c) { if (c < cost[to]) cost[to] = c; }
    for (i = 0; i < n; i++) {
      if (cost[i] >= INF) continue;
      var base = cost[i];
      relax(i + 1, base + litCost(chars[i]));
      // dictionary words (3 to 16 characters), a little extra for capitals and look-alike digits
      for (len = 3; len <= 16 && i + len <= n; len++) {
        var seg = lower.slice(i, i + len).join('');
        var extra = dictLookup(seg);
        if (extra >= 0) {
          var caps = chars.slice(i, i + len).some(function (c, idx) { return c !== lower[i + idx]; }) ? 1.5 : 0;
          relax(i + len, base + Math.log2(WORD_COUNT) + 1 + extra + caps);
        }
      }
      // years
      if (i + 4 <= n && /^(19|20)[0-9]{2}$/.test(chars.slice(i, i + 4).join(''))) relax(i + 4, base + 6.6);
      // repeats of the previous block of 1 to 8 characters
      for (k = 1; k <= 8 && k <= i; k++) {
        var run = 0;
        while (i + run < n && chars[i + run] === chars[i + run - k]) run++;
        for (len = Math.max(3, k); len <= run; len++) relax(i + len, base + 2 + Math.log2(len / k + 1));
      }
      // sequences (abc, 321) and keyboard walks
      [1, -1].forEach(function (dir) {
        var run2 = 1;
        while (i + run2 < n && lower[i + run2].codePointAt(0) - lower[i + run2 - 1].codePointAt(0) === dir && /[a-z0-9]/.test(lower[i + run2])) run2++;
        for (var l2 = 3; l2 <= run2; l2++) relax(i + l2, base + 4 + Math.log2(l2));
      });
      for (len = 3; i + len <= n; len++) {
        var s2 = lower.slice(i, i + len).join(''), hit = false;
        for (var r = 0; r < KEY_ROWS.length && !hit; r++) {
          var row = KEY_ROWS[r];
          if (row.indexOf(s2) >= 0 || row.split('').reverse().join('').indexOf(s2) >= 0) hit = true;
        }
        if (!hit) break;
        relax(i + len, base + 4 + Math.log2(len));
      }
    }
    var bits = n === 0 ? 0 : cost[n];
    var score = bits < BLOCK_BITS ? 0 : bits < 48 ? 1 : bits < 60 ? 2 : bits < 76 ? 3 : 4;
    return { bits: Math.round(bits * 10) / 10, score: score };
  }
  function normalizeForCommon(pass) {
    var l = String(pass).toLowerCase(), out = {};
    // umlauts as typed on a keyboard without them: ä to ae or a, and so on
    var folded = l.replace(/[äöüß]/g, function (c) { return { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }[c]; });
    var plain = l.replace(/[äöüß]/g, function (c) { return { 'ä': 'a', 'ö': 'o', 'ü': 'u', 'ß': 's' }[c]; });
    // also with every separator and digit taken out: "Ich-Liebe-Dich-123!" is "ichliebedich"
    var lettersOnly = function (s) { return s.replace(/[^a-z]+/g, ''); };
    [l, folded, plain, deleet(l, 'i'), deleet(l, 'l'), deleet(folded, 'i'), lettersOnly(folded), lettersOnly(plain), lettersOnly(deleet(folded, 'i')), lettersOnly(deleet(folded, 'l'))].forEach(function (v) {
      out[v] = true;
      out[v.replace(/[^a-z]+$/, '')] = true; // trailing digits and symbols
    });
    return Object.keys(out);
  }
  // Synchronous rules: returns {ok, code: null|'empty'|'short'|'common'|'weak', n, estimate}. strict: no breach check is
  // available (switched off for the app, or unreachable), so the local estimate has to carry more weight.
  function checkLocal(pass, strict) {
    pass = String(pass || '').normalize('NFC');
    var est = estimate(pass);
    if (pass.length === 0) return { ok: false, code: 'empty', estimate: est };
    var len = Array.from(pass).length;
    if (len < MIN_PASSPHRASE) return { ok: false, code: 'short', n: len, estimate: est };
    if (normalizeForCommon(pass).some(function (v) { return COMMON_SET[v]; })) return { ok: false, code: 'common', estimate: est };
    if (est.bits < BLOCK_BITS) return { ok: false, code: 'weak', estimate: est };
    if (strict && est.bits < STRICT_BITS) return { ok: false, code: 'weak', strict: true, estimate: est };
    return { ok: true, code: null, estimate: est };
  }
  // Pwned Passwords range query with padding. Only the first 5 hex characters of SHA-1 leave the device.
  async function hibpCheck(pass, o) {
    o = o || {};
    var f = o.fetch || (typeof fetch === 'function' ? fetch.bind(root) : null);
    if (!f) return { status: 'unavailable' };
    var digest = hexUpper(new Uint8Array(await root.crypto.subtle.digest('SHA-1', utf8(String(pass).normalize('NFC')))));
    var prefix = digest.slice(0, 5), suffix = digest.slice(5);
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, o.timeoutMs || 8000) : null;
    try {
      var res = await f((o.url || HIBP_URL) + prefix, {
        method: 'GET', headers: { 'Add-Padding': 'true' }, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res.ok) return { status: 'unavailable' };
      var text = await res.text(), lines = text.split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        var m = /^([0-9A-Fa-f]{35}):(\d+)/.exec(lines[i].trim());
        if (m && m[1].toUpperCase() === suffix) {
          var count = Number(m[2]);
          if (count > 0) return { status: 'pwned', count: count };
        }
      }
      return { status: 'ok' };
    } catch (e) {
      return { status: 'unavailable' };
    } finally { if (timer) clearTimeout(timer); }
  }
  // Full check used by the dialogs: local rules first, then HIBP when enabled.
  async function checkPassphrase(pass, o) {
    o = o || {};
    var local = checkLocal(pass);
    if (!local.ok) return local;
    if (o.hibp === false) {
      return Object.assign({ hibp: { status: 'skipped' } }, checkLocal(pass, true));
    }
    var h = await hibpCheck(pass, o);
    if (h.status === 'pwned') return { ok: false, code: 'pwned', count: h.count, estimate: local.estimate, hibp: h };
    if (h.status !== 'ok') { var s2 = checkLocal(pass, true); if (!s2.ok) return Object.assign({ hibp: h }, s2); }
    return Object.assign({ hibp: h }, local);
  }

  // ------------------------------------------------------------------------------------------------------------
  // 4. Minimal ZIP writer (store only, UTF-8 names) and the export layout
  // ------------------------------------------------------------------------------------------------------------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  // entries: [{name, data: Uint8Array|string}]. Returns a Blob. No compression, no Zip64 (limits are checked).
  function makeZip(entries, when) {
    var d = when || new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var dosDate = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    if (entries.length > 65535) throw new Core.WDSError('too many entries for one ZIP file');
    var parts = [], central = [], offset = 0;
    entries.forEach(function (e) {
      var name = utf8(e.name), data = typeof e.data === 'string' ? utf8(e.data) : e.data;
      if (name.length > 65535 || data.length > 0xfffffffe) throw new Core.WDSError('entry too large for a ZIP file');
      var crc = crc32(data);
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
      if (offset > 0xfffffff0) throw new Core.WDSError('archive too large for a ZIP file (4 GiB limit)');
    });
    var cdSize = 0;
    central.forEach(function (c) { cdSize += c.length; });
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
    end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
  }

  // File name endings for files whose record name has none (the MIME type tells what they are).
  var MIME_EXT = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg', 'image/bmp': '.bmp',
    'application/pdf': '.pdf', 'application/zip': '.zip', 'application/json': '.json', 'text/plain': '.txt', 'text/csv': '.csv', 'text/html': '.html',
    'text/markdown': '.md', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'video/mp4': '.mp4', 'video/webm': '.webm',
  };
  function extForMime(mime) { return MIME_EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || ''; }
  // Path inside the archive for a record: keeps folders, adds ".json" to JSON records and an ending that matches the MIME type
  // to files without one, avoids collisions.
  function archivePaths(records, reserved) {
    var used = {}, out = [];
    (reserved || []).forEach(function (r) { used[r.toLowerCase()] = true; });
    records.forEach(function (r) {
      var p = fileSafe(r.name);
      if (r.kind === 'json' && !/\.json$/i.test(p)) p += '.json';
      else if (r.kind === 'bytes' && !/\.[A-Za-z0-9]{1,8}$/.test(p.slice(p.lastIndexOf('/') + 1))) p += extForMime(r.mime);
      var candidate = p, n = 2;
      while (used[candidate.toLowerCase()]) {
        var dot = p.lastIndexOf('.'), slash = p.lastIndexOf('/');
        candidate = dot > slash + 1 ? p.slice(0, dot) + ' (' + n + ')' + p.slice(dot) : p + ' (' + n + ')';
        n++;
      }
      used[candidate.toLowerCase()] = true;
      out.push(candidate);
    });
    return out;
  }
  function recordBytes(r) {
    if (r.kind === 'json') return utf8(JSON.stringify(r.value, null, 2) + '\n');
    var v = r.value;
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return utf8(String(v));
  }
  // records: [{name, kind, mime, version, time, value}] -> {blob, manifest}
  function buildArchive(records, meta) {
    var paths = archivePaths(records, ['wds-export.json', 'README.txt']);
    var entries = [], list = [];
    records.forEach(function (r, i) {
      var data = recordBytes(r);
      entries.push({ name: paths[i], data: data });
      list.push({ name: r.name, file: paths[i], kind: r.kind, mime: r.mime || null, version: r.version === undefined ? null : r.version, time: r.time === undefined ? null : r.time, size: data.length });
    });
    var manifest = { format: 'wds-export', v: 1, scope: meta.scope, service: meta.service, exported: meta.exported, note: meta.note || undefined, records: list };
    var readme = 'WIAI Datastore export\r\n\r\nApp (scope): ' + meta.scope + '\r\nExported: ' + meta.exported + '\r\n\r\n' +
      'Every entry of the vault is stored as a file. JSON entries got the ending .json; files without an ending got one that matches their type.\r\n\r\n' +
      'wds-export.json maps each entry name to its file and lists kind, MIME type, version and size.\r\n\r\n' +
      'The files are NOT encrypted: keep them safe.\r\n';
    entries.unshift({ name: 'wds-export.json', data: JSON.stringify(manifest, null, 2) + '\n' }, { name: 'README.txt', data: readme });
    return { blob: makeZip(entries, new Date(meta.exported)), manifest: manifest };
  }

  // ------------------------------------------------------------------------------------------------------------
  // 5. Access sheet (printable HTML)
  // ------------------------------------------------------------------------------------------------------------
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  // o: {appName, scope, accessId (display), recoveryCode (display)|null, service, created (ms), role}
  function buildSheetHtml(o, t, lang) {
    var rows = [[t('sheet.app'), o.appName + ' (' + o.scope + ')'], [t('sheet.accessId'), o.accessId]];
    if (o.recoveryCode) rows.push([t('sheet.recovery'), o.recoveryCode]);
    if (o.role) rows.push([t('sheet.access'), t('role.' + o.role)]);
    rows.push([t('sheet.created'), formatTime(Math.floor(o.created / 1000), lang)], [t('sheet.service'), o.service]);
    var body = rows.map(function (r, i) {
      var code = (i === 1 || (i === 2 && o.recoveryCode)) ? ' class="code"' : '';
      return '<tr><th scope="row">' + esc(r[0]) + '</th><td' + code + '>' + esc(r[1]) + '</td></tr>';
    }).join('');
    return '<!DOCTYPE html>\n<html lang="' + lang + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + esc(t('sheet.page.title') + ' - ' + o.appName) + '</title><style>' +
      'body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#111}' +
      'h1{font-size:1.6rem;margin:0 0 .25rem}table{border-collapse:collapse;width:100%;margin:1.25rem 0}' +
      'th,td{text-align:left;padding:.55rem .75rem;border:1px solid #888;vertical-align:top}th{width:11rem;font-weight:600;background:#f2f2f2}' +
      'td.code{font:600 1.35rem/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.06em}' +
      '.box{border:1px solid #888;padding:.6rem .9rem;margin:1rem 0;border-radius:4px}.box h2{font-size:1rem;margin:0 0 .25rem}' +
      'button{font:inherit;padding:.4rem .9rem}@media print{.noprint{display:none}body{margin:0}}</style></head><body>' +
      '<h1>' + esc(o.sandbox ? t('sandbox.sheet.title') : t('sheet.page.title')) + '</h1><p>' + esc(o.recoveryCode ? t('sheet.intro.owner') : t('sheet.intro.member')) + '</p>' +
      '<table>' + body + '</table>' +
      '<p>' + esc(t('sheet.passphrase.note')) + '</p>' +
      (o.recoveryCode ? '<p>' + esc(t('sheet.recovery.note')) + '</p>' : '') + (o.sandbox ? '<p>' + esc(t('sandbox.sheet.note')) + '</p>' : '') +
      '<div class="box"><h2>' + esc(t('sheet.escrow.title')) + '</h2><p style="margin:0">' + esc(t('sheet.escrow.text')) + '</p></div>' +
      '<p class="noprint"><button type="button" onclick="window.print()">' + esc(t('sheet.page.print')) + '</button></p>' +
      '</body></html>\n';
  }

  // ------------------------------------------------------------------------------------------------------------
  // 6. Styles, dialog stack, focus trap, notifications
  // ------------------------------------------------------------------------------------------------------------
  var CSS = [
    '.wds-root{--_bg:var(--wds-bg,#fff);--_fg:var(--wds-fg,#1b1f24);--_muted:var(--wds-muted,#566170);--_border:var(--wds-border,#b9c0ca);',
    '--_accent:var(--wds-accent,#1c58b5);--_accent-fg:var(--wds-accent-fg,#fff);--_danger:var(--wds-danger,#b3261e);--_warn:var(--wds-warn,#8a5a00);',
    '--_ok:var(--wds-ok,#1b6e3c);--_soft:var(--wds-soft,#f1f3f6);--_radius:var(--wds-radius,10px);',
    '--_font:var(--wds-font,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif);',
    '--_mono:var(--wds-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);--_backdrop:var(--wds-backdrop,rgba(15,20,30,.55));',
    '--_shadow:var(--wds-shadow,0 18px 50px rgba(0,0,0,.35));font-family:var(--_font);font-size:var(--wds-font-size,16px);line-height:1.5;color:var(--_fg)}',
    '@media (prefers-color-scheme:dark){.wds-root{--_bg:var(--wds-bg,#1d2128);--_fg:var(--wds-fg,#e9ecf0);--_muted:var(--wds-muted,#a5afbc);',
    '--_border:var(--wds-border,#434c59);--_accent:var(--wds-accent,#7db0ff);--_accent-fg:var(--wds-accent-fg,#0a1a33);--_danger:var(--wds-danger,#ff9a90);',
    '--_warn:var(--wds-warn,#f0c36a);--_ok:var(--wds-ok,#78d9a0);--_soft:var(--wds-soft,#272d36)}}',
    '.wds-root *,.wds-root *::before,.wds-root *::after{box-sizing:border-box}',
    '.wds-overlay{position:fixed;inset:0;z-index:var(--wds-z,2147483000);display:flex;align-items:flex-start;justify-content:center;overflow:auto;overscroll-behavior:contain;',
    'padding:max(1rem,6vh) 1rem 1rem;background:var(--_backdrop)}',
    '.wds-dialog{width:100%;max-width:34rem;background:var(--_bg);color:var(--_fg);border-radius:var(--_radius);box-shadow:var(--_shadow);outline:0}',
    '.wds-dialog-wide{max-width:46rem}',
    '.wds-dragover .wds-dialog{outline:3px dashed var(--_accent);outline-offset:3px}',
    '.wds-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;padding:1.15rem 1.4rem .3rem}',
    '.wds-title{margin:0;font-size:1.25rem;line-height:1.3;font-weight:650;color:inherit}',
    '.wds-sub{margin:.15rem 0 0;color:var(--_muted);font-size:.9rem}',
    '.wds-body{padding:.5rem 1.4rem 1.4rem}',
    '.wds-body p{margin:.6rem 0}',
    '.wds-x{font:inherit;line-height:1;background:none;border:0;color:var(--_muted);font-size:1.6rem;padding:.1rem .4rem;cursor:pointer;border-radius:6px}',
    '.wds-field{margin:.95rem 0}',
    '.wds-label{display:block;font-weight:600;margin:0 0 .25rem}',
    '.wds-hint{color:var(--_muted);font-size:.875rem;margin:.3rem 0 0}',
    '.wds-input,.wds-select{display:block;width:100%;padding:.55rem .65rem;border:1px solid var(--_border);border-radius:calc(var(--_radius) - 4px);background:var(--_bg);color:inherit;font:inherit}',
    '.wds-mono{font-family:var(--_mono);letter-spacing:.05em}',
    // Host pages often style bare input and label elements (width:100%, min-height, display:block); the rows of the dialogs must not
    // depend on that, so these rules are specific enough to win and reset what such global rules set.
    '.wds-root .wds-check{display:flex;gap:.55rem;align-items:flex-start;margin:.5rem 0}',
    '.wds-root .wds-check input[type=checkbox]{-webkit-appearance:checkbox;appearance:auto;box-sizing:border-box;flex:none;width:1.1rem;height:1.1rem;min-width:0;min-height:0;max-width:none;padding:0;margin:.2rem 0 0;border:revert;background:revert}',
    '.wds-root .wds-check label{display:block;flex:1 1 auto;min-width:0;margin:0;padding:0;font:inherit;font-weight:400;line-height:inherit;color:inherit;text-transform:none;letter-spacing:normal}',
    '.wds-btn{font:inherit;padding:.55rem 1rem;border:1px solid var(--_border);background:var(--_soft);color:inherit;border-radius:calc(var(--_radius) - 4px);cursor:pointer;display:inline-block;text-decoration:none;line-height:1.3}',
    '.wds-btn:hover{border-color:var(--_accent)}',
    '.wds-btn-primary{background:var(--_accent);color:var(--_accent-fg);border-color:var(--_accent);font-weight:600}',
    '.wds-btn-danger{background:var(--_danger);color:var(--_bg);border-color:var(--_danger);font-weight:600}',
    '.wds-btn-small{padding:.3rem .65rem;font-size:.875rem}',
    '.wds-btn[disabled],.wds-input[disabled],.wds-select[disabled]{opacity:.55;cursor:not-allowed}',
    '.wds-link{font:inherit;background:none;border:0;padding:0;color:var(--_accent);text-decoration:underline;cursor:pointer}',
    '.wds-actions{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;margin-top:1.15rem}',
    '.wds-spacer{flex:1 1 auto}',
    '.wds-root :focus-visible{outline:3px solid var(--_accent);outline-offset:2px}',
    '.wds-vh{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;padding:0;margin:-1px}',
    '.wds-btn:focus-within{outline:3px solid var(--_accent);outline-offset:2px}',
    '.wds-msg{margin:.8rem 0;padding:.6rem .8rem;border-left:4px solid var(--_accent);background:var(--_soft);border-radius:0 calc(var(--_radius) - 4px) calc(var(--_radius) - 4px) 0}',
    '.wds-msg-error{border-left-color:var(--_danger)}.wds-msg-warn{border-left-color:var(--_warn)}.wds-msg-ok{border-left-color:var(--_ok)}',
    '.wds-error{color:var(--_danger);font-weight:600;margin:.5rem 0 0}',
    '.wds-meter{height:.4rem;background:var(--_soft);border:1px solid var(--_border);border-radius:99px;overflow:hidden;margin-top:.5rem}',
    '.wds-meter-bar{height:100%;width:0;background:var(--_danger);transition:width .15s}',
    '.wds-meter-bar[data-level="2"]{background:var(--_warn)}.wds-meter-bar[data-level="3"],.wds-meter-bar[data-level="4"]{background:var(--_ok)}',
    '.wds-strength{margin:.3rem 0 0;font-size:.875rem;color:var(--_muted)}',
    '.wds-box{border:1px solid var(--_border);border-radius:calc(var(--_radius) - 2px);padding:.7rem .9rem;margin:1rem 0;background:var(--_soft)}',
    '.wds-box h3{margin:0 0 .25rem;font-size:1rem}.wds-box p{margin:.25rem 0}',
    '.wds-code{font:600 1rem/1.5 var(--_mono);letter-spacing:.04em;padding:.55rem .75rem;border:1px solid var(--_border);border-radius:calc(var(--_radius) - 4px);background:var(--_soft);white-space:nowrap;overflow-x:auto;user-select:all}',
    '.wds-g{display:inline-block}',
    '.wds-body>.wds-section:first-child{border-top:0;margin-top:.2rem;padding-top:0}',
    '.wds-dl{display:grid;grid-template-columns:max-content 1fr;gap:.45rem .9rem;margin:1rem 0}.wds-dl dt{font-weight:600}.wds-dl dd{margin:0;min-width:0}',
    '.wds-section{border-top:1px solid var(--_border);margin-top:1.4rem;padding-top:1rem}.wds-section>h3{margin:0 0 .4rem;font-size:1.05rem}',
    '.wds-people{list-style:none;margin:.4rem 0;padding:0}',
    '.wds-person{display:flex;flex-wrap:wrap;gap:.5rem .9rem;align-items:center;border:1px solid var(--_border);border-radius:calc(var(--_radius) - 2px);padding:.65rem .8rem;margin:.5rem 0}',
    '.wds-person-main{flex:1 1 13rem;min-width:0}.wds-person-name{font-weight:600}.wds-person-info{color:var(--_muted);font-size:.875rem}',
    '.wds-person-new{border-color:var(--_accent)}',
    '.wds-badge{display:inline-block;font-size:.75rem;font-weight:500;padding:.05rem .5rem;margin-left:.4rem;border-radius:99px;border:1px solid var(--_border);background:var(--_soft);color:var(--_muted);vertical-align:.1em}',
    '.wds-compare{display:grid;grid-template-columns:1fr 1fr;gap:.8rem;margin:1rem 0}',
    '@media (max-width:36rem){.wds-compare{grid-template-columns:1fr}.wds-dl{grid-template-columns:1fr}.wds-code{font-size:.875rem;letter-spacing:.02em}}',
    '@media (max-width:24rem){.wds-code{white-space:normal;overflow-wrap:anywhere;font-size:.8125rem}}',
    '.wds-pane{border:1px solid var(--_border);border-radius:calc(var(--_radius) - 2px);padding:.65rem .75rem;min-width:0}',
    '.wds-pane h3{margin:0;font-size:1rem}.wds-pane .wds-sub{margin:0 0 .3rem}',
    '.wds-pre{margin:.4rem 0 0;padding:.5rem;max-height:13rem;overflow:auto;font:.8125rem/1.45 var(--_mono);white-space:pre-wrap;word-break:break-word;background:var(--_soft);border-radius:6px}',
    '.wds-progress{width:100%;height:1rem;margin:.6rem 0}',
    '.wds-spin{display:inline-block;width:1em;height:1em;border:2px solid var(--_border);border-top-color:var(--_accent);border-radius:50%;animation:wds-rot .8s linear infinite;vertical-align:-.15em;margin-right:.45rem}',
    '@keyframes wds-rot{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.wds-spin{animation:none}.wds-meter-bar{transition:none}}',
    '.wds-fs{border:0;margin:0;padding:0;min-width:0}',
    '.wds-details{margin:.9rem 0}.wds-details>summary{cursor:pointer;font-weight:600}',
    '.wds-toasts{position:fixed;right:1rem;bottom:1rem;z-index:calc(var(--wds-z,2147483000) + 1);display:flex;flex-direction:column;gap:.5rem;width:min(26rem,calc(100vw - 2rem));pointer-events:none}',
    '.wds-toast{pointer-events:auto;background:var(--_bg);color:var(--_fg);border:1px solid var(--_border);border-left:5px solid var(--_accent);border-radius:calc(var(--_radius) - 2px);padding:.7rem .85rem;box-shadow:var(--_shadow)}',
    '.wds-toast-warn{border-left-color:var(--_warn)}.wds-toast-error{border-left-color:var(--_danger)}.wds-toast-ok{border-left-color:var(--_ok)}',
    '.wds-toast p{margin:0}.wds-toast-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.5rem}',
    '@media (max-width:36rem){.wds-toasts{left:.5rem;right:.5rem;bottom:.5rem;width:auto;max-height:40vh;overflow:auto}.wds-toast{padding:.5rem .7rem}}',
    '.wds-act{margin:.7rem 0}.wds-act .wds-hint{margin-top:.3rem}',
  ].join('');

  function ensureStyle() {
    if (document.getElementById('wds-style')) return;
    var st = document.createElement('style');
    st.id = 'wds-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  var stack = [];
  var inertChanged = [];
  var restoreFocusTo = null;
  var focusGuard = null;

  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
  function focusables(node) {
    return Array.prototype.filter.call(node.querySelectorAll(FOCUSABLE), function (n) {
      return !n.hasAttribute('inert') && (n.offsetWidth > 0 || n.offsetHeight > 0 || n.getClientRects().length > 0);
    });
  }
  function setPageInert(on) {
    if (on) {
      Array.prototype.forEach.call(document.body.children, function (c) {
        if (c.classList.contains('wds-root') || c.hasAttribute('inert') || c.tagName === 'SCRIPT' || c.tagName === 'STYLE') return;
        c.setAttribute('inert', '');
        inertChanged.push(c);
      });
    } else {
      inertChanged.forEach(function (c) { c.removeAttribute('inert'); });
      inertChanged = [];
    }
  }
  function onFocusIn(ev) {
    var top = stack[stack.length - 1];
    if (!top) return;
    if (top.overlay.contains(ev.target)) return;
    if (ev.target.closest && ev.target.closest('.wds-toasts')) return;
    var f = focusables(top.dialog);
    (f[0] || top.dialog).focus();
  }

  // The banner of a sandbox scope: inline !important styles, so that CSS of the host page cannot hide it.
  function pinVisible(node, extra) {
    node.style.setProperty('display', 'block', 'important');
    node.style.setProperty('visibility', 'visible', 'important');
    node.style.setProperty('opacity', '1', 'important');
    if (extra) Object.keys(extra).forEach(function (k) { node.style.setProperty(k, extra[k], 'important'); });
    return node;
  }
  function sandboxBanner(S) {
    var sb = S.info && S.info.sandbox;
    return pinVisible(el('div', { class: 'wds-msg wds-msg-warn', role: 'note', 'data-wds': 'sandbox-banner', text: S.t('sandbox.banner', { time: formatTime(sb.next_wipe, S.lang) }) }),
      { margin: '0', 'border-radius': '10px 10px 0 0', padding: '.55rem 1.4rem', 'font-size': '.9rem', 'background-color': '#fff4cc', color: '#3d2b00', 'border-left': '0', 'border-bottom': '2px solid #b58100' });
  }
  function isSandbox(S) { return !!(S.info && S.info.sandbox); }
  // Many apps share the one sandbox scope: its name alone does not say which app is being tested. In a sandbox the page title
  // (trimmed, at most 60 characters) comes first, then the scope name; elsewhere the scope name is the app.
  function pageTitle() {
    var s = String((typeof document !== 'undefined' && document.title) || '').replace(/\s+/g, ' ').trim();
    return s.length > 60 ? s.slice(0, 59).trim() + '…' : s;
  }
  function appLabel(S, name) {
    var pt = isSandbox(S) ? pageTitle() : '';
    return pt && pt !== name ? pt + ' – ' + name : name;
  }
  // The file name of a key file: in a sandbox it starts with the page title, so that the files of several tested apps can be told apart.
  function keyFileName(S, kf) {
    var slug = isSandbox(S) ? pageTitle().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') : '';
    return slug ? slug + '-' + kf.filename : kf.filename;
  }
  function sandboxPrefix(S) { return isSandbox(S) ? S.t('sandbox.prefix') : ''; }
  // Opens a library dialog for this store: language, and in a sandbox the title prefix and the banner.
  function dialogFor(S, o) {
    o.lang = S.lang;
    if (isSandbox(S)) { o.titlePrefix = sandboxPrefix(S); o.banner = sandboxBanner(S); }
    return openDialog(o);
  }

  // o: {title, view, cancelable, wide, role, sandbox (scope info of a sandbox: title prefix + banner), onClose(result)}. Returns the dialog handle.
  // Every dialog carries data-wds-view (its current view, see setView) and, in a sandbox, the banner.
  function openDialog(o) {
    ensureStyle();
    var titleId = uid('wds-title');
    var overlay = el('div', { class: 'wds-overlay wds-root', lang: o.lang });
    var dialog = el('div', { class: 'wds-dialog' + (o.wide ? ' wds-dialog-wide' : ''), role: o.role || 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1', 'data-wds-view': o.view });
    var prefix = o.titlePrefix || '', rawTitle = o.title || '', bareTitle = false;
    var title = el('h2', { class: 'wds-title', id: titleId, text: prefix + rawTitle });
    var body = el('div', { class: 'wds-body' });
    var d = { overlay: overlay, dialog: dialog, body: body, title: title, closed: false, cancelable: !!o.cancelable };
    var closeBtn = o.cancelable ? el('button', { type: 'button', class: 'wds-x', 'aria-label': o.closeLabel || 'Close', 'data-wds': 'close', onclick: function () { d.close(undefined); } }, '×') : null;
    append(dialog, [o.banner || null, el('div', { class: 'wds-head' }, [title, closeBtn]), body]);
    overlay.appendChild(dialog);
    overlay.addEventListener('keydown', function (ev) {
      if (stack[stack.length - 1] !== d) return;
      if (ev.key === 'Escape' && d.cancelable) { ev.stopPropagation(); d.close(undefined); return; }
      if (ev.key !== 'Tab') return;
      var f = focusables(dialog);
      if (!f.length) { ev.preventDefault(); dialog.focus(); return; }
      var first = f[0], lastEl = f[f.length - 1], active = document.activeElement;
      if (ev.shiftKey && (active === first || active === dialog)) { ev.preventDefault(); lastEl.focus(); }
      else if (!ev.shiftKey && active === lastEl) { ev.preventDefault(); first.focus(); }
    });
    function paintTitle() { title.textContent = (bareTitle ? '' : prefix) + rawTitle; }
    d.setTitle = function (s, bare) { rawTitle = s; bareTitle = !!bare; paintTitle(); };
    // The scope turned out to be a sandbox after the dialog was opened (the first view loads the scope information).
    d.applySandbox = function (S) {
      if (!isSandbox(S)) return;
      prefix = sandboxPrefix(S); paintTitle();
      var old = dialog.querySelector('[data-wds="sandbox-banner"]');
      if (old) old.parentNode.removeChild(old);
      dialog.insertBefore(sandboxBanner(S), dialog.firstChild);
    };
    d.setView = function (v) { dialog.setAttribute('data-wds-view', v); };
    d.setCancelable = function (on) { d.cancelable = !!on; if (closeBtn) closeBtn.disabled = !on; };
    d.focusFirst = function () {
      var f = focusables(body);
      (f[0] || dialog).focus();
    };
    d.close = function (result) {
      if (d.closed) return;
      d.closed = true;
      var idx = stack.indexOf(d);
      if (idx >= 0) stack.splice(idx, 1);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      var top = stack[stack.length - 1];
      if (top) top.overlay.removeAttribute('inert');
      if (!stack.length) {
        setPageInert(false);
        document.removeEventListener('focusin', onFocusIn, true);
        var back = restoreFocusTo;
        restoreFocusTo = null;
        if (back && back.focus && document.contains(back)) { try { back.focus(); } catch (e) { /* ignore */ } }
      } else top.dialog.focus();
      if (o.onClose) o.onClose(result);
    };
    if (!stack.length) {
      restoreFocusTo = document.activeElement;
      document.addEventListener('focusin', onFocusIn, true);
    } else stack[stack.length - 1].overlay.setAttribute('inert', '');
    stack.push(d);
    document.body.appendChild(overlay);
    if (stack.length === 1) setPageInert(true);
    dialog.focus();
    return d;
  }

  // ---- notifications ----
  var toastRegionEl = null;
  function toastRegion(label) {
    ensureStyle();
    if (toastRegionEl && document.body.contains(toastRegionEl)) return toastRegionEl;
    toastRegionEl = el('div', { class: 'wds-toasts wds-root', role: 'region', 'aria-label': label || 'Notifications' });
    document.body.appendChild(toastRegionEl);
    return toastRegionEl;
  }
  var toastKeys = {};
  function closeAllToasts() {
    Object.keys(toastKeys).forEach(function (k) { try { toastKeys[k].close(); } catch (e) { /* already gone */ } });
    toastKeys = {};
    if (toastRegionEl) while (toastRegionEl.firstChild) toastRegionEl.removeChild(toastRegionEl.firstChild);
  }
  // o: {kind: info|ok|warn|error, text, actions: [{label, onClick, primary}], sticky, key, regionLabel, dismissLabel}
  function showToast(o) {
    var region = toastRegion(o.regionLabel);
    if (o.key && toastKeys[o.key] && toastKeys[o.key].node.parentNode) { toastKeys[o.key].update(o.text); return toastKeys[o.key]; }
    var kind = o.kind || 'info';
    var textEl = el('p', { text: o.text });
    var node = el('div', { lang: o.lang, class: 'wds-toast wds-toast-' + kind, role: kind === 'error' || kind === 'warn' ? 'alert' : 'status', 'data-wds-toast': o.key }, [textEl]);
    var timer = null;
    var h = {
      node: node,
      update: function (s) { textEl.textContent = s; },
      close: function () {
        if (timer) clearTimeout(timer);
        if (node.parentNode) node.parentNode.removeChild(node);
        if (o.key && toastKeys[o.key] === h) delete toastKeys[o.key];
      },
    };
    var acts = (o.actions || []).map(function (a) {
      return el('button', { type: 'button', class: 'wds-btn wds-btn-small' + (a.primary ? ' wds-btn-primary' : ''), 'data-wds': 'toast-action', onclick: function () { if (a.close !== false) h.close(); a.onClick(h); } }, a.label);
    });
    if (o.dismissLabel !== null) acts.push(el('button', { type: 'button', class: 'wds-btn wds-btn-small', 'data-wds': 'toast-dismiss', onclick: function () { h.close(); } }, o.dismissLabel || 'Dismiss'));
    node.appendChild(el('div', { class: 'wds-toast-actions' }, acts));
    region.appendChild(node);
    if (o.key) toastKeys[o.key] = h;
    var sticky = o.sticky !== undefined ? o.sticky : kind !== 'info' && kind !== 'ok';
    if (!sticky) timer = setTimeout(h.close, o.timeoutMs || 9000);
    return h;
  }

  // ------------------------------------------------------------------------------------------------------------
  // 7. Form building blocks and error texts
  // ------------------------------------------------------------------------------------------------------------
  function inp(o) {
    return el('input', {
      id: o.id, type: o.type || 'text', class: 'wds-input' + (o.mono ? ' wds-mono' : ''), value: o.value, autocomplete: o.autocomplete || 'off',
      autocapitalize: o.autocapitalize || 'off', autocorrect: 'off', spellcheck: 'false', name: o.name, maxlength: o.maxlength, accept: o.accept,
      'aria-label': o.ariaLabel, 'data-wds': o.wds,
    });
  }
  // A labelled field with hint and error slot. Returns {wrap, input, setError, clearError}.
  function field(o) {
    var id = o.input.id || uid('wds-in');
    o.input.id = id;
    var hintId = id + '-hint', errId = id + '-err';
    var describedBy = [];
    var hint = o.hint ? el('p', { class: 'wds-hint', id: hintId, text: o.hint }) : null;
    if (hint) describedBy.push(hintId);
    var err = el('div', { class: 'wds-error', id: errId, role: 'alert' });
    describedBy.push(errId);
    o.input.setAttribute('aria-describedby', describedBy.join(' '));
    var wrap = el('div', { class: 'wds-field' }, [el('label', { class: 'wds-label', for: id, text: o.label }), o.input, hint, err]);
    return {
      wrap: wrap, input: o.input,
      setError: function (s) { err.textContent = s; o.input.setAttribute('aria-invalid', 'true'); },
      clearError: function () { err.textContent = ''; o.input.removeAttribute('aria-invalid'); },
    };
  }
  function msg(kind, text, role) { return el('div', { class: 'wds-msg wds-msg-' + kind, role: role || (kind === 'error' ? 'alert' : 'status') }, text); }
  // A code in groups ("XXXX-XXXX-..."): each group is one unit, so lines wrap between groups.
  function codeBox(text, attrs) {
    var groups = String(text).split('-');
    var box = el('div', Object.assign({ class: 'wds-code' }, attrs));
    groups.forEach(function (g, i) { box.appendChild(el('span', { class: 'wds-g', text: g + (i < groups.length - 1 ? '-' : '') })); });
    return box;
  }
  // o.wds: the stable name of the control (attribute data-wds). Every control inside .wds-root has one (PLAN: wds-verify and
  // app tests click library controls by it, in any language).
  function btn(label, o) {
    o = o || {};
    return el('button', { type: o.type || 'button', class: 'wds-btn' + (o.primary ? ' wds-btn-primary' : '') + (o.danger ? ' wds-btn-danger' : '') + (o.small ? ' wds-btn-small' : ''), onclick: o.onClick, disabled: o.disabled, 'data-wds': o.wds }, label);
  }
  function linkBtn(label, onClick, wds) { return el('button', { type: 'button', class: 'wds-link', onclick: onClick, 'data-wds': wds }, label); }
  function busyLine() { return el('p', { class: 'wds-hint', role: 'status', 'aria-live': 'polite' }); }
  function showBusy(line, text) { clear(line); if (text) append(line, [el('span', { class: 'wds-spin', 'aria-hidden': 'true' }), text]); }

  function explainError(S, e, where) {
    var t = S.t;
    if (e instanceof Core.OfflineError) return t('err.offline');
    if (e instanceof Core.VersionError) return t('note.version', { message: e.message });
    if (e instanceof Core.IntegrityError) return e.code === 'rollback' ? t('err.rollback') : t('err.integrity', { code: e.code || 'integrity' });
    if (e instanceof Core.AuthError) {
      if (e.code === 'revoked') return t('err.revoked');
      if (e.code === 'vault_deleted') return t('err.vaultDeleted');
      if (e.code === 'invite_expired' || e.status === 410) return t('err.expired');
      return where === 'redeem' ? t('err.invite.invalid') : t('err.wrongPass');
    }
    if (e && (e.status === 429 || e.code === 'rate_limited')) return t('err.rate');
    if (e && e.code === 'already_redeemed') return t('err.alreadyRedeemed');
    if (e && e.code === 'join_code_invalid') return t('err.joinCode');
    var nightly = S.info && S.info.sandbox ? ' ' + t('sandbox.nightly') : '';
    if (e && e.code === 'sandbox_disabled') return t('err.sandboxDisabled') + nightly;
    if (e && (e.code === 'vault_limit_reached' || e.code === 'enrollment_closed')) return e.code === 'enrollment_closed' ? t('create.closed') : t('err.vaultLimit') + nightly;
    if (e && e.code === 'scope_suspended') return t('create.suspended');
    if (e && e.status === 404) return where === 'scope' ? t('err.scope') : t('err.notFound');
    if (e && e.status === 400 && where === 'unlock') return t('err.badId');
    if (e && e.code === 'invalid_code') return where === 'redeem' ? t('err.invite.invalid') : t('err.badId');
    if (e && e.code === 'invalid_keyfile') return /different/.test(e.message) ? t('err.keyfile.other') : t('err.keyfile.invalid');
    if (e && /no escrow key IDs are pinned/.test(e.message || '')) return t('err.noPins');
    return t('err.generic', { message: (e && e.message) || String(e) });
  }

  // Passphrase input(s) with strength meter, rule checks and the breach check. mode: 'new' (rules, repeat field) or 'current'.
  function passphraseGroup(S, o) {
    var t = S.t, isNew = o.mode === 'new';
    var pw = inp({ type: 'password', mono: false, autocomplete: isNew ? 'new-password' : 'current-password', wds: 'passphrase' });
    var f1 = field({ label: o.label || t('create.passphrase'), input: pw, hint: isNew ? (o.hint === undefined ? t('create.passphrase.hint') : o.hint) : null });
    var rep = null, f2 = null, meterWrap = null, bar = null, strengthLine = null, timer = null;
    var nodes = [f1.wrap];
    if (isNew) {
      bar = el('div', { class: 'wds-meter-bar', 'data-level': '0' });
      meterWrap = el('div', { class: 'wds-meter', 'aria-hidden': 'true' }, bar);
      strengthLine = el('p', { class: 'wds-strength', role: 'status', 'aria-live': 'polite' });
      f1.wrap.insertBefore(meterWrap, f1.wrap.querySelector('.wds-error'));
      f1.wrap.insertBefore(strengthLine, f1.wrap.querySelector('.wds-error'));
      rep = inp({ type: 'password', autocomplete: 'new-password', wds: 'passphrase-repeat' });
      f2 = field({ label: t('create.repeat'), input: rep });
      nodes.push(f2.wrap);
    }
    var showId = uid('wds-show');
    var show = el('input', { type: 'checkbox', id: showId, 'data-wds': 'show-passphrase', onchange: function () {
      var type = show.checked ? 'text' : 'password';
      pw.type = type;
      if (rep) rep.type = type;
    } });
    nodes.push(el('div', { class: 'wds-check' }, [show, el('label', { for: showId, text: t('pw.show') })]));
    var hibpLine = el('p', { class: 'wds-hint', role: 'status', 'aria-live': 'polite' });
    var hibpOn = function () { return !!(S.info && S.info.hibp !== false); };
    if (isNew) nodes.push(hibpLine);
    function updateStrength() {
      if (!isNew) return;
      var v = pw.value;
      if (!v) { bar.style.width = '0%'; strengthLine.textContent = ''; return; }
      var est = estimate(v.normalize('NFC'));
      bar.style.width = (12 + est.score * 22) + '%';
      bar.setAttribute('data-level', String(est.score));
      strengthLine.textContent = t('pw.strength', { label: t('pw.label.' + est.score) });
    }
    if (isNew) pw.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(updateStrength, 120); f1.clearError(); });
    if (rep) rep.addEventListener('input', function () { f2.clearError(); });
    pw.addEventListener('input', function () { f1.clearError(); });
    var g = {
      nodes: nodes, input: pw,
      value: function () { return pw.value; },
      focus: function () { pw.focus(); },
      // 'current': only checks for emptiness. 'new': full rules. Returns {passphrase, hibp} or null (error shown).
      validate: async function () {
        var v = pw.value;
        if (!isNew) {
          if (!v) { f1.setError(t('err.passphrase.missing')); pw.focus(); return null; }
          return { passphrase: v };
        }
        var local = checkLocal(v);
        if (!local.ok) {
          var key = local.code === 'empty' ? 'pw.empty' : local.code === 'short' ? 'pw.tooShort' : local.code === 'common' ? 'pw.common' : 'pw.weak';
          f1.setError(t(key, { n: local.n })); pw.focus(); updateStrength(); return null;
        }
        if (rep.value !== v) { f2.setError(t('pw.mismatch')); rep.focus(); return null; }
        var hibp = { status: 'skipped' };
        if (hibpOn()) {
          showBusy(hibpLine, t('pw.hibp.checking'));
          hibp = await hibpCheck(v);
          showBusy(hibpLine, '');
          if (hibp.status === 'pwned') { f1.setError(t('pw.pwned', { count: hibp.count })); pw.focus(); return null; }
          if (hibp.status === 'unavailable') hibpLine.textContent = t('pw.hibp.unavailable');
        }
        // Without a breach check (switched off for the app, or not reachable) a well-known passphrase would pass unseen, so the
        // local estimate has to be stricter.
        if (hibp.status !== 'ok' && !checkLocal(v, true).ok) { hibpLine.textContent = ''; f1.setError(t('pw.weak.noBreachCheck')); pw.focus(); updateStrength(); return null; }
        return { passphrase: v, hibp: hibp };
      },
      reset: function () { pw.value = ''; if (rep) rep.value = ''; },
      note: function () { return hibpOn() ? el('p', { class: 'wds-hint', text: t('pw.hibp.note') }) : null; },
    };
    return g;
  }

  // ------------------------------------------------------------------------------------------------------------
  // 8. Unlock flow: unlock, create vault, redeem invite, access sheet
  // ------------------------------------------------------------------------------------------------------------
  function printHtml(host, html) {
    var f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true'); f.setAttribute('tabindex', '-1'); f.setAttribute('title', 'print');
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
    f.onload = function () {
      try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { /* printing blocked */ }
      setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 60000);
    };
    f.srcdoc = html;
    (host || document.body).appendChild(f);
  }

  function sheetView(S, dlg, o, onContinue) {
    var t = S.t, sandbox = isSandbox(S);
    clear(dlg.body); dlg.setView('sheet');
    if (sandbox) dlg.setTitle(t('sandbox.sheet.title'), true); else dlg.setTitle(t('sheet.title'));
    var owner = !!o.recoveryCode && !sandbox;   // a sandbox vault has no recovery: the code is neither shown nor kept
    var data = { appName: o.appName, scope: S.client.scope, accessId: o.accessId, recoveryCode: owner ? o.recoveryCode : null, service: S.client.service, created: S.now(), role: o.role, sandbox: sandbox };
    var dl = el('dl', { class: 'wds-dl' }, [
      el('dt', { text: t('sheet.app') }), el('dd', { text: o.appName }),
      el('dt', { text: t('sheet.accessId') }), el('dd', null, codeBox(o.accessId, { 'data-wds': 'access-id' })),
      owner ? el('dt', { text: t('sheet.recovery') }) : null, owner ? el('dd', null, codeBox(o.recoveryCode, { 'data-wds': 'recovery-code' })) : null,
    ]);
    var confirmId = uid('wds-ack');
    var ack = el('input', { type: 'checkbox', id: confirmId, 'data-wds': 'sheet-confirm', onchange: function () { go.disabled = !ack.checked; } });
    var go = btn(t('common.continue'), { primary: true, disabled: true, wds: 'sheet-continue', onClick: function () { onContinue(); } });
    append(dlg.body, [
      el('div', { 'data-wds': 'form-error', 'aria-live': 'polite' }),
      el('p', { text: owner ? t('sheet.intro.owner') : t('sheet.intro.member') }),
      dl,
      el('div', { class: 'wds-actions' }, [
        btn(t('sheet.keyfile'), { wds: 'sheet-keyfile', onClick: function () { downloadText(o.keyFile.text, keyFileName(S, o.keyFile), 'application/json'); } }),
        btn(t('sheet.print'), { wds: 'sheet-print', onClick: function () { printHtml(dlg.overlay, buildSheetHtml(data, t, S.lang)); } }),
        btn(t('sheet.download'), { wds: 'sheet-download', onClick: function () { downloadText(buildSheetHtml(data, t, S.lang), S.client.scope + '-access-sheet.html', 'text/html;charset=utf-8'); } }),
      ]),
      el('p', { class: 'wds-hint', text: t('sheet.keyfile.hint') }),
      el('p', { text: t('sheet.passphrase.note') }),
      owner ? el('p', { text: t('sheet.recovery.note') }) : null,
      sandbox ? el('p', { text: t('sandbox.sheet.note') }) : null,
      o.hibpSkipped ? msg('warn', t('sheet.hibp.skipped')) : null,
      el('div', { class: 'wds-check' }, [ack, el('label', { for: confirmId, text: owner ? t('sheet.confirm.owner') : t('sheet.confirm.member') })]),
      el('div', { class: 'wds-actions' }, [go]),
    ]);
    dlg.focusFirst();
  }

  // Returns a promise for {created: boolean}. o: {cancelable}.
  function runUnlock(S, o) {
    var t = S.t, client = S.client;
    return new Promise(function (resolve, reject) {
      var settled = false, dlg;
      var st = { accessId: client.rememberedAccessId() || '', vaultId: null, inviteCode: '', notice: null };
      function done(result) { if (settled) return; settled = true; dlg.close(); resolve(result); }
      dlg = dialogFor(S, {
        title: t('unlock.title'), view: 'loading', cancelable: !!o.cancelable, closeLabel: t('common.close'),
        onClose: function () { if (!settled) { settled = true; reject(new Core.UsageError('unlock was cancelled', { code: 'cancelled' })); } },
      });
      function appLine() { return el('p', { class: 'wds-sub', text: t('unlock.app', { name: appLabel(S, S.info ? S.info.name : client.scope) }) }); }

      // ---- key files: anywhere on the dialog ----
      async function loadKeyFile(file, afterLoad) {
        try {
          if (file.size > 20000) throw new Core.UsageError('not a key file', { code: 'invalid_keyfile' });
          var kf = await Core.parseKeyFile(await file.text(), { scope: client.scope, service: client.service });
          st.accessId = kf.accessId; st.vaultId = kf.vaultId; st.notice = { kind: 'ok', text: t('unlock.keyfile.loaded') };
          viewUnlock();
        } catch (e) {
          if (afterLoad) afterLoad(explainError(S, e, 'unlock'));
          else { st.notice = { kind: 'error', text: explainError(S, e, 'unlock') }; viewUnlock(); }
        }
      }
      dlg.overlay.addEventListener('dragover', function (ev) { ev.preventDefault(); dlg.overlay.classList.add('wds-dragover'); });
      dlg.overlay.addEventListener('dragleave', function (ev) { if (ev.target === dlg.overlay) dlg.overlay.classList.remove('wds-dragover'); });
      dlg.overlay.addEventListener('drop', function (ev) {
        ev.preventDefault(); dlg.overlay.classList.remove('wds-dragover');
        var files = ev.dataTransfer && ev.dataTransfer.files;
        if (files && files[0]) loadKeyFile(files[0]);
      });

      function frame(view, title, children) {
        clear(dlg.body); dlg.setTitle(title); dlg.setView(view);
        append(dlg.body, children);
      }

      // A sandbox is emptied every night: an access ID remembered from before the last wipe belongs to a vault that is gone.
      // The remembered time is that of the first remembering (the vault's creation), so a vault unlocked after the wipe time but
      // before the sweep that deleted it is recognised as well.
      function sandboxEmptied() {
        var sb = S.info && S.info.sandbox, mem = client.rememberedAccess();
        if (!(sb && mem && sb.last_wipe && mem.t < sb.last_wipe * 1000)) return false;
        client.forgetAccessId(); st.accessId = ''; st.vaultId = null;
        st.notice = { kind: 'warn', text: t('sandbox.emptied', { date: formatDate(sb.last_wipe, S.lang) }) };
        viewCreate();
        return true;
      }

      // ---- loading and fatal errors ----
      function viewLoading() {
        frame('loading', t('unlock.title'), el('p', { role: 'status' }, [el('span', { class: 'wds-spin', 'aria-hidden': 'true' }), t('common.loading')]));
        S.getInfo(true).then(function () {
          dlg.applySandbox(S);
          if (sandboxEmptied()) return;
          viewUnlock();
        }, function (e) {
          frame('error', t('unlock.title'), [
            el('div', { 'data-wds': 'form-error', 'aria-live': 'polite' }, msg('error', explainError(S, e, 'scope'))),
            el('div', { class: 'wds-actions' }, [btn(t('common.retry'), { primary: true, wds: 'retry', onClick: viewLoading })]),
          ]);
          dlg.focusFirst();
        });
      }

      // ---- unlock ----
      function viewUnlock() {
        var idInput = inp({ mono: true, autocomplete: 'username', autocapitalize: 'characters', value: st.accessId ? Core.displayCode(st.accessId) : '', name: 'username', wds: 'access-id-input' });
        var fId = field({ label: t('unlock.accessId'), input: idInput, hint: t('unlock.accessId.hint') });
        var fileInput = el('input', { type: 'file', class: 'wds-vh', accept: '.json,application/json', 'data-wds': 'keyfile', onchange: function () { if (fileInput.files[0]) loadKeyFile(fileInput.files[0], function (m) { fId.setError(m); }); } });
        var pw = passphraseGroup(S, { mode: 'current', label: t('unlock.passphrase') });
        var formErr = el('div', { 'aria-live': 'polite', 'data-wds': 'form-error' });
        var busy = busyLine();
        var fs = el('fieldset', { class: 'wds-fs' }, [
          el('p', { text: t('unlock.intro') }), appLine(),
          fId.wrap,
          el('div', { class: 'wds-field' }, [el('label', { class: 'wds-btn wds-btn-small', 'data-wds': 'keyfile-button' }, [t('unlock.keyfile.choose'), fileInput]), el('p', { class: 'wds-hint', text: t('unlock.keyfile.hint') })]),
          pw.nodes, formErr,
          el('div', { class: 'wds-actions' }, [btn(t('unlock.submit'), { type: 'submit', primary: true, wds: 'unlock-submit' })]),
          busy,
        ]);
        var form = el('form', { class: 'wds-form', novalidate: 'novalidate', onsubmit: async function (ev) {
          ev.preventDefault();
          fId.clearError(); clear(formErr);
          var raw = idInput.value.trim();
          if (!raw) { fId.setError(t('err.accessId.missing')); idInput.focus(); return; }
          var kind = Core.classifyCode(raw);
          if (kind === 'invite') { st.inviteCode = raw; viewRedeem(); return; }
          if (kind === 'recovery') { fId.setError(t('unlock.recoveryEntered')); idInput.focus(); return; }
          if (kind !== 'access_id') { fId.setError(t('err.badId')); idInput.focus(); return; }
          var checked = await pw.validate();
          if (!checked) return;
          var accessId = Core.normalizeCode(raw);
          fs.disabled = true; showBusy(busy, t('unlock.busy'));
          await nextPaint();
          try {
            await client.unlock({ accessId: accessId, passphrase: checked.passphrase, vaultId: st.vaultId && accessId === st.accessId ? st.vaultId : undefined, maintain: false });
            done({ created: false });
          } catch (e) {
            fs.disabled = false; showBusy(busy, '');
            if (e && e.code === 'invite_not_redeemed') { st.inviteCode = raw; viewRedeem(); return; }
            // The dialog may have been open across a nightly wipe of a sandbox: ask again whether the remembered vault is gone.
            if (isSandbox(S) && client.rememberedAccessId() === accessId && !(e instanceof Core.OfflineError)) {
              try { await S.getInfo(true); if (sandboxEmptied()) return; } catch (e3) { /* the error below is shown */ }
            }
            var text = explainError(S, e, 'unlock');
            append(formErr, msg('error', text));
            if (e instanceof Core.AuthError && e.code !== 'revoked' && e.status !== 410) { pw.input.select(); pw.focus(); } else idInput.focus();
          }
        } }, fs);
        var links = el('div', { class: 'wds-actions' }, [linkBtn(t('unlock.toCreate'), viewCreate, 'to-create'), el('span', { class: 'wds-spacer' }), linkBtn(t('unlock.toRedeem'), function () { viewRedeem(); }, 'to-redeem')]);
        frame('unlock', t('unlock.title'), [st.notice ? msg(st.notice.kind, st.notice.text) : null, form, links]);
        st.notice = null;
        if (st.accessId) pw.focus(); else idInput.focus();
      }

      // ---- create ----
      function viewCreate() {
        var info = S.info || {};
        if (info.status === 'suspended' || info.enrollment === 'closed') {
          frame('create', t('create.title'), [msg('warn', info.status === 'suspended' ? t('create.suspended') : t('create.closed')), el('div', { class: 'wds-actions' }, [btn(t('create.back'), { wds: 'back', onClick: viewUnlock })])]);
          dlg.focusFirst();
          return;
        }
        var joinField = null, joinInput = null;
        if (info.enrollment === 'join_code') {
          joinInput = inp({ mono: true, autocapitalize: 'characters', wds: 'join-code' });
          joinField = field({ label: t('create.joinCode'), input: joinInput, hint: t('create.joinCode.hint') });
        }
        var pw = passphraseGroup(S, { mode: 'new' });
        var sandbox = isSandbox(S);   // no recovery in the sandbox: no contact address either
        var contactInput = sandbox ? null : inp({ type: 'email', autocomplete: 'email', maxlength: 254, wds: 'recovery-contact' });
        var contactField = sandbox ? null : field({ label: t('create.contact.label'), input: contactInput, hint: t('create.contact.hint') });
        var formErr = el('div', { 'aria-live': 'polite', 'data-wds': 'form-error' });
        var busy = busyLine();
        var privacy = info.privacy_url && /^https?:\/\//i.test(info.privacy_url) ? el('a', { href: info.privacy_url, target: '_blank', rel: 'noopener noreferrer', text: t('create.privacy') }) : null;
        var fs = el('fieldset', { class: 'wds-fs' }, [
          el('p', { text: t('create.intro') }), appLine(),
          joinField ? joinField.wrap : null,
          pw.nodes, pw.note(),
          sandbox ? null : el('details', { class: 'wds-details' }, [el('summary', { text: t('create.contact'), 'data-wds': 'recovery-contact-toggle' }), contactField.wrap]),
          el('div', { class: 'wds-box' }, [el('h3', { text: t('create.escrow.title') }), el('p', { text: t(sandbox ? 'sandbox.create.escrow' : 'create.escrow.text') }), privacy ? el('p', null, privacy) : null]),
          formErr,
          el('div', { class: 'wds-actions' }, [btn(t(sandbox ? 'sandbox.create.submit' : 'create.submit'), { type: 'submit', primary: true, wds: 'create-submit' })]),
          busy,
        ]);
        var form = el('form', { class: 'wds-form', novalidate: 'novalidate', onsubmit: async function (ev) {
          ev.preventDefault();
          clear(formErr);
          if (joinField) { joinField.clearError(); if (!joinInput.value.trim()) { joinField.setError(t('err.joinCode.missing')); joinInput.focus(); return; } }
          var contact = sandbox ? '' : contactInput.value.trim();
          if (contactField) contactField.clearError();
          if (contact && !/^[^\s@]+@[^\s@]+$/.test(contact)) { contactField.setError(t('err.contact.invalid')); contactInput.closest('details').open = true; contactInput.focus(); return; }
          var checked = await pw.validate();
          if (!checked) return;
          fs.disabled = true; showBusy(busy, t('create.busy'));
          await nextPaint();
          try {
            var res = await client.createVault({ passphrase: checked.passphrase, joinCode: joinField ? joinInput.value.trim() : undefined, recoveryContact: contact || undefined });
            pw.reset();
            sheetView(S, dlg, {
              appName: appLabel(S, info.name || client.scope), accessId: res.accessIdDisplay, recoveryCode: res.recoveryCode.display, keyFile: res.keyFile,
              role: 'owner', hibpSkipped: checked.hibp && checked.hibp.status === 'unavailable',
            }, function () { done({ created: true }); });
          } catch (e) {
            fs.disabled = false; showBusy(busy, '');
            if (joinField && e && e.code === 'join_code_invalid') {   // next to the field, which is far above the button on a long form
              joinField.setError(explainError(S, e, 'create')); joinInput.focus(); joinInput.select();
              if (joinInput.scrollIntoView) joinInput.scrollIntoView({ block: 'center' });
              return;
            }
            append(formErr, msg('error', explainError(S, e, 'create')));
          }
        } }, fs);
        frame('create', t('create.title'), [st.notice ? msg(st.notice.kind, st.notice.text) : null, form, el('div', { class: 'wds-actions' }, [linkBtn(t('create.back'), viewUnlock, 'back')])]);
        st.notice = null;
        (joinInput || pw.input).focus();
      }

      // ---- redeem ----
      function viewRedeem() {
        var info = S.info || {};
        var codeInput = inp({ mono: true, autocapitalize: 'characters', value: st.inviteCode ? Core.displayCode(Core.normalizeCode(st.inviteCode)) : '', wds: 'invite-code-input' });
        var fCode = field({ label: t('redeem.code'), input: codeInput, hint: t('redeem.code.hint') });
        var pw = passphraseGroup(S, { mode: 'new' });
        var formErr = el('div', { 'aria-live': 'polite', 'data-wds': 'form-error' });
        var busy = busyLine();
        var fs = el('fieldset', { class: 'wds-fs' }, [
          el('p', { text: t('redeem.intro') }), appLine(), fCode.wrap, pw.nodes, pw.note(), formErr,
          el('div', { class: 'wds-actions' }, [btn(t('redeem.submit'), { type: 'submit', primary: true, wds: 'redeem-submit' })]), busy,
        ]);
        var form = el('form', { class: 'wds-form', novalidate: 'novalidate', onsubmit: async function (ev) {
          ev.preventDefault();
          clear(formErr); fCode.clearError();
          var raw = codeInput.value.trim();
          if (Core.classifyCode(raw) !== 'invite') { fCode.setError(t('err.invite.invalid')); codeInput.focus(); return; }
          var checked = await pw.validate();
          if (!checked) return;
          fs.disabled = true; showBusy(busy, t('redeem.busy'));
          await nextPaint();
          try {
            var res = await client.redeemInvite({ inviteCode: raw, passphrase: checked.passphrase, maintain: false });
            pw.reset();
            var accessId = Core.displayCode(res.accessId);
            clear(dlg.body);
            sheetView(S, dlg, { appName: appLabel(S, info.name || client.scope), accessId: accessId, recoveryCode: null, keyFile: res.keyFile, role: res.role, hibpSkipped: checked.hibp && checked.hibp.status === 'unavailable' }, function () { done({ created: false, redeemed: true }); });
            dlg.setTitle(t('redeem.done'));
            dlg.body.insertBefore(msg('ok', res.role === 'read' ? t('redeem.role.read') : t('redeem.role.write')), dlg.body.firstChild);
          } catch (e) {
            fs.disabled = false; showBusy(busy, '');
            append(formErr, msg('error', explainError(S, e, 'redeem')));
          }
        } }, fs);
        frame('redeem', t('redeem.title'), [form, el('div', { class: 'wds-actions' }, [linkBtn(t('redeem.back'), viewUnlock, 'back')])]);
        (st.inviteCode ? pw.input : codeInput).focus();
      }

      viewLoading();
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // 9. Conflict and history dialogs
  // ------------------------------------------------------------------------------------------------------------
  function sizeOfValue(v) {
    if (v === undefined || v === null) return 0;
    if (typeof v.size === 'number') return v.size;
    if (typeof v.byteLength === 'number') return v.byteLength;
    return v.length || 0;
  }
  function previewNode(S, side) {
    var t = S.t;
    if (!side) return el('p', { class: 'wds-hint', text: t('conflict.noTheirs') });
    if (side.deleted) return el('p', { class: 'wds-hint', text: side.who === 'mine' ? t('conflict.mineDeleted') : t('conflict.theirsDeleted') });
    if (side.kind === 'bytes') return el('p', { text: t('conflict.file', { mime: side.mime || 'application/octet-stream', size: formatBytes(sizeOfValue(side.value)) }) });
    var text;
    try { text = JSON.stringify(side.value, null, 2); } catch (e) { text = String(side.value); }
    if (text === undefined) text = '';
    var cut = text.length > 1500;
    return el('div', null, [el('pre', { class: 'wds-pre', tabindex: '0', text: cut ? text.slice(0, 1500) : text }), cut ? el('p', { class: 'wds-hint', text: t('conflict.truncated') }) : null]);
  }
  function markedName(name, marker, kind) {
    var base = fileSafe(name), dot = base.lastIndexOf('.'), slash = base.lastIndexOf('/');
    if (kind === 'json') return (/\.json$/i.test(base) ? base.slice(0, base.length - 5) : base) + '.' + marker + '.json';
    return dot > slash + 1 ? base.slice(0, dot) + '.' + marker + base.slice(dot) : base + '.' + marker;
  }
  function downloadSide(name, marker, side) {
    if (!side || side.deleted) return;
    var bytes = recordBytes({ kind: side.kind, value: side.value });
    downloadBlob(new Blob([bytes], { type: side.kind === 'json' ? 'application/json' : (side.mime || 'application/octet-stream') }), markedName(name, marker, side.kind));
  }

  // c: {name, mine: {value, kind, mime, deleted}, theirs: {version, deleted, kind, mime, time, value}|null}. -> 'mine' | 'theirs'
  function conflictDialog(S, c) {
    var t = S.t, isDelete = !!(c.mine && c.mine.deleted);
    return new Promise(function (resolve) {
      var dlg = dialogFor(S, { title: t(isDelete ? 'conflict.delete.title' : 'conflict.title'), view: 'conflict', wide: true });
      function choose(which) { dlg.close(); resolve(which); }
      var theirs = c.theirs ? Object.assign({ who: 'theirs' }, c.theirs) : null;
      var mine = Object.assign({ who: 'mine' }, c.mine);
      var paneTheirs = el('section', { class: 'wds-pane', 'aria-labelledby': 'wds-c-theirs' }, [
        el('h3', { id: 'wds-c-theirs', text: t('conflict.theirs') }),
        theirs && theirs.time ? el('p', { class: 'wds-sub', text: t('conflict.saved', { time: formatTime(theirs.time / 1000, S.lang) }) }) : null,
        previewNode(S, theirs),
      ]);
      var paneMine = el('section', { class: 'wds-pane', 'aria-labelledby': 'wds-c-mine' }, [
        el('h3', { id: 'wds-c-mine', text: t('conflict.mine') }),
        previewNode(S, mine),
      ]);
      var hasDownload = !!((theirs && !theirs.deleted) || (!mine.deleted));
      append(dlg.body, [
        el('div', { 'data-wds': 'form-error', 'aria-live': 'polite' }),
        el('p', { text: t(isDelete ? 'conflict.delete.intro' : 'conflict.intro', { name: S.label(c.name) }) }),
        el('div', { class: 'wds-compare' }, [paneTheirs, paneMine]),
        el('div', { class: 'wds-actions' }, [
          btn(t(isDelete ? 'conflict.delete.keepTheirs' : 'conflict.keepTheirs'), { primary: true, wds: 'conflict-theirs', onClick: function () { choose('theirs'); } }),
          btn(t(isDelete ? 'conflict.delete.keepMine' : 'conflict.keepMine'), { wds: 'conflict-mine', onClick: function () { choose('mine'); } }),
          el('span', { class: 'wds-spacer' }),
          hasDownload ? btn(t('conflict.downloadBoth'), { wds: 'conflict-download', onClick: function () { downloadSide(c.name, 'theirs', theirs); downloadSide(c.name, 'mine', mine); } }) : null,
        ]),
      ]);
      dlg.focusFirst();
    });
  }

  // api: {history(name), getVersion(name, v), restore(name, v)}. Resolves {restored: n} or null.
  function historyDialog(S, name, api, o) {
    var t = S.t, title = (o && typeof o.title === 'string' && o.title.trim()) || S.label(name);
    return new Promise(function (resolve) {
      var result = null;
      var dlg = dialogFor(S, { title: t('history.title', { name: title }), view: 'history', wide: true, cancelable: true, closeLabel: t('common.close'), onClose: function () { resolve(result); } });
      var list = el('ul', { class: 'wds-people' });
      var previewBox = el('div', { 'aria-live': 'polite' });
      var status = el('div', { 'aria-live': 'polite', 'data-wds': 'form-error' });
      append(dlg.body, [el('p', { text: t('history.intro') }), status, list, previewBox]);
      api.history(name).then(function (h) {
        if (!h.versions.length) { list.parentNode.insertBefore(el('p', { text: t('history.empty') }), list); return; }
        h.versions.forEach(function (v) {
          var isCurrent = v.version === h.current;
          var previewBtn = btn(t('history.preview'), { small: true, wds: 'history-preview', disabled: v.deleted, onClick: async function () {
            clear(previewBox);
            try {
              var rec = await api.getVersion(name, v.version);
              if (!rec || rec.deleted) { previewBox.appendChild(msg('warn', t('history.unavailable'))); return; }
              append(previewBox, [el('h3', { text: t('history.version', { n: v.version }) }), previewNode(S, rec)]);
            } catch (e) { previewBox.appendChild(msg('error', explainError(S, e, 'history'))); }
          } });
          var readOnly = !!(api.role && api.role() === 'read');   // a read member cannot restore (it would be refused)
          var restoreBtn = btn(t('history.restore'), { small: true, wds: 'history-restore', primary: !isCurrent && !v.deleted && !readOnly, disabled: isCurrent || v.deleted || readOnly, onClick: async function () {
            restoreBtn.disabled = true; clear(status);
            try {
              await api.restore(name, v.version);
              result = { restored: v.version };
              dlg.close(result);
            } catch (e) { restoreBtn.disabled = false; status.appendChild(msg('error', explainError(S, e, 'history'))); }
          } });
          append(list, el('li', { class: 'wds-person', 'data-wds': 'history-version', 'data-wds-version': v.version }, [
            el('div', { class: 'wds-person-main' }, [
              el('div', { class: 'wds-person-name' }, [t('history.version', { n: v.version }), isCurrent ? el('span', { class: 'wds-badge', text: t('history.current') }) : null, v.deleted ? el('span', { class: 'wds-badge', text: t('history.deleted') }) : null]),
              el('div', { class: 'wds-person-info', text: formatTime(v.created, S.lang) }),
            ]),
            previewBtn, restoreBtn,
          ]));
        });
        dlg.focusFirst();
      }, function (e) { status.appendChild(msg('error', explainError(S, e, 'history'))); });
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // 10. Share dialog: members, invites, revocation, own access
  // ------------------------------------------------------------------------------------------------------------
  function recoveryRequestNode(S, rec, onCancel, onKeep, bare) {
    var t = S.t;
    return el('div', { class: 'wds-msg wds-msg-warn', role: 'alert', 'data-wds': 'recovery-request' }, [
      bare ? null : el('strong', { text: t('share.recovery.title') }),
      el('p', { text: t('share.recovery.text', { time: formatTime(rec.requested, S.lang), ready: formatTime(rec.ready_at, S.lang) }) }),
      el('div', { class: 'wds-actions' }, [btn(t('share.recovery.cancel'), { danger: true, wds: 'recovery-cancel', onClick: onCancel }), onKeep ? btn(t('share.recovery.keep'), { wds: 'recovery-keep', onClick: onKeep }) : null]),
    ]);
  }
  function recoveredNode(S, onAck, bare) {
    var t = S.t;
    return el('div', { class: 'wds-msg wds-msg-warn', role: 'alert', 'data-wds': 'recovered-notice' }, [
      bare ? null : el('strong', { text: t('share.recovered.title') }),
      el('p', { text: t('share.recovered.text') }),
      el('div', { class: 'wds-actions' }, [btn(t('share.recovered.ack'), { primary: true, wds: 'recovered-ack', onClick: onAck })]),
    ]);
  }
  function shortId(slotId) { return String(slotId).slice(0, 8); }
  function foreignRecoverySlots(status) { return (status.recoverySlots || []).filter(function (id) { return id !== status.slotId; }); }

  // api: {labels: {get(), set(slotId, text|null)}, seen: {get(), add(ids)}, lock(), reloadLabels()}
  function shareDialog(S, api) {
    var t = S.t, client = S.client;
    return new Promise(function (resolve) {
      var dlg = dialogFor(S, { title: t('share.title'), view: 'share', wide: true, cancelable: true, closeLabel: t('common.close'), onClose: function () { resolve(); } });
      var st = { view: 'main', invite: null, flash: null, revokeSlot: null, error: null };
      var locked = false;
      var seenAtOpen = api.seen.get(); // what counts as "new" stays fixed while the dialog is open

      function setFlash(kind, text) { st.flash = text ? { kind: kind, text: text } : null; }
      function explain(e) {
        if (e && e.code === 'recovery_unacknowledged') return t('share.error.recoveryAck');
        return t('share.error.generic', { message: explainError(S, e, 'share') });
      }
      async function guard(fn) {
        try { return await fn(); } catch (e) {
          if (e instanceof Core.AuthError && (e.code === 'revoked' || e.status === 401)) { api.onRevoked(); dlg.close(); return undefined; }
          setFlash('error', explain(e)); st.view = 'main'; render(); return undefined;
        }
      }

      function labelOf(m, idx) {
        if (m.self) return t('share.you');
        if (m.escrow) return t('share.escrow');
        return (api.labels.get()[m.slotId]) || (m.role === 'owner' ? t('share.otherOwner') : t('share.member') + ' ' + idx);
      }

      // ---- progress view (revocation and re-encryption) ----
      function viewProgress(titleText, work) {
        clear(dlg.body); dlg.setView('progress');
        dlg.setCancelable(false);
        var bar = el('progress', { class: 'wds-progress', 'aria-label': titleText });
        var line = el('p', { role: 'status', 'aria-live': 'polite', text: t('share.revoke.starting') });
        append(dlg.body, [el('p', { text: titleText }), bar, line]);
        var total = 0;
        work(function (p) {
          total = Math.max(total, p.rekeyed + p.remaining);
          bar.max = total || 1; bar.value = p.rekeyed;
          line.textContent = t('share.revoke.progress', { done: p.rekeyed, total: total });
        }).then(function (r) {
          dlg.setCancelable(true);
          setFlash('ok', r && r.done === false ? t('share.revoke.partial') : t('share.revoke.done'));
          st.view = 'main'; render('close');
        }, function (e) {
          dlg.setCancelable(true);
          if (e instanceof Core.AuthError && (e.code === 'revoked' || e.status === 401)) { api.onRevoked(); dlg.close(); return; }
          setFlash('error', explain(e) + ' ' + t('share.revoke.partial')); st.view = 'main'; render();
        });
      }

      // ---- views ----
      function viewRevokeConfirm() {
        var m = st.revokeSlot, textKey = m.invite ? 'share.revoke.invite.text' : m.owner ? 'share.revoke.owner.text' : 'share.revoke.text';
        clear(dlg.body); dlg.setTitle(t('share.revoke.title')); dlg.setView('revoke');
        append(dlg.body, [
          el('p', { text: t(textKey, { label: m.label }) }),
          el('p', { class: 'wds-hint', 'data-wds': 'revoke-id', text: t('share.revoke.id', { id: shortId(m.slotId) }) }),
          el('div', { class: 'wds-actions' }, [
            btn(t('share.revoke.confirm'), { danger: true, wds: 'revoke-confirm', onClick: function () {
              dlg.setTitle(t('share.title'));
              viewProgress(t(textKey, { label: m.label }), function (onProgress) {
                return client.revoke(m.slotId, { onProgress: onProgress }).then(function (r) { return api.labels.drop(m.slotId).then(function () { return r; }, function () { return r; }); });
              });
            } }),
            btn(t('common.cancel'), { wds: 'revoke-cancel', onClick: function () { dlg.setTitle(t('share.title')); st.view = 'main'; render(); } }),
          ]),
        ]);
        dlg.focusFirst();
      }

      function inviteSection() {
        if (st.invite) {
          var inv = st.invite;
          var copied = el('span', { class: 'wds-hint', role: 'status', 'aria-live': 'polite' });
          return el('div', { class: 'wds-section' }, [
            el('h3', { text: t('share.invite.title') }),
            el('p', { class: 'wds-label', text: t('share.invite.result') }),
            codeBox(inv.code.display, { 'data-wds': 'invite-code', tabindex: '0' }),
            el('p', { class: 'wds-hint', text: t('share.invite.until', { time: formatTime(inv.expires, S.lang) }) }),
            el('div', { class: 'wds-actions' }, [
              btn(t('common.copy'), { wds: 'invite-copy', onClick: function () {
                var done = function () { copied.textContent = t('common.copied'); };
                try { navigator.clipboard.writeText(inv.code.display).then(done, function () {}); } catch (e) { /* select manually */ }
              } }),
              btn(t('share.invite.another'), { wds: 'invite-another', onClick: function () { st.invite = null; render('invite-role'); } }),
              copied,
            ]),
            el('p', { class: 'wds-hint', text: t('share.invite.hint') }),
          ]);
        }
        var role = el('select', { class: 'wds-select', id: uid('wds-role'), 'data-wds': 'invite-role' }, [
          el('option', { value: 'write', text: t('role.write') }), el('option', { value: 'read', text: t('role.read') }),
        ]);
        var expiry;
        if (isSandbox(S)) {
          // The server refuses an invite that outlives the next nightly wipe: the only choice is "until then" (with a margin for clock differences).
          var wipeAt = S.info.sandbox.next_wipe, left = Math.floor(wipeAt - S.now() / 1000) - 300;
          if (left < 3600) {
            return el('div', { class: 'wds-section' }, [el('h3', { text: t('share.invite.title') }), msg('warn', t('share.invite.sandboxLate', { time: formatTime(wipeAt, S.lang) }))]);
          }
          expiry = el('select', { class: 'wds-select', id: uid('wds-exp'), 'data-wds': 'invite-expiry' }, [
            el('option', { value: String(Math.min(left, 14 * 86400)), text: t('share.expiry.sandbox', { time: formatTime(wipeAt, S.lang) }) }),
          ]);
        } else {
          expiry = el('select', { class: 'wds-select', id: uid('wds-exp'), 'data-wds': 'invite-expiry' }, [
            el('option', { value: '86400', text: t('share.expiry.1') }), el('option', { value: '172800', selected: 'selected', text: t('share.expiry.2') }),
            el('option', { value: '604800', text: t('share.expiry.7') }), el('option', { value: '1209600', text: t('share.expiry.14') }),
          ]);
          expiry.value = '172800';
        }
        var labelInput = inp({ maxlength: 60, wds: 'invite-label' });
        var fLabel = field({ label: t('share.invite.label'), input: labelInput, hint: t('share.invite.label.hint') });
        var busy = busyLine();
        var fs = el('fieldset', { class: 'wds-fs' }, [
          el('div', { class: 'wds-field' }, [el('label', { class: 'wds-label', for: role.id, text: t('share.invite.role') }), role]),
          el('div', { class: 'wds-field' }, [el('label', { class: 'wds-label', for: expiry.id, text: t('share.invite.expiry') }), expiry]),
          fLabel.wrap,
          el('div', { class: 'wds-actions' }, [btn(t('share.invite.create'), { type: 'submit', primary: true, wds: 'invite-create' })]), busy,
        ]);
        return el('div', { class: 'wds-section' }, [
          el('h3', { text: t('share.invite.title') }),
          el('form', { novalidate: 'novalidate', onsubmit: async function (ev) {
            ev.preventDefault();
            fs.disabled = true; showBusy(busy, t('share.invite.busy'));
            try {
              var res = await client.createInvite({ role: role.value, expiresIn: Number(expiry.value) });
              var label = labelInput.value.trim();
              if (label) { try { await api.labels.set(res.slotId, label); } catch (e) { /* label is a convenience */ } }
              st.invite = res; setFlash(null); render('invite-code');
            } catch (e) {
              fs.disabled = false; showBusy(busy, '');
              if (e instanceof Core.AuthError && (e.code === 'revoked' || e.status === 401)) { api.onRevoked(); dlg.close(); return; }
              setFlash('error', explain(e)); render();
            }
          } }, fs),
        ]);
      }

      function peopleSection(members, seen) {
        var idx = 0;
        var items = members.map(function (m) {
          if (!m.self && !m.escrow) idx++;
          var label = labelOf(m, idx);
          var isNew = !!m.redeemed && !m.self && seen.indexOf(m.slotId) < 0;
          var badges = [];
          if (m.escrow) badges.push(el('span', { class: 'wds-badge', text: t('share.escrow.badge') }));   // not "owner": the faculty does not own the vault
          else if (m.role === 'owner' || m.self) badges.push(el('span', { class: 'wds-badge', text: t('role.' + m.role) }));
          var info = [];
          if (m.escrow) info.push(t(isSandbox(S) ? 'sandbox.share.escrow' : 'share.escrow.hint'));
          else if (m.kind === 'invite' && !m.redeemed) {
            info.push(m.expired ? t('share.status.expired') : t(m.used ? 'share.status.opened' : 'share.status.invited', { time: formatTime(m.expires, S.lang) }));
          }
          else if (m.redeemed) info.push(t('share.status.redeemed', { time: formatTime(m.redeemed, S.lang) }));
          else info.push(t('share.status.active'));
          if (m.renewalPending && !m.escrow) info.push(t('share.status.renewal'));
          if (m.addedByEscrow) info.push(t('share.addedByFaculty'));
          if (!m.self && !m.escrow) info.push(t('share.slotId', { id: shortId(m.slotId) }));
          if (isNew) badges.push(el('span', { class: 'wds-badge', text: t('share.status.new') }));
          var actions = [];
          if (!m.self && !m.escrow && m.role !== 'owner') {
            var sel = el('select', { class: 'wds-select', style: 'width:auto', 'data-wds': 'member-role', 'aria-label': t('share.role', { label: label }), onchange: function () {
              guard(async function () { await client.setRole(m.slotId, sel.value); setFlash(null); render(); });
            } }, [el('option', { value: 'write', text: t('role.write') }), el('option', { value: 'read', text: t('role.read') })]);
            sel.value = m.role;
            actions.push(sel);
            if (m.kind === 'invite' && !m.redeemed && !m.used) {
              // An invite that nobody has used leaves quietly. If the server saw its token in the meantime, cancelInvite
              // refuses (revocation_required) and the revocation dialog takes over.
              actions.push(btn(t('share.cancelInvite'), { small: true, wds: 'cancel-invite', onClick: function () {
                guard(async function () {
                  try { await client.cancelInvite(m.slotId, { revoke: false }); } catch (e) {
                    if (e && e.code === 'revocation_required') { st.revokeSlot = { slotId: m.slotId, label: label, owner: false, invite: true }; st.view = 'revoke'; render(); return; }
                    throw e;
                  }
                  await api.labels.drop(m.slotId).catch(function () {}); setFlash(null); render();
                });
              } }));
            } else {
              // Used or redeemed: it can only be withdrawn like a member, by a revocation (new key, re-encryption).
              var withdrawn = m.kind === 'invite' && !m.redeemed;
              actions.push(btn(t('share.revoke'), { small: true, danger: true, wds: 'revoke', onClick: function () { st.revokeSlot = { slotId: m.slotId, label: label, owner: false, invite: withdrawn }; st.view = 'revoke'; render(); } }));
            }
          }
          if (!m.self && !m.escrow && m.role === 'owner' && m.revocable) {
            actions.push(btn(t('share.revoke'), { small: true, danger: true, wds: 'revoke', onClick: function () { st.revokeSlot = { slotId: m.slotId, label: label, owner: true }; st.view = 'revoke'; render(); } }));
          }
          return el('li', { class: 'wds-person' + (isNew ? ' wds-person-new' : ''), 'data-wds': m.escrow ? 'person-escrow' : 'person' }, [
            el('div', { class: 'wds-person-main' }, [el('div', { class: 'wds-person-name' }, [label, badges]), el('div', { class: 'wds-person-info', text: info.join(' · ') })]),
            actions,
          ]);
        });
        return el('div', { class: 'wds-section' }, [el('h3', { text: t('share.people') }), el('ul', { class: 'wds-people' }, items), el('p', { class: 'wds-hint', text: t('share.labels.hint') })]);
      }

      function mySection(status) {
        var parts = [el('h3', { text: t('share.me.title') }), el('p', { text: t('share.me.role', { role: t('role.' + status.role) }) })];
        if (status.role !== 'owner') parts.push(el('p', { class: 'wds-hint', text: t('share.me.onlyOwner') }));
        // each button with its own explanation directly below it
        parts.push(el('div', { class: 'wds-act' }, [
          btn(t('share.me.keyfile'), { wds: 'me-keyfile', onClick: function () {
            var kf = Core.makeKeyFile({ scope: client.scope, accessId: status.accessId, vaultId: status.vaultId, service: client.service });
            downloadText(kf.text, keyFileName(S, kf), 'application/json');
          } }),
          el('p', { class: 'wds-hint', text: t('share.me.keyfile.hint') }),
        ]));
        parts.push(el('div', { class: 'wds-act' }, [
          btn(t('share.me.renew'), { wds: 'me-renew', onClick: function () { guard(async function () { await client.renewKeys(); setFlash('ok', t('share.me.renew.done')); render('close'); }); } }),
          el('p', { class: 'wds-hint', text: t('share.me.renew.hint') }),
        ]));
        parts.push(el('div', { class: 'wds-act' }, [
          btn(t('share.me.lock'), { wds: 'me-lock', onClick: function () { locked = true; api.lock(); dlg.close(); } }),
          el('p', { class: 'wds-hint', text: t('share.me.lock.hint') }),
        ]));
        var pw = passphraseGroup(S, { mode: 'new', label: t('share.me.passphrase.new'), hint: null });
        var busy = busyLine(), out = el('div', { 'aria-live': 'polite' });
        var fs = el('fieldset', { class: 'wds-fs' }, [pw.nodes, pw.note(), el('div', { class: 'wds-actions' }, [btn(t('share.me.passphrase.submit'), { type: 'submit', primary: true, wds: 'me-passphrase-submit' })]), busy]);
        parts.push(el('details', { class: 'wds-details' }, [el('summary', { text: t('share.me.passphrase'), 'data-wds': 'me-passphrase-toggle' }),
          el('form', { novalidate: 'novalidate', onsubmit: async function (ev) {
            ev.preventDefault(); clear(out);
            var checked = await pw.validate();
            if (!checked) return;
            fs.disabled = true; showBusy(busy, t('unlock.busy'));
            await nextPaint();
            try { await client.changePassphrase(checked.passphrase); pw.reset(); out.appendChild(msg('ok', t('share.me.passphrase.done'))); }
            catch (e) { out.appendChild(msg('error', explain(e))); }
            fs.disabled = false; showBusy(busy, '');
          } }, fs), out]));
        return el('div', { class: 'wds-section' }, parts);
      }

      function render(focusKey) {
        if (dlg.closed) return;
        if (st.view === 'revoke') { viewRevokeConfirm(); return; }
        var status = client.status();
        if (!status.unlocked) { dlg.close(); return; }
        clear(dlg.body); dlg.setTitle(t('share.title')); dlg.setView('share');
        var owner = status.role === 'owner';
        var banners = [];
        banners.push(el('div', { 'data-wds': 'form-error', 'aria-live': 'polite' }, st.flash ? msg(st.flash.kind, st.flash.text) : null));
        if (owner && status.recovery) {
          banners.push(recoveryRequestNode(S, status.recovery, function () {
            guard(async function () { await client.cancelRecovery(); setFlash('ok', t('share.recovery.cancelled')); render(); });
          }));
        }
        var freshRecovered = owner ? api.acked.pending(status) : [];
        if (freshRecovered.length) {
          banners.push(recoveredNode(S, function () { api.acked.confirm(freshRecovered); render(); }));
        }
        if (owner && status.rekeyPending) {
          banners.push(el('div', { class: 'wds-msg wds-msg-warn', role: 'status' }, [
            el('p', { text: t('share.rekey.pending') }),
            el('div', { class: 'wds-actions' }, [btn(t('share.rekey.continue'), { primary: true, wds: 'rekey-continue', onClick: function () {
              viewProgress(t('share.rekey.pending'), function (onProgress) { return client.resumeRekey({ onProgress: onProgress }); });
            } })]),
          ]));
        }
        var seen = seenAtOpen, members = [], newOnes = [];
        if (owner) {
          members = client.members().sort(function (a, b) { return (b.self ? 1 : 0) - (a.self ? 1 : 0) || (a.escrow ? 1 : 0) - (b.escrow ? 1 : 0); });
          newOnes = members.filter(function (m) { return m.redeemed && !m.self && seen.indexOf(m.slotId) < 0; });
          if (newOnes.length) banners.push(msg('ok', newOnes.length === 1 ? t('note.redeemed.one') : t('note.redeemed.other', { n: newOnes.length }), 'status'));
        }
        append(dlg.body, banners);
        if (owner) { append(dlg.body, [peopleSection(members, seen), inviteSection()]); api.seen.add(members.filter(function (m) { return m.redeemed; }).map(function (m) { return m.slotId; })); }
        append(dlg.body, mySection(status));
        var target = focusKey && dlg.body.querySelector('[data-wds="' + focusKey + '"],[data-focus="' + focusKey + '"]');
        if (target) target.focus(); else dlg.dialog.focus();
      }

      render();
      // Bring the roster up to date (redemptions, key renewals) without blocking the first paint.
      if (client.status().role === 'owner') {
        client.maintain().then(function () { if (!dlg.closed && !locked && st.view === 'main' && !st.invite) render(); }, function () { /* the banners explain what is needed */ });
      }
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // 11. WDS.connect(): the store API
  // ------------------------------------------------------------------------------------------------------------
  function isInternalName(name) { return typeof name === 'string' && name.indexOf(INTERNAL_PREFIX) === 0; }
  function checkAppName(name) {
    if (typeof name !== 'string' || name.length === 0) throw new Core.UsageError('record name must be a non-empty string');
    if (isInternalName(name)) throw new Core.UsageError('record names starting with "' + INTERNAL_PREFIX + '" are reserved for the library');
    return name;
  }
  async function snapshotValue(value) { // detached copy for backups: JSON text round trip, Blobs to bytes
    if (typeof Blob !== 'undefined' && value instanceof Blob) return { kind: 'bytes', mime: value.type || undefined, value: new Uint8Array(await value.arrayBuffer()) };
    if (value instanceof ArrayBuffer) return { kind: 'bytes', value: new Uint8Array(value.slice(0)) };
    if (ArrayBuffer.isView(value)) return { kind: 'bytes', value: new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) };
    var text = JSON.stringify(value);
    return { kind: 'json', value: text === undefined ? null : JSON.parse(text) };
  }

  // Synchronous detached copy for the lock snapshot: the state is read once and must not change afterwards, even when an onLock
  // handler clears the object that getState() returned. Blobs are immutable; binary buffers are copied; the rest is JSON.
  function cloneState(value) {
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    var text = JSON.stringify(value);
    return text === undefined ? null : JSON.parse(text);
  }

  // Collection index (1.2): applies pending operations to a copy of the items. upsert keeps the c (creation time, only for sorting) of an
  // existing entry; ops run in order; nothing depends on a clock.
  function applyCollectionOps(items, ops) {
    var out = {};
    Object.keys(items).forEach(function (id) { out[id] = items[id]; });
    ops.forEach(function (op) {
      if (op.t === 'upsert') {
        var old = out[op.id];
        // An op that carries the version of the record it describes never replaces the entry of a newer version (a saved-later
        // title of another device is not overwritten by a delayed op of this one).
        if (old && old.v !== undefined && op.v !== undefined && op.v < old.v) return;
        var entry = { c: old ? old.c : op.c, m: op.m || {} };
        var v = op.v !== undefined ? op.v : (old ? old.v : undefined);
        if (v !== undefined) entry.v = v;
        out[op.id] = entry;
      }
      else if (op.t === 'remove') delete out[op.id];
    });
    return out;
  }

  function connect(opts) {
    opts = opts || {};
    var lang = detectLang(opts.locale);
    // Deliberately few options: no injected fetch, storage or Argon2 function, so nothing in the API can see the passphrase.
    var client = new Core.Client({ scope: opts.scope, service: opts.baseUrl, escrowPins: opts.escrowPins, retiredEscrow: opts.retiredEscrow });
    var notify = opts.notify !== false;
    var S = {
      opts: opts, lang: lang, t: makeT(lang), client: client, info: null, recoveryAcked: false, sandboxWipe: null,
      now: function () { return Date.now(); },
      getInfo: function (force) { return client.getScopeInfo(force).then(function (i) { S.info = i; return i; }); },
      // What a person sees instead of a record name ("books/179249e9"): the app's label function, or the name itself.
      label: function (name) {
        if (typeof opts.label !== 'function') return name;
        try { var l = opts.label(name); return typeof l === 'string' && l.trim() ? l.trim().slice(0, 200) : name; } catch (e) { return name; }
      },
    };
    var t = S.t;   // reassigned by setLocale
    var unlockPromise = null, lockPromise = null, pending = new Map(), cache = new Map(), queues = new Map();
    var allHandles = new Set(), handlesByName = new Map();           // autosave handles that are alive (a superseded one until it is flushed)
    var held = new Map(), lastVaultId = null;        // lock snapshots that could not be saved yet (1.5)
    var collections = new Map();
    var conflictGlobal = null, conflictByName = new Map(), conflictPrefixes = [];
    var staleHandler = null, lockHandlers = [], unlockHandlers = [], labels = {};
    var rekeyRunning = false, watchInstalled = false, lastCheck = 0, checking = false, notifiedStale = {}, unloadInstalled = false, sandboxBar = null, barPad = null;

    function toast(kind, text, o) {
      if (!notify) return null;
      o = o || {};
      return showToast({ lang: lang, kind: kind, text: text, actions: o.actions, sticky: o.sticky, key: o.key, regionLabel: t('common.notifications'), dismissLabel: t('common.dismiss'), timeoutMs: o.timeoutMs });
    }
    function storageGet(suffix) {
      try { return client.storage.getItem('wds:' + client.scope + ':' + client.status().accessId + ':' + suffix); } catch (e) { return null; }
    }
    function storageSet(suffix, v) {
      try { client.storage.setItem('wds:' + client.scope + ':' + client.status().accessId + ':' + suffix, v); } catch (e) { /* storage unavailable */ }
    }
    function logError(what, e) { if (typeof console !== 'undefined' && console.error) console.error('wds: ' + what + ': ' + ((e && e.message) || e)); }
    function addOnce(list, fn) { if (typeof fn !== 'function') throw new Core.UsageError('a function is required'); if (list.indexOf(fn) < 0) list.push(fn); return function () { var i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }; }
    function canWrite() { var r = client.status().role; return r === 'owner' || r === 'write'; }
    function sameJson(a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; } }

    // ---- sandbox ----
    function showSandboxBar() {
      if (!isSandbox(S) || (sandboxBar && sandboxBar.parentNode)) return;
      ensureStyle();
      sandboxBar = pinVisible(el('div', { class: 'wds-root', role: 'status', lang: lang, 'data-wds': 'sandbox-bar', text: t('sandbox.bar') }), {
        position: 'fixed', top: '0', left: '0', right: '0', 'z-index': '2147483001', 'text-align': 'center', padding: '.2rem .5rem', 'font-size': '.8125rem', 'line-height': '1.4',
        'font-weight': '600', 'background-color': '#fff4cc', color: '#3d2b00', 'border-bottom': '2px solid #b58100', 'pointer-events': 'none',
      });
      document.body.appendChild(sandboxBar);
      document.documentElement.style.setProperty('--wds-sandbox-bar', sandboxBar.offsetHeight + 'px');   // for sticky headers: top: var(--wds-sandbox-bar, 0)
      // The bar is fixed at the top: the page moves down by its height, so that it does not cover the app's own header.
      var root = document.documentElement, cs = window.getComputedStyle ? window.getComputedStyle(root) : null;
      barPad = [root.style.getPropertyValue('padding-top'), root.style.getPropertyPriority('padding-top')];
      root.style.setProperty('padding-top', ((cs ? parseFloat(cs.paddingTop) || 0 : 0) + sandboxBar.offsetHeight) + 'px', 'important');
    }
    function hideSandboxBar() {
      if (sandboxBar && sandboxBar.parentNode) sandboxBar.parentNode.removeChild(sandboxBar);
      sandboxBar = null;
      document.documentElement.style.removeProperty('--wds-sandbox-bar');
      if (barPad) { document.documentElement.style.setProperty('padding-top', barPad[0], barPad[1]); barPad = null; }
    }
    // The session ended with an auth failure or an unknown vault after the nightly wipe of a sandbox: the vault is gone.
    function sandboxWiped(e) {
      if (!isSandbox(S) || !S.sandboxWipe || Date.now() / 1000 < S.sandboxWipe) return false;
      return !!e && ((e instanceof Core.AuthError && e.code !== 'forbidden') || e.status === 404);
    }

    // ---- errors and the end of a session ----
    function attachBackup(e) { e.downloadBackup = downloadBackup; return e; }
    function endSession(reason, emptied) {
      lockSession(reason, emptied).catch(function (e) { logError('lock failed', e); });
    }
    function reportError(e) {
      if (sandboxWiped(e)) endSession('expired', true);
      else if (e instanceof Core.OfflineError) {
        attachBackup(e);
        toast('warn', t('note.offline'), { key: 'offline', actions: [{ label: t('note.backup'), close: false, onClick: function () { downloadBackup(); } }] });
      } else if (e instanceof Core.QuotaError) toast('warn', t('note.quota', { message: e.message }), { key: 'quota' });
      else if (e instanceof Core.AuthError && (e.code === 'revoked' || e.status === 401)) endSession(e.code === 'revoked' ? 'revoked' : 'expired', false);
      else if (e instanceof Core.AuthError && e.code === 'forbidden') toast('warn', t('note.forbidden'), { key: 'forbidden' });
      else if (e instanceof Core.IntegrityError) toast('error', t('note.integrity', { code: e.code || 'integrity' }), { key: 'integrity' });
      else if (e instanceof Core.VersionError) toast('error', t('note.version', { message: e.message }), { key: 'version' });
    }
    async function guarded(fn) {
      try { return await fn(); } catch (e) {
        if (e instanceof Core.OfflineError) attachBackup(e);
        reportError(e);
        throw e;
      }
    }

    // ---- backup of unsaved values ----
    async function downloadBackup() {
      var recs = [];
      pending.forEach(function (v, name) { recs.push({ name: name, dir: 'unsaved', kind: v.kind, mime: v.mime, value: v.value, time: v.time }); });
      held.forEach(function (h, name) { if (!pending.has(name) && h.snap) recs.push({ name: name, dir: 'unsaved', kind: h.snap.kind, mime: h.snap.mime, value: h.snap.value, time: S.now() }); });
      cache.forEach(function (value, name) { if (!pending.has(name) && !held.has(name)) recs.push({ name: name, dir: 'last-known', kind: 'json', value: value }); });
      if (!recs.length) { toast('info', t('note.backup.none'), { key: 'backup' }); return false; }
      if (recs.length === 1 && recs[0].dir === 'unsaved') {
        var r = recs[0];
        downloadBlob(new Blob([recordBytes(r)], { type: r.kind === 'json' ? 'application/json' : (r.mime || 'application/octet-stream') }), markedName(r.name, 'unsaved', r.kind));
        return true;
      }
      var arc = buildArchive(recs.map(function (r) { return { name: r.dir + '/' + r.name, kind: r.kind, mime: r.mime, value: r.value, time: r.time }; }),
        { scope: client.scope, service: client.service, exported: new Date().toISOString(), note: 'backup after a failed save; unsaved/ holds values that could not be saved' });
      downloadBlob(arc.blob, client.scope + '-backup.zip');
      return true;
    }
    function remember(name, value) {
      if (value === undefined || value === null || typeof value !== 'object' && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') { if (value === null) cache.set(name, null); return; }
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || (typeof Blob !== 'undefined' && value instanceof Blob)) return;
      try { var text = JSON.stringify(value); if (text.length < 1000000) cache.set(name, JSON.parse(text)); } catch (e) { /* not serialisable */ }
    }

    // ---- per-name write queue ----
    function enqueue(name, fn) {
      var prev = queues.get(name) || Promise.resolve();
      var p = prev.then(fn);
      var tail = p.then(function () {}, function () {});
      queues.set(name, tail);
      tail.then(function () { if (queues.get(name) === tail) queues.delete(name); });
      return p;
    }
    async function ensureUnlocked() {
      if (unlockPromise) await unlockPromise;
      if (!client.status().unlocked) await store.unlock();
    }

    // ---- conflicts (1.1): internal handler of a collection index (not here, see writeBatch) > exact name > prefix > global > built-in dialog ----
    function handlerFor(name) {
      var h = conflictByName.get(name);
      if (h) return h;
      for (var i = 0; i < conflictPrefixes.length; i++) if (name.indexOf(conflictPrefixes[i].prefix) === 0) return conflictPrefixes[i].fn;
      return conflictGlobal;
    }
    function registerConflict(pattern, fn) {
      if (typeof pattern !== 'string' || !pattern) throw new Core.UsageError('onConflict: the pattern must be a record name or a prefix ending in "/"');
      if (isInternalName(pattern)) throw new Core.UsageError('onConflict: names starting with "' + INTERNAL_PREFIX + '" are reserved for the library');
      var isPrefix = pattern.slice(-1) === '/';
      if (fn === null || fn === undefined) { conflictByName.delete(pattern); conflictPrefixes = conflictPrefixes.filter(function (p) { return p.prefix !== pattern; }); return function () {}; }
      if (typeof fn !== 'function') throw new Core.UsageError('onConflict: a function is required');
      if (!isPrefix) { conflictByName.set(pattern, fn); return function () { if (conflictByName.get(pattern) === fn) conflictByName.delete(pattern); }; }
      conflictPrefixes.forEach(function (p) {
        if (p.prefix !== pattern && (p.prefix.indexOf(pattern) === 0 || pattern.indexOf(p.prefix) === 0)) {
          throw new Core.UsageError('onConflict: the prefix "' + pattern + '" overlaps the prefix "' + p.prefix + '", which has a handler already');
        }
      });
      conflictPrefixes = conflictPrefixes.filter(function (p) { return p.prefix !== pattern; });
      var entry = { prefix: pattern, fn: fn };
      conflictPrefixes.push(entry);
      return function () { conflictPrefixes = conflictPrefixes.filter(function (p) { return p !== entry; }); };
    }
    // err: the core's ConflictError; op: 'set' | 'remove'. Resolves {type: 'mine' | 'theirs'} or {type: 'merge', value}.
    function decide(err, name, op) {
      var choice = null;
      var m = err.mine || {};
      var mine = { value: m.value, kind: m.kind, mime: m.mime, deleted: !!m.deleted };
      var theirs = err.theirs ? Object.assign({}, err.theirs) : null;
      var c = {
        name: name, op: op, mine: mine, theirs: theirs,
        keepMine: function () { choice = { type: 'mine' }; },
        keepTheirs: function () { choice = { type: 'theirs' }; },
        merge: function (fn) {
          if (op === 'remove') throw new Core.UsageError('merge() is not available when a record is being removed');
          if (typeof fn !== 'function') throw new Core.UsageError('merge() needs a function');
          choice = { type: 'merge', fn: fn };
        },
        ask: function () { return conflictDialog(S, c).then(function (which) { choice = { type: which }; return which; }); },
      };
      function viaDialog() { return conflictDialog(S, c).then(function (which) { return { type: which }; }); }
      var handler = handlerFor(name);
      var chosen = handler ? new Promise(function (resolve) { resolve(handler(c)); }).then(function (ret) {
        if (!choice && (ret === 'mine' || ret === 'theirs')) choice = { type: ret };
        return choice;
      }).catch(function (e) { logError('conflict handler for "' + name + '" failed, the dialog decides', e); choice = null; return null; }) : Promise.resolve(null);
      return chosen.then(function (ch) { return ch || viaDialog(); }).then(function (ch) {
        if (ch.type !== 'merge') return ch;
        return Promise.resolve(ch.fn(mine.value, theirs && !theirs.deleted ? theirs.value : undefined)).then(function (v) { return { type: 'merge', value: v }; });
      });
    }

    // info (optional, filled in): {theirsDeleted}. o.silentIdentical: a replay of a saved snapshot may meet its own earlier write.
    async function writeRecord(name, value, o, info) {
      var resolution = 'saved', lastErr = null;
      for (var round = 0; round < 4; round++) {
        try {
          var putOpts = o && o.mime ? { mime: o.mime } : undefined;
          var r = await client.put(name, value, putOpts);
          pending.delete(name); remember(name, value);
          var out = { name: name, version: r.version, size: r.size, resolution: resolution };
          if (resolution === 'merged') out.value = value;
          return out;
        } catch (e) {
          if (!(e instanceof Core.ConflictError)) {
            if (e instanceof Core.OfflineError) {
              try { var snap = await snapshotValue(value); pending.set(name, { kind: snap.kind, mime: (o && o.mime) || snap.mime, value: snap.value, time: S.now() }); } catch (e2) { /* not backed up */ }
            }
            throw e;
          }
          lastErr = e;
          var th = e.theirs;
          if (info) info.theirsDeleted = !!(th && th.deleted);
          if (o && o.silentIdentical && th && !th.deleted && e.mine && e.mine.kind === 'json' && th.kind === 'json' && sameJson(th.value, e.mine.value)) {
            remember(name, th.value);
            return { name: name, version: th.version, resolution: 'saved' };
          }
          var d = await decide(e, name, 'set');
          if (d.type === 'theirs') {
            if (th && !th.deleted) remember(name, th.value);
            return { name: name, version: th ? th.version : null, resolution: 'theirs', deleted: !!(th && th.deleted), value: th && !th.deleted ? th.value : undefined };
          }
          if (d.type === 'merge') { value = d.value; resolution = 'merged'; } else resolution = 'mine';
        }
      }
      throw lastErr;
    }
    function setRecord(name, value, o, info) {
      return enqueue(name, async function () { await ensureUnlocked(); return guarded(function () { return writeRecord(name, value, o, info); }); });
    }
    // Same as setRecord for work that runs while the unlock is still finishing (snapshot replay).
    function setRecordNow(name, value, o, info) {
      return enqueue(name, function () { return guarded(function () { return writeRecord(name, value, o, info); }); });
    }

    // ---- remove (1.4) ----
    async function removeRecord(name) {
      var mineChosen = false, lastErr = null;
      for (var round = 0; round < 4; round++) {
        try {
          var done = await client.delete(name);
          cache.delete(name); pending.delete(name);
          return { name: name, deleted: done, resolution: !done ? 'absent' : mineChosen ? 'mine' : 'deleted' };
        } catch (e) {
          if (!(e instanceof Core.ConflictError)) throw e;
          lastErr = e;
          if (!e.theirs || e.theirs.deleted) { cache.delete(name); return { name: name, deleted: false, resolution: 'absent' }; }
          var d = await decide(e, name, 'remove');
          if (d.type === 'theirs') { remember(name, e.theirs.value); return { name: name, deleted: false, resolution: 'theirs', value: e.theirs.value }; }
          mineChosen = true;
        }
      }
      throw lastErr || new Core.ConflictError('could not delete "' + name + '" because it keeps changing', { code: 'precondition_failed', record: name });
    }

    // ---- autosave (1.5) ----
    // hooks (collections): prepare(state) -> ctx (may throw, nothing is written then), afterSave(result, state, ctx).
    function makeAutosave(name, getState, o, hooks) {
      o = o || {};
      if (typeof getState !== 'function') throw new Core.UsageError('autosave needs a function that returns the state');
      var delay = o.delayMs === undefined ? 2000 : o.delayMs;
      var timer = null, dirty = false, running = null, status = 'idle', prevClean = 'idle', failures = 0, paused = 0, stopReason = null, lastError = null, warnedReplaced = false;
      var handle;
      var old = handlesByName.get(name);
      if (old) old._i.supersede();
      function setStatus(s, err) {
        status = s;
        if (o.onStatus) { try { o.onStatus(s, err); } catch (e) { /* app callback failed */ } }
      }
      function fail(err) {
        lastError = err;
        if (o.onError) { try { o.onError(err); } catch (e) { /* app callback failed */ } }
      }
      function schedule(ms) { if (stopReason || paused) return; clearTimeout(timer); timer = setTimeout(run, ms === undefined ? delay : ms); }
      function run() {
        clearTimeout(timer); timer = null;
        if (stopReason || paused || running || !dirty) return running || Promise.resolve();
        if (!client.status().unlocked) { setStatus('error', new Core.UsageError('locked: unlock the vault first', { code: 'locked' })); return Promise.resolve(); }
        dirty = false;
        var state, ctx;
        try { state = getState(); if (state !== undefined && hooks && hooks.prepare) ctx = hooks.prepare(state); } catch (e) { dirty = true; setStatus('error', e); fail(e); return Promise.resolve(); }
        if (state === undefined) { setStatus(prevClean); return Promise.resolve(); }   // nothing to save right now
        setStatus('saving');
        running = enqueue(name, function () { return guarded(function () { return writeRecord(name, state, o); }); }).then(function (res) {
          failures = 0; lastError = null;
          setStatus(dirty ? 'dirty' : 'saved');
          if (res.resolution === 'theirs' || res.resolution === 'merged') { if (o.onResolved) { try { o.onResolved(res); } catch (e) { /* app callback failed */ } } }
          if (o.onSaved) { try { o.onSaved(res); } catch (e) { /* app callback failed */ } }
          if (hooks && hooks.afterSave) { try { hooks.afterSave(res, state, ctx); } catch (e) { logError('afterSave failed', e); } }
        }, function (err) {
          dirty = true; setStatus('error', err); fail(err);
          if (err instanceof Core.OfflineError) { failures++; schedule(Math.min(60000, 5000 * failures)); }
        }).then(function () { running = null; if (dirty && status !== 'error') schedule(); });
        return running;
      }
      async function flush() {
        try {
          for (var i = 0; i < 5; i++) {
            if (running) await running;
            if (!dirty || stopReason || paused) return status;
            await run();
            if (status === 'error') return status;
          }
        } catch (e) { /* flush never rejects */ }
        return status;
      }
      function stopInternal(reason) {
        if (stopReason) return;
        stopReason = reason; clearTimeout(timer); timer = null;
        allHandles.delete(handle);
        if (handlesByName.get(name) === handle) handlesByName.delete(name);
        setStatus('stopped');
      }
      handle = {
        name: name,
        changed: function () {
          if (stopReason) { var e = new Core.UsageError('autosave handle stopped (' + stopReason + ')', { code: 'stopped' }); fail(e); return; }
          dirty = true;
          if (status !== 'saving' && status !== 'dirty') { prevClean = status; }
          if (status !== 'saving') setStatus('dirty');
          if (!running) schedule();
        },
        flush: flush,
        stop: function () { stopInternal('stop'); },
        get status() { return status; },
        get dirty() { return dirty || !!running; },
        get error() { return lastError; },
        get stopReason() { return stopReason; },
      };
      Object.defineProperty(handle, '_i', { value: {
        // A remove() of this name is running: no save meanwhile. done(result) with the outcome, or done(null) when the request failed.
        pause: function () {
          paused++; clearTimeout(timer); timer = null;
          return function (result) {
            paused = Math.max(0, paused - 1);
            if (stopReason) return;
            if (result && (result.resolution === 'deleted' || result.resolution === 'absent' || result.resolution === 'mine')) { stopInternal('removed'); return; }
            if (result && result.resolution === 'theirs') {
              setStatus('replaced');   // an edit made meanwhile stays dirty and is saved: the person chose to keep the entry
              if (o.onReplaced) { try { o.onReplaced(result.value); } catch (e) { logError('onReplaced failed', e); } }
              else if (!warnedReplaced) { warnedReplaced = true; if (typeof console !== 'undefined' && console.warn) console.warn('wds: "' + name + '" was not removed, the other side\'s newer version was kept; pass onReplaced to autosave() to show it'); }
              if (dirty && !running) schedule();
              return;
            }
            if (dirty && !running) schedule();
          };
        },
        supersede: function () {
          handlesByName.delete(name);
          flush().then(function () { stopInternal('superseded'); });
        },
        running: function () { return running || Promise.resolve(); },
        // Takes the lock snapshot: getState() once, only when something is unsaved. Then the handle stops.
        snapshot: function (reason) {
          var snap = null;
          if (!stopReason && dirty) {
            try {
              var state = getState();
              if (state !== undefined) snap = { name: name, state: cloneState(state), o: { mime: o.mime }, hooks: hooks || null };
            } catch (e) { logError('could not read the state of "' + name + '" before locking', e); }
          }
          stopInternal(reason);
          return snap;
        },
      } });
      allHandles.add(handle); handlesByName.set(name, handle);
      installUnloadGuards();
      return handle;
    }
    function handlesNamed(name) { var out = []; allHandles.forEach(function (h) { if (h.name === name) out.push(h); }); return out; }

    // ---- lock snapshots and lock (1.5) ----
    async function writeSnapshot(entry) {
      var ctx = entry.hooks && entry.hooks.prepare ? entry.hooks.prepare(entry.state) : undefined;
      var res = await setRecordNow(entry.name, entry.state, Object.assign({}, entry.o, { silentIdentical: true }), {});
      if (entry.hooks && entry.hooks.afterSave) await entry.hooks.afterSave(res, entry.state, ctx, true);
      return res;
    }
    function timeout(ms) { return new Promise(function (resolve) { setTimeout(function () { resolve('timeout'); }, ms); }); }
    function lockSession(reason, emptied) {
      if (lockPromise) return lockPromise;
      lockPromise = (async function () {
        try {
          var vault = client.status().vaultId || lastVaultId;
          var live = Array.from(allHandles), saveable = reason === 'user' && client.status().unlocked;
          var deadline = timeout(8000);
          if (saveable && live.length) await Promise.race([Promise.all(live.map(function (h) { return h._i.running(); })), deadline]);
          // The state of every dirty handle is read once, now, before any onLock handler can touch the screen.
          var snaps = [];
          live.forEach(function (h) { var s = h._i.snapshot('lock'); if (s) snaps.push(s); });
          if (saveable) {
            var saves = snaps.map(function (s) { return writeSnapshot(s).then(function () { s.saved = true; }, function () { /* kept below */ }); });
            var flushed = Promise.all(saves).then(function () { return Promise.all(Array.from(collections.values()).map(function (c) { return c._flushOnLock(); })); });
            await Promise.race([flushed, deadline]);
          }
          var unsaved = snaps.filter(function (s) { return !s.saved; });
          for (var u = 0; u < unsaved.length; u++) { try { unsaved[u].snap = await snapshotValue(unsaved[u].state); } catch (e) { unsaved[u].snap = null; } held.set(unsaved[u].name, unsaved[u]); }
          collections.forEach(function (c) { c._onLock(vault); });
          lastVaultId = vault || lastVaultId;
          client.lock(); cache.clear(); labels = {};
          closeAllToasts();   // a notice about the session that just ended (an export, a warning) must not stay on the lock screen
          hideSandboxBar();
          if (reason === 'revoked') { var lost = held.size > 0 || Array.from(collections.values()).some(function (c) { return c._hasOps(); }); held.clear(); collections.forEach(function (c) { c._dropOps(); }); if (lost) toast('warn', t('note.unsavedDropped'), { key: 'unsaved' }); }
          if (reason === 'revoked') toast('error', t('note.revoked'), { key: 'session' });
          else if (reason === 'expired') toast('error', emptied ? t('sandbox.emptied', { date: formatDate(S.sandboxWipe, S.lang) }) : t('note.sessionExpired'), { key: 'session' });
          lockHandlers.slice().forEach(function (h) { try { h(reason); } catch (e) { /* app handler failed */ } });
        } finally { lockPromise = null; }
      })();
      return lockPromise;
    }
    // After the unlock of the same vault the saved snapshots are written (before onUnlock handlers run); of another vault they are dropped.
    async function replayHeld() {
      var st = client.status(), cols = Array.from(collections.values());
      var anyOps = cols.some(function (c) { return c._hasOps(); });
      if (!held.size && !anyOps) return;
      if (st.vaultId !== lastVaultId) {   // another vault
        held.clear(); cols.forEach(function (c) { c._dropOps(); });
        toast('warn', t('note.unsavedDropped'), { key: 'unsaved' });
        return;
      }
      var entries = Array.from(held.values());
      for (var i = 0; i < entries.length; i++) {
        try { await writeSnapshot(entries[i]); held.delete(entries[i].name); } catch (e) { /* stays held; the error toast came from the failed write */ }
      }
      await Promise.all(cols.map(function (c) { return c._flushOnLock().catch(function () {}); }));
    }
    function hasUnsaved() {
      var any = held.size > 0;
      allHandles.forEach(function (a) { if (a.dirty) any = true; });
      collections.forEach(function (c) { if (c._hasOps(true)) any = true; });
      return any;
    }

    // ---- collections (1.2) ----
    function collectionApply(items, ops) { return applyCollectionOps(items, ops); }
    function makeCollection(prefix, options) {
      var col = {}, opt = {}, loaded = false, base = null, ops = [], opsVault = null, writing = null, failed = false, lastWrite = 0, debounceTimer = null, loading = null, warnedBig = false;
      var listeners = [], gate = Promise.resolve();
      // Reads and writes of the index take turns: a read that was sent before a write must not come back after it (the core would see
      // an older version than the write it just made).
      function exclusive(fn) { var p = gate.then(fn, fn); gate = p.then(function () {}, function () {}); return p; }
      function setOptions(o) {
        o = o || {};
        if (o.meta !== undefined && typeof o.meta !== 'function') throw new Core.UsageError('collection: meta must be a function (value, id) => object');
        var idx = o.index === undefined ? prefix.slice(0, -1) + '.index' : o.index;
        checkAppName(idx);
        if (idx.indexOf(prefix) === 0) throw new Core.UsageError('collection: the index record "' + idx + '" must lie outside the prefix "' + prefix + '"');
        if (col.indexName && col.indexName !== idx) { if (ops.length) throw new Core.UsageError('collection: the index name cannot change while changes are waiting to be written'); loaded = false; base = null; }
        opt = { meta: o.meta };
        col.indexName = idx;
      }
      function checkId(id) {
        if (typeof id !== 'string' || id.length < 1 || id.length > 200 || id.indexOf('/') >= 0) throw new Core.UsageError('collection: an id is 1 to 200 characters without "/"');
        return id;
      }
      function newId() {
        var b = new Uint8Array(10), s = '', chars = '0123456789abcdefghijklmnopqrstuvwxyz';
        crypto.getRandomValues(b);
        for (var i = 0; i < 10; i++) s += chars[b[i] % 36];
        return s;
      }
      function metaFor(value, id, explicit) {
        var m = explicit !== undefined ? explicit : (opt.meta ? opt.meta(value, id) : undefined);
        if (m === undefined || m === null) return {};
        if (typeof m !== 'object' || Array.isArray(m)) throw new Core.UsageError('collection: meta must be a plain object');
        var text = JSON.stringify(m);
        if (utf8(text).length > 512) throw new Core.UsageError('collection: the meta of "' + id + '" is larger than 512 bytes; keep only what a list needs');
        return JSON.parse(text);
      }
      function parseIndex(v) {
        if (!v || typeof v !== 'object' || v.wds !== 'collection/1' || !v.items || typeof v.items !== 'object' || Array.isArray(v.items)) {
          throw new Core.UsageError('the record "' + col.indexName + '" is not a collection index', { code: 'bad_index' });
        }
        var out = {};
        Object.keys(v.items).forEach(function (id) {
          var e = v.items[id];
          if (e && typeof e === 'object') {
            out[id] = { c: Number.isFinite(e.c) ? e.c : 0, m: e.m && typeof e.m === 'object' && !Array.isArray(e.m) ? e.m : {} };
            if (Number.isInteger(e.v) && e.v >= 0) out[id].v = e.v;   // version of the record this entry describes
          }
        });
        return out;
      }
      function view() { return base ? applyCollectionOps(base.items, ops) : {}; }
      function listOf(items) {
        return Object.keys(items).map(function (id) { return { id: id, name: prefix + id, meta: items[id].m, created: items[id].c }; })
          .sort(function (a, b) { return a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
      }
      function diff(before, after) {
        var added = [], removed = [], changed = [];
        Object.keys(after).forEach(function (id) { if (!before[id]) added.push(id); else if (!sameJson(before[id].m, after[id].m)) changed.push(id); });
        Object.keys(before).forEach(function (id) { if (!after[id]) removed.push(id); });
        return { added: added, removed: removed, changed: changed };
      }
      function fire(d) {
        if (!d.added.length && !d.removed.length && !d.changed.length) return;
        var payload = { items: listOf(view()), added: d.added, removed: d.removed, changed: d.changed };
        listeners.slice().forEach(function (fn) { try { fn(payload); } catch (e) { logError('collection onChange handler failed', e); } });
      }
      async function readBase(fresh) {
        var vault = client.status().vaultId;
        var r = await guarded(function () { return client.getRecord(col.indexName, fresh ? { fresh: true } : undefined); });
        if (client.status().vaultId !== vault) throw new Core.UsageError('collection: the vault changed while the index was being read', { code: 'vault_changed' });
        // A read that was slower than a write of this page returns an older version: it must not replace the newer base.
        if (r && base && base.version !== undefined && r.version < base.version) { loaded = true; return; }
        base = r ? { version: r.version, items: parseIndex(r.value) } : { version: undefined, items: {} };
        loaded = true;
      }
      function annotate(e, op) {
        var c = e;
        if (e.stored) { c = Object.assign(Object.create(Object.getPrototypeOf(e)), e, { message: e.message, stack: e.stack }); }
        c.stored = true; c.id = op.id; c.record = prefix + op.id;   // not err.name: that stays the class name of the error
        return c;
      }
      async function writeBatch(batch) {
        var lastErr = null, vault = client.status().vaultId;
        // A batch belongs to the vault it started in: after a lock (or another unlock) it must not touch the index of another vault.
        function sameVault() { return client.status().vaultId === vault; }
        function vaultChanged() { return new Core.UsageError('collection: the vault changed while the index was being written', { code: 'vault_changed' }); }
        if (!base) await readBase(false);
        for (var round = 0; round < 10; round++) {
          if (!sameVault()) throw vaultChanged();
          var items = applyCollectionOps(base.items, batch);
          var value = { wds: 'collection/1', items: items };
          if (!warnedBig && JSON.stringify(value).length > 262144) { warnedBig = true; if (typeof console !== 'undefined' && console.warn) console.warn('wds: the index "' + col.indexName + '" is larger than 256 KB; split the collection (by year or project) or keep meta smaller'); }
          try {
            // base null = the index must not exist yet (If-None-Match); never fall back to what the client happens to know
            var r = await guarded(function () { return client.put(col.indexName, value, { base: base.version === undefined ? null : base.version }); });
            if (sameVault()) base = { version: r.version, items: items };
            lastWrite = Date.now(); failed = false;
            ops = ops.filter(function (op) { return batch.indexOf(op) < 0; });
            batch.forEach(function (op) { if (op.resolve) op.resolve(); });
            return;
          } catch (e) {
            if (!(e instanceof Core.ConflictError)) throw e;
            lastErr = e;
            var th = e.theirs;   // theirs is the new base; the pending changes are replayed on it
            if (!sameVault()) throw vaultChanged();
            base = th && !th.deleted ? { version: th.version, items: parseIndex(th.value) } : { version: th ? th.version : undefined, items: {} };
            if (round < 9) await sleep(50 + Math.floor(Math.random() * 450));
          }
        }
        throw lastErr;
      }
      async function pump() {
        while (ops.some(function (op) { return !op.lazy; })) {
          var batch = ops.slice();
          try { await exclusive(function () { return writeBatch(batch); }); }
          catch (e) {
            failed = true;
            // Every call that waits for the index fails, also those queued while this write was running; their ops stay queued for a retry.
            ops.forEach(function (op) { if (op.reject) { var r = op.reject; op.reject = null; op.resolve = null; r(op.t === 'noop' ? e : annotate(e, op)); } });
            return;
          }
        }
      }
      function kick() {
        clearTimeout(debounceTimer); debounceTimer = null;
        if (!writing) writing = pump().then(function () { writing = null; }, function () { writing = null; });
        return writing;
      }
      // o: {lazy: waits for the next write that happens anyway, debounced: at most one write per 10 s}
      function queueOp(op, o) {
        o = o || {};
        op.lazy = !!o.lazy;
        ops.push(op); opsVault = client.status().vaultId || opsVault;
        if (op.lazy) return Promise.resolve();
        var p = new Promise(function (resolve, reject) { op.resolve = resolve; op.reject = reject; });
        if (o.debounced) {
          if (!debounceTimer && !writing) debounceTimer = setTimeout(kick, Math.max(0, lastWrite + 10000 - Date.now()));
        } else kick();
        return p;
      }
      function upsertOp(id, meta, c, v) { var op = { t: 'upsert', id: id, c: c === undefined ? Date.now() : c, m: meta }; if (Number.isInteger(v)) op.v = v; return op; }
      // What the collection does after an entity was written (or turned out to be gone). Resolves when the index write succeeded.
      function afterEntity(id, res, info, meta, value, explicitMeta, o, created) {
        var mem = view()[id], force = info && info.theirsDeleted;
        if (res.resolution === 'theirs') {
          if (res.deleted) { return canWrite() && mem ? queueOp({ t: 'remove', id: id }, { lazy: true }) : Promise.resolve(); }
          var tm; try { tm = metaFor(res.value, id, undefined); } catch (e) { tm = null; }
          if (tm && (!mem || !sameJson(mem.m, tm))) return queueOp(upsertOp(id, tm, undefined, res.version), o);
          return Promise.resolve();
        }
        var m = res.resolution === 'merged' && explicitMeta === undefined ? metaFor(res.value, id, undefined) : meta;
        if (force || !mem || !sameJson(mem.m, m)) return queueOp(upsertOp(id, m, created, res.version), o);
        return Promise.resolve();
      }
      async function loadNow() {
        if (loaded) return;
        if (!loading) loading = exclusive(function () { return readBase(false); }).then(function () { loading = null; }, function (e) { loading = null; throw e; });
        await loading;
      }
      async function softLoad() { try { await ensureUnlocked(); await loadNow(); } catch (e) { /* the index is repaired by the next write */ } }
      function needLoaded() { if (!loaded) throw new Core.UsageError('call await ' + prefix.slice(0, -1) + '.load() first: the list of "' + prefix + '" is not loaded'); }

      col.prefix = prefix;
      col.load = async function () {
        await ensureUnlocked();
        await loadNow();
        return listOf(view());
      };
      col.refresh = async function () {
        await ensureUnlocked();
        if (writing) await writing;
        var before = null;
        await exclusive(function () { before = loaded ? view() : null; return readBase(true); });
        if (before) fire(diff(before, view()));
        return listOf(view());
      };
      col.items = function () { needLoaded(); return listOf(view()); };
      col.has = function (id) { needLoaded(); return !!view()[id]; };
      col.get = async function (id) {
        checkId(id);
        var v = await store.get(prefix + id);
        if (v === undefined && loaded && canWrite() && view()[id]) queueOp({ t: 'remove', id: id }, { lazy: true });
        return v;
      };
      col.getAll = async function (o) {
        await col.load();
        var list = listOf(view()), vals = await store.getMany(list.map(function (e) { return e.name; }), o), out = [];
        list.forEach(function (e, i) {
          if (vals[i] === undefined) { if (canWrite()) queueOp({ t: 'remove', id: e.id }, { lazy: true }); return; }
          out.push({ id: e.id, name: e.name, meta: e.meta, value: vals[i] });
        });
        return out;
      };
      function checkCreated(o) {
        if (o.created !== undefined && !Number.isFinite(o.created)) throw new Core.UsageError('collection: created must be a number (milliseconds since 1970), it only decides the order of the list');
      }
      col.add = async function (value, o) {
        o = o || {};
        var id = o.id !== undefined ? checkId(o.id) : newId(), name = prefix + id;
        checkAppName(name);
        var meta = metaFor(value, id, o.meta);
        checkCreated(o);
        var info = {};
        var res = await setRecord(name, value, { mime: o.mime }, info);
        await afterEntity(id, res, info, meta, value, o.meta, undefined, o.created);
        return { id: id, name: name, version: res.version, resolution: res.resolution };
      };
      col.set = async function (id, value, o) {
        o = o || {};
        checkId(id); var name = prefix + id;
        var meta = metaFor(value, id, o.meta);
        checkCreated(o);
        await softLoad();
        var info = {};
        var res = await setRecord(name, value, { mime: o.mime }, info);
        await afterEntity(id, res, info, meta, value, o.meta, undefined, o.created);   // created only counts for an entry the index does not have yet
        return res;
      };
      col.remove = async function (id) {
        checkId(id);
        await softLoad();
        var res = await store.remove(prefix + id), mem = view()[id];
        if (res.resolution === 'deleted' || res.resolution === 'absent' || res.resolution === 'mine') {
          if (mem || res.resolution !== 'absent') await queueOp({ t: 'remove', id: id });
        } else if (res.resolution === 'theirs') {
          var tm; try { tm = metaFor(res.value, id, undefined); } catch (e) { tm = null; }
          if (tm && (!mem || !sameJson(mem.m, tm))) await queueOp(upsertOp(id, tm));
        }
        return res;
      };
      col.autosave = function (id, getState, o) {
        checkId(id); o = o || {};
        return makeAutosave(prefix + id, getState, o, {
          prepare: function (state) { return metaFor(state, id, o.meta); },
          // meta changes of an autosave are written at most every 10 s (and on lock and pagehide)
          afterSave: function (res, state, meta, now) {
            var p = (now ? loadNow().catch(function () {}) : softLoad()).then(function () { return afterEntity(id, res, {}, meta, state, o.meta, { debounced: !now }); });
            return now ? p : p.catch(function (e) { logError('index of "' + prefix + '" not updated yet', e); });
          },
        });
      };
      // Resolves when every change of this collection that is waiting for the index (also after a failed index write, or lazy ones) is on the
      // server; rejects with the error of the failed write (the changes stay queued). Nothing to do: resolves at once.
      col.flush = async function () {
        await ensureUnlocked();
        if (!ops.length) return;
        await queueOp({ t: 'noop' });   // a barrier: it goes out in the same write as everything queued before it
      };
      col.rebuild = async function () {
        await ensureUnlocked();
        await col.refresh();
        var rows = await guarded(function () { return client.list(prefix); });
        var found = {}, names = [];
        rows.forEach(function (r) { var rest = r.name.slice(prefix.length); if (rest && rest.indexOf('/') < 0 && !isInternalName(r.name)) { found[rest] = r; names.push(r.name); } });
        var vals = await store.getMany(names, { concurrency: 4 });
        var mem = view(), ps = [];
        names.forEach(function (name, i) {
          var id = name.slice(prefix.length), m = mem[id], meta;
          try { meta = metaFor(vals[i], id, undefined); } catch (e) { meta = m ? m.m : {}; }
          if (!m || !sameJson(m.m, meta)) ps.push(queueOp(upsertOp(id, meta, found[id].time, found[id].version)));
        });
        Object.keys(mem).forEach(function (id) { if (!found[id]) ps.push(queueOp({ t: 'remove', id: id })); });
        var before = view();
        await Promise.all(ps);
        fire(diff(before, view()));
        return listOf(view());
      };
      col.onChange = function (fn) { return addOnce(listeners, fn); };

      // ---- internals for the store ----
      col._setOptions = setOptions;
      col._hasOps = function (strict) { return ops.some(function (op) { return !strict || !op.lazy; }); };
      col._dropOps = function () { ops = []; opsVault = null; loaded = false; base = null; clearTimeout(debounceTimer); debounceTimer = null; };
      col._onLock = function (vault) { loaded = false; base = null; loading = null; clearTimeout(debounceTimer); debounceTimer = null; if (ops.length) opsVault = vault || opsVault; };
      col._flushOnLock = async function () {
        if (!ops.some(function (op) { return !op.lazy; }) || !canWrite()) return;
        await kick();
      };
      col._flushNow = function () { if (canWrite() && ops.some(function (op) { return !op.lazy; })) kick(); };
      col._retry = function () { if (failed && canWrite() && ops.some(function (op) { return !op.lazy; })) kick(); };
      col._loaded = function () { return loaded; };
      // rows: list() result of the whole vault or a part. Records under the prefix that the index does not know are queued as upserts.
      col._orphans = function (rows) {
        if (!loaded || !canWrite()) return;
        var mem = view(), before = mem;
        rows.forEach(function (r) {
          if (r.name.indexOf(prefix) !== 0) return;
          var id = r.name.slice(prefix.length);
          if (!id || id.indexOf('/') >= 0 || id.length > 200 || mem[id]) return;
          var known = cache.get(r.name), meta = {};   // meta only from a value this page has seen
          if (known !== undefined && opt.meta) { try { meta = metaFor(known, id, undefined); } catch (e) { meta = {}; } }
          queueOp(upsertOp(id, meta, r.time, r.version), { lazy: true });
        });
        fire(diff(before, view()));
      };
      col._staleIndex = function () { if (loaded) col.refresh().catch(function () {}); };
      setOptions(options);
      return col;
    }

    // ---- the API ----
    var store = {
      version: Core.version,
      scope: client.scope,
      unlock: function (o) {
        if (client.status().unlocked && !unlockPromise) return Promise.resolve(store.status());
        if (unlockPromise) return unlockPromise;
        unlockPromise = (async function () {
          try {
            var res = await runUnlock(S, o || {});
            await afterUnlock(res);
            await replayHeld();
            var st = store.status();
            unlockHandlers.slice().forEach(function (h) {
              try { var r = h(st); if (r && typeof r.then === 'function') r.then(null, function (e) { logError('onUnlock handler failed', e); }); } catch (e) { logError('onUnlock handler failed', e); }
            });
            return st;
          } finally { unlockPromise = null; }
        })();
        return unlockPromise;
      },
      isUnlocked: function () { return client.status().unlocked; },
      status: function () { return Object.assign({}, client.status(), { sandbox: isSandbox(S) }); },
      // Saves unsaved autosave edits and pending collection changes first (up to 8 s), then forgets all keys. Returns a promise.
      lock: function () { return lockSession('user'); },
      onLock: function (fn) { return addOnce(lockHandlers, fn); },
      onUnlock: function (fn) { return addOnce(unlockHandlers, fn); },
      // The language of dialogs and notices from now on ('de' or 'en', also 'de-DE' and the like). Without a call, the language comes
      // from the locale option, or else from navigator.language. An app with its own language switch calls this with every change.
      setLocale: function (l) { lang = detectLang(l); S.lang = lang; S.t = makeT(lang); t = S.t; return lang; },
      get locale() { return S.lang; },
      // onConflict(fn) for every record, onConflict(pattern, fn) for a name or a prefix ending in "/"; a handler that decides nothing hands over to the dialog.
      onConflict: function (a, b) {
        if (typeof a === 'string') return registerConflict(a, b);
        if (a !== null && a !== undefined && typeof a !== 'function') throw new Core.UsageError('onConflict: a function or a pattern and a function');
        conflictGlobal = a || null;
        return function () { if (conflictGlobal === a) conflictGlobal = null; };
      },
      onStale: function (fn) { staleHandler = fn || null; },

      get: async function (name, o) {
        checkAppName(name);
        await ensureUnlocked();
        return guarded(async function () { var v = await client.get(name, o && o.fresh ? { fresh: true } : undefined); remember(name, v); return v; });
      },
      getRecord: async function (name, o) {
        checkAppName(name);
        await ensureUnlocked();
        return guarded(function () { return client.getRecord(name, o && o.fresh ? { fresh: true } : undefined); });
      },
      getMany: async function (names, o) {
        if (!Array.isArray(names)) throw new Core.UsageError('getMany needs an array of record names');
        o = o || {};
        var conc = o.concurrency === undefined ? 6 : o.concurrency;
        if (!Number.isInteger(conc) || conc < 1 || conc > 16) throw new Core.UsageError('getMany: concurrency is a whole number from 1 to 16');
        names.forEach(checkAppName);
        await ensureUnlocked();
        var out = new Array(names.length), next = 0, firstErr = null, fresh = o.fresh ? { fresh: true } : undefined;
        async function worker() {
          while (!firstErr) {
            var i = next++;
            if (i >= names.length) return;
            try { var v = await guarded(function () { return client.get(names[i], fresh); }); remember(names[i], v); out[i] = v; }
            catch (e) { if (!firstErr) firstErr = e; }
          }
        }
        var workers = [];
        for (var k = 0; k < Math.min(conc, names.length); k++) workers.push(worker());
        await Promise.all(workers);
        if (firstErr) throw firstErr;
        return out;
      },
      getBlob: async function (name) {
        var r = await store.getRecord(name);
        if (!r) return undefined;
        if (r.kind !== 'bytes') return new Blob([JSON.stringify(r.value)], { type: 'application/json' });
        return new Blob([r.value], { type: r.mime || 'application/octet-stream' });
      },
      set: function (name, value, o) {
        checkAppName(name);
        return setRecord(name, value, o);
      },
      // -> { name, deleted, resolution: 'deleted' | 'absent' | 'mine' | 'theirs', value? }. Autosave handles of the name are paused meanwhile.
      remove: function (name) {
        checkAppName(name);
        return enqueue(name, async function () {
          await ensureUnlocked();
          var dones = handlesNamed(name).map(function (h) { return h._i.pause(); }), result = null;
          try { result = await guarded(function () { return removeRecord(name); }); }
          finally { dones.forEach(function (done) { done(result); }); }
          return result;
        });
      },
      list: async function (prefix) {
        await ensureUnlocked();
        var rows = await guarded(function () { return client.list(prefix); });
        rows = rows.filter(function (r) { return !isInternalName(r.name); });
        collections.forEach(function (c) { c._orphans(rows); });
        return rows;
      },
      history: async function (name) { checkAppName(name); await ensureUnlocked(); return guarded(function () { return client.history(name); }); },
      restore: function (name, version) {
        checkAppName(name);
        return enqueue(name, async function () { await ensureUnlocked(); return guarded(function () { return client.restore(name, version); }); });
      },
      showHistory: async function (name, o) {
        checkAppName(name);
        await ensureUnlocked();
        return historyDialog(S, name, {
          history: function (n) { return guarded(function () { return client.history(n); }); },
          getVersion: function (n, v) { return guarded(function () { return client.getVersion(n, v); }); },
          restore: function (n, v) { return store.restore(n, v); },
          role: function () { var st = client.status(); return st && st.role; },
        }, o);
      },
      usage: async function () { await ensureUnlocked(); return guarded(function () { return client.usage(); }); },

      // Statuses: idle, dirty, saving, saved, error, replaced, stopped. One live handle per name: a new one flushes and stops the old one.
      autosave: function (name, getState, o) { checkAppName(name); return makeAutosave(name, getState, o, null); },

      // A list of items "<prefix><id>" with an index record that several devices can extend without losing each other's items (1.2).
      collection: function (prefix, o) {
        if (typeof prefix !== 'string' || prefix.length < 2 || prefix.slice(-1) !== '/') throw new Core.UsageError('collection: the prefix must end with "/", for example "notes/"');
        if (isInternalName(prefix)) throw new Core.UsageError('collection: prefixes starting with "' + INTERNAL_PREFIX + '" are reserved for the library');
        var c = collections.get(prefix);
        if (c) { c._setOptions(o); return c; }   // the options of the latest call win
        c = makeCollection(prefix, o);
        collections.set(prefix, c);
        installUnloadGuards();
        return c;
      },

      share: async function () {
        await ensureUnlocked();
        if (client.status().role === 'owner') await loadLabels();
        return shareDialog(S, shareApi);
      },
      exportAll: async function (o) {
        o = o || {};
        await ensureUnlocked();
        return guarded(async function () {
          var names = (await client.list()).filter(function (r) { return !isInternalName(r.name); });
          collections.forEach(function (c) { c._orphans(names); });
          var recs = [], h = toast('info', t('note.exporting', { done: 0, total: names.length }), { sticky: true, key: 'export', dismissLabel: null });
          try {
            for (var i = 0; i < names.length; i++) {
              var r = await client.getRecord(names[i].name);
              if (r) recs.push(r);
              if (h) h.update(t('note.exporting', { done: i + 1, total: names.length }));
            }
          } finally { if (h) h.close(); }
          var arc = buildArchive(recs, { scope: client.scope, service: client.service, exported: new Date().toISOString() });
          var filename = o.filename || client.scope + '-export.zip';
          downloadBlob(arc.blob, filename);
          toast('ok', t('note.exported', { n: recs.length }), { key: 'exported' });
          return { count: recs.length, filename: filename, bytes: arc.blob.size };
        });
      },
    };

    // ---- labels for members (stored encrypted inside the vault; owner only) ----
    async function loadLabels() {
      try {
        var r = await client.getRecord(LABELS_RECORD);
        labels = r && r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : {};
      } catch (e) { labels = labels || {}; }
    }
    async function mutateLabels(fn) {
      for (var i = 0; i < 3; i++) {
        await loadLabels();
        var next = Object.assign({}, labels);
        fn(next);
        try { await client.put(LABELS_RECORD, next); labels = next; return; }
        catch (e) { if (!(e instanceof Core.ConflictError)) throw e; }
      }
    }
    var shareApi = {
      labels: {
        get: function () { return labels; },
        set: function (slotId, text) { return mutateLabels(function (m) { m[slotId] = text; }); },
        drop: function (slotId) { return labels[slotId] === undefined ? Promise.resolve() : mutateLabels(function (m) { delete m[slotId]; }); },
      },
      // Recovered owner slots whose notice the user already confirmed on this device (not secret; same namespace as "seen").
      acked: {
        get: function () { try { var v = JSON.parse(storageGet('acked') || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } },
        add: function (ids) {
          var cur = shareApi.acked.get();
          ids.forEach(function (id) { if (cur.indexOf(id) < 0) cur.push(id); });
          storageSet('acked', JSON.stringify(cur.slice(-200)));
        },
        // true when the user still has to confirm: slots added by the faculty that were not confirmed before. Otherwise the
        // core is told right away that the notice is known (it refuses roster edits until then).
        pending: function (status) {
          var foreign = foreignRecoverySlots(status), done = shareApi.acked.get();
          var fresh = foreign.filter(function (id) { return done.indexOf(id) < 0; });
          if (!fresh.length && foreign.length) { client.acknowledgeRecovery(); S.recoveryAcked = true; }
          return fresh;
        },
        confirm: function (ids) { client.acknowledgeRecovery(); S.recoveryAcked = true; shareApi.acked.add(ids); },
      },
      seen: {
        get: function () { try { var v = JSON.parse(storageGet('seen') || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } },
        add: function (ids) {
          var cur = shareApi.seen.get(), changed = false;
          ids.forEach(function (id) { if (cur.indexOf(id) < 0) { cur.push(id); changed = true; } });
          if (changed) storageSet('seen', JSON.stringify(cur.slice(-200)));
        },
      },
      lock: function () { return store.lock(); },
      onRevoked: function () { endSession('revoked', false); },
    };

    // ---- after unlock ----
    function noticeDialog(title, build) {
      return new Promise(function (resolve) {
        var dlg = dialogFor(S, { title: title, view: 'notice', cancelable: true, closeLabel: t('common.close'), onClose: function () { resolve(); } });
        dlg.body.appendChild(build(dlg));
        dlg.body.appendChild(el('div', { 'data-wds': 'form-error', 'aria-live': 'polite' }));
        dlg.focusFirst();
      });
    }
    async function afterUnlock(res) {
      var info = S.info, st = client.status();
      if (isSandbox(S)) { S.sandboxWipe = info.sandbox.next_wipe; showSandboxBar(); } else S.sandboxWipe = null;
      if (info && info.library && Array.isArray(info.library.deprecated) && info.library.deprecated.indexOf(Core.version) >= 0) toast('warn', t('note.advisory'), { key: 'advisory' });
      if (info && info.status === 'suspended') toast('warn', t('note.suspended'), { key: 'suspended' });
      else if (info && info.read_only) toast('warn', t('note.readOnly'), { key: 'readonly' });
      if (st.role === 'owner') {
        if (st.recovery) {
          await noticeDialog(t('share.recovery.title'), function (dlg) {
            return recoveryRequestNode(S, st.recovery, function () {
              client.cancelRecovery().then(function () { toast('ok', t('share.recovery.cancelled'), { key: 'recovery' }); dlg.close(); }, function (e) { reportError(e); dlg.close(); });
            }, function () { dlg.close(); }, true);
          });
        }
        var freshRecovered = shareApi.acked.pending(st);
        if (freshRecovered.length) {
          await noticeDialog(t('share.recovered.title'), function (dlg) {
            return recoveredNode(S, function () { shareApi.acked.confirm(freshRecovered); dlg.close(); }, true);
          });
        }
      }
      try { await client.maintain(); } catch (e) { if (typeof console !== 'undefined') console.warn('wds: maintenance skipped: ' + e.message); }
      st = client.status();
      if (!res.created && !res.redeemed && st.newDevice) {
        toast(st.stateStatus === 'invalid' ? 'warn' : 'info', t(st.stateStatus === 'invalid' ? 'note.stateInvalid' : 'note.newDevice'), { key: 'newdevice', sticky: st.stateStatus === 'invalid' });
      }
      if (st.role === 'owner') {
        var seen = shareApi.seen.get();
        var fresh = client.members().filter(function (m) { return m.redeemed && !m.self && seen.indexOf(m.slotId) < 0; });
        if (fresh.length) {
          toast('info', fresh.length === 1 ? t('note.redeemed.one') : t('note.redeemed.other', { n: fresh.length }), { key: 'redeemed', sticky: true, actions: [{ label: t('note.review'), onClick: function () { store.share(); } }] });
        }
        if (st.rekeyPending) runRekey();
      }
      installWatcher();
    }
    function runRekey() {
      if (rekeyRunning) return;
      rekeyRunning = true;
      var h = toast('info', t('note.rekey', { done: 0, left: '…' }), { sticky: true, key: 'rekey', dismissLabel: null });
      client.resumeRekey({ onProgress: function (p) { if (h) h.update(t('note.rekey', { done: p.rekeyed, left: p.remaining })); } }).then(function (r) {
        if (h) h.close();
        if (r.done) toast('ok', t('note.rekey.done'), { key: 'rekeydone' });
      }, function (e) {
        if (h) h.close();
        if (e instanceof Core.AuthError || e instanceof Core.IntegrityError) reportError(e);
        else toast('warn', t('note.rekey.failed'), { key: 'rekeyfail' });
      }).then(function () { rekeyRunning = false; });
    }

    // ---- watch for newer versions elsewhere ----
    async function checkStale() {
      if (!client.status().unlocked || checking || Date.now() - lastCheck < 15000) return;
      checking = true; lastCheck = Date.now();
      try {
        var watched = [];
        collections.forEach(function (c) { if (c._loaded()) watched.push(c.indexName); });
        var rows = (await client.checkRemote({ names: watched })).filter(function (r) { return !isInternalName(r.name) && notifiedStale[(r.name || '?') + '@' + r.version] !== true; });
        // The index of a collection is merged by the library: no notice, the collection re-reads it and fires onChange.
        rows = rows.filter(function (r) {
          var hit = false;
          collections.forEach(function (c) { if (c.indexName === r.name) { hit = true; c._staleIndex(); } });
          return !hit;
        });
        if (!rows.length) return;
        rows.forEach(function (r) { notifiedStale[(r.name || '?') + '@' + r.version] = true; });
        if (staleHandler) { try { staleHandler(rows); } catch (e) { /* app handler failed */ } return; }
        var names = rows.map(function (r) { return r.name; }).filter(Boolean).map(function (n) { return S.label(n); });
        toast('info', names.length && names.length <= 3 ? t('note.stale', { names: names.map(function (n) { return '"' + n + '"'; }).join(', ') }) : t('note.stale.many', { n: rows.length }), { key: 'stale', sticky: true });
      } catch (e) { /* checking is best effort */ } finally { checking = false; }
    }
    function installWatcher() {
      if (watchInstalled || opts.watch === false || typeof window === 'undefined') return;
      watchInstalled = true;
      window.addEventListener('focus', checkStale);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) checkStale(); });
    }
    function retryCollections() { collections.forEach(function (c) { c._retry(); }); }
    function installUnloadGuards() {
      if (unloadInstalled || typeof window === 'undefined') return;
      unloadInstalled = true;
      function flushAll() {
        allHandles.forEach(function (a) { if (a.dirty) a.flush(); });
        collections.forEach(function (c) { c._flushNow(); });
      }
      document.addEventListener('visibilitychange', function () { if (document.hidden) flushAll(); });
      window.addEventListener('pagehide', flushAll);
      window.addEventListener('online', retryCollections);
      window.addEventListener('focus', retryCollections);
      window.addEventListener('beforeunload', function (ev) {
        if (hasUnsaved()) { ev.preventDefault(); ev.returnValue = ''; }
      });
    }

    return store;
  }

  var api = {
    version: UI_VERSION,
    connect: connect,
    errors: Core.errors,
    ConflictError: Core.ConflictError, OfflineError: Core.OfflineError, QuotaError: Core.QuotaError, AuthError: Core.AuthError,
    IntegrityError: Core.IntegrityError, VersionError: Core.VersionError, UsageError: Core.UsageError,
    // pure helpers and texts; used by the unit tests and tools, not part of the app API
    internals: {
      TEXT: TEXT, makeT: makeT, detectLang: detectLang, estimate: estimate, checkLocal: checkLocal, checkPassphrase: checkPassphrase, hibpCheck: hibpCheck,
      crc32: crc32, makeZip: makeZip, buildArchive: buildArchive, archivePaths: archivePaths, buildSheetHtml: buildSheetHtml, markedName: markedName,
      applyCollectionOps: applyCollectionOps, fileSafe: fileSafe, formatBytes: formatBytes, formatTime: formatTime, MIN_PASSPHRASE: MIN_PASSPHRASE, WORD_COUNT: WORD_COUNT, COMMON_COUNT: COMMON_EXACT.length,
    },
  };
  return api;
});
