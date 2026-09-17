#!/bin/sh
# Real OMP packaging oracle; no install, credentials, prompt, or model request.
# Usage (from the checkout root): sh scripts/probe-plugin-load.sh [--negative-import]
# --negative-import deliberately breaks ONLY the snapshot; expect exit 1, never PASS.
# Historical branch/tag arguments are no longer accepted. Switch working trees instead.
# Requires python3 and an installed omp matching the OMP development baseline in package.json. Runtime is bounded to 30 seconds.
set -eu
case $# in
0) negative=no ;;
1) case $1 in
	--negative-import) negative=yes ;;
	--help | -h)
		sed -n '2,6p' "$0"
		exit 0
		;;
	*)
		echo 'Usage: sh scripts/probe-plugin-load.sh [--negative-import]' >&2
		exit 2
		;;
	esac ;;
*)
	echo 'Usage: sh scripts/probe-plugin-load.sh [--negative-import]' >&2
	exit 2
	;;
esac
command -v python3 >/dev/null 2>&1 || {
	echo 'FAIL: python3 is required' >&2
	exit 1
}
OMP=$(command -v omp) || {
	echo 'FAIL: omp is required on PATH' >&2
	exit 1
}
# Resolve relative PATH entries before entering the isolated project.
case $OMP in /*) ;; *) OMP=$PWD/$OMP ;; esac
umask 077
SCRATCH=$(mktemp -d /tmp/omp-plugin-probe.XXXXXXXXXX)
# Only the directory returned by this invocation's mktemp is ever removed.
trap 'rm -rf -- "$SCRATCH"' 0
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
python3 - "$PWD" "$SCRATCH" "$OMP" "$negative" <<'PY'
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import uuid

root, scratch, omp, negative = sys.argv[1:]
root, scratch = Path(root), Path(scratch)
snapshot = scratch / 'package'


def fail(message):
    raise SystemExit('FAIL: ' + message)


# Copy plugin-owned assets, not a git clone: modified and untracked source files
# are included. An allowlist avoids copying credentials, .git, .beads, node_modules,
# .omp configuration, worktrees, sessions, or other checkout-local user state.
# No symlinks: imports must not escape to live files outside this snapshot.
owned = ('package.json', 'src', 'agents', 'skills', 'rules',
         '.omp-plugin', '.claude-plugin')
excluded = {'.git', '.beads', 'node_modules', '.omp', '.pi', '__pycache__',
            'auth.json', 'auth.db', 'credentials.json', '.env'}


def copy_owned(source, dest):
    if source.name in excluded or source.name.startswith('.env.'):
        return
    if source.is_symlink():
        fail(f'symlink in plugin assets is not isolated: {source.relative_to(root)}')
    if source.is_dir():
        dest.mkdir()
        for child in source.iterdir():
            copy_owned(child, dest / child.name)
    elif source.is_file():
        shutil.copyfile(source, dest)
    else:
        fail(f'not a regular plugin asset: {source}')


snapshot.mkdir()
for name in owned:
    source = root / name
    if source.exists() or source.is_symlink():
        copy_owned(source, snapshot / name)
try:
    manifest = json.loads((snapshot / 'package.json').read_text())
    entries = manifest['omp']['extensions']
except (OSError, ValueError, KeyError, TypeError) as error:
    fail(f'missing or invalid package.json omp.extensions: {error}')
# This oracle instruments the source factory, never a stale bundle or fallback
# index. A packaging change needs an explicit new instrumentation strategy.
if entries != ['./src/index.ts']:
    fail(f'expected omp.extensions=["./src/index.ts"], got {entries!r}')
src = snapshot / 'src/index.ts'
if not src.is_file():
    fail('manifest entry src/index.ts is missing')
text = src.read_text()
factory = re.findall(r'^export default function [A-Za-z_$][\w$]*\(pi: ExtensionAPI\): void \{\n', text, re.M)
# Conservatively require the existing layout: the factory is the final top-level
# construct, and its final brace is the only unindented line in its body. Reject
# layout drift rather than placing a success marker outside the factory.
if len(factory) != 1:
    fail('cannot uniquely instrument the source default factory')
start = text.index(factory[0]) + len(factory[0])
body = text[start:]
if not re.fullmatch(r'(?:[ \t][^\n]*\n|\n)*\}\s*', body):
    fail('factory must be the final top-level construct with an indented body')
handler_names = ('before_agent_start', 'tool_call', 'todo_reminder')
handlers = []
for name in handler_names:
    pattern = rf'pi\.on\("{name}",'
    matches = list(re.finditer(pattern, text))
    if len(matches) != 1:
        fail(f'cannot uniquely instrument the source {name} handler')
    handlers.append((name, matches[0]))
token = uuid.uuid4().hex
factory_marker, handler_marker = scratch / 'factory', scratch / 'handler'


def marker_statement(path):
    return f'require("node:fs").writeFileSync({json.dumps(str(path))}, {json.dumps(token)});'


closer = text.rfind('}')
text = text[:closer] + '\t' + marker_statement(factory_marker) + '\n' + text[closer:]
if re.search(r'pi\.on\("before_agent_start", async \(event, ctx\) => \{', text) is None:
    fail('cannot uniquely instrument the source before_agent_start handler body')
if negative == 'yes':
    text = 'import "./__probe_intentionally_missing_' + token + '.ts";\n' + text
src.write_text(text)

for name in ('project', 'home', 'agent', 'config', 'cache', 'data', 'tmp'):
    (scratch / name).mkdir()
# Whitelist environment rather than trying to enumerate every provider's secrets
# or inherited OMP/Beads control variable. PATH locates the installed runtime only.
environment = {
    'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
    'HOME': str(scratch / 'home'),
    'PI_CODING_AGENT_DIR': str(scratch / 'agent'),
    'XDG_CONFIG_HOME': str(scratch / 'config'),
    'XDG_CACHE_HOME': str(scratch / 'cache'),
    'XDG_DATA_HOME': str(scratch / 'data'),
    'TMPDIR': str(scratch / 'tmp'),
    'SHELL': '/bin/sh', 'TERM': 'dumb', 'NO_COLOR': '1',
}
# extension-loading.md: -e PACKAGE resolves omp.extensions even with
# --no-extensions. Print mode initializes extensions/session_start before its
# optional prompt loop. Empty stdin and NO positional prompt mean no model call.
# Explicit bundled model selection avoids the no-model startup guard; no API key
# is needed because no prompt is submitted. No fake credential is supplied either.
argv = [omp, '--no-extensions', '-e', str(snapshot), '--no-skills',
        '--no-rules', '--no-tools', '--no-session', '--provider', 'anthropic',
        '--model', 'claude-sonnet-4-5', '-p']
print(f'Snapshot: {root} (working tree, including uncommitted plugin assets)', flush=True)
process = None


def stop_process():
    if process is not None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def interrupted(signum, _frame):
    stop_process()
    raise SystemExit(128 + signum)


for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(sig, interrupted)
try:
    # File-backed output cannot fill a pipe while the host is starting.
    with (scratch / 'omp.log').open('w+b') as log:
        process = subprocess.Popen(argv, cwd=scratch / 'project', env=environment,
                                   stdin=subprocess.DEVNULL, stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        timed_out = False
        try:
            status = process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            timed_out = True
            stop_process()
            status = process.returncode
        finally:
            # Also reap any descendants remaining after the host exits.
            stop_process()
        observed = []
        for label, path in (('factory invoked', factory_marker),):
            ok = path.is_file() and path.read_text() == token
            observed.append(ok)
            print(f'{label}: {"yes" if ok else "NO"}')
        if timed_out or status != 0 or not all(observed):
            log.seek(0, os.SEEK_END)
            length = log.tell()
            log.seek(max(0, length - 16000))
            print(log.read().decode(errors='replace'), file=sys.stderr)
            fail(f'OMP exit={status}, timeout={timed_out}; required exact-source factory marker and handlers'
                 + (' (deliberately broken import)' if negative == 'yes' else ''))
except OSError as error:
    fail(f'could not run installed OMP: {error}')
print('Verified handlers: ' + ', '.join(handler_names))
print('PASS: OMP resolved the snapshot manifest, completed its factory and dispatched before_agent_start')
PY
