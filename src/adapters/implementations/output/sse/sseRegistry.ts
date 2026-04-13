import http from 'node:http';
import type { ISseRegistry } from '../../../../use-cases/interface/output/sse/sseRegistry.interface';

export class SseRegistry implements ISseRegistry {
  private connections = new Map<string, http.ServerResponse>();
  private heartbeatTimer: NodeJS.Timeout;

  constructor(heartbeatIntervalMs = 25_000) {
    this.heartbeatTimer = setInterval(() => {
      for (const [userId, res] of this.connections) {
        try {
          res.write(': ping\n\n');
        } catch {
          this.connections.delete(userId);
        }
      }
    }, heartbeatIntervalMs);
  }

  connect(userId: string, res: http.ServerResponse): void {
    this.connections.get(userId)?.end();
    this.connections.set(userId, res);
    res.on('close', () => this.connections.delete(userId));
  }

  push(userId: string, event: { type: string; [key: string]: unknown }): boolean {
    const res = this.connections.get(userId);
    if (!res) return false;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      return true;
    } catch {
      this.connections.delete(userId);
      return false;
    }
  }

  isConnected(userId: string): boolean {
    return this.connections.has(userId);
  }

  stop(): void {
    clearInterval(this.heartbeatTimer);
    for (const res of this.connections.values()) {
      try { res.end(); } catch { /* ignore */ }
    }
    this.connections.clear();
  }
}
