const MAX_LOGS = 500;

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  context?: { cardId?: string; stage?: string; project?: string; durationMs?: number; costUsd?: number };
}

export class LogBuffer {
  private logs: LogEntry[] = [];

  add(level: LogEntry['level'], message: string, context?: LogEntry['context']): void {
    this.logs.unshift({
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
    });
    if (this.logs.length > MAX_LOGS) {
      this.logs = this.logs.slice(0, MAX_LOGS);
    }
  }

  info(msg: string, ctx?: LogEntry['context']): void { this.add('info', msg, ctx); }
  warn(msg: string, ctx?: LogEntry['context']): void { this.add('warn', msg, ctx); }
  error(msg: string, ctx?: LogEntry['context']): void { this.add('error', msg, ctx); }

  getAll(): LogEntry[] { return this.logs; }

  /** Filter logs by level, stage, project */
  query(filters: { level?: string; stage?: string; project?: string; limit?: number }): LogEntry[] {
    let results = this.logs;
    if (filters.level) results = results.filter((l) => l.level === filters.level);
    if (filters.stage) results = results.filter((l) => l.context?.stage === filters.stage);
    if (filters.project) results = results.filter((l) => l.context?.project === filters.project);
    return results.slice(0, filters.limit || 100);
  }

  /** Install as console override to capture all console.log/warn/error */
  install(): void {
    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);

    console.log = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      this.info(msg);
      origLog(...args);
    };

    console.warn = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      this.warn(msg);
      origWarn(...args);
    };

    console.error = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      this.error(msg);
      origError(...args);
    };
  }
}
