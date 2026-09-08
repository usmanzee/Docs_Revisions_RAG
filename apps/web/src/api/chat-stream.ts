/**
 * Server-Sent Events client for the chat endpoint.
 *
 * `EventSource` cannot be used here because it only issues GET requests and the
 * chat turn needs a JSON body. `fetch` with a streaming reader gives the same
 * semantics plus the ability to abort a turn mid-answer, which the UI needs for
 * its stop button.
 */

import type { ChatStreamEvent, RetrievalFilters } from '@docs-rag/shared';

export interface ChatStreamHandlers {
  onEvent(event: ChatStreamEvent): void;
  onDone?(): void;
  onError?(error: Error): void;
}

export interface ChatStreamRequest {
  conversationId?: string | null;
  message: string;
  filters?: RetrievalFilters;
  signal?: AbortSignal;
}

/** Split a raw SSE buffer into complete frames, returning the remainder. */
function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;

  for (;;) {
    const boundary = rest.indexOf('\n\n');
    if (boundary === -1) break;
    frames.push(rest.slice(0, boundary));
    rest = rest.slice(boundary + 2);
  }

  return { frames, rest };
}

function parseFrame(frame: string): ChatStreamEvent | null {
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    // Comment frames are keep-alives.
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }

  if (dataLines.length === 0) return null;

  try {
    return JSON.parse(dataLines.join('\n')) as ChatStreamEvent;
  } catch {
    return null;
  }
}

export async function streamChat(request: ChatStreamRequest, handlers: ChatStreamHandlers): Promise<void> {
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: request.conversationId ?? null,
        message: request.message,
        ...(request.filters ? { filters: request.filters } : {}),
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (!response.ok) {
      // An error before streaming started arrives as an ordinary JSON body.
      const text = await response.text();
      let message = `Request failed with status ${response.status}`;
      try {
        const body = JSON.parse(text) as { error?: { message?: string } };
        if (body.error?.message) message = body.error.message;
      } catch {
        // Keep the status-derived message.
      }
      throw new Error(message);
    }

    if (!response.body) throw new Error('The server returned no response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = splitFrames(buffer);
      buffer = rest;

      for (const frame of frames) {
        const event = parseFrame(frame);
        if (event) handlers.onEvent(event);
      }
    }

    // Flush a final frame that arrived without a trailing blank line.
    const trailing = parseFrame(buffer);
    if (trailing) handlers.onEvent(trailing);

    handlers.onDone?.();
  } catch (error) {
    // An aborted turn is a user action, not a failure.
    if (error instanceof DOMException && error.name === 'AbortError') {
      handlers.onDone?.();
      return;
    }
    handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}
