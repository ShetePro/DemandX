import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Radar decisions are invisible in a local app; keep a short audit trail so
 * "only one idea" can be traced to the model, the evidence gates or the plan.
 */
export function scanLog(message: string): void {
  try {
    const dir = path.join(homedir(), '.demandx', 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'scan.log'), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Diagnostics must never take a scan down.
  }
}
