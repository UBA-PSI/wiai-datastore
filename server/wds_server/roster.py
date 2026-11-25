"""Roster validation and storage (PROTOCOL.md 6): structure, invariants, allowed changes, keyring, new slots."""

from __future__ import annotations

import json
from dataclasses import dataclass

from .errors import ApiError, bad_request, read_only
from .sandbox import evict_until, wipe_instants
from .service import INVITE_MAX_SECONDS, ROSTER_BYTES_CAP, ROSTER_HARD_CAP, ROSTER_SOFT_CAP
from .util import b64u_encode, cjson, is_int, sha256, vault_id_from_pub, b64u_decode
from .validate import (check_envelope, decode_envelope, TYPE_KEYRING, TYPE_SLOT, valid_access_id, valid_b64u,
                       valid_pub, valid_slot_id, validate_kdf)

BODY_KEYS = {"type", "v", "scope", "vault", "version", "prev", "epoch", "commit", "slots", "signer", "time"}
SLOT_KEYS = {"id", "kind", "role", "e_pub", "s_pub", "expires"}
MAX_SLOTS = 64
MAX_BODY_BYTES = 65536


def invalid(detail: str) -> ApiError:
    return ApiError(400, "invalid_roster", detail, extra={"detail": detail})


@dataclass
class ParsedRoster:
    body: dict
    sig: str
    canonical: bytes
    hash: str
    slots: dict  # id -> entry
    escrow_slot: str

    @property
    def version(self) -> int:
        return self.body["version"]

    @property
    def epoch(self) -> int:
        return self.body["epoch"]

    @property
    def signer(self) -> str:
        return self.body["signer"]


def parse_roster(doc: object, *, scope: str, vault: str, escrow_sets) -> ParsedRoster:
    """Structure and invariants that do not need server state (6.1, 6.2)."""
    if not isinstance(doc, dict) or set(doc) != {"body", "sig"}:
        raise invalid("roster must be an object with body and sig")
    body, sig = doc["body"], doc["sig"]
    if not valid_b64u(sig, 64):
        raise invalid("sig must be 64 bytes in base64url")
    if not isinstance(body, dict) or set(body) != BODY_KEYS:
        raise invalid("roster body has missing or unknown keys")
    try:
        canonical = cjson(body)
    except ValueError:
        raise invalid("roster body is not canonical JSON") from None
    if len(canonical) > MAX_BODY_BYTES:
        raise invalid("roster body is too large")
    if body["type"] != "roster" or body["v"] != 1 or not is_int(body["v"]):
        raise invalid("type must be roster and v must be 1")
    if body["scope"] != scope or body["vault"] != vault:
        raise invalid("scope or vault does not match")
    version, epoch = body["version"], body["epoch"]
    if not is_int(version) or version < 1 or not is_int(epoch) or epoch < 1 or not is_int(body["time"]):
        raise invalid("version, epoch and time must be positive integers")
    prev = body["prev"]
    if not isinstance(prev, str) or (prev != "" if version == 1 else not valid_b64u(prev, 32)):
        raise invalid("prev must be empty for version 1 and a roster hash otherwise")
    commit = body["commit"]
    if not isinstance(commit, dict) or set(commit) != {"epochs", "nk"} or not valid_b64u(commit["nk"], 32):
        raise invalid("commit must hold epochs and nk")
    epochs = commit["epochs"]
    if not isinstance(epochs, list) or not epochs:
        raise invalid("commit.epochs must be a non-empty list")
    last = 0
    for item in epochs:
        if not isinstance(item, dict) or set(item) != {"c", "e"} or not is_int(item["e"]) or not valid_b64u(item["c"], 32):
            raise invalid("commit.epochs entries must be {c, e}")
        if item["e"] <= last:
            raise invalid("commit.epochs must be strictly ascending")
        last = item["e"]
    if last != epoch:
        raise invalid("commit.epochs must contain epoch and nothing above it")
    slots = body["slots"]
    if not isinstance(slots, list) or not 2 <= len(slots) <= MAX_SLOTS:
        raise invalid("slots must be a list of 2 to 64 entries")
    by_id: dict = {}
    escrow_slot = None
    prev_id = None
    for entry in slots:
        if not isinstance(entry, dict) or set(entry) != SLOT_KEYS:
            raise invalid("slot entry has missing or unknown keys")
        sid = entry["id"]
        if not valid_slot_id(sid):
            raise invalid("slot id is malformed")
        if prev_id is not None and sid <= prev_id:
            raise invalid("slots must be sorted by id without duplicates")
        prev_id = sid
        kind, role = entry["kind"], entry["role"]
        if kind not in ("passphrase", "invite", "escrow") or role not in ("owner", "write", "read"):
            raise invalid("slot kind or role is not allowed")
        if not valid_pub(entry["e_pub"]) or not valid_pub(entry["s_pub"]):
            raise invalid("slot public keys must be uncompressed P-256 points")
        exp = entry["expires"]
        if kind == "invite":
            if not is_int(exp):
                raise invalid("invite slots need an expiry")
        elif exp is not None:
            raise invalid("only invite slots have an expiry")
        if kind == "escrow":
            if escrow_slot is not None:
                raise invalid("exactly one escrow slot is required")
            if role != "owner":
                raise invalid("the escrow slot must be an owner")
            if (entry["e_pub"], entry["s_pub"]) not in escrow_sets:
                raise invalid("escrow keys are not a configured escrow set")
            escrow_slot = sid
        by_id[sid] = entry
    if escrow_slot is None:
        raise invalid("exactly one escrow slot is required")
    if not any(e["role"] == "owner" and e["kind"] != "escrow" for e in slots):
        raise invalid("at least one non-escrow owner slot is required")
    signer = body["signer"]
    if not valid_slot_id(signer):
        raise invalid("signer is malformed")
    if version == 1 and signer not in by_id:
        raise invalid("signer must be a slot of version 1")
    # Owner invites (recovery) are only checked when they are *added*; see apply_roster.
    if version == 1:
        if len(slots) != 2 or epoch != 1:
            raise invalid("version 1 has exactly two slots and epoch 1")
        founder = by_id[signer]
        if signer == escrow_slot or founder["kind"] != "passphrase" or founder["role"] != "owner":
            raise invalid("version 1 must be signed by a passphrase owner slot")
        if vault_id_from_pub(b64u_decode(founder["s_pub"], 65)) != vault:
            raise invalid("vault ID does not match the founder's signing key")
    return ParsedRoster(body, sig, canonical, b64u_encode(sha256(canonical)), by_id, escrow_slot)


