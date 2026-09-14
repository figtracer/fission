"""Observe a local execution + Lighthouse pair; never starts or modifies a node."""
import argparse
import json
import socket
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--execution", default="http://127.0.0.1:8545")
parser.add_argument("--execution-ipc", help="Verify the execution network genesis over local IPC when block zero is pruned")
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
        detail = json.dumps(result.get("error", "missing result"), ensure_ascii=True)
        raise ValueError(f"Execution RPC failed: {method} {json.dumps(params or [])}: {detail}")
    return result["result"]


def network_identity():
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(5)
        connection.connect(args.execution_ipc)
        connection.sendall(b'{"jsonrpc":"2.0","id":1,"method":"admin_nodeInfo","params":[]}\n')
        response = bytearray()
        # Node identity is a small object; do not accumulate an unbounded response.
        while len(response) < 65536:
            part = connection.recv(65536 - len(response))
            if not part:
                break
            response.extend(part)
            try:
                result = json.loads(response)
            except json.JSONDecodeError:
                continue
            if result.get("id") != 1 or "error" in result:
                raise ValueError("Execution IPC failed: admin_nodeInfo")
            return result["result"]["protocols"]["eth"]
    raise ValueError("Incomplete or oversized execution IPC identity")


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
        if args.execution_ipc:
            identity = network_identity()
            genesis_hash = identity["genesis"]
            checks["executionNetwork"] = int(identity["network"]) == args.chain_id and int(identity["config"]["chainId"]) == args.chain_id
        else:
            genesis_hash = rpc("eth_getBlockByNumber", ["0x0", False])["hash"]
        beacon_genesis = get(args.consensus + "/eth/v1/beacon/genesis")["data"]
        beacon = get(args.consensus + "/eth/v2/beacon/blocks/head")
        message = beacon["data"]["message"]
        payload = message["body"]["execution_payload"]
        payload_number = int(payload["block_number"])
        canonical = rpc("eth_getBlockByNumber", [hex(payload_number), False])
        payload_age = time.time() - int(payload["timestamp"])
        checks.update({
            "mainnetExecutionGenesis": args.chain_id == 1 and genesis_hash.lower() == "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
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
