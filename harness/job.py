"""Remote job supervisor. No wallet, provider credentials, or model runs here."""
import json
import os
import pathlib
import signal
import subprocess
import sys
import time

root = pathlib.Path(sys.argv[1])
spec = json.loads((root / "spec.json").read_text())
deadline = spec["deadline"]
state = {"id": spec["id"], "phase": "running", "startedAt": time.time(), "step": 0}


def save():
    temporary = root / "status.tmp"
    with temporary.open("w") as file:
        json.dump(state, file)
        file.flush()
        os.fsync(file.fileno())
    temporary.replace(root / "status.json")


def run(command, log):
    remaining = deadline - time.time()
    if remaining <= 0:
        raise TimeoutError("Job deadline reached")
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log,
                               stderr=log, start_new_session=True, cwd=spec["cwd"])
    state["pid"] = process.pid
    save()
    try:
        return process.wait(timeout=remaining)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        raise TimeoutError("Job deadline reached")


try:
    save()
    with (root / "output.log").open("ab", buffering=0) as log:
        for index, command in enumerate(spec["commands"]):
            state.update(phase="running", step=index)
            save()
            code = run(command, log)
            if code:
                state.update(phase="failed", returncode=code)
                break
        else:
            readiness = spec.get("readiness", [])
            while readiness:
                state.update(phase="waiting")
                save()
                results = [run(command, log) for command in readiness]
                state["checks"] = results
                save()
                if all(code == 0 for code in results):
                    break
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise TimeoutError("Readiness deadline reached")
                time.sleep(min(spec["pollSeconds"], remaining))
            state.update(phase="succeeded", returncode=0)
except TimeoutError as error:
    state.update(phase="timed_out", error=str(error))
except Exception as error:
    state.update(phase="failed", error=str(error))
finally:
    state["finishedAt"] = time.time()
    save()
