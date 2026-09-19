#!/bin/sh
# Real OMP extension oracle: load the source with a stub pi and exercise its handlers.
# Usage (from the checkout root): sh scripts/probe-plugin-load.sh [--negative-rewrite]
# --negative-rewrite deliberately drops BEADS_ACTOR; expect exit 1.
set -eu
case $# in
0) negative=no ;;
1) case $1 in
	--negative-rewrite) negative=yes ;;
	--help | -h)
		sed -n '2,5p' "$0"
		exit 0
		;;
	*)
		echo 'Usage: sh scripts/probe-plugin-load.sh [--negative-rewrite]' >&2
		exit 2
		;;
esac ;;
*)
	echo 'Usage: sh scripts/probe-plugin-load.sh [--negative-rewrite]' >&2
	exit 2
;;
esac
command -v python3 >/dev/null 2>&1 || { echo 'FAIL: python3 is required' >&2; exit 1; }
BUN=$(command -v bun) || { echo 'FAIL: bun is required on PATH' >&2; exit 1; }
case $BUN in /*) ;; *) BUN=$PWD/$BUN ;; esac
umask 077
SCRATCH=$(mktemp -d /tmp/omp-plugin-probe.XXXXXXXXXX)
trap 'rm -rf -- "$SCRATCH"' 0
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
python3 - "$PWD" "$SCRATCH" "$BUN" "$negative" <<'PY'
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys

root, scratch, bun, negative = sys.argv[1:]
root, scratch = Path(root), Path(scratch)
snapshot = scratch / "package"


def fail(message):
    raise SystemExit("FAIL: " + message)


owned = ("package.json", "src", "agents", "skills", "rules", ".omp-plugin", ".claude-plugin")
excluded = {".git", ".beads", "node_modules", ".omp", ".pi", "__pycache__", "auth.json", "auth.db", "credentials.json", ".env"}


def copy_owned(source, dest):
    if source.name in excluded or source.name.startswith(".env."):
        return
    if source.is_symlink():
        fail(f"symlink in plugin assets is not isolated: {source.relative_to(root)}")
    if source.is_dir():
        dest.mkdir()
        for child in source.iterdir():
            copy_owned(child, dest / child.name)
    elif source.is_file():
        shutil.copyfile(source, dest)
    else:
        fail(f"not a regular plugin asset: {source}")


snapshot.mkdir()
for name in owned:
    source = root / name
    if source.exists() or source.is_symlink():
        copy_owned(source, snapshot / name)
try:
    manifest = json.loads((snapshot / "package.json").read_text())
    entries = manifest["omp"]["extensions"]
except (OSError, ValueError, KeyError, TypeError) as error:
    fail(f"missing or invalid package.json omp.extensions: {error}")
if entries != ["./src/index.ts"]:
    fail(f"expected omp.extensions=[\"./src/index.ts\"], got {entries!r}")
if not (snapshot / "src/index.ts").is_file():
    fail("manifest entry src/index.ts is missing")

# The registration itself is the load oracle. Stop after the handlers under test have
# registered so unrelated tool registrations cannot hide a bad pi stub.
source = snapshot / "src/index.ts"
text = source.read_text()
if text.count('pi.on("tool_call",') != 1 or text.count('pi.on("before_agent_start",') != 1:
    fail("cannot uniquely locate required handler registrations")
# The ledger is intentionally not registered in this probe; seed the handler's status snapshot
# so a synthetic drifted todo exercises the real reminder branch.
text = text.replace("registerLedger(pi);", "return; // registerLedger omitted", 1)
text = text.replace("const ids = statusBeadIds(ctx);", "const ids = new Set([\"probe-known\"]);")
source.write_text(text)

for name in ("project", "home", "agent", "config", "cache", "data", "tmp"):
    (scratch / name).mkdir()
# Keep a scratch project as the handler context and preserve the old isolated setup.
(scratch / "project" / ".beads").mkdir()

probe = snapshot / "probe.ts"
probe.write_text(r'''import extension from "./src/index.ts";

const handlers = new Map<string, (event: any, ctx: any) => any>();
const registrations: string[] = [];
const reminders: string[] = [];
const pi: any = {
  setLabel() {},
  on(name: string, handler: any) { registrations.push(name); handlers.set(name, handler); },
  events: { on() {} },
  registerTool() {},
  sendUserMessage(message: string) { reminders.push(message); },
};
const model = { provider: "probe", id: "probe" };
const ctx: any = {
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => "probe-session" },
  models: { resolve: () => model, current: () => model },
  getSystemPrompt: () => [],
};
extension(pi);
const actor = "omp/probe-session";
const tool = handlers.get("tool_call");
if (!tool) throw new Error("tool_call handler was not registered");
const rewritten = await tool({ toolName: "bash", input: { command: "bd list", env: { BD_ACTOR: "other" } } }, ctx);
if (!rewritten || rewritten.input?.env?.BD_ACTOR !== actor || rewritten.input?.env?.BEADS_ACTOR !== actor || rewritten.input?.env?.BD_ACTOR === "other") {
  throw new Error(`actor check failed: ${JSON.stringify(rewritten)}`);
}
if (process.env.NEGATIVE_REWRITE === "1") {
  delete rewritten.input.env.BEADS_ACTOR;
  if (rewritten.input.env.BEADS_ACTOR !== actor) throw new Error(`actor check failed after negative rewrite: ${JSON.stringify(rewritten)}`);
}
const start = handlers.get("session_start");
const before = handlers.get("before_agent_start");
if (!start || !before) throw new Error("session_start/before_agent_start handler was not registered");
for (const plugin of ["beads", "build", "worktrunk"]) globalThis[Symbol.for(`com.srobroek.${plugin}.present.v1`)] = { version: "0.0.0" };
start({}, ctx);
const present = await before({ prompt: "orchestrate" }, ctx);
const presentText = present?.message?.content ?? "";
if (!presentText.includes("orchestrate-with-bd run header") || presentText.includes("STOP.")) throw new Error(`run-header check failed: ${presentText}`);
for (const plugin of ["beads", "build", "worktrunk"]) delete globalThis[Symbol.for(`com.srobroek.${plugin}.present.v1`)];
const absent = await before({ prompt: "orchestrate" }, ctx);
const absentText = absent?.message?.content ?? "";
const stop = "STOP. omp-orchestrate requires companion plugins that are not loaded: beads, build, worktrunk";
if (!absentText.includes(stop)) throw new Error(`companion refusal check failed: ${absentText}`);
const reminder = handlers.get("todo_reminder");
if (!reminder) throw new Error("todo_reminder handler was not registered");
await reminder({ todos: [{ content: "orphan todo" }] }, ctx);
if (!reminders.some((message) => message.includes("todo items not backed by a bead"))) throw new Error(`todo reminder check failed: ${JSON.stringify(reminders)}`);
console.log(JSON.stringify({ registrations, actor, checks: ["actor rewrite", "run header", "companion refusal", "todo_reminder"] }));
''')

environment = {
    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
    "HOME": str(scratch / "home"),
    "PI_CODING_AGENT_DIR": str(scratch / "agent"),
    "XDG_CONFIG_HOME": str(scratch / "config"),
    "XDG_CACHE_HOME": str(scratch / "cache"),
    "XDG_DATA_HOME": str(scratch / "data"),
    "TMPDIR": str(scratch / "tmp"),
    "SHELL": "/bin/sh", "TERM": "dumb", "NO_COLOR": "1",
}
if negative == "yes":
    environment["NEGATIVE_REWRITE"] = "1"
try:
    result = subprocess.run([bun, str(probe)], cwd=scratch / "project", env=environment,
                            text=True, capture_output=True, timeout=30)
except (OSError, subprocess.TimeoutExpired) as error:
    fail(f"could not run bun probe: {error}")
if result.returncode != 0:
    output = (result.stdout + result.stderr).strip()
    print(output, file=sys.stderr)
    fail("actor/check handler probe failed")
try:
    observed = json.loads(result.stdout)
except (ValueError, TypeError) as error:
    fail(f"probe returned invalid JSON: {error}: {result.stdout!r}")
registrations = observed.get("registrations", [])
required = {"session_start", "tool_call", "before_agent_start", "todo_reminder"}
if not required.issubset(registrations):
    fail(f"handlers were not reached via pi.on registrations: {registrations!r}")
checks = observed.get("checks", [])
if "todo_reminder" not in checks:
    fail(f"todo reminder output was not observed: {observed!r}")
print("Registered via pi.on: " + ", ".join(registrations))
print("Checks: " + ", ".join(checks))
print("PASS: real handlers accepted synthetic tool and lifecycle events")
PY
