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
parser.add_argument("--mainnet-pair", action="store_true", help="Also verify both mainnet genesis identities and the consensus execution payload")
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
    pair = None
    if args.mainnet_pair:
        genesis = rpc("eth_getBlockByNumber", ["0x0", False])
        beacon_genesis = get(args.consensus + "/eth/v1/beacon/genesis")["data"]
        beacon = get(args.consensus + "/eth/v2/beacon/blocks/head")
        message = beacon["data"]["message"]
        payload = message["body"]["execution_payload"]
        payload_number = int(payload["block_number"])
        canonical = rpc("eth_getBlockByNumber", [hex(payload_number), False])
        payload_age = time.time() - int(payload["timestamp"])
        checks.update({
            "mainnetExecutionGenesis": args.chain_id == 1 and genesis["hash"].lower() == "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
            "mainnetConsensusGenesis": beacon_genesis["genesis_validators_root"].lower() == "0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95" and int(beacon_genesis["genesis_time"]) == 1606824023,
            "consensusHeadVerified": beacon.get("execution_optimistic") is False,
            "consensusHeadFresh": 0 <= payload_age <= args.max_head_age,
            "canonicalExecutionPayload": canonical is not None and canonical["hash"].lower() == payload["block_hash"].lower(),
        })
        pair = {"slot": message["slot"], "executionBlock": payload_number,
                "executionHash": payload["block_hash"], "headAgeSeconds": payload_age}
    ready = all(checks.values())
    print(json.dumps({"ready": ready, "checks": checks, "chainId": chain, "peers": peers,
                      "consensusPeers": consensus_peers, "block": head["number"], "headAgeSeconds": age, "pair": pair}))
    raise SystemExit(0 if ready else 1)
except Exception as error:
    print(json.dumps({"ready": False, "error": str(error)}))
    raise SystemExit(1)
