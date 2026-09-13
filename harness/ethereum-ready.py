"""Observe a local execution + Lighthouse pair; never starts or modifies a node."""
import argparse
import json
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--execution", default="http://127.0.0.1:8545")
parser.add_argument("--consensus", default="http://127.0.0.1:5052")
parser.add_argument("--chain-id", required=True, type=int)
parser.add_argument("--max-head-age", required=True, type=int)
args = parser.parse_args()
if args.max_head_age <= 0:
    parser.error("--max-head-age must be positive seconds")


def get(url, body=None):
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def rpc(method, params=None):
    result = get(args.execution, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []})
    if "error" in result or "result" not in result:
        raise ValueError("Execution RPC failed: " + method)
    return result["result"]


try:
    chain = int(rpc("eth_chainId"), 16)
    peers = int(rpc("net_peerCount"), 16)
    syncing = rpc("eth_syncing")
    head = rpc("eth_getBlockByNumber", ["latest", False])
    age = time.time() - int(head["timestamp"], 16)
    consensus = get(args.consensus + "/eth/v1/node/syncing")["data"]
    consensus_peers = int(get(args.consensus + "/eth/v1/node/peer_count")["data"]["connected"])
    checks = {
        "chain": chain == args.chain_id,
        "executionPeers": peers > 0,
        "consensusPeers": consensus_peers > 0,
        "executionSynced": syncing is False,
        "freshHead": 0 <= age <= args.max_head_age,
        "consensusSynced": consensus.get("is_syncing") is False and int(consensus["sync_distance"]) == 0,
        "executionVerified": consensus.get("is_optimistic") is False and consensus.get("el_offline") is False,
    }
    ready = all(checks.values())
    print(json.dumps({"ready": ready, "checks": checks, "chainId": chain, "peers": peers,
                      "consensusPeers": consensus_peers, "block": head["number"], "headAgeSeconds": age}))
    raise SystemExit(0 if ready else 1)
except Exception as error:
    print(json.dumps({"ready": False, "error": str(error)}))
    raise SystemExit(1)
