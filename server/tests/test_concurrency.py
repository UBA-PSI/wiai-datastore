import os

from .helpers import API, ServerTestCase, Vault, b64, envelope


class Races(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.v = self.env.new_vault()

    def put_call(self, name, **kw):
        h = dict(self.v.auth)
        if kw.get("if_match") is not None:
            h["If-Match"] = f'"{kw["if_match"]}"'
        if kw.get("if_none_match"):
            h["If-None-Match"] = "*"
        h["WDS-Commit"] = b64(os.urandom(32))
        h["Content-Type"] = "application/octet-stream"
        return {"method": "PUT", "url": f"{self.v.path}/records/{Vault.rid(name)}", "headers": h,
                "body": envelope(1, 1, kw.get("size", 100))}

    def test_concurrent_creates_exactly_one_wins(self):
        results = self.c.gather([self.put_call("race", if_none_match=True) for _ in range(20)])
        statuses = sorted(r.status for r in results)
        self.assertEqual(statuses, [201] + [412] * 19)
        self.assertEqual(self.c.get(self.v.path + "/usage", self.v.auth).json()["versions"], 1)

    def test_concurrent_updates_on_same_version(self):
        self.v.put_ok("r")
        results = self.c.gather([self.put_call("r", if_match=1) for _ in range(20)])
        self.assertEqual(sorted(r.status for r in results), [200] + [412] * 19)
        h = self.c.get(f"{self.v.path}/records/{Vault.rid('r')}/versions", self.v.auth).json()
        self.assertEqual(h["current"], 2)

    def test_retry_loops_get_every_version_exactly_once(self):
        """Many writers retry on 412 until they win: versions 1..N are each stored exactly once."""
        import asyncio
        n = 12

        async def writer(i):
            while True:
                g = await self.c._call("GET", f"{self.v.path}/records/{Vault.rid('seq')}", self.v.auth, None, None, True)
                if g.status == 200:
                    call = self.put_call("seq", if_match=int(g.headers["etag"].strip('"')))
                else:
                    call = self.put_call("seq", if_none_match=True)
                r = await self.c._call("PUT", call["url"], call["headers"], call["body"], None, True)
                if r.status in (200, 201):
                    return r.json()["version"]
                self.assertEqual(r.status, 412)

        async def run():
            return await asyncio.gather(*[writer(i) for i in range(n)])

        versions = asyncio.run_coroutine_threadsafe(run(), self.c.loop).result(timeout=60)
        self.assertEqual(sorted(versions), list(range(1, n + 1)))

    def test_concurrent_roster_posts_one_wins(self):
        calls = []
        for _ in range(8):
            body = self.v.bump_body()
            calls.append({"method": "POST", "url": self.v.path + "/roster",
                          "headers": {**self.v.auth, "Content-Type": "application/json"},
                          "body": __import__("json").dumps({"roster": self.v.sign(body),
                                                            "keyring": self.v.keyring_for(self.v.slots)}).encode()})
        statuses = sorted(r.status for r in self.c.gather(calls))
        self.assertEqual(statuses, [200] + [409] * 7)
        self.assertEqual(self.c.get(self.v.path + "/roster", self.v.auth).json()["head"], 2)

    def test_concurrent_revocation_and_write(self):
        m = self.v.invite(role="write")
        m.redeem()
        epochs = {1: self.v.commits[1], 2: b64(os.urandom(32))}
        body = self.v.roster_body(slots=[s for s in self.v.slots.values() if s["id"] != m.slot], epoch=2,
                                  commit={"epochs": [{"c": c, "e": e} for e, c in epochs.items()], "nk": self.v.nk_commit})
        revoke = {"method": "POST", "url": self.v.path + "/roster", "headers": {**self.v.auth, "Content-Type": "application/json"},
                  "body": __import__("json").dumps({"roster": self.v.sign(body), "keyring": self.v.keyring_for(
                      [s["id"] for s in body["slots"]])}).encode()}
        writes = []
        for i in range(10):
            c = self.put_call(f"w{i}", if_none_match=True)
            c["headers"] = {**c["headers"], **m.auth}
            writes.append(c)
        results = self.c.gather(writes[:5] + [revoke] + writes[5:])
        by_status = [r.status for r in results]
        self.assertEqual(results[5].status, 200, results[5])
        # every write either landed before the revocation (201) or was refused afterwards (401 revoked / 409 epoch)
        for r in results[:5] + results[6:]:
            self.assertIn(r.status, (201, 401, 409), r)
        # after the revocation nothing from the revoked token is accepted
        self.assertError(self.c.put_bytes(f"{self.v.path}/records/{Vault.rid('late')}", envelope(1, 2, 100),
                                          {**m.auth, "If-None-Match": "*", "WDS-Commit": b64(os.urandom(32))}), 401, "revoked")

    def test_bytes_stay_consistent_under_concurrent_writes(self):
        calls = [self.put_call(f"n{i % 5}", if_none_match=True, size=100 + i) for i in range(30)]
        self.c.gather(calls)
        real = self.env.sql("SELECT COALESCE(SUM(size),0) FROM record_versions WHERE vault_id=?", (self.v.vault,))[0][0]
        cached = self.env.sql("SELECT bytes FROM vaults WHERE vault_id=?", (self.v.vault,))[0][0]
        self.assertEqual(cached, real)

    def test_concurrent_vault_creation_respects_limit(self):
        scope = self.env.create_scope(slug="lim", limits={"max_vaults": 3})
        vaults = [Vault(self.env, scope["scope"]) for _ in range(10)]
        calls = [{"method": "POST", "url": f"{API}/scopes/{scope['scope']}/vaults",
                  "headers": {"Content-Type": "application/json"}, "body": __import__("json").dumps(v.create_body(scope["join_code"])).encode(),
                  "ip": f"10.0.0.{i}"} for i, v in enumerate(vaults)]
        statuses = sorted(r.status for r in self.c.gather(calls))
        self.assertEqual(statuses, [201] * 3 + [403] * 7)
