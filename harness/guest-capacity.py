import json
import os
import platform
import subprocess


def root_disk(tree):
    nodes = []

    def visit(node):
        nodes.append(node)
        for child in node.get("children", []):
            visit(child)

    for node in tree["blockdevices"]:
        visit(node)
    roots = [node for node in nodes if "/" in (node.get("mountpoints") or [])]
    if len(roots) != 1:
        raise ValueError("root filesystem block device is ambiguous")
    current = roots[0]
    seen = set()
    while current.get("type") != "disk":
        identity = current.get("kname")
        parent = current.get("pkname")
        if not identity or identity in seen or not parent:
            raise ValueError("root block path does not terminate at one disk")
        seen.add(identity)
        matches = [node for node in nodes if node.get("kname") == parent]
        if len(matches) != 1:
            raise ValueError("root block parent is missing or ambiguous")
        current = matches[0]
    if not isinstance(current.get("size"), int) or current["size"] <= 0:
        raise ValueError("root disk size is invalid")
    return roots[0]["path"], current["size"]


def observe():
    filesystem = os.statvfs("/")
    memory = int(next(line.split()[1] for line in open("/proc/meminfo") if line.startswith("MemTotal:"))) * 1024
    tree = json.loads(subprocess.check_output([
        "lsblk", "--json", "--bytes", "--output", "NAME,KNAME,PATH,PKNAME,SIZE,TYPE,MOUNTPOINTS"
    ], text=True))
    root_device, root_disk_bytes = root_disk(tree)
    return {
        "architecture": platform.machine(),
        "cpu": os.cpu_count(),
        "memoryBytes": memory,
        "filesystemBytes": filesystem.f_blocks * filesystem.f_frsize,
        "freeBytes": filesystem.f_bavail * filesystem.f_frsize,
        "rootDevice": root_device,
        "rootDiskBytes": root_disk_bytes,
    }


if __name__ == "__main__":
    print(json.dumps(observe()))
