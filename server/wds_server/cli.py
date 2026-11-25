"""Development and maintenance commands: python -m wds_server.cli <command> --db <path> [--config <file>]"""

from __future__ import annotations

import argparse
import json
import secrets
import sys

from .config import load_config
from .db import transaction
from . import sandbox as sandbox_mod
from .maintenance import run_maintenance
from .scopes import create_scope
from .api_public import scope_doc
from .service import Service
from .util import b64u_encode, sha256


def _service(args, validate=False) -> Service:
    config = load_config(args.config)
    if validate:
        config.validate()
    svc = Service(config, args.db, validate=False)
    return svc


def cmd_create_scope(args) -> int:
    svc = _service(args)
    limits = {}
    for item in args.limit or []:
        key, _, value = item.partition("=")
        limits[key] = int(value)
    with svc.db.connection() as conn:
        with transaction(conn):
            row = create_scope(svc, conn, slug=args.slug, name=args.name, enrollment=args.enrollment,
                               join_code=args.join_code, hibp=not args.no_hibp, limits=limits or None)
            svc.audit(conn, "cli", "scope_created", row["scope_id"])
    doc = scope_doc(svc, row, admin=True)
    print(json.dumps(doc, indent=2))
    return 0


def cmd_maintenance(args) -> int:
    svc = _service(args)
    try:
        if svc.config.sandbox:
            svc.config.sandbox.validate(svc.config.limit_ceilings)
        sandbox_mod.ensure_sandbox(svc)
        print(json.dumps(run_maintenance(svc)))
    finally:
        svc.close()
    return 0


def cmd_sandbox(args) -> int:
    svc = _service(args, validate=True)
    try:
        sandbox_mod.ensure_sandbox(svc)
        if args.action == "wipe":
            try:
                count = sandbox_mod.wipe_now(svc)
            except ValueError as err:
                print(err, file=sys.stderr)
                return 1
            print(json.dumps({"purged_vaults": count}))
        else:
            print(json.dumps(sandbox_mod.status(svc), indent=2))
    finally:
        svc.close()
    return 0


def cmd_operator_token(args) -> int:
    token = "wdsop." + b64u_encode(secrets.token_bytes(32))
    print("token (keep secret):", token)
    print("hash (for the config file):", b64u_encode(sha256(token.encode("ascii"))))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="wds_server.cli")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p):
        p.add_argument("--db", required=True)
        p.add_argument("--config")

    p = sub.add_parser("create-scope", help="create a scope directly in the database")
    common(p)
    p.add_argument("--slug", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--enrollment", default="join_code", choices=["join_code", "open", "closed"])
    p.add_argument("--join-code")
    p.add_argument("--no-hibp", action="store_true")
    p.add_argument("--limit", action="append", metavar="KEY=VALUE", help="e.g. max_vaults=10 (repeatable)")
    p.set_defaults(func=cmd_create_scope)

    p = sub.add_parser("maintenance", help="purge empty and deleted vaults, sweep history, vacuum")
    common(p)
    p.set_defaults(func=cmd_maintenance)

    p = sub.add_parser("sandbox", help="the public sandbox: 'wipe' purges all its vaults now, 'status' shows its state")
    common(p)
    p.add_argument("action", choices=["wipe", "status"])
    p.set_defaults(func=cmd_sandbox)

    p = sub.add_parser("operator-token", help="generate an operator token and its hash")
    p.set_defaults(func=cmd_operator_token)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
