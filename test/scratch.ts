import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created = new Set<string>();

export function scratchDir(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	created.add(path);
	return path;
}


export function cleanupScratchDirs(): void {
	for (const path of created) rmSync(path, { recursive: true, force: true });
	created.clear();
}
