import os

from wds_server.util import b64u_encode

from .helpers import API, ServerTestCase, Vault, b64, envelope


class RecordCas(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.v = self.env.new_vault()

    def test_create_read_update_roundtrip(self):
        data = envelope(1, 1, 500)
        commit = b64(os.urandom(32))
        r = self.v.put("doc", env_bytes=data, if_none_match=True, headers={"WDS-Commit": commit})
        self.assertEqual(r.status, 201, r)
        self.assertEqual(r.json(), {"version": 1, "epoch": 1, "size": 500})
        self.assertEqual(r.headers["etag"], '"1"')
        g = self.v.get("doc")
        self.assertEqual(g.status, 200)
        self.assertEqual(g.body, data)
        self.assertEqual(g.headers["etag"], '"1"')
        self.assertEqual(g.headers["wds-commit"], commit)
        self.assertEqual(g.headers["content-type"], "application/octet-stream")
        r = self.v.put("doc", if_match=1)
        self.assertEqual((r.status, r.json()["version"], r.headers["etag"]), (200, 2, '"2"'))
        self.assertEqual(self.v.get("doc").headers["etag"], '"2"')

    def test_preconditions_required(self):
        self.assertError(self.v.put("a"), 428, "precondition_required")
        self.assertError(self.v.delete("a", None), 428, "precondition_required")

    def test_malformed_preconditions(self):
        for value in ('W/"1"', "1", '"1", "2"', "*", '"0"', '""', '"01"', '"-1"'):
            r = self.v.put("a", headers={"If-Match": value})
            self.assertError(r, 400, "bad_request")
        r = self.v.put("a", headers={"If-None-Match": '"1"'})
        self.assertError(r, 400, "bad_request")
        r = self.v.put("a", headers={"If-None-Match": "*", "If-Match": '"1"'})
        self.assertError(r, 400, "bad_request")

    def test_if_none_match_on_existing_is_412(self):
        self.v.put_ok("a")
        r = self.v.put("a", if_none_match=True)
        self.assertEqual(r.status, 412)
        self.assertEqual(r.json()["current"], 1)
        self.assertFalse(r.json()["deleted"])
        self.assertEqual(r.json()["error"], "precondition_failed")

    def test_stale_if_match_is_412(self):
        self.v.put_ok("a")
        self.v.put_ok("a")
        r = self.v.put("a", if_match=1)
        self.assertEqual((r.status, r.json()["current"]), (412, 2))
        r = self.v.put("a", if_match=3)
        self.assertEqual((r.status, r.json()["current"]), (412, 2))

    def test_if_match_on_unknown_record(self):
        r = self.v.put("never", if_match=1)
        self.assertEqual(r.status, 412)
        self.assertEqual(r.json()["current"], None)
        self.assertFalse(r.json()["deleted"])

    def test_412_does_not_change_state(self):
        self.v.put_ok("a")
        before = self.c.get(self.v.path + "/usage", self.v.auth).json()
        self.v.put("a", if_match=9, size=300)
        self.assertEqual(self.c.get(self.v.path + "/usage", self.v.auth).json(), before)

    def test_tombstones_and_non_reused_versions(self):
        self.v.put_ok("a")
        self.v.put_ok("a")
        r = self.v.delete("a", 2)
        self.assertEqual((r.status, r.json()), (200, {"version": 3}))
        g = self.v.get("a")
        self.assertError(g, 404, "deleted")
        self.assertEqual(g.json()["version"], 3)
        # deleting a tombstone again, or with a stale version
        r = self.v.delete("a", 3)
        self.assertEqual((r.status, r.json()["deleted"], r.json()["current"]), (412, True, 3))
        self.assertEqual(self.v.delete("a", 1).status, 412)
        # If-None-Match on a tombstone fails: the ID has existed
        r = self.v.put("a", if_none_match=True)
        self.assertEqual((r.status, r.json()["deleted"]), (412, True))
        # recreate on the tombstone version: version 4, never 1
        r = self.v.put("a", if_match=3)
        self.assertEqual((r.status, r.json()["version"]), (200, 4))
        self.assertEqual(self.v.get("a").headers["etag"], '"4"')

    def test_delete_unknown_record(self):
        r = self.v.delete("zzz", 1)
        self.assertEqual((r.status, r.json()["current"]), (412, None))

    def test_unknown_record_get(self):
        self.assertError(self.v.get("zzz"), 404, "not_found")

    def test_malformed_record_ids(self):
        for rid in ("short", "x" * 44, "!" * 43, "A" * 43 + "="):
            r = self.v.get(None, rid=rid)
            self.assertEqual(r.status, 400, rid)
        # non-canonical trailing bits
        self.assertEqual(self.v.get(None, rid="A" * 42 + "B").status, 400)

    def test_list_records_and_paging(self):
        names = [f"n{i}" for i in range(7)]
        for n in names:
            self.v.put_ok(n)
        self.v.put_ok("n3")
        self.v.delete("n5", 1)
        d = self.c.get(self.v.path + "/records", self.v.auth).json()
        self.assertIsNone(d["next"])
        self.assertEqual([r["id"] for r in d["records"]], sorted(Vault.rid(n) for n in names))
        by = {r["id"]: r for r in d["records"]}
        self.assertEqual(by[Vault.rid("n3")]["version"], 2)
        self.assertEqual(by[Vault.rid("n3")]["size"], 100)
        self.assertEqual(by[Vault.rid("n3")]["epoch"], 1)
        t = by[Vault.rid("n5")]
        self.assertEqual((t["deleted"], t["epoch"], t["size"], t["version"]), (True, None, 0, 2))
        got, after = [], None
        while True:
            q = "?limit=3" + (f"&after={after}" if after else "")
            page = self.c.get(self.v.path + "/records" + q, self.v.auth).json()
            got += [r["id"] for r in page["records"]]
            after = page["next"]
            if not after:
                break
        self.assertEqual(got, sorted(Vault.rid(n) for n in names))
        self.assertError(self.c.get(self.v.path + "/records?limit=0", self.v.auth), 400, "bad_request")
        self.assertError(self.c.get(self.v.path + "/records?after=bad", self.v.auth), 400, "bad_request")
        self.assertEqual(len(self.c.get(self.v.path + "/records?limit=5000", self.v.auth).json()["records"]), 7)

    def test_epoch_changed(self):
        r = self.v.put("a", epoch=2, if_none_match=True)
        self.assertError(r, 409, "epoch_changed")
        self.assertEqual(r.json()["epoch"], 1)
        self.assertError(self.v.put("a", epoch=0, if_none_match=True), 409, "epoch_changed")

    def test_wds_commit_header(self):
        self.assertError(self.v.put("a", if_none_match=True, commit=False), 400, "bad_request")
        self.assertError(self.v.put("a", if_none_match=True, commit=False, headers={"WDS-Commit": "short"}), 400, "bad_request")
        self.assertError(self.v.put("a", if_none_match=True, commit=False, headers={"WDS-Commit": b64(os.urandom(31))}), 400,
                         "bad_request")


class EnvelopeAndHeaderChecks(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.scope = self.env.create_scope(limits={"max_value_bytes": 1000})
        self.v = self.env.new_vault(self.scope)
        self.max = self.c.get(f"{API}/scopes/{self.scope['scope']}").json()["limits"]["max_envelope_bytes"]

    def test_malformed_envelopes_are_rejected(self):
        bad = {
            "too short": envelope(1, 1, 37),
            "magic": envelope(1, 1, 100, magic=b"WDS2"),
            "wrong type": envelope(2, 1, 100),
            "keyring type": envelope(3, 1, 150),
            "flags": envelope(1, 1, 100, flags=1),
            "empty": b"",
        }
        for name, data in bad.items():
            with self.subTest(name):
                self.assertError(self.v.put("a", env_bytes=data, if_none_match=True), 400, "malformed_envelope")

    def test_minimum_and_maximum_length(self):
        self.assertEqual(self.v.put("min", env_bytes=envelope(1, 1, 38), if_none_match=True).status, 201)
        self.assertEqual(self.v.put("max", env_bytes=envelope(1, 1, self.max), if_none_match=True).status, 201)
        r = self.v.put("big", env_bytes=envelope(1, 1, self.max + 1), if_none_match=True)
        self.assertError(r, 413, "value_too_large")
        self.assertEqual(r.json()["limit"], self.max)

    def test_content_type_and_length(self):
        rid = Vault.rid("a")
        h = {**self.v.auth, "If-None-Match": "*", "WDS-Commit": b64(os.urandom(32))}
        r = self.c.request("PUT", f"{self.v.path}/records/{rid}", {**h, "Content-Type": "application/json"}, envelope(1, 1, 100))
        self.assertError(r, 415, "unsupported_media_type")
        r = self.c.request("PUT", f"{self.v.path}/records/{rid}", {**h, "Content-Type": "application/octet-stream"},
                           envelope(1, 1, 100), add_length=False)
        self.assertError(r, 411, "length_required")
        r = self.c.request("PUT", f"{self.v.path}/records/{rid}", {**h, "Content-Type": "application/octet-stream",
                                                                    "Content-Length": str(self.max + 1)}, b"x", add_length=False)
        self.assertError(r, 413, "value_too_large")

    def test_token_is_checked_before_body_and_length(self):
        rid = Vault.rid("a")
        r = self.c.request("PUT", f"{self.v.path}/records/{rid}", {"Content-Type": "text/plain", "Content-Length": "999999999"},
                           b"x", add_length=False)
        self.assertError(r, 401, "unauthorized")
        r = self.c.request("PUT", f"{self.v.path}/records/{rid}",
                           {**Vault.bearer(self.v.access_id, os.urandom(32)), "Content-Length": "999999999"}, b"x", add_length=False)
        self.assertError(r, 401, "unauthorized")

    def test_check_order_role_before_readonly_before_headers(self):
        m = self.v.invite(role="read")
        m.redeem()
        self.env.disk[0] = 0.9
        r = self.c.put_bytes(f"{self.v.path}/records/{Vault.rid('a')}", envelope(1, 1, 100), m.auth)
        self.assertError(r, 403, "forbidden")  # role before read-only and before 428
        r = self.c.put_bytes(f"{self.v.path}/records/{Vault.rid('a')}", envelope(1, 1, 100), self.v.auth)
        self.assertError(r, 503, "read_only")  # read-only before 428

    def test_wrong_vault_in_path(self):
        other = self.env.new_vault(self.scope)
        r = self.c.get(f"{other.path}/records", self.v.auth)
        self.assertError(r, 403, "forbidden")


class Roles(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.v = self.env.new_vault()
        self.reader = self.v.invite(role="read")
        self.reader.redeem()
        self.writer = self.v.invite(role="write")
        self.writer.redeem()
        self.v.put_ok("a")

    def test_read_member(self):
        h = self.reader.auth
        self.assertEqual(self.c.get(f"{self.v.path}/records/{Vault.rid('a')}", h).status, 200)
        self.assertEqual(self.c.get(f"{self.v.path}/records", h).status, 200)
        self.assertEqual(self.c.get(f"{self.v.path}/usage", h).status, 200)
        self.assertEqual(self.c.get(f"{self.v.path}/roster", h).status, 200)
        self.assertEqual(self.c.get(f"{self.v.path}/records/{Vault.rid('a')}/versions", h).status, 200)
        self.assertError(self.v.put("a", if_match=1, auth=h), 403, "forbidden")
        self.assertError(self.v.delete("a", 1, auth=h), 403, "forbidden")
        self.assertError(self.c.delete(f"{self.v.path}/records/{Vault.rid('a')}/versions", h), 403, "forbidden")
        self.assertError(self.c.get(f"{self.v.path}/rekey", h), 403, "forbidden")
        self.assertError(self.c.delete(self.v.path, h), 403, "forbidden")
        self.assertError(self.c.delete(f"{self.v.path}/recovery", h), 403, "forbidden")
        self.assertError(self.c.post_json(f"{self.v.path}/roster", {}, h), 403, "forbidden")

    def test_write_member(self):
        h = self.writer.auth
        self.assertEqual(self.v.put("a", if_match=1, auth=h).status, 200)
        self.assertEqual(self.v.delete("a", 2, auth=h).status, 200)
        self.assertError(self.c.delete(f"{self.v.path}/records/{Vault.rid('a')}/versions", h), 403, "forbidden")
        self.assertError(self.c.get(f"{self.v.path}/rekey", h), 403, "forbidden")
        self.assertError(self.c.delete(self.v.path, h), 403, "forbidden")
        self.assertError(self.c.post_json(f"{self.v.path}/roster", {}, h), 403, "forbidden")
        self.assertError(self.c.put_bytes(f"{self.v.path}/records/{Vault.rid('a')}/versions/1/rekey", envelope(1, 1, 100),
                                          {**h, "If-Match": '"e1"'}), 403, "forbidden")

    def test_role_comes_from_head_roster_for_redeemed_invites(self):
        m = self.v.invite(role="write")
        m.redeem()
        # still listed as invite in the roster, acts with its roster role
        self.assertEqual(self.v.put("b", if_none_match=True, auth=m.auth).status, 201)

    def test_deleted_vault_beats_role_check(self):
        self.c.delete(self.v.path, self.v.auth)
        self.assertError(self.v.put("a", if_match=1, auth=self.reader.auth), 410, "vault_deleted")

    def test_scope_suspension_blocks_writes_only(self):
        self.c.patch_json(f"{API}/admin/scopes/{self.v.scope}", {"status": "suspended"}, self.env.op)
        self.assertError(self.v.put("a", if_match=1), 403, "scope_suspended")
        self.assertEqual(self.v.get("a").status, 200)
        self.assertEqual(self.v.delete("a", 1).status, 200)
        self.assertEqual(self.c.delete(f"{self.v.path}/records/{Vault.rid('a')}/versions", self.v.auth).status, 200)
        self.assertEqual(self.v.invite().slot in self.v.slots, True)  # roster changes allowed
        self.c.patch_json(f"{API}/admin/scopes/{self.v.scope}", {"status": "active"}, self.env.op)
        self.assertEqual(self.v.put("a", if_match=2).status, 200)


class History(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.scope = self.env.create_scope(limits={"history_versions": 3})
        self.v = self.env.new_vault(self.scope)

    def versions(self, name="a"):
        d = self.c.get(f"{self.v.path}/records/{Vault.rid(name)}/versions", self.v.auth)
        return d.json()

    def test_history_listing_and_version_read(self):
        commits = []
        for i in range(3):
            c = b64(os.urandom(32))
            commits.append(c)
            self.v.put_ok("a", headers={"WDS-Commit": c})
        h = self.versions()
        self.assertEqual(h["id"], Vault.rid("a"))
        self.assertEqual(h["current"], 3)
        self.assertEqual([x["version"] for x in h["versions"]], [3, 2, 1])
        self.assertEqual([x["commit"] for x in h["versions"]], list(reversed(commits)))
        self.assertTrue(all(x["epoch"] == 1 and x["size"] == 100 and not x["deleted"] for x in h["versions"]))
        r = self.c.get(f"{self.v.path}/records/{Vault.rid('a')}/versions/2", self.v.auth)
        self.assertEqual((r.status, r.headers["etag"], r.headers["wds-commit"]), (200, '"2"', commits[1]))
        self.assertError(self.c.get(f"{self.v.path}/records/{Vault.rid('a')}/versions/9", self.v.auth), 404, "not_found")
        self.assertError(self.c.get(f"{self.v.path}/records/{Vault.rid('a')}/versions/x", self.v.auth), 400, "bad_request")
        self.assertError(self.c.get(f"{self.v.path}/records/{Vault.rid('zz')}/versions", self.v.auth), 404, "not_found")

    def test_count_limit_with_ten_minute_floor(self):
        for _ in range(6):
            self.v.put_ok("a")
        # all six are younger than 10 minutes: nothing is dropped by count
        self.assertEqual(len(self.versions()["versions"]), 6)
        self.env.clock.advance(601)
        self.v.put_ok("a")  # version 7 triggers pruning: keep 7,6,5 by count; 6 and 5 are old, 4..1 old -> dropped
        got = [x["version"] for x in self.versions()["versions"]]
        self.assertEqual(got, [7, 6, 5])

    def test_floor_is_per_version_age(self):
        for _ in range(3):
            self.v.put_ok("a")
        self.env.clock.advance(601)
        self.v.put_ok("a")  # 4 new, 1 old and beyond the limit -> dropped
        self.assertEqual([x["version"] for x in self.versions()["versions"]], [4, 3, 2])
        self.env.clock.advance(100)
        self.v.put_ok("a")  # 5: version 2 is 701 s old and beyond the count -> dropped
        self.assertEqual([x["version"] for x in self.versions()["versions"]], [5, 4, 3])
        self.v.put_ok("a")  # 6: version 3 is 701 s old and beyond the count -> dropped
        self.v.put_ok("a")  # 7: version 4 is beyond the count but only 100 s old -> kept
        self.assertEqual([x["version"] for x in self.versions()["versions"]], [7, 6, 5, 4])

    def test_tombstones_count_as_versions(self):
        self.v.put_ok("a")
        self.env.clock.advance(1000)
        self.v.put_ok("a")
        r = self.v.delete("a", 2)
        self.assertEqual(r.status, 200)
        h = self.versions()
        self.assertEqual([(x["version"], x["deleted"]) for x in h["versions"]], [(3, True), (2, False), (1, False)])
        self.assertIsNone(h["versions"][0]["commit"])
        self.assertIsNone(h["versions"][0]["epoch"])
        r = self.c.get(f"{self.v.path}/records/{Vault.rid('a')}/versions/3", self.v.auth)
        self.assertError(r, 404, "deleted")
        self.env.clock.advance(1000)
        self.v.put("a", if_match=3)  # 4: keep 4,3,2 -> 1 dropped
        self.assertEqual([x["version"] for x in self.versions()["versions"]], [4, 3, 2])

    def test_latest_is_never_dropped(self):
        scope = self.env.create_scope(slug="one", limits={"history_versions": 1})
        v = self.env.new_vault(scope)
        for _ in range(3):
            v.put_ok("a")
            self.env.clock.advance(1000)
        d = self.c.get(f"{v.path}/records/{Vault.rid('a')}/versions", v.auth).json()
        self.assertEqual([x["version"] for x in d["versions"]], [3])

    def test_purge_history_owner_only_frees_bytes(self):
        for i in range(3):
            self.v.put_ok("a", size=200)
        usage = self.c.get(self.v.path + "/usage", self.v.auth).json()
        self.assertEqual((usage["bytes"], usage["versions"], usage["records"]), (600, 3, 1))
        r = self.c.delete(f"{self.v.path}/records/{Vault.rid('a')}/versions", self.v.auth)
        self.assertEqual(r.json(), {"freed": 400})
        usage = self.c.get(self.v.path + "/usage", self.v.auth).json()
        self.assertEqual((usage["bytes"], usage["versions"]), (200, 1))
        self.assertEqual(self.v.get("a").status, 200)
        self.assertEqual(self.v.put("a", if_match=3).json()["version"], 4)  # counter continues
        self.assertError(self.c.delete(f"{self.v.path}/records/{Vault.rid('zz')}/versions", self.v.auth), 404, "not_found")
