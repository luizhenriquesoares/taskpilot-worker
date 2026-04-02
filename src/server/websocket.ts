import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { ClaudeStreamEvent } from '../claude/headless-runner.js';

export interface WsMessage {
  type: 'stream' | 'job_start' | 'job_complete' | 'job_fail' | 'log';
  cardId?: string;
  cardName?: string;
  stage?: string;
  data: string;
  timestamp: string;
}

export class StreamBroadcaster {
  private wss: WebSocketServer | null = null;

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      console.log(`[WS] Client connected (${this.wss?.clients.size} total)`);

      ws.on('close', () => {
        console.log(`[WS] Client disconnected (${this.wss?.clients.size} total)`);
      });

      // Send welcome message
      ws.send(JSON.stringify({
        type: 'log',
        data: 'Connected to Trello Pilot Worker stream',
        timestamp: new Date().toISOString(),
      }));
    });

    console.log('[WS] WebSocket server ready on /ws');
  }

  /** Broadcast a message to all connected clients */
  broadcast(msg: WsMessage): void {
    if (!this.wss) return;
    const payload = JSON.stringify(msg);

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  /** Create an onEvent callback for the Claude runner */
  createStreamHandler(cardId: string, cardName: string, stage: string): (event: ClaudeStreamEvent) => void {
    return (event: ClaudeStreamEvent) => {
      this.broadcast({
        type: 'stream',
        cardId,
        cardName,
        stage,
        data: `[${event.type}] ${event.data}`,
        timestamp: event.timestamp,
      });
    };
  }

  /** Notify job lifecycle events */
  notifyJobStart(cardId: string, cardName: string, stage: string): void {
    this.broadcast({
      type: 'job_start',
      cardId,
      cardName,
      stage,
      data: `Starting ${stage}: ${cardName}`,
      timestamp: new Date().toISOString(),
    });
  }

  notifyJobComplete(cardId: string, cardName: string, stage: string, summary: string): void {
    this.broadcast({
      type: 'job_complete',
      cardId,
      cardName,
      stage,
      data: summary,
      timestamp: new Date().toISOString(),
    });
  }

  notifyJobFail(cardId: string, cardName: string, stage: string, error: string): void {
    this.broadcast({
      type: 'job_fail',
      cardId,
      cardName,
      stage,
      data: error,
      timestamp: new Date().toISOString(),
    });
  }

  getClientCount(): number {
    return this.wss?.clients.size ?? 0;
  }
}
