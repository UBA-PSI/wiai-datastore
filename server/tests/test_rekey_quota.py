import os

from .helpers import API, ServerTestCase, Vault, b64, envelope


class Rekey(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.v = self.env.new_vault()
        for name in ("a", "b", "c"):
            self.v.put_ok(name, size=150)
        self.v.put_ok("a", size=150)  # a has two versions
        m = self.v.invite()
        m.redeem()
        self.assertEqual(self.v.revoke(m.slot).status, 200)  # epoch 2

    def listing(self, query=""):
        r = self.c.get(f"{self.v.path}/rekey{query}", self.v.auth)
        self.assertEqual(r.status, 200, r)
        return r.json()

    def rekey(self, rid, n, k, size, epoch=2, **kw):
        h = {**self.v.auth, "If-Match": f'"e{k}"'}
        h.update(kw)
        return self.c.put_bytes(f"{self.v.path}/records/{rid}/versions/{n}/rekey", envelope(1, epoch, size), h)

    def test_listing_sorted_and_paged(self):
        d = self.listing()
        self.assertEqual((d["epoch"], d["remaining"], len(d["items"])), (2, 4, 4))
        keys = [(i["id"], i["version"]) for i in d["items"]]
        self.assertEqual(keys, sorted(keys))
        self.assertTrue(all(i["epoch"] == 1 and i["size"] == 150 for i in d["items"]))
        seen, cursor = [], None
        while True:
            page = self.listing("?limit=3" + (f"&after={cursor}" if cursor else ""))
            seen += [(i["id"], i["version"]) for i in page["items"]]
            cursor = page["next"]
            if not cursor:
                break
        self.assertEqual(seen, keys)
        self.assertError(self.c.get(f"{self.v.path}/rekey?after=zzz", self.v.auth), 400, "bad_request")

    def test_rekey_loop_until_empty(self):
        for item in self.listing()["items"]:
            r = self.rekey(item["id"], item["version"], 1, item["size"])
            self.assertEqual(r.status, 200, r)
            self.assertEqual(r.json(), {"version": item["version"], "epoch": 2})
        d = self.listing()
        self.assertEqual((d["remaining"], d["items"]), (0, []))
        usage = self.c.get(self.v.path + "/usage", self.v.auth).json()
        self.assertEqual(usage["old_epoch_blobs"], 0)
        # history version content is replaced in place and the epoch updated
        h = self.c.get(f"{self.v.path}/records/{Vault.rid('a')}/versions", self.v.auth).json()
        self.assertEqual([x["epoch"] for x in h["versions"]], [2, 2])

    def test_rekey_keeps_commitment_and_bytes(self):
        before = self.c.get(f"{self.v.path}/records/{Vault.rid('b')}/versions", self.v.auth).json()
        usage = self.c.get(self.v.path + "/usage", self.v.auth).json()["bytes"]
        self.rekey(Vault.rid("b"), 1, 1, 150)
        after = self.c.get(f"{self.v.path}/records/{Vault.rid('b')}/versions", self.v.auth).json()
        self.assertEqual(before["versions"][0]["commit"], after["versions"][0]["commit"])
        self.assertEqual(self.c.get(self.v.path + "/usage", self.v.auth).json()["bytes"], usage)
        self.assertEqual(len(self.v.get("b").body), 150)

    def test_rekey_conflicts_and_errors(self):
        rid = Vault.rid("b")
        self.assertError(self.rekey(rid, 1, 1, 149), 400, "rekey_size_mismatch")
        self.assertEqual(self.rekey(rid, 1, 1, 150).status, 200)
        r = self.rekey(rid, 1, 1, 150)  # second session
        self.assertEqual((r.status, r.json()["error"], r.json()["epoch"]), (412, "precondition_failed", 2))
        self.assertError(self.rekey(rid, 1, 2, 150), 400, "bad_request")  # k must be older than current
        self.assertError(self.rekey(rid, 1, 1, 150, epoch=1), 409, "epoch_changed")
        self.assertError(self.rekey(rid, 9, 1, 150), 404, "not_found")
        self.assertError(self.rekey(rid, 1, 1, 37), 400, "malformed_envelope")
        self.assertError(self.c.put_bytes(f"{self.v.path}/records/{rid}/versions/1/rekey", envelope(1, 2, 150), self.v.auth),
                         428, "precondition_required")
        for bad in ("1", '"e"', '"x1"', 'W/"e1"', '"e1", "e2"'):
            r = self.c.put_bytes(f"{self.v.path}/records/{rid}/versions/1/rekey", envelope(1, 2, 150),
                                 {**self.v.auth, "If-Match": bad})
            self.assertEqual(r.status, 400, bad)
        self.assertError(self.rekey(rid, 1, 1, 150, **{"Content-Type": "text/plain"}), 415, "unsupported_media_type")

    def test_rekey_of_tombstone(self):
        self.v.delete("c", 1)
        self.assertError(self.rekey(Vault.rid("c"), 2, 1, 100), 404, "deleted")
        # the live version 1 under the old epoch is still listed and can be rekeyed
        self.assertEqual(self.rekey(Vault.rid("c"), 1, 1, 150).status, 200)

    def test_rekey_allowed_in_read_only_mode_and_when_suspended(self):
        self.env.disk[0] = 0.9
        self.assertEqual(self.rekey(Vault.rid("b"), 1, 1, 150).status, 200)
        self.assertEqual(self.c.get(f"{self.v.path}/rekey", self.v.auth).status, 200)
        self.env.disk[0] = 0.1
        self.c.patch_json(f"{API}/admin/scopes/{self.v.scope}", {"status": "suspended"}, self.env.op)
        self.assertEqual(self.rekey(Vault.rid("c"), 1, 1, 150).status, 200)

    def test_new_writes_use_new_epoch_and_old_epoch_rejected(self):
        self.assertError(self.v.put("a", if_match=2, epoch=1), 409, "epoch_changed")
        self.assertEqual(self.v.put("a", if_match=2, epoch=2).status, 200)


class RekeyBounds(ServerTestCase):
    """A blob that is larger than the scope's current limit (lowered later) must still be re-encrypted (PLAN 8.3)."""

    def setUp(self):
        super().setUp()
        self.scope = self.env.create_scope(limits={"max_value_bytes": 100000})
        self.v = self.env.new_vault(self.scope)
        self.v.put_ok("big", size=60000)
        m = self.v.invite()
        m.redeem()
        self.assertEqual(self.v.revoke(m.slot).status, 200)  # epoch 2
        self.rid = Vault.rid("big")

    def rekey(self, size, epoch=2):
        h = {**self.v.auth, "If-Match": '"e1"'}
        return self.c.put_bytes(f"{self.v.path}/records/{self.rid}/versions/1/rekey", envelope(1, epoch, size), h)

    def test_rekey_ignores_the_current_scope_limit(self):
        self.env.config.limit_defaults["max_value_bytes"] = 1000  # the limit of a scope without its own setting
        self.env.sql("SELECT 1")
        with self.env.svc.db.connection() as conn:
            conn.execute("UPDATE scopes SET limits='{}' WHERE scope_id=?", (self.scope["scope"],))
        self.assertLess(self.c.get(f"{API}/scopes/{self.scope['scope']}").json()["limits"]["max_envelope_bytes"], 60000)
        # a new write above the lowered limit is refused ...
        self.assertError(self.v.put("other", size=60000, if_none_match=True), 413, "value_too_large")
        # ... but the stored blob can be re-encrypted, and it can still be read
        r = self.rekey(60000)
        self.assertEqual(r.status, 200, r)
        self.assertEqual(self.v.get("big").status, 200)
        self.assertEqual(self.c.get(self.v.path + "/usage", self.v.auth).json()["old_epoch_blobs"], 0)

    def test_rekey_is_still_bounded_by_the_stored_length_and_the_ceiling(self):
        self.assertError(self.rekey(59999), 400, "rekey_size_mismatch")
        self.env.config.limit_ceilings["max_value_bytes"] = 50000  # ceiling below the stored blob: refused before the body is read
        r = self.rekey(60000)
        self.assertEqual(r.status, 413, r)
        self.assertEqual(r.json()["error"], "value_too_large")


class Quotas(ServerTestCase):
    def test_record_writes_count_roster_bytes_toward_the_vault_quota(self):
        [v] = self.env.quota_scope(vault_bytes=1000)
        roster = self.env.sql("SELECT roster_bytes FROM vaults WHERE vault_id=?", (v.vault,))[0][0]
        self.assertGreater(roster, 500)
        self.assertEqual(v.put("a", size=600, if_none_match=True).status, 201)
        r = v.put("b", size=401, if_none_match=True)  # records alone (1001) would fit a 1000 + roster limit only if rosters were ignored
        self.assertEqual((r.status, r.json()["limit"]), (507, "vault_bytes"))
        self.assertEqual(v.put("b", size=400, if_none_match=True).status, 201)  # records + roster exactly at the limit
        self.assertEqual(self.c.get(v.path + "/usage", v.auth).json()["bytes"], 1000)  # usage reports records only

    def test_record_writes_count_roster_bytes_toward_the_scope_quota(self):
        a, b = self.env.quota_scope(vaults=2, scope_bytes=3000, vault_bytes=3000)
        a.invite()  # more roster history in vault a: it counts against the scope as well
        extra = self.env.sql("SELECT roster_bytes FROM vaults WHERE vault_id=?", (a.vault,))[0][0] - \
            self.env.sql("SELECT roster_bytes FROM vaults WHERE vault_id=?", (b.vault,))[0][0]
        self.assertGreater(extra, 100)
        self.assertEqual(a.put("x", size=1000, if_none_match=True).status, 201)
        room = 3000 - extra - 1000
        r = b.put("y", size=room + 1, if_none_match=True)
        self.assertEqual((r.status, r.json()["limit"]), (507, "scope_bytes"))
        self.assertEqual(b.put("y", size=room, if_none_match=True).status, 201)

    def test_deletes_still_work_when_roster_history_has_filled_the_quota(self):
        [v] = self.env.quota_scope(vault_bytes=4000)
        m = v.invite()
        m.redeem()
        v.put_ok("a", size=2500)
        self.assertEqual(v.revoke(m.slot).status, 200)  # protective: never refused, but it adds roster bytes
        used = self.env.sql("SELECT bytes + roster_bytes FROM vaults WHERE vault_id=?", (v.vault,))[0][0]
        limit = self.env.sql("SELECT limits FROM scopes WHERE scope_id=?", (v.scope,))[0][0]
        self.assertGreater(used, __import__("json").loads(limit)["vault_bytes"])
        self.assertError(v.put("b", size=100, if_none_match=True), 507, "quota_exceeded")
        self.assertEqual(v.delete("a", v.record_versions["a"]).status, 200)
        self.assertEqual(self.c.delete(f"{v.path}/records/{Vault.rid('a')}/versions", v.auth).status, 200)  # frees the history
        self.assertEqual(v.put("b", size=200, if_none_match=True).status, 201)

    def test_vault_quota_with_exact_bytes(self):
        [v] = self.env.quota_scope(vault_bytes=1000, history_versions=2)
        self.assertEqual(v.put("a", size=500, if_none_match=True).status, 201)
        self.assertEqual(v.put("b", size=500, if_none_match=True).status, 201)  # exactly at the limit
        r = v.put("c", size=100, if_none_match=True)
        self.assertEqual(r.status, 507)
        self.assertEqual(r.json(), {"error": "quota_exceeded", "message": r.json()["message"], "limit": "vault_bytes"})
        self.assertEqual(self.c.get(v.path + "/usage", v.auth).json()["bytes"], 1000)
        self.assertError(v.get("c"), 404, "not_found")  # rolled back completely

    def test_history_counts_and_pruning_frees_space(self):
        [v] = self.env.quota_scope(vault_bytes=1000, history_versions=2)
        v.put_ok("a", size=400)
        v.put_ok("a", size=400)  # 800 used, two versions
        self.assertEqual(v.put("a", if_match=2, size=400).status, 507)  # young versions are never pruned by count
        self.env.clock.advance(601)
        r = v.put("a", if_match=2, size=400)  # prune version 1 first: 400 + 400 + 400 - 400 = 800
        self.assertEqual(r.status, 200, r)
        self.assertEqual(self.c.get(v.path + "/usage", v.auth).json()["bytes"], 800)

    def test_delete_and_purge_free_quota(self):
        [v] = self.env.quota_scope(vault_bytes=1000, history_versions=5)
        v.put_ok("a", size=500)
        v.put_ok("a", size=500)
        self.assertEqual(v.put("b", size=100, if_none_match=True).status, 507)
        self.c.delete(f"{v.path}/records/{Vault.rid('a')}/versions", v.auth)  # keeps the latest
        self.assertEqual(v.put("b", size=100, if_none_match=True).status, 201)
        self.assertEqual(self.c.get(v.path + "/usage", v.auth).json()["bytes"], 600)

    def test_scope_quota_across_vaults(self):
        a, b = self.env.quota_scope(vaults=2, scope_bytes=1500, vault_bytes=1000)
        self.assertEqual(a.put("x", size=800, if_none_match=True).status, 201)
        self.assertEqual(b.put("x", size=700, if_none_match=True).status, 201)
        r = b.put("y", size=100, if_none_match=True)
        self.assertEqual((r.status, r.json()["limit"]), (507, "scope_bytes"))
        self.assertEqual(a.put("y", size=100, if_none_match=True).status, 507)

    def test_other_scope_not_affected(self):
        [a] = self.env.quota_scope(slug="one", scope_bytes=500, vault_bytes=500)
        [b] = self.env.quota_scope(slug="two", scope_bytes=500, vault_bytes=500)
        self.assertEqual(a.put("x", size=500, if_none_match=True).status, 201)
        self.assertEqual(b.put("x", size=500, if_none_match=True).status, 201)

    def test_max_value_bytes_derives_envelope_limit(self):
        scope = self.env.create_scope(limits={"max_value_bytes": 100})
        v = self.env.new_vault(scope)
        limit = self.c.get(f"{API}/scopes/{scope['scope']}").json()["limits"]
        from wds_server.util import padme
        self.assertEqual(limit["max_envelope_bytes"], padme(4 + 2048 + 100) + 38)
        self.assertEqual(v.put("a", size=limit["max_envelope_bytes"], if_none_match=True).status, 201)
        self.assertEqual(v.put("b", size=limit["max_envelope_bytes"] + 1, if_none_match=True).status, 413)

    def test_cached_bytes_match_real_sum(self):
        scope = self.env.create_scope(limits={"history_versions": 3})
        v = self.env.new_vault(scope)
        for i in range(12):
            v.put_ok(f"n{i % 4}", size=100 + i)
            self.env.clock.advance(300)
        v.delete("n1", v.record_versions["n1"])
        self.c.delete(f"{v.path}/records/{Vault.rid('n2')}/versions", v.auth)
        real = self.env.sql("SELECT COALESCE(SUM(size),0) FROM record_versions WHERE vault_id=?", (v.vault,))[0][0]
        cached = self.env.sql("SELECT bytes FROM vaults WHERE vault_id=?", (v.vault,))[0][0]
        self.assertEqual(cached, real)

    def test_scope_limits_are_clamped_to_ceilings_and_validated(self):
        for bad in ({"max_vaults": 501}, {"history_versions": 51}, {"vault_bytes": 1073741825}, {"max_value_bytes": 0},
                    {"bogus": 1}, {"max_vaults": "5"}, {"max_vaults": True}):
            r = self.c.post_json(f"{API}/admin/scopes", {"slug": "x", "name": "X", "limits": bad}, self.env.op)
            self.assertError(r, 400, "bad_request")
        r = self.c.post_json(f"{API}/admin/scopes", {"slug": "x", "name": "X", "limits": {"max_vaults": 500}}, self.env.op)
        self.assertEqual(r.status, 201)
