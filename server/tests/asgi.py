"""A minimal in-process ASGI client (httpx is not an allowed dependency).

The app runs on an event loop in a background thread so tests can fire concurrent requests.
"""

from __future__ import annotations

import asyncio
import json
import threading
from urllib.parse import urlsplit


class Response:
    def __init__(self, status: int, headers: list[tuple[str, str]], body: bytes):
        self.status = status
        self.header_list = headers
        self.headers = {k.lower(): v for k, v in headers}
        self.body = body

    def json(self):
        return json.loads(self.body)

    @property
    def text(self):
        return self.body.decode("utf-8")

    def __repr__(self):
        return f"<Response {self.status} {self.body[:200]!r}>"


class Client:
    def __init__(self, app, default_ip: str = "10.1.1.1"):
        self.app = app
        self.default_ip = default_ip
        self.loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self._thread.start()

    def close(self):
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(timeout=5)
        self.loop.close()

    async def _call(self, method, url, headers, body, ip, add_length):
        parts = urlsplit(url)
        hdrs = [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in (headers or {}).items()]
        names = {k for k, _ in hdrs}
        if add_length and b"content-length" not in names and body is not None:
            hdrs.append((b"content-length", str(len(body)).encode()))
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
            "scheme": "https", "path": parts.path, "raw_path": parts.path.encode(), "query_string": parts.query.encode(),
            "root_path": "", "headers": hdrs, "server": ("testserver", 443), "client": (ip or self.default_ip, 1234),
        }
        payload = body or b""
        sent = False
        result = {"status": None, "headers": [], "body": b""}

        async def receive():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": payload, "more_body": False}
            await asyncio.sleep(3600)
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.start":
                result["status"] = message["status"]
                result["headers"] = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in message["headers"]]
            elif message["type"] == "http.response.body":
                result["body"] += message.get("body", b"")

        await self.app(scope, receive, send)
        return Response(result["status"], result["headers"], result["body"])

    def request(self, method, url, headers=None, body=None, ip=None, add_length=True) -> Response:
        fut = asyncio.run_coroutine_threadsafe(self._call(method, url, headers, body, ip, add_length), self.loop)
        return fut.result(timeout=60)

    def gather(self, calls: list[dict]) -> list[Response]:
        """Run several requests concurrently; each call is a dict of request() keyword arguments."""
        async def run():
            return await asyncio.gather(*[
                self._call(c["method"], c["url"], c.get("headers"), c.get("body"), c.get("ip"), c.get("add_length", True))
                for c in calls])
        return asyncio.run_coroutine_threadsafe(run(), self.loop).result(timeout=120)

    # conveniences
    def get(self, url, headers=None, **kw):
        return self.request("GET", url, headers, **kw)

    def delete(self, url, headers=None, **kw):
        return self.request("DELETE", url, headers, **kw)

    def post_json(self, url, obj, headers=None, **kw):
        h = {"Content-Type": "application/json", **(headers or {})}
        return self.request("POST", url, h, json.dumps(obj).encode(), **kw)

    def put_json(self, url, obj, headers=None, **kw):
        h = {"Content-Type": "application/json", **(headers or {})}
        return self.request("PUT", url, h, json.dumps(obj).encode(), **kw)

    def patch_json(self, url, obj, headers=None, **kw):
        h = {"Content-Type": "application/json", **(headers or {})}
        return self.request("PATCH", url, h, json.dumps(obj).encode(), **kw)

    def put_bytes(self, url, data, headers=None, **kw):
        h = {"Content-Type": "application/octet-stream", **(headers or {})}
        return self.request("PUT", url, h, data, **kw)
