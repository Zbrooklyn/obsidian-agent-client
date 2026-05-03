/**
 * File-based [WARMUP] tracing.
 *
 * Writes every console [WARMUP] line to a configurable on-disk path
 * (typically `<vault>/.obsidian/plugins/agent-client/warmup-trace.log`)
 * so a developer can read the trace from disk without DevTools copy-paste.
 *
 * Path is configured by setWarmupTracePath() once the vault is known.
 * Failures are silent — trace logging must never break the plugin.
 *
 * Tag for removal before final PR: this is a diagnostic helper for the
 * eager warm-up optimization, not a long-term feature.
 */

import * as fs from "fs";
import * as path from "path";

let __warmupTracePath: string | null = null;

export function setWarmupTracePath(p: string): void {
	__warmupTracePath = p;
	try {
		const dir = path.dirname(p);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		// Truncate on plugin load so each session starts a fresh trace.
		fs.writeFileSync(
			p,
			`=== trace start ${new Date().toISOString()} ===\n`,
		);
	} catch {
		__warmupTracePath = null;
	}
}

export function warmupLog(line: string): void {
	console.log(line);
	if (!__warmupTracePath) return;
	try {
		fs.appendFileSync(__warmupTracePath, line + "\n");
	} catch {
		// Silent — never let logging break the plugin.
	}
}