def parse_keyring(obj: object, roster: ParsedRoster) -> dict:
    """6.4: one type 0x03 entry for exactly the slots of the roster; returns slot_id -> b64u text."""
    if not isinstance(obj, dict) or set(obj) != set(roster.slots):
        raise ApiError(400, "invalid_keyring", "keyring must hold exactly one entry for every slot of the roster")
    out = {}
    for sid, entry in obj.items():
        decode_envelope(entry, TYPE_KEYRING)
        out[sid] = entry
    return out


def parse_new_slots(obj: object) -> dict:
    """Server material for added slots; returns slot_id -> dict(access_id, kdf_text, token_hash, wrapped)."""
    if not isinstance(obj, list):
        raise bad_request("new_slots must be a list.")
    out = {}
    for item in obj:
        if not isinstance(item, dict) or set(item) != {"slot", "access_id", "kdf", "token_hash", "wrapped"}:
            raise bad_request("new_slots entries have missing or unknown keys.")
        if not valid_slot_id(item["slot"]) or not valid_access_id(item["access_id"]):
            raise bad_request("slot or access_id is malformed.")
        if not valid_b64u(item["token_hash"], 32):
            raise bad_request("token_hash must be 32 bytes in base64url.")
        kdf_text = validate_kdf(item["kdf"], kind="invite")
        decode_envelope(item["wrapped"], TYPE_SLOT)
        if item["slot"] in out:
            raise bad_request("duplicate slot in new_slots.")
        out[item["slot"]] = {"access_id": item["access_id"], "kdf": kdf_text,
                             "token_hash": b64u_decode(item["token_hash"], 32), "wrapped": item["wrapped"]}
    return out


