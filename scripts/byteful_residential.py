#!/usr/bin/env python3
"""Thin bridge from the camofox CLI to the byteful SDK's residential_list().

camofox is a Node tool; the byteful SDK is Python. `camofox proxy list` shells
out to this script (run with the byteful-sdk venv's interpreter) to fetch a
batch of residential proxies and emits the result as a single JSON object on
stdout so the Node side can parse it without scraping human text.

Output (stdout): {"data": ["ip:port:user:pass", ...], "message": "..."}
Errors (stderr): {"error": "...", "kind": "ExceptionClassName"} with exit 1.

Auth keys come from BYTEFUL_API_PUBLIC_KEY / BYTEFUL_API_PRIVATE_KEY in the
environment (the camofox CLI resolves and forwards them before exec).
"""

from __future__ import annotations

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch byteful residential proxies")
    parser.add_argument("--count", type=int, default=None, help="list_count")
    parser.add_argument("--format", dest="list_format", default="standard",
                        help="list_format (standard/http/https/socks5/socks5h)")
    parser.add_argument("--session-type", dest="session_type", default=None,
                        help="list_session_type (sticky/rotating)")
    parser.add_argument("--country", dest="country_id", default=None, help="country_id, e.g. us")
    parser.add_argument("--city", dest="city_alias", default=None, help="city_alias")
    parser.add_argument("--subdivision", dest="subdivision_id", default=None, help="subdivision_id")
    parser.add_argument("--zip", dest="zip_code_id", type=int, default=None, help="zip_code_id")
    parser.add_argument("--session-ttl", dest="session_ttl", default=None, help="list_session_ttl")
    parser.add_argument("--proxy-user", dest="proxy_user_id", default=None, help="proxy_user_id")
    parser.add_argument("--mode", dest="list_mode", default=None, help="list_mode (general/size/speed)")
    args = parser.parse_args()

    try:
        from byteful import BytefulClient
    except Exception as exc:  # noqa: BLE001 -- surface import problems as JSON
        json.dump(
            {"error": f"could not import the byteful SDK: {exc}", "kind": "ImportError"},
            sys.stderr,
        )
        sys.stderr.write("\n")
        return 1

    try:
        with BytefulClient() as client:
            result = client.residential_list(
                list_count=args.count,
                list_format=args.list_format,
                proxy_user_id=args.proxy_user_id,
                list_session_type=args.session_type,
                country_id=args.country_id,
                city_alias=args.city_alias,
                subdivision_id=args.subdivision_id,
                zip_code_id=args.zip_code_id,
                list_session_ttl=args.session_ttl,
                list_mode=args.list_mode,
            )
        json.dump({"data": list(result.data), "message": result.message}, sys.stdout)
        sys.stdout.write("\n")
        return 0
    except Exception as exc:  # noqa: BLE001 -- one JSON error shape for the Node caller
        json.dump({"error": str(exc), "kind": type(exc).__name__}, sys.stderr)
        sys.stderr.write("\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
