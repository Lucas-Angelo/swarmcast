#!/usr/bin/env python3
"""Minimal obs-websocket v5 client (no authentication).

    obs_ws.py REQUEST_TYPE ['{"json": "data"}']   -> prints responseData as JSON

Exits 1 if the request fails. OBS_WS_URL overrides ws://127.0.0.1:4455.
"""
import asyncio
import json
import os
import sys
import uuid

import websockets


async def call(request_type, data):
    async with websockets.connect(os.environ.get("OBS_WS_URL", "ws://127.0.0.1:4455"), max_size=None) as ws:
        hello = json.loads(await ws.recv())
        if hello.get("op") != 0:
            raise RuntimeError(f"unexpected first message: {hello}")
        if hello["d"].get("authentication"):
            raise RuntimeError("obs-websocket requires a password; disable auth_required")
        await ws.send(json.dumps({"op": 1, "d": {"rpcVersion": 1, "eventSubscriptions": 0}}))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("op") == 2:
                break
        rid = str(uuid.uuid4())
        await ws.send(json.dumps({"op": 6, "d": {"requestType": request_type, "requestId": rid, "requestData": data}}))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("op") == 7 and msg["d"].get("requestId") == rid:
                return msg["d"]


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    data = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    try:
        res = asyncio.run(call(sys.argv[1], data))
    except Exception as err:  # connection refused while OBS starts, etc.
        print(f"error: {err}", file=sys.stderr)
        sys.exit(1)
    status = res.get("requestStatus", {})
    print(json.dumps(res.get("responseData", {})))
    if not status.get("result"):
        print(f"request failed: {status}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
