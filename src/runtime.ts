import fs from "fs";
import path from "path";
import { AgentName, Config } from "./types";

export function resolveRuntimePaths(cwd: string, config: Config): { lockPath: string; logDir: string } {
  return {
    lockPath: path.resolve(cwd, config.lock_file),
    logDir: path.resolve(cwd, config.log_dir),
  };
}

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (_error) {
    return null;
  }
}

export function createRunLogger({
  cwd,
  config,
  runId,
}: {
  cwd: string;
  config: Config;
  runId: string;
}): { logPath: string; logEvent: (event: Record<string, unknown>) => void } {
  const { logDir } = resolveRuntimePaths(cwd, config);
  ensureDirectory(logDir);
  const logPath = path.join(logDir, `${runId}.jsonl`);

  function logEvent(event: Record<string, unknown>): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      run_id: runId,
      ...event,
    });
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
  }

  return {
    logPath,
    logEvent,
  };
}

function tryCreateLock(lockPath: string, payload: Record<string, unknown>): void {
  const fd = fs.openSync(lockPath, "wx");
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function acquireRunLock({
  cwd,
  config,
  runId,
}: {
  cwd: string;
  config: Config;
  runId: string;
}): { lockPath: string; release: () => void } {
  const { lockPath } = resolveRuntimePaths(cwd, config);
  const payload = {
    pid: process.pid,
    run_id: runId,
    cwd,
    created_at: new Date().toISOString(),
  };

  let acquired = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      tryCreateLock(lockPath, payload);
      acquired = true;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw new Error(`Failed to acquire lock at ${lockPath}: ${(error as Error).message}`);
      }

      const existing = readJsonFile(lockPath);
      const existingPid = typeof existing?.pid === "number" ? existing.pid : Number(existing?.pid);
      const alive = Number.isFinite(existingPid) ? isProcessAlive(existingPid) : false;
      if (alive) {
        throw new Error(
          `Another run is active (pid=${existing?.pid || "unknown"}, run_id=${existing?.run_id || "unknown"}, ` +
            `started_at=${existing?.created_at || "unknown"}). Remove ${lockPath} only if stale.`
        );
      }

      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        throw new Error(
          `Failed to remove stale lock at ${lockPath}: ${(unlinkError as Error).message}`
        );
      }
    }
  }

  if (!acquired) {
    throw new Error(`Could not acquire lock at ${lockPath}`);
  }

  let released = false;
  function release(): void {
    if (released) {
      return;
    }
    released = true;

    if (!fs.existsSync(lockPath)) {
      return;
    }

    const existing = readJsonFile(lockPath);
    if (existing && existing.run_id && existing.run_id !== runId) {
      return;
    }

    try {
      fs.unlinkSync(lockPath);
    } catch (_error) {
      // Ignore cleanup errors.
    }
  }

  return {
    lockPath,
    release,
  };
}

export function resolveTimeoutMs(agentName: AgentName, config: Config, cliTimeoutMs?: number): number {
  if (Number.isInteger(cliTimeoutMs) && (cliTimeoutMs as number) > 0) {
    return cliTimeoutMs as number;
  }

  const perAgentTimeout = config.agent_timeouts_ms[agentName];
  if (Number.isInteger(perAgentTimeout) && (perAgentTimeout as number) > 0) {
    return perAgentTimeout as number;
  }

  return config.agent_timeout_ms;
}
