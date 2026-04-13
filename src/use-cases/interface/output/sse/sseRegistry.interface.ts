import type http from 'node:http';

export interface ISseRegistry {
  push(userId: string, event: { type: string; [key: string]: unknown }): boolean;
  connect(userId: string, res: http.ServerResponse): void;
}
