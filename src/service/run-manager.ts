/**
 * RunManager — an in-memory registry of active workflow runs so the /runs page
 * can show what is live and operators can cancel a run.
 *
 * A run "handle" is anything that looks like a child process (has `pid` and
 * `kill`). Cancellation escalates SIGTERM -> (wait) -> SIGKILL. In-process
 * workflows register a handle without a pid; for those, cancel simply runs the
 * registered `onCancel` writeback (there is no OS process to signal, and we must
 * never signal the server's own pid).
 *
 * The ledger writeback is provided by the caller via `onCancel` so this module
 * stays free of storage/config coupling and can be unit-tested with a mock
 * child process.
 */

export interface RunHandle {
  pid?: number;
  killed?: boolean;
  kill?(signal?: NodeJS.Signals | number): boolean;
}

interface RunEntry {
  handle: RunHandle;
  startedAt: number;
  workflow?: string;
  onCancel?: () => void | Promise<void>;
}

export type CancelStatus = 'not-found' | 'cancelled' | 'signalled' | 'killed';

export interface CancelResult {
  ok: boolean;
  runId: string;
  status: CancelStatus;
  signals: string[];
}

export interface ActiveRun {
  runId: string;
  workflow?: string;
  pid?: number;
  startedAt: number;
  ageMs: number;
}

export interface CancelOptions {
  /** How long to wait after SIGTERM before escalating to SIGKILL. */
  escalationMs?: number;
}

const DEFAULT_ESCALATION_MS = 3000;

class RunManager {
  private entries = new Map<string, RunEntry>();

  register(runId: string, handle: RunHandle, meta: { workflow?: string; onCancel?: () => void | Promise<void> } = {}): void {
    this.entries.set(runId, {
      handle,
      startedAt: Date.now(),
      workflow: meta.workflow,
      onCancel: meta.onCancel,
    });
  }

  unregister(runId: string): void {
    this.entries.delete(runId);
  }

  isActive(runId: string): boolean {
    return this.entries.has(runId);
  }

  list(): ActiveRun[] {
    const now = Date.now();
    return [...this.entries.entries()].map(([runId, entry]) => ({
      runId,
      workflow: entry.workflow,
      pid: entry.handle.pid,
      startedAt: entry.startedAt,
      ageMs: now - entry.startedAt,
    }));
  }

  async cancel(runId: string, options: CancelOptions = {}): Promise<CancelResult> {
    const entry = this.entries.get(runId);
    if (!entry) return { ok: false, runId, status: 'not-found', signals: [] };

    const signals: string[] = [];
    let status: CancelStatus = 'cancelled';
    const { handle, onCancel } = entry;

    if (typeof handle.kill === 'function' && handle.pid) {
      handle.kill('SIGTERM');
      signals.push('SIGTERM');
      status = 'signalled';
      const exited = await waitForExit(handle, options.escalationMs ?? DEFAULT_ESCALATION_MS);
      if (!exited) {
        handle.kill('SIGKILL');
        signals.push('SIGKILL');
        status = 'killed';
      }
    }

    this.entries.delete(runId);
    if (onCancel) {
      try {
        await onCancel();
      } catch (error) {
        console.warn(`[run-manager] onCancel for ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { ok: true, runId, status, signals };
  }

  /** Test-only: drop all registrations. */
  clearForTests(): void {
    this.entries.clear();
  }
}

function waitForExit(handle: RunHandle, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const poll = (): void => {
      if (handle.killed) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, Math.min(50, timeoutMs));
    };
    poll();
  });
}

export const runManager = new RunManager();
