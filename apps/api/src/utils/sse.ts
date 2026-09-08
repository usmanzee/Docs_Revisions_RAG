/**
 * Server-Sent Events helper.
 *
 * SSE rather than WebSockets because the traffic is one-directional and
 * short-lived: the browser's EventSource semantics, automatic reconnection and
 * proxy friendliness are exactly what a streamed answer needs, without a second
 * protocol to operate.
 */

import type { FastifyReply } from 'fastify';

export class SseStream {
  private closed = false;

  constructor(private readonly reply: FastifyReply) {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx buffers responses by default, which would hold every token until
      // the answer completed and defeat the point of streaming.
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders?.();

    // If the client navigates away mid-answer, stop writing into a dead socket.
    reply.raw.on('close', () => {
      this.closed = true;
    });
  }

  get isClosed(): boolean {
    return this.closed || this.reply.raw.destroyed;
  }

  /** Write one named event with a JSON payload. */
  send(event: string, data: unknown): void {
    if (this.isClosed) return;
    const payload = JSON.stringify(data);
    this.reply.raw.write(`event: ${event}\ndata: ${payload}\n\n`);
  }

  /** Comment frame; keeps intermediaries from timing out a quiet stream. */
  comment(text: string): void {
    if (this.isClosed) return;
    this.reply.raw.write(`: ${text}\n\n`);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.reply.raw.end();
  }
}
