import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  AgentArtsRuntimeApp,
  PingStatus,
  type TextExecutor,
  type ExecutionPrincipal,
  ProtocolHttpError,
} from 'agentarts-sdk/sdk/runtime';
import { createA2aAdapter } from '../../../../packages/agentarts-protocol-a2a/src/index.js';
import { createAguiAdapter } from '../../../../packages/agentarts-protocol-agui/src/index.js';

const a2aRequire = createRequire(
  new URL('../../../../packages/agentarts-protocol-a2a/package.json', import.meta.url),
);
const aguiRequire = createRequire(
  new URL('../../../../packages/agentarts-protocol-agui/package.json', import.meta.url),
);
const sdk = await import(a2aRequire.resolve('@a2a-js/sdk'));
const a2a = await import(a2aRequire.resolve('@a2a-js/sdk/client'));
const agui = await import(aguiRequire.resolve('@ag-ui/client'));
const schemas = await import(aguiRequire.resolve('@ag-ui/core/schemas'));
const gates = new Set<() => void>();
function deferred() {
  let finish!: () => void;
  const promise = new Promise<void>((done) => {
    finish = done;
  });
  gates.add(finish);
  return {
    promise,
    resolve: () => {
      gates.delete(finish);
      finish();
    },
  };
}
const apps: Array<{ app: AgentArtsRuntimeApp; server: Server }> = [];
afterEach(async () => {
  for (const finish of gates) finish();
  gates.clear();
  for (const { app, server } of apps.splice(0)) {
    await app.executions.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const authenticate = ({
  headers,
}: {
  headers: Readonly<Record<string, unknown>>;
}): ExecutionPrincipal | null => {
  if (headers.authorization === 'Bearer alice') return { tenantId: 'a', subject: 'alice' };
  if (headers.authorization === 'Bearer bob') return { tenantId: 'a', subject: 'bob' };
  if (headers.authorization === 'Bearer other-tenant') return { tenantId: 'b', subject: 'alice' };
  return null;
};
async function setup(
  execute: TextExecutor = () => 'hello',
  options: ConstructorParameters<typeof AgentArtsRuntimeApp>[0] = {},
) {
  const app = new AgentArtsRuntimeApp(options);
  app.entrypoint(async () => 'legacy');
  const server = app.run('127.0.0.1', 0);
  apps.push({ app, server });
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const card = sdk.AgentCard.fromJSON({
    name: 'Test agent',
    description: 'Text only',
    version: '1.0.0',
    supportedInterfaces: [
      { url: url + '/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'bearer' } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    skills: [{ id: 'text', name: 'text', description: 'Text only', tags: ['text'] }],
  });
  app.use(createA2aAdapter({ agentCard: card, authenticate, execute }));
  app.use(createAguiAdapter({ authenticate, execute }));
  const fetchImpl: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', 'Bearer alice');
    return fetch(input, { ...init, headers });
  };
  const client = await new a2a.ClientFactory({
    transports: [new a2a.JsonRpcTransportFactory({ fetchImpl })],
    cardResolver: new a2a.DefaultAgentCardResolver({ fetchImpl }),
    clientConfig: { polling: false },
  }).createFromUrl(url);
  return { app, url, client, card };
}
function message(id = 'message-1', text = 'hello', immediate = false) {
  return sdk.SendMessageRequest.fromJSON({
    message: { messageId: id, role: 'ROLE_USER', parts: [{ text, mediaType: 'text/plain' }] },
    configuration: { returnImmediately: immediate },
  });
}
function aguiInput(runId = 'run-1') {
  return {
    threadId: 'thread-1',
    runId,
    messages: [{ id: 'user-1', role: 'user', content: 'hello' }],
    tools: [],
    context: [],
  };
}
function post(
  url: string,
  path: string,
  input: unknown,
  token = 'alice',
  extra: Record<string, string> = {},
) {
  return fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra },
    body: JSON.stringify(input),
  });
}
function rpc(method: string, params: unknown, id: string | number = 'rpc-1') {
  return { jsonrpc: '2.0', id, method, params };
}
async function frames(response: globalThis.Response): Promise<any[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data:'))
    .map((frame) => JSON.parse(frame.slice(5).trim()));
}

it('interoperates with the official A2A client for discovery, send and get', async () => {
  const { app, client } = await setup();
  const task = await client.sendMessage(message());
  expect(task.status.state).toBe(sdk.TaskState.TASK_STATE_COMPLETED);
  expect(task.artifacts[0].parts[0].content.value).toBe('hello');
  const fetched = await client.getTask(sdk.GetTaskRequest.fromJSON({ id: task.id }));
  expect(fetched.id).toBe(task.id);
  expect(app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY);
});

it('interoperates with the official AG-UI HttpAgent and schema-validates the stream', async () => {
  const { url } = await setup();
  const agent = new agui.HttpAgent({
    url: url + '/ag-ui',
    headers: { authorization: 'Bearer alice' },
    threadId: 'client-thread',
    messages: [{ id: 'm1', role: 'user', content: 'hello' }],
  });
  await agent.runAgent({ runId: 'client-run' });
  expect(
    agent.messages.some((entry: any) => entry.role === 'assistant' && entry.content === 'hello'),
  ).toBe(true);
  const events = await frames(await post(url, '/ag-ui', aguiInput('schema-run')));
  for (const event of events) expect(schemas.EventSchema.safeParse(event).success).toBe(true);
  expect(events[0].type).toBe('RUN_STARTED');
  expect(events.at(-1).type).toBe('RUN_FINISHED');
});

it.each(['bob', 'other-tenant'])(
  'does not expose or cancel another principal task: %s',
  async (token) => {
    const { url, client } = await setup();
    const task = await client.sendMessage(message());
    for (const method of ['GetTask', 'CancelTask', 'SubscribeToTask']) {
      const response = await post(url, '/a2a', rpc(method, { id: task.id }), token, {
        'a2a-version': '1.0',
      });
      const result: any = await response.json();
      expect(result.error).toBeDefined();
      expect(result.result).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('hello');
    }
  },
);

it('requires authentication and does not leak authentication provider secrets', async () => {
  const { url, app } = await setup();
  expect((await fetch(url + '/.well-known/agent-card.json')).status).toBe(401);
  expect((await post(url, '/ag-ui', aguiInput(), 'invalid')).status).toBe(401);
  app.use(
    createAguiAdapter({
      path: '/secret-test',
      authenticate: () => {
        throw new Error('SECRET-AK-SK');
      },
      execute: () => 'never',
    }),
  );
  const logged = vi.spyOn(app.logger, 'exception');
  const response = await post(url, '/secret-test', aguiInput());
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain('SECRET');
  expect(JSON.stringify(logged.mock.calls)).not.toContain('SECRET');
});

it.each(['a2a', 'agui'])(
  'does not reflect typed authentication provider failures on %s',
  async (protocol) => {
    const { app, url, card } = await setup();
    const authenticate = async () => {
      throw new ProtocolHttpError(500, 'PRIVATE-AUTH-CODE', 'PRIVATE-AUTH-MESSAGE', {
        'x-private-auth': 'PRIVATE-AUTH-HEADER',
      });
    };
    const execute = vi.fn(() => 'never');
    if (protocol === 'a2a') {
      const agentCard = sdk.AgentCard.fromJSON(sdk.AgentCard.toJSON(card));
      agentCard.supportedInterfaces[0]!.url = url + '/typed-a2a';
      app.use(
        createA2aAdapter({
          path: '/typed-a2a',
          cardPath: '/typed-card',
          agentCard,
          authenticate,
          execute,
        }),
      );
    } else app.use(createAguiAdapter({ path: '/typed-agui', authenticate, execute }));
    const response = await post(
      url,
      `/typed-${protocol}`,
      protocol === 'a2a'
        ? rpc('SendMessage', sdk.SendMessageRequest.toJSON(message()))
        : aguiInput(),
      'alice',
      { 'a2a-version': '1.0' },
    );
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('PRIVATE');
    expect(response.headers.get('x-private-auth')).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  },
);

it('rejects foreign tenant overrides, remote files, callbacks and unsupported AG-UI tools', async () => {
  const { url } = await setup();
  const base = sdk.SendMessageRequest.toJSON(message());
  expect(
    (
      await post(url, '/a2a', rpc('SendMessage', { ...base, tenant: 'b' }), 'alice', {
        'a2a-version': '1.0',
      })
    ).status,
  ).toBe(403);
  const file = {
    message: {
      messageId: 'file',
      role: 'ROLE_USER',
      parts: [{ url: 'http://127.0.0.1/internal', mediaType: 'text/plain' }],
    },
  };
  expect(
    (await post(url, '/a2a', rpc('SendMessage', file), 'alice', { 'a2a-version': '1.0' })).status,
  ).toBe(400);
  const callback = {
    ...base,
    configuration: { taskPushNotificationConfig: { url: 'http://127.0.0.1/internal' } },
  };
  expect(
    (await post(url, '/a2a', rpc('SendMessage', callback), 'alice', { 'a2a-version': '1.0' }))
      .status,
  ).toBe(400);
  expect(
    (
      await post(url, '/ag-ui', {
        ...aguiInput(),
        tools: [{ name: 'exec', description: 'run code', parameters: {} }],
      })
    ).status,
  ).toBe(400);
});

it('rejects invalid JSON, poison keys, depth and size limits without consuming execution capacity', async () => {
  const { url, app } = await setup();
  app.use(
    createAguiAdapter({ path: '/small', authenticate, execute: () => '', maxBodyBytes: 128 }),
  );
  expect(
    (await post(url, '/small', { ...aguiInput(), forwardedProps: 'x'.repeat(256) })).status,
  ).toBe(413);
  for (const raw of ['{', '{"__proto__":{"admin":true}}', '['.repeat(70) + '0' + ']'.repeat(70)]) {
    const response = await fetch(url + '/ag-ui', {
      method: 'POST',
      headers: { authorization: 'Bearer alice', 'content-type': 'application/json' },
      body: raw,
    });
    expect(response.status).toBe(400);
  }
  expect(
    (
      await fetch(url + '/ag-ui', {
        method: 'POST',
        headers: { authorization: 'Bearer alice' },
        body: '{}',
      })
    ).status,
  ).toBe(415);
  expect(app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY);
});

it('shares maxConcurrency across HTTP, mounted protocols and WS-style explicit leases', async () => {
  const finish = deferred();
  const { app, url, client } = await setup(
    async () => {
      await finish.promise;
      return 'done';
    },
    { maxConcurrency: 1 },
  );
  const task = await client.sendMessage(message('active', 'hello', true));
  try {
    expect((await fetch(url + '/invocations', { method: 'POST', body: '{}' })).status).toBe(503);
    expect((await post(url, '/ag-ui', aguiInput())).status).toBe(503);
    expect(
      (
        await post(
          url,
          '/a2a',
          rpc('SendMessage', sdk.SendMessageRequest.toJSON(message('second', 'hello', true))),
          'alice',
          { 'a2a-version': '1.0' },
        )
      ).status,
    ).toBe(503);
    expect(() => app.acquireSlot()).toThrow();
    expect(((await (await fetch(url + '/ping')).json()) as any).status).toBe(
      PingStatus.HEALTHY_BUSY,
    );
  } finally {
    finish.resolve();
  }
  await expect
    .poll(
      async () => (await client.getTask(sdk.GetTaskRequest.fromJSON({ id: task.id }))).status.state,
    )
    .toBe(sdk.TaskState.TASK_STATE_COMPLETED);
  const lease = app.acquireSlot();
  try {
    expect((await post(url, '/ag-ui', aguiInput('blocked-by-ws'))).status).toBe(503);
  } finally {
    lease.release();
  }
});

it('deduplicates A2A messages and rejects reusing AG-UI run ids with different inputs', async () => {
  let calls = 0;
  const { url, client } = await setup(() => {
    calls++;
    return 'done';
  });
  const first = await client.sendMessage(message('dedupe'));
  const second = await client.sendMessage(message('dedupe'));
  expect(first.id).toBe(second.id);
  expect(calls).toBe(1);
  expect(
    (
      await post(
        url,
        '/a2a',
        rpc('SendMessage', sdk.SendMessageRequest.toJSON(message('dedupe', 'changed'))),
        'alice',
        { 'a2a-version': '1.0' },
      )
    ).status,
  ).toBe(409);
  await frames(await post(url, '/ag-ui', aguiInput()));
  const changed = { ...aguiInput(), messages: [{ id: 'm2', role: 'user', content: 'changed' }] };
  expect((await post(url, '/ag-ui', changed)).status).toBe(409);
});

it('A2A streaming disconnect does not cancel execution; explicit cancel waits for cleanup', async () => {
  const cleaning = deferred(),
    finish = deferred();
  const { app, url, client } = await setup(
    async (_input, context) => {
      context.emitText('started');
      await new Promise<void>((resolve) =>
        context.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      cleaning.resolve();
      await finish.promise;
    },
    { maxConcurrency: 1 },
  );
  const abort = new AbortController();
  const response = await fetch(url + '/a2a', {
    method: 'POST',
    headers: {
      authorization: 'Bearer alice',
      'content-type': 'application/json',
      'a2a-version': '1.0',
    },
    body: JSON.stringify(
      rpc('SendStreamingMessage', sdk.SendMessageRequest.toJSON(message('stream'))),
    ),
    signal: abort.signal,
  });
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const event = JSON.parse(first.split('\n\n')[0]!.slice(5).trim());
  const id = event.result.task.id;
  abort.abort();
  await reader.cancel().catch(() => {});
  expect(app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY_BUSY);
  const canceled = client.cancelTask(sdk.CancelTaskRequest.fromJSON({ id }));
  await cleaning.promise;
  try {
    expect((await post(url, '/ag-ui', aguiInput())).status).toBe(503);
  } finally {
    finish.resolve();
  }
  expect((await canceled).status.state).toBe(sdk.TaskState.TASK_STATE_CANCELED);
  expect(app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY);
});

it('AG-UI disconnect cancels the run but keeps the slot until cleanup finishes', async () => {
  const cleaning = deferred(),
    finish = deferred();
  const { app, url } = await setup(
    async (_input, context) => {
      context.emitText('started');
      await new Promise<void>((resolve) =>
        context.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      cleaning.resolve();
      await finish.promise;
    },
    { maxConcurrency: 1 },
  );
  const abort = new AbortController();
  const response = await fetch(url + '/ag-ui', {
    method: 'POST',
    headers: { authorization: 'Bearer alice', 'content-type': 'application/json' },
    body: JSON.stringify(aguiInput()),
    signal: abort.signal,
  });
  const reader = response.body!.getReader();
  await reader.read();
  abort.abort();
  await cleaning.promise;
  try {
    expect(app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY_BUSY);
  } finally {
    finish.resolve();
  }
  await reader.cancel().catch(() => {});
  await expect.poll(() => app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY);
});

it('reports executor failures as AG-UI RUN_ERROR without exposing secrets', async () => {
  const { url } = await setup(() => {
    throw new Error('SECRET-server-credential');
  });
  const events = await frames(await post(url, '/ag-ui', aguiInput()));
  expect(events.at(-1).type).toBe('RUN_ERROR');
  expect(JSON.stringify(events)).not.toContain('SECRET');
});

it('preserves the legacy routes and rejects route conflicts atomically', async () => {
  const { app, url } = await setup();
  expect(() =>
    app.use(createAguiAdapter({ path: '/invocations', authenticate, execute: () => '' })),
  ).toThrow();
  expect(() =>
    app.use(createAguiAdapter({ path: '/ag-ui', authenticate, execute: () => '' })),
  ).toThrow();
  expect(() =>
    app.use(createAguiAdapter({ path: '/x/../ping', authenticate, execute: () => '' })),
  ).toThrow();
  expect((await fetch(url + '/invocations', { method: 'POST', body: '{}' })).status).toBe(200);
  expect((await fetch(url + '/ag-ui')).status).toBe(405);
});

it('bounds protocol requests without blocking legacy health probes', async () => {
  const finish = deferred();
  const { url, app } = await setup(
    async () => {
      await finish.promise;
      return 'done';
    },
    { maxProtocolRequests: 1 },
  );
  const abort = new AbortController();
  const response = await fetch(url + '/ag-ui', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer alice' },
    body: JSON.stringify(aguiInput()),
    signal: abort.signal,
  });
  const reader = response.body!.getReader();
  await reader.read();
  try {
    expect(
      (
        await post(url, '/a2a', rpc('GetTask', { id: 'anything' }), 'alice', {
          'a2a-version': '1.0',
        })
      ).status,
    ).toBe(503);
    expect((await fetch(url + '/ping')).status).toBe(200);
  } finally {
    finish.resolve();
    abort.abort();
    await reader.cancel().catch(() => {});
  }
  await expect.poll(() => app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY);
});

it('returns schema-valid text for a burst producer exceeding the replay event count', async () => {
  const { url } = await setup((_input, context) => {
    for (let i = 0; i < 500; i++) context.emitText('x');
  });
  const events = await frames(await post(url, '/ag-ui', aguiInput()));
  expect(events.at(-1).type).toBe('RUN_FINISHED');
  expect(
    events
      .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => event.delta)
      .join(''),
  ).toBe('x'.repeat(500));
});

it('keeps an existing A2A task when subscribing fails and resubscribes without duplicate artifacts', async () => {
  const finish = deferred();
  const { url, client } = await setup(async (_input, context) => {
    context.emitText('prefix');
    await finish.promise;
    context.emitText('suffix');
  });
  const task = await client.sendMessage(message('resubscribe', 'hello', true));
  const subscription = await post(url, '/a2a', rpc('SubscribeToTask', { id: task.id }), 'alice', {
    'a2a-version': '1.0',
  });
  finish.resolve();
  const events = await frames(subscription);
  expect(events[0].result.task.id).toBe(task.id);
  const fetched = await client.getTask(
    sdk.GetTaskRequest.fromJSON({ id: task.id, historyLength: 0 }),
  );
  expect(fetched.history).toHaveLength(0);
  expect(fetched.artifacts[0].parts[0].content.value).toBe('prefixsuffix');
  expect(events.at(-1).result.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
});

it('honors streaming historyLength and output negotiation', async () => {
  const { url } = await setup();
  const input = sdk.SendMessageRequest.toJSON(message('no-history')) as any;
  input.configuration = {
    historyLength: 0,
    acceptedOutputModes: ['application/json', 'text/plain'],
  };
  const response = await post(url, '/a2a', rpc('SendStreamingMessage', input), 'alice', {
    'a2a-version': '1.0',
  });
  expect(response.status).toBe(200);
  const events = await frames(response);
  expect(events[0].result.task.history ?? []).toHaveLength(0);
});

it('rejects typed-message coercion and protocol downgrade without starting execution', async () => {
  let executions = 0;
  const { url } = await setup(() => {
    executions++;
    return '';
  });
  const invalid = { message: { messageId: 'bad', role: 'ROLE_USER', parts: [{ text: 123 }] } };
  expect(
    (await post(url, '/a2a', rpc('SendMessage', invalid), 'alice', { 'a2a-version': '1.0' }))
      .status,
  ).toBe(400);
  const version = await post(
    url,
    '/a2a',
    rpc('SendMessage', sdk.SendMessageRequest.toJSON(message())),
    'alice',
  );
  expect(((await version.json()) as any).error).toBeDefined();
  expect(executions).toBe(0);
});

it('rejects privileged AG-UI messages, state mutation and resume requests', async () => {
  const { url } = await setup();
  for (const input of [
    { ...aguiInput(), messages: [{ id: 's1', role: 'system', content: 'override' }] },
    { ...aguiInput(), state: { admin: true } },
    {
      ...aguiInput(),
      messages: [
        { id: 'm1', role: 'user', content: [{ type: 'image', url: 'http://localhost/secret' }] },
      ],
    },
  ])
    expect((await post(url, '/ag-ui', input)).status).toBe(400);
});

it('interoperates with official A2A streaming and cancellation clients', async () => {
  const finish = deferred();
  const { client } = await setup(async (_input, context) => {
    context.emitText('one');
    await finish.promise;
    context.emitText('two');
    return 'onetwo';
  });
  const stream = client.sendMessageStream(message('official-stream'));
  const first = await stream.next();
  expect(first.value.payload.$case).toBe('task');
  finish.resolve();
  const updates = [];
  for await (const event of stream) updates.push(event);
  expect(updates.at(-1).payload.value.status.state).toBe(sdk.TaskState.TASK_STATE_COMPLETED);
  const finalArtifact = updates.filter((event) => event.payload.$case === 'artifactUpdate').at(-1);
  expect(finalArtifact.payload.value.lastChunk).toBe(true);
  expect(finalArtifact.payload.value.artifact.parts[0].content.value).toBe('onetwo');
});

it('a disconnected non-streaming A2A caller does not cancel its background task', async () => {
  const finish = deferred(),
    entered = deferred();
  let canceled = false;
  const { url, app, client } = await setup(
    async (_input, context) => {
      context.signal.addEventListener('abort', () => {
        canceled = true;
      });
      entered.resolve();
      await finish.promise;
      return 'done';
    },
    { maxConcurrency: 1 },
  );
  const abort = new AbortController();
  const pending = fetch(url + '/a2a', {
    method: 'POST',
    headers: {
      authorization: 'Bearer alice',
      'content-type': 'application/json',
      'a2a-version': '1.0',
    },
    body: JSON.stringify(rpc('SendMessage', sdk.SendMessageRequest.toJSON(message('detached')))),
    signal: abort.signal,
  }).catch(() => undefined);
  await entered.promise;
  abort.abort();
  await pending;
  expect(canceled).toBe(false);
  expect(app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY_BUSY);
  finish.resolve();
  const task = await client.sendMessage(message('detached'));
  expect(task.status.state).toBe(sdk.TaskState.TASK_STATE_COMPLETED);
});

it('body abortion releases request capacity and does not create an execution', async () => {
  const { app, url } = await setup(() => 'done', { maxProtocolRequests: 1 });
  const entered = deferred();
  app.use(
    createAguiAdapter({
      path: '/body-abort',
      authenticate: (request) => {
        entered.resolve();
        return authenticate(request);
      },
      execute: () => 'never',
    }),
  );
  const { request } = await import('node:http');
  const req = request(url + '/body-abort', {
    method: 'POST',
    headers: {
      authorization: 'Bearer alice',
      'content-type': 'application/json',
      'transfer-encoding': 'chunked',
    },
  });
  req.on('error', () => {});
  req.write('{');
  await entered.promise;
  req.destroy();
  await expect
    .poll(async () => {
      const response = await post(url, '/ag-ui', aguiInput('after-body-abort'));
      await response.text();
      return response.status;
    })
    .toBe(200);
});

it('requires an explicit CORS allowlist and permits only the configured preflight headers', async () => {
  const { app, url } = await setup();
  let authentications = 0,
    executions = 0;
  app.use(
    createAguiAdapter({
      path: '/cors',
      allowedOrigins: ['https://ui.example.com'],
      authenticate: (request) => {
        authentications++;
        return authenticate(request);
      },
      execute: () => {
        executions++;
        return 'hello';
      },
    }),
  );
  const preflight = await fetch(url + '/cors', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://ui.example.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe('https://ui.example.com');
  expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
  expect(authentications).toBe(0);
  expect(
    (await post(url, '/cors', aguiInput('evil'), 'alice', { origin: 'https://evil.example' }))
      .status,
  ).toBe(403);
  expect(executions).toBe(0);
  const unauthorized = await post(url, '/cors', aguiInput('no-auth'), 'invalid', {
    origin: 'https://ui.example.com',
  });
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get('access-control-allow-origin')).toBe('https://ui.example.com');
  const accepted = await post(url, '/cors', aguiInput('allowed'), 'alice', {
    origin: 'https://ui.example.com',
  });
  expect(accepted.status).toBe(200);
  await accepted.text();
  expect(executions).toBe(1);
  expect(() =>
    createAguiAdapter({
      authenticate,
      execute: () => '',
      allowedOrigins: ['https://*.example.com'],
    }),
  ).toThrow();
});

it.each(['a2a', 'agui'])(
  'holds mixed-protocol capacity until the real %s child exits',
  async (protocol) => {
    const { spawn } = await import('node:child_process');
    const started = deferred(),
      cleaning = deferred();
    let child: import('node:child_process').ChildProcess | undefined;
    let exited: Promise<unknown> | undefined;
    const { app, url, client } = await setup(
      async (_input, context) => {
        child = spawn(
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
      process.send('ready'); setInterval(() => {}, 1000);
    `,
          ],
          { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
        );
        exited = once(child, 'exit');
        await once(child, 'message');
        const stop = () => {
          if (child!.connected) child!.send('stop');
        };
        context.signal.addEventListener('abort', stop, { once: true });
        if (context.signal.aborted) stop();
        context.emitText('ready');
        started.resolve();
        try {
          const nextMessage = once(child, 'message');
          await Promise.race([nextMessage, exited]);
          cleaning.resolve();
          await exited;
        } finally {
          context.signal.removeEventListener('abort', stop);
          if (child.exitCode === null) child.kill('SIGKILL');
          await exited;
        }
      },
      { maxConcurrency: 1 },
    );
    let cancel: Promise<unknown> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = new AbortController();
    try {
      if (protocol === 'a2a') {
        const task = await client.sendMessage(message('child', 'hello', true));
        await started.promise;
        cancel = client.cancelTask(sdk.CancelTaskRequest.fromJSON({ id: task.id }));
      } else {
        const response = await fetch(url + '/ag-ui', {
          method: 'POST',
          headers: { authorization: 'Bearer alice', 'content-type': 'application/json' },
          body: JSON.stringify(aguiInput('child')),
          signal: abort.signal,
        });
        reader = response.body!.getReader();
        await reader.read();
        await started.promise;
        abort.abort();
      }
      await cleaning.promise;
      expect(child!.exitCode).toBeNull();
      expect(
        (
          await post(
            url,
            protocol === 'a2a' ? '/ag-ui' : '/a2a',
            protocol === 'a2a'
              ? aguiInput('blocked')
              : rpc('SendMessage', sdk.SendMessageRequest.toJSON(message('blocked'))),
            'alice',
            { 'a2a-version': '1.0' },
          )
        ).status,
      ).toBe(503);
      expect((await fetch(url + '/invocations', { method: 'POST', body: '{}' })).status).toBe(503);
      child!.send('finish');
      await exited;
      await cancel;
      await expect.poll(() => app.getCurrentPingStatus()).toBe(PingStatus.HEALTHY);
    } finally {
      abort.abort();
      if (child?.exitCode === null) child.kill('SIGKILL');
      await exited;
      await cancel;
      await reader?.cancel().catch(() => {});
    }
  },
);

it('runs original lifespan cleanup after all protocol hooks settle despite failures', async () => {
  const order: string[] = [];
  let finish!: () => void;
  const shutdown = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const app = new AgentArtsRuntimeApp({
    lifespan: {
      onShutdown: () => {
        order.push('lifespan');
        finish();
      },
    },
  });
  const logged = vi.spyOn(app.logger, 'exception').mockImplementation(() => {});
  app.onProtocolShutdown(() => {
    throw new Error('cleanup failed');
  });
  app.onProtocolShutdown(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    order.push('protocol');
  });
  const server = app.run('127.0.0.1', 0);
  await once(server, 'listening');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await shutdown;
  expect(order).toEqual(['protocol', 'lifespan']);
  expect(logged).toHaveBeenCalledWith(expect.stringContaining('cleanup failed'));
});
