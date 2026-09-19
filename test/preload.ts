/**
 * Test preload: keep every test run out of any real checkout and any real store.
 *
 * Suites locate the repository through `import.meta.dir`, never through the process cwd.
 * A `BEADS_DIR` inherited from the shell would make every live `bd` answer for the
 * operator's store instead of the fixture's, so it is cleared here.
 */

import { mkdtempSync } from "node:fs";
import { afterEach, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupScratchDirs } from "./scratch";
afterEach(cleanupScratchDirs);

const testCwd = mkdtempSync(join(tmpdir(), "orc-test-cwd-"));
process.chdir(testCwd);
afterAll(() => { process.chdir(tmpdir()); rmSync(testCwd, { recursive: true, force: true }); });
delete process.env.BEADS_DIR;
