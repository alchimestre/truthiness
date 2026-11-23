import difflib
import json
import os
from pathlib import Path
import signal
import subprocess
from tempfile import TemporaryDirectory

SANDBOX = """(version 1)
(deny default)
(allow file-read-data (literal "/"))
(allow process-fork)
(allow process-exec (literal "/bin/sh") (literal "/bin/bash") (literal "/bin/cat") (literal "/usr/bin/sed") (literal "/usr/bin/mktemp") (literal "/bin/rm"))
(allow process-exec (literal "/bin/mkdir") (literal "/bin/rmdir"))
(allow file-read* (subpath "/System/Library") (subpath "/usr/lib"))
(allow file-read* (literal "/bin/sh") (literal "/bin/bash") (literal "/bin/cat") (literal "/usr/bin/sed") (literal "/usr/bin/mktemp") (literal "/bin/rm"))
(allow file-read* (literal "/bin/mkdir") (literal "/bin/rmdir"))
(allow file-read* file-write* (subpath (param "PATCH_TMP")))
(allow file-read* (literal (param "SCRIPT")))
(allow file-write* (literal "/dev/null"))
(allow file-read* (literal "/dev/null"))
(allow sysctl-read)
"""
PROBE = '{"probe":true}\n'
CHECKS = {
    "failure_after_reply": ("cat >/dev/null; printf '[\"accepted\"]\\n'; exit 19", 19, ""),
    "success_strips_fences": ("cat >/dev/null; printf '%s\\n' '```json' '[\"accepted\"]' '```'", 0, '["accepted"]\n'),
    "forwards_prompt": ("input=$(cat); case \"$input\" in 'Apply the rubric'*'{\"probe\":true}') printf '[]\\n';; *) exit 17;; esac", 0, "[]\n"),
}


def evaluate_patch(original, replacement, path, directory):
    if not replacement.startswith("#!/bin/sh\n") or len(replacement.encode()) > 4096 or "\0" in replacement:
        return {"complete_shell_file": False}
    changes = difflib.unified_diff(original.splitlines(keepends=True), replacement.splitlines(keepends=True),
                                   fromfile=f"a/{path}", tofile=f"b/{path}")
    (directory / "candidate.diff").write_text("".join(changes))
    with TemporaryDirectory(prefix="truthiness-patch-") as scratch:
        script = Path(scratch).resolve() / "wrapper.sh"
        script.write_text(replacement)
        checks = {name: check(script, *probe) for name, probe in CHECKS.items()}
    (directory / "patch-checks.json").write_text(json.dumps(checks, indent=2) + "\n")
    return checks


def check(script, reviewer, status, output):
    args = ["/bin/sh", "-c", 'ulimit -f 64; exec "$@"', "patch-check", "/usr/bin/sandbox-exec",
            "-p", SANDBOX, "-D", f"SCRIPT={script}"]
    with TemporaryDirectory(prefix="truthiness-output-") as scratch:
        root = Path(scratch)
        patch_tmp = root.resolve() / "patch"
        patch_tmp.mkdir()
        args.extend(["-D", f"PATCH_TMP={patch_tmp}", "/bin/sh", str(script)])
        env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "TMPDIR": str(patch_tmp),
               "TRUTHINESS_REVIEW_COMMAND": reviewer}
        with (root / "stdout").open("w+b") as stdout, (root / "stderr").open("w+b") as stderr:
            return run_probe(args, script.parent, env, stdout, stderr, status, output)


def run_probe(args, cwd, env, stdout, stderr, status, output):
    with subprocess.Popen(args, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr,
                          cwd=cwd, env=env, start_new_session=True) as process:
        try:
            process.communicate(PROBE.encode(), timeout=4)
        except subprocess.TimeoutExpired:
            return False
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    stdout.seek(0)
    stderr.seek(0)
    errors = stderr.read()
    if errors.startswith(b"sandbox-exec:"):
        raise RuntimeError(errors.decode(errors="replace").strip())
    return process.returncode == status and stdout.read() == output.encode()
