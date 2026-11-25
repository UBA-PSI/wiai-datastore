"""python -m wds_server --db <path> --host 0.0.0.0 --port 8000 --config <file>"""

from __future__ import annotations

import argparse
import logging

import uvicorn

from .app import create_app
from .config import load_config


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(prog="wds_server", description="WIAI Datastore server")
    parser.add_argument("--db", required=True, help="path of the SQLite database (created if missing)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--config", help="INI file with limits, escrow keys, operator token hashes")
    parser.add_argument("--forwarded-allow-ips", default="127.0.0.1",
                        help="peers whose X-Forwarded-For is trusted (the reverse proxy)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING)
    config = load_config(args.config)
    app = create_app(config, args.db)
    uvicorn.run(app, host=args.host, port=args.port, proxy_headers=True, forwarded_allow_ips=args.forwarded_allow_ips,
                access_log=False, server_header=False, ws="none", log_level="warning")


if __name__ == "__main__":
    main()
