from .helpers import API, ServerTestCase


class Smoke(ServerTestCase):
    def test_create_and_roundtrip(self):
        scope = self.env.create_scope()
        r = self.c.get(f"{API}/scopes/{scope['scope']}")
        self.assertEqual(r.status, 200, r)
        v = self.env.new_vault(scope)
        r = self.c.get(f"{API}/slots/{v.access_id}", v.auth)
        self.assertEqual(r.status, 200, r)
        r = v.put("a", if_none_match=True)
        self.assertEqual(r.status, 201, r)
        r = v.get("a")
        self.assertEqual(r.status, 200, r)