def apply_roster(svc, conn, vault_row, parsed: ParsedRoster, keyring: dict, new_slots: dict, *, mode: str, now: int):
    """Validate the transition against the stored head and store the new version.

    mode: "owner" (POST /vaults/{v}/roster) or "recovery" (operator, signer must be the escrow slot).
    Must run inside a write transaction. Returns a dict describing the change.
    """
    vault = vault_row["vault_id"]
    head, head_hash, cur_epoch = vault_row["roster_version"], vault_row["head_hash"], vault_row["epoch"]
    if parsed.version != head + 1 or parsed.body["prev"] != head_hash:
        raise ApiError(409, "roster_conflict", "The roster head has changed.", extra={"head": head, "head_hash": head_hash})
    prev_body = json.loads(conn.execute("SELECT body FROM rosters WHERE vault_id=? AND version=?", (vault, head)).fetchone()["body"])
    old = {e["id"]: e for e in prev_body["slots"]}
    new = parsed.slots
    escrow_slot = vault_row["escrow_slot"]
    if parsed.escrow_slot != escrow_slot:
        raise invalid("the escrow slot must keep its slot ID")
    if parsed.epoch not in (cur_epoch, cur_epoch + 1):
        raise invalid("epoch must stay the same or grow by exactly one")
    signer = parsed.signer
    if signer not in old or old[signer]["role"] != "owner":
        raise invalid("signer must be an owner slot of the previous version")
    if mode == "owner" and signer == escrow_slot:
        raise invalid("owners may not post roster versions signed by the escrow slot")
    if mode == "recovery" and signer != escrow_slot:
        raise invalid("recovery roster versions must be signed by the escrow slot")
    ignored = {"version", "prev", "time", "signer"}
    if {k: v for k, v in parsed.body.items() if k not in ignored} == {k: v for k, v in prev_body.items() if k not in ignored}:
        raise invalid("the version changes nothing")

    if mode == "recovery":
        # Escrow-signed versions are the narrowest kind: the client verifier (checkRosterTransition) rejects anything but
        # one added owner invite, so the server refuses everything else before it can become an unusable head.
        if parsed.epoch != cur_epoch:
            raise invalid("recovery keeps the epoch")
        if parsed.body["commit"] != prev_body["commit"]:
            raise invalid("recovery keeps the commitments")
        if any(new.get(sid) != entry for sid, entry in old.items()):
            raise invalid("recovery leaves every existing slot unchanged")

    bump = parsed.epoch == cur_epoch + 1
    removed = [sid for sid in old if sid not in new]
    added = [sid for sid in new if sid not in old]
    slot_rows = {r["slot_id"]: r for r in conn.execute("SELECT * FROM slots WHERE vault_id=?", (vault,))}

    for sid in removed:
        if sid == escrow_slot:
            raise invalid("the escrow slot cannot be removed")
        row = slot_rows.get(sid)
        never_used = old[sid]["kind"] == "invite" and row is not None and not row["used"]
        if not bump and not never_used:
            raise ApiError(409, "revocation_required", "Removing a slot needs a new epoch.")

    # slots that stay
    adopted = []
    for sid, entry in new.items():
        if sid in added:
            continue
        o = old[sid]
        row = slot_rows.get(sid)
        if entry["kind"] != o["kind"]:
            if not (o["kind"] == "invite" and entry["kind"] == "passphrase"):
                raise invalid("slot kind may only change from invite to passphrase")
            if row is None or row["redeemed"] is None:
                raise invalid("the invite has not been redeemed")
        if entry["kind"] == o["kind"] and entry["expires"] != o["expires"]:
            raise invalid("expiry cannot change")
        if o["role"] != entry["role"]:
            if o["role"] == "owner" or entry["role"] == "owner" or entry["kind"] == "escrow":
                raise invalid("owner roles never change")
        if (o["e_pub"], o["s_pub"]) != (entry["e_pub"], entry["s_pub"]):
            if sid == escrow_slot:
                pass  # switch to the other configured escrow set; validated by parse_roster
            elif sid == signer and o["role"] == "owner":
                # an owner signs in its own new keys; if they are the pending renewal (a redeemed owner invite), it is adopted
                renewal = json.loads(row["renewal"]) if row is not None and row["renewal"] else None
                if renewal is not None and (renewal["body"]["e_pub"], renewal["body"]["s_pub"]) == (entry["e_pub"], entry["s_pub"]):
                    adopted.append(sid)
            elif o["role"] == "owner":
                raise invalid("only an owner may change its own keys")
            else:
                renewal = json.loads(row["renewal"]) if row is not None and row["renewal"] else None
                if renewal is None or (renewal["body"]["e_pub"], renewal["body"]["s_pub"]) != (entry["e_pub"], entry["s_pub"]):
                    raise ApiError(409, "renewal_mismatch", "New keys must equal the slot's pending renewal.")
                adopted.append(sid)

    # added slots
    expected_new = set(added)
    if set(new_slots) != expected_new:
        raise invalid("new_slots must list exactly the added slots")
    taken = {r[0] for r in conn.execute("SELECT slot_id FROM slot_ids WHERE vault_id=?", (vault,))}
    sandbox = svc.is_sandbox(vault_row["scope_id"])
    if sandbox and added:
        used = conn.execute("SELECT COUNT(*) FROM slots WHERE vault_id=? AND revoked IS NULL"
                            " AND (kind='invite' OR redeemed IS NOT NULL)", (vault,)).fetchone()[0]
        if used + len(added) > svc.config.sandbox.invite_slots:
            raise ApiError(409, "invite_limit", "A sandbox vault has at most %d invites." % svc.config.sandbox.invite_slots,
                           extra={"limit": svc.config.sandbox.invite_slots})
    for sid in added:
        entry = new[sid]
        if sid in taken:
            raise ApiError(409, "slot_id_taken", "Slot IDs are never reused.")
        if entry["kind"] != "invite":
            raise invalid("added slots must be invites")
        if not (now < entry["expires"] <= now + INVITE_MAX_SECONDS):
            raise invalid("invite expiry must be in the future and at most 15 days away")
        if sandbox and entry["expires"] > wipe_instants(svc.config.sandbox, now)[1]:
            raise invalid("in the sandbox an invite cannot outlive the next nightly wipe")
        if entry["role"] == "owner" and signer != escrow_slot:
            raise invalid("owner invites may only be added by the escrow slot")
        aid = new_slots[sid]["access_id"]
        if conn.execute("SELECT 1 FROM access_ids WHERE access_id=?", (aid,)).fetchone():
            raise ApiError(409, "access_id_taken", "Access IDs are never reused.")
    if len({v["access_id"] for v in new_slots.values()}) != len(new_slots):
        raise bad_request("duplicate access_id in new_slots.")
    if mode == "recovery":
        if len(added) != 1 or new[added[0]]["role"] != "owner":
            raise invalid("recovery adds exactly one owner invite")
        if removed:
            raise invalid("recovery removes nothing")

    # commitments
    old_commit = {e["e"]: e["c"] for e in prev_body["commit"]["epochs"]}
    new_commit = {e["e"]: e["c"] for e in parsed.body["commit"]["epochs"]}
    if parsed.body["commit"]["nk"] != prev_body["commit"]["nk"]:
        raise invalid("the NK commitment never changes")
    for e, c in new_commit.items():
        if e in old_commit and old_commit[e] != c:
            raise invalid("commitments of existing epochs never change")
        if e not in old_commit and e != parsed.epoch:
            raise invalid("only the new epoch may add a commitment")
    dropped = sorted(e for e in old_commit if e not in new_commit)
    if dropped:
        in_use = [r[0] for r in conn.execute(
            "SELECT DISTINCT epoch FROM record_versions WHERE vault_id=? AND epoch IS NOT NULL", (vault,)) if r[0] in dropped]
        if in_use:
            raise ApiError(409, "epoch_in_use", "Stored blobs still use these epochs.", extra={"epochs": sorted(in_use)})

    # ---- growth control (roster history is never pruned, so it is bounded and counted against the quota) ----
    old_escrow, new_escrow = old[escrow_slot], new[escrow_slot]
    switched = (old_escrow["e_pub"], old_escrow["s_pub"]) != (new_escrow["e_pub"], new_escrow["s_pub"])
    protective = bool(removed or dropped or adopted or switched)
    size = len(parsed.canonical) + len(parsed.sig) + sum(len(m["wrapped"]) for m in new_slots.values())
    total = vault_row["roster_bytes"] + size
    if mode == "owner":
        if not protective and svc.read_only():
            raise read_only()
        if parsed.version > ROSTER_HARD_CAP or (parsed.version > ROSTER_SOFT_CAP and not protective):
            raise ApiError(507, "quota_exceeded", "This vault has reached its roster version limit.",
                           extra={"limit": "roster_versions"})
        if not protective:
            limits = svc.scope_limits(conn.execute("SELECT * FROM scopes WHERE scope_id=?", (vault_row["scope_id"],)).fetchone())
            if total > ROSTER_BYTES_CAP:
                raise ApiError(507, "quota_exceeded", "The roster history of this vault is too large.",
                               extra={"limit": "roster_bytes"})
            if vault_row["bytes"] + total > limits["vault_bytes"]:
                raise ApiError(507, "quota_exceeded", "The vault quota is exhausted.", extra={"limit": "vault_bytes"})
            def scope_total():
                return conn.execute("SELECT COALESCE(SUM(bytes + roster_bytes),0) FROM vaults WHERE scope_id=?",
                                    (vault_row["scope_id"],)).fetchone()[0]

            fits = scope_total() + size <= limits["scope_bytes"]
            if not fits and svc.is_sandbox(vault_row["scope_id"]):
                fits = evict_until(svc, conn, vault_row["scope_id"], lambda: scope_total() + size <= limits["scope_bytes"],
                                   exclude=vault)
            if not fits:
                raise ApiError(507, "quota_exceeded", "The scope quota is exhausted.", extra={"limit": "scope_bytes"})

    # ---- store ----
    conn.execute("UPDATE vaults SET roster_bytes=? WHERE vault_id=?", (total, vault))
    conn.execute("INSERT INTO rosters (vault_id, version, body, sig, hash, created) VALUES (?,?,?,?,?,?)",
                 (vault, parsed.version, parsed.canonical.decode("ascii"), parsed.sig, parsed.hash, now))
    conn.execute("UPDATE vaults SET roster_version=?, head_hash=?, epoch=? WHERE vault_id=?",
                 (parsed.version, parsed.hash, parsed.epoch, vault))
    for sid in new:
        conn.execute("INSERT OR IGNORE INTO slot_ids (vault_id, slot_id) VALUES (?,?)", (vault, sid))
    for sid in removed:
        conn.execute("UPDATE slots SET revoked=?, token_hash=x'', wrapped='', renewal=NULL WHERE vault_id=? AND slot_id=?",
                     (now, vault, sid))
    for sid, entry in new.items():
        if sid in added or sid == escrow_slot:
            continue
        conn.execute("UPDATE slots SET role=? WHERE vault_id=? AND slot_id=?", (entry["role"], vault, sid))
    for sid in adopted:
        conn.execute("UPDATE slots SET renewal=NULL WHERE vault_id=? AND slot_id=?", (vault, sid))
    for sid in added:
        material = new_slots[sid]
        conn.execute("INSERT INTO access_ids (access_id) VALUES (?)", (material["access_id"],))
        conn.execute(
            "INSERT INTO slots (access_id, vault_id, slot_id, kind, role, kdf, token_hash, wrapped, sv, expires, created)"
            " VALUES (?,?,?,?,?,?,?,?,1,?,?)",
            (material["access_id"], vault, sid, "invite", new[sid]["role"], material["kdf"], material["token_hash"],
             material["wrapped"], new[sid]["expires"], now))
    store_keyring(conn, vault, parsed.version, keyring)
    return {"removed": removed, "added": added, "bump": bump, "adopted": adopted}


def store_keyring(conn, vault: str, version: int, keyring: dict) -> None:
    conn.execute("DELETE FROM keyring WHERE vault_id=?", (vault,))
    conn.executemany("INSERT INTO keyring (vault_id, slot_id, roster_version, entry) VALUES (?,?,?,?)",
                     [(vault, sid, version, entry) for sid, entry in keyring.items()])
