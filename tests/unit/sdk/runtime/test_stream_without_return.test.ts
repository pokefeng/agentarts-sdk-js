import { expect, it } from 'vitest';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import {
  AgentArtsRuntimeApp,
  PingStatus,
  StreamingResponse,
  type RequestContext,
} from 'agentarts-sdk/sdk/runtime';

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'retains execution until a non-cancellable stream finishes (consumed: %s, explicit: %s)',
  async (consumed, explicit) => {
    const app = new AgentArtsRuntimeApp({ maxConcurrency: 1 });
    let finish!: () => void;
    const execution = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let first = true;
    const source: AsyncIterableIterator<string> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (first) {
          first = false;
          return { done: false, value: 'started' };
        }
        await execution;
        return { done: true, value: undefined };
      },
    };
    app.entrypoint(() => (explicit ? new StreamingResponse(source) : source));
    const response = (await app._handleInvocation({
      json: async () => ({}),
      headers: {},
    })) as StreamingResponse;
    const stream = (response.contentStream as AsyncIterable<string>)[Symbol.asyncIterator]();
    if (consumed) await stream.next();
    const closing = stream.return!();
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY_BUSY);
    } finally {
      finish();
      await closing;
    }
  },
);

it('retains the HTTP slot while a disconnected peer child is still cleaning up and the stream has no return', async () => {
  const app = new AgentArtsRuntimeApp({ maxConcurrency: 1 });
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    // Cooperative shutdown over IPC: process signals are not delivered to
    // Windows children, so the parent asks for cleanup with a message instead.
    process.on('message', (message) => {
      if (message === 'stop') process.send('cleaning');
      else process.exit(0);
    });
    process.send('ready');
    setInterval(() => {}, 1000);
  `,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  const exited = once(child, 'exit');
  await once(child, 'message');
  let entered!: () => void, opened!: () => void;
  const invocationStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const iteratorOpened = new Promise<void>((resolve) => {
    opened = resolve;
  });
  app.entrypoint(async (payload: any, context?: RequestContext) => {
    if (payload.probe) return { ok: true };
    const cleaning = once(child, 'message');
    context!.signal!.addEventListener(
      'abort',
      () => {
        if (child.connected) child.send('stop');
      },
      { once: true },
    );
    entered();
    await cleaning;
    return new StreamingResponse({
      [Symbol.asyncIterator]() {
        opened();
        return {
          async next() {
            await exited;
            return { done: true, value: undefined };
          },
        };
      },
    });
  });
  const server = app.run('127.0.0.1', 0);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const cancellation = new AbortController();
  const pending = fetch(`http://127.0.0.1:${address.port}/invocations`, {
    method: 'POST',
    body: '{}',
    signal: cancellation.signal,
  }).catch(() => undefined);
  try {
    await invocationStarted;
    cancellation.abort();
    await iteratorOpened;
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.exitCode).toBeNull();
    const probe = await fetch(`http://127.0.0.1:${address.port}/invocations`, {
      method: 'POST',
      body: JSON.stringify({ probe: true }),
    });
    expect(probe.status).toBe(503);
    await probe.text();
    expect(app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY_BUSY);
    child.send('finish');
    await exited;
    await expect.poll(() => app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY);
    const recovered = await fetch(`http://127.0.0.1:${address.port}/invocations`, {
      method: 'POST',
      body: JSON.stringify({ probe: true }),
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ ok: true });
  } finally {
    if (child.connected) child.send('finish');
    else child.kill('SIGKILL');
    await exited;
    await pending;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const request = () => ({ json: async () => ({}), headers: {} });
function iterator(response: StreamingResponse) {
  return (response.contentStream as AsyncIterable<string>)[Symbol.asyncIterator]();
}

it('waits for the existing read before draining without starting concurrent reads', async () => {
  const app = new AgentArtsRuntimeApp({ maxConcurrency: 1 });
  const entered = deferred(),
    first = deferred(),
    draining = deferred(),
    finish = deferred();
  let calls = 0,
    active = 0,
    peak = 0;
  const source: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      active++;
      peak = Math.max(peak, active);
      try {
        if (++calls === 1) {
          entered.resolve();
          await first.promise;
          return { done: false, value: 'chunk' };
        }
        draining.resolve();
        await finish.promise;
        return { done: true, value: undefined };
      } finally {
        active--;
      }
    },
  };
  app.entrypoint(() => new StreamingResponse(source));
  const stream = iterator((await app._handleInvocation(request())) as StreamingResponse);
  const pending = stream.next();
  await entered.promise;
  const closing = stream.return!();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    first.resolve();
    await pending;
    await draining.promise;
    expect(peak).toBe(1);
    expect(app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY_BUSY);
  } finally {
    first.resolve();
    finish.resolve();
    await closing;
  }
  expect(app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY);
});

it.each([false, true])(
  'does not restart a failed source without return (explicit: %s)',
  async (explicit) => {
    const app = new AgentArtsRuntimeApp({ maxConcurrency: 1 });
    let reads = 0;
    const source: AsyncIterableIterator<string> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        reads++;
        throw new Error('execution failed');
      },
    };
    app.entrypoint(() => (explicit ? new StreamingResponse(source) : source));
    const stream = iterator((await app._handleInvocation(request())) as StreamingResponse);
    if (explicit) await expect(stream.next()).rejects.toThrow('execution failed');
    else expect(String((await stream.next()).value)).toContain('"error":"execution failed"');
    await stream.return!();
    expect(reads).toBe(1);
    expect(app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY);
  },
);

it('reports failure during drain without leaking a slot or retrying cleanup', async () => {
  const app = new AgentArtsRuntimeApp({ maxConcurrency: 1 });
  let reads = 0;
  const source: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (++reads === 1) return { done: false, value: 'chunk' };
      throw new Error('drain failed');
    },
  };
  app.entrypoint(() => new StreamingResponse(source));
  const stream = iterator((await app._handleInvocation(request())) as StreamingResponse);
  await expect(stream.return!()).rejects.toThrow('drain failed');
  await expect(stream.return!()).rejects.toThrow('drain failed');
  expect(reads).toBe(2);
  expect(app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY);
});

it('lets the event loop service other work while a synchronous source is drained', async () => {
  const app = new AgentArtsRuntimeApp({ maxConcurrency: 1 });
  let finished = false,
    reads = 0;
  const source: IterableIterator<string> = {
    [Symbol.iterator]() {
      return this;
    },
    next() {
      return finished || ++reads > 4096
        ? { done: true, value: undefined }
        : { done: false, value: 'chunk' };
    },
  };
  app.entrypoint(() => new StreamingResponse(source));
  const stream = iterator((await app._handleInvocation(request())) as StreamingResponse);
  const closing = stream.return!();
  const status = await new Promise<PingStatus>((resolve) =>
    setImmediate(() => {
      const current = app.getCurrentPingStatus();
      finished = true;
      resolve(current);
    }),
  );
  await closing;
  expect(status).toBe(PingStatus.HEALTHY_BUSY);
  expect(app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY);
});
