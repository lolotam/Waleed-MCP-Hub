import { afterEach, expect, it } from 'vitest';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import {
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import {
  MANAGED_BRIDGE_CAPABILITIES,
  ManagedBridgeCapabilitiesSchema,
} from '@waleed/contracts';
import { definitionHash } from '@waleed/hub-core';
import { contentFixture, deferred } from './helpers/bridge-content.js';
const fixtures: Awaited<ReturnType<typeof contentFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function setup(count = 2) {
  const f = await contentFixture(count);
  fixtures.push(f);
  return f;
}
it('advertises resources/prompts with list-change support and subscriptions disabled', async () => {
  const f = await setup();
  expect(f.agent.getServerCapabilities()).toEqual(MANAGED_BRIDGE_CAPABILITIES);
  expect(
    ManagedBridgeCapabilitiesSchema.safeParse({
      ...MANAGED_BRIDGE_CAPABILITIES,
      resources: { subscribe: true, listChanged: true },
    }).success,
  ).toBe(false);
  expect(f.starts).toEqual([]);
});
it('namespaces identical upstream resource URIs and routes reads to the owning connector', async () => {
  const f = await setup(),
    catalog = await f.agent.listResources();
  expect(catalog.resources).toHaveLength(2);
  expect(new Set(catalog.resources.map((resource) => resource.uri)).size).toBe(
    2,
  );
  for (const [index, resource] of catalog.resources.entries()) {
    expect(resource.uri).toMatch(/^wmh-resource:\/\/r-/);
    expect(resource.uri).not.toContain('fixture://');
    const result = await f.agent.readResource({ uri: resource.uri });
    expect(result.contents[0]).toMatchObject({
      uri: resource.uri,
      text: expect.stringContaining(
        `connector-${index} resource fixture://same`,
      ),
    });
  }
  expect(
    f.requests
      .filter((request) => request.method === 'resources/read')
      .map((request) => request.connectorId),
  ).toEqual(['connector-0', 'connector-1']);
  expect(f.bridge.requestLog.records()).toEqual([]);
});
it('exposes opaque variable-bearing templates and forwards decoded expansions, not Hub URIs', async () => {
  const f = await setup(),
    catalog = await f.agent.listResourceTemplates();
  expect(catalog.resourceTemplates).toHaveLength(2);
  for (const template of catalog.resourceTemplates) {
    expect(template.uriTemplate).not.toContain('fixture://');
    const uri = new UriTemplate(template.uriTemplate).expand({
        key: 'hello world',
        format: 'json',
      }),
      result = await f.agent.readResource({ uri });
    expect(result.contents[0]!.uri).toBe(uri);
  }
  expect(
    f.requests
      .filter((request) => request.method === 'resources/read')
      .map((request) => (request.params as { uri: string }).uri),
  ).toEqual([
    'fixture://files/hello%20world?format=json',
    'fixture://files/hello%20world?format=json',
  ]);
});
it('disambiguates duplicate prompt names, preserves argument metadata and forwards exact arguments once', async () => {
  const f = await setup(),
    catalog = await f.agent.listPrompts();
  expect(catalog.prompts).toHaveLength(2);
  expect(new Set(catalog.prompts.map((prompt) => prompt.name)).size).toBe(2);
  for (const [index, prompt] of catalog.prompts.entries()) {
    expect(prompt.name).toMatch(new RegExp(`^connector-${index}__`));
    expect(prompt.arguments).toEqual([{ name: 'topic', required: true }]);
    expect(
      (
        await f.agent.getPrompt({
          name: prompt.name,
          arguments: { topic: 'SYNTHETIC-PRIVATE-PROMPT-ARG' },
        })
      ).messages[0]!.content,
    ).toMatchObject({
      type: 'text',
      text: expect.stringContaining('SYNTHETIC-PRIVATE-PROMPT-ARG'),
    });
  }
  expect(
    f.requests
      .filter((request) => request.method === 'prompts/get')
      .map((request) => request.params),
  ).toEqual([
    { name: 'summarize', arguments: { topic: 'SYNTHETIC-PRIVATE-PROMPT-ARG' } },
    { name: 'summarize', arguments: { topic: 'SYNTHETIC-PRIVATE-PROMPT-ARG' } },
  ]);
  expect(f.bridge.requestLog.records()).toEqual([]);
});
it('supports names requiring normalization without routing by guessed raw names', async () => {
  const f = await setup(1);
  f.definitions[0]!.prompts = [{ name: 'Summarize these docs / عربي' }];
  const prompt = (await f.agent.listPrompts()).prompts[0]!;
  expect(prompt.name.length).toBeLessThanOrEqual(40);
  await f.agent.getPrompt({ name: prompt.name });
  await expect(
    f.agent.getPrompt({ name: 'Summarize these docs / عربي' }),
  ).rejects.toThrow('unknown, stale');
});
it('strictly isolates two agents for resources, templates and prompts, including exchanged handles', async () => {
  const f = await setup();
  f.state.profiles[0]!.connectorIds = ['connector-0'];
  f.state.profiles.push({
    ...f.state.profiles[0]!,
    id: 'other',
    connectorIds: ['connector-1'],
  });
  f.state.agentProfileBindings = { cursor: 'profile', codex: 'other' };
  const codex = await f.launch('codex'),
    a = await f.agent.listResources(),
    b = await codex.agent.listResources(),
    ap = await f.agent.listPrompts(),
    bp = await codex.agent.listPrompts();
  expect(a.resources.map((item) => item.name)).toEqual(['document-0']);
  expect(b.resources.map((item) => item.name)).toEqual(['document-1']);
  expect(
    (await f.agent.listResourceTemplates()).resourceTemplates.map(
      (item) => item.name,
    ),
  ).toEqual(['template-0']);
  expect(
    (await codex.agent.listResourceTemplates()).resourceTemplates.map(
      (item) => item.name,
    ),
  ).toEqual(['template-1']);
  await expect(
    f.agent.readResource({ uri: b.resources[0]!.uri }),
  ).rejects.toThrow();
  await expect(
    codex.agent.getPrompt({ name: ap.prompts[0]!.name }),
  ).rejects.toThrow();
  await f.agent.getPrompt({ name: ap.prompts[0]!.name });
  await codex.agent.getPrompt({ name: bp.prompts[0]!.name });
  expect(
    f.requests
      .filter((request) => request.method === 'prompts/get')
      .map((request) => request.connectorId),
  ).toEqual(['connector-0', 'connector-1']);
});
it.each(['disabled', 'empty', 'missing'] as const)(
  'exposes no resources or prompts for a %s assigned profile',
  async (mode) => {
    const f = await setup(1);
    f.state.agentProfileBindings = {
      cursor: mode === 'missing' ? 'missing' : 'profile',
    };
    if (mode === 'disabled') f.state.profiles[0]!.enabled = false;
    if (mode === 'empty') f.state.profiles[0]!.connectorIds = [];
    expect((await f.agent.listResources()).resources).toEqual([]);
    expect((await f.agent.listPrompts()).prompts).toEqual([]);
    expect((await f.agent.listResourceTemplates()).resourceTemplates).toEqual(
      [],
    );
    expect(f.starts).toEqual([]);
  },
);
it.each(['disable', 'scope', 'definition', 'approval'] as const)(
  'refuses cached resource, template and prompt handles after %s changes',
  async (mode) => {
    const f = await setup(1),
      resource = (await f.agent.listResources()).resources[0]!,
      template = (await f.agent.listResourceTemplates()).resourceTemplates[0]!,
      prompt = (await f.agent.listPrompts()).prompts[0]!,
      before = f.requests.length;
    if (mode === 'disable') f.state.connectors[0]!.enabled = false;
    if (mode === 'scope') {
      f.state.agentProfileBindings = { cursor: 'profile' };
      f.state.profiles[0]!.connectorIds = [];
    }
    if (mode === 'definition') {
      f.state.connectors[0]!.revision++;
      f.state.connectors[0]!.trustApproval!.revision++;
      f.state.connectors[0]!.trustApproval!.definitionHash = definitionHash(
        f.state.connectors[0]!,
      );
    }
    if (mode === 'approval') f.state.connectors[0]!.trustApproval = null;
    await expect(f.agent.readResource({ uri: resource.uri })).rejects.toThrow();
    await expect(
      f.agent.readResource({
        uri: new UriTemplate(template.uriTemplate).expand({ key: 'work' }),
      }),
    ).rejects.toThrow();
    await expect(f.agent.getPrompt({ name: prompt.name })).rejects.toThrow();
    expect(f.requests.length).toBe(before);
  },
);
it('omits unsupported and failing providers without losing healthy connector catalogs or leaking errors', async () => {
  const f = await setup(3);
  f.definitions[0]!.capabilities = {};
  f.definitions[1]!.errors = new Set([
    'resources/list',
    'resources/templates/list',
    'prompts/list',
  ]);
  for (const result of [
    await f.agent.listResources(),
    await f.agent.listResourceTemplates(),
    await f.agent.listPrompts(),
  ])
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC-PRIVATE');
  expect(
    (await f.agent.listResources()).resources.map((item) => item.name),
  ).toEqual(['document-2']);
  expect((await f.agent.listPrompts()).prompts).toHaveLength(1);
});
it('does not leak known credentials in catalog URIs, template literals or prompt descriptions', async () => {
  const f = await setup(1),
    definition = f.definitions[0]!,
    secret = 'SYNTHETIC-PROTECTED-CONTENT-CREDENTIAL';
  definition.secret = secret;
  definition.resources[0]!.uri = `fixture://${secret}`;
  definition.templates[0]!.uriTemplate = `fixture://${secret}/{key}`;
  definition.prompts[0]!.description = secret;
  for (const value of [
    await f.agent.listResources(),
    await f.agent.listResourceTemplates(),
    await f.agent.listPrompts(),
  ])
    expect(JSON.stringify(value)).not.toContain(secret);
  expect((await f.agent.listResources()).resources).toEqual([]);
});
it('withholds text and binary resource credential echoes and provider errors', async () => {
  const f = await setup(1),
    definition = f.definitions[0]!,
    secret = 'SYNTHETIC-PROTECTED-CONTENT-CREDENTIAL';
  definition.secret = secret;
  const uri = (await f.agent.listResources()).resources[0]!.uri;
  for (const contents of [
    [{ uri: 'fixture://same', text: secret }],
    [
      {
        uri: 'fixture://same',
        blob: Buffer.from(`x${secret} trailing`).toString('base64'),
      },
    ],
  ]) {
    definition.result = { contents };
    await expect(f.agent.readResource({ uri })).rejects.not.toThrow(secret);
  }
  definition.errors.add('resources/read');
  await expect(f.agent.readResource({ uri })).rejects.not.toThrow(
    'SYNTHETIC-PRIVATE-PROVIDER-ERROR',
  );
});
it('withholds prompt credential echoes, including embedded binary content and images', async () => {
  const f = await setup(1),
    definition = f.definitions[0]!,
    secret = 'SYNTHETIC-PROTECTED-CONTENT-CREDENTIAL';
  definition.secret = secret;
  const name = (await f.agent.listPrompts()).prompts[0]!.name;
  for (const content of [
    { type: 'text' as const, text: secret },
    {
      type: 'resource' as const,
      resource: {
        uri: 'fixture://same',
        blob: Buffer.from(`x${secret} trailing`).toString('base64'),
      },
    },
    {
      type: 'image' as const,
      mimeType: 'image/png',
      data: Buffer.from(`x${secret} trailing`).toString('base64'),
    },
  ]) {
    definition.promptResult = { messages: [{ role: 'user', content }] };
    await expect(f.agent.getPrompt({ name })).rejects.not.toThrow(secret);
  }
});
it('rewrites embedded prompt resource URIs and resource links to owning connector handles', async () => {
  const f = await setup(1);
  f.definitions[0]!.promptResult = {
    messages: [
      {
        role: 'user',
        content: {
          type: 'resource',
          resource: { uri: 'fixture://embedded', text: 'embedded' },
        },
      },
      {
        role: 'assistant',
        content: {
          type: 'resource_link',
          uri: 'fixture://linked',
          name: 'link',
        },
      },
    ],
  };
  const name = (await f.agent.listPrompts()).prompts[0]!.name,
    result = await f.agent.getPrompt({ name });
  for (const message of result.messages) {
    const uri =
      message.content.type === 'resource'
        ? message.content.resource.uri
        : message.content.type === 'resource_link'
          ? message.content.uri
          : '';
    expect(uri).toMatch(/^wmh-resource:\/\/r-/);
    await f.agent.readResource({ uri });
  }
  expect(
    f.requests
      .filter((request) => request.method === 'resources/read')
      .map((request) => (request.params as { uri: string }).uri),
  ).toEqual(['fixture://embedded', 'fixture://linked']);
});
it('rejects unknown resource URIs, forged templates, extra/duplicate variables and raw upstream prompt names', async () => {
  const f = await setup(1),
    template = (await f.agent.listResourceTemplates()).resourceTemplates[0]!,
    uri = new UriTemplate(template.uriTemplate).expand({ key: 'work' });
  for (const value of [
    'fixture://same',
    uri + '&unknown=evil',
    uri + '&key=other',
    uri + '#bad',
    uri.replace('/?', '/other?'),
  ])
    await expect(f.agent.readResource({ uri: value })).rejects.toThrow();
  await expect(f.agent.getPrompt({ name: 'summarize' })).rejects.toThrow();
  expect(
    f.requests.filter(
      (request) =>
        request.method === 'resources/read' || request.method === 'prompts/get',
    ),
  ).toEqual([]);
});
it('rejects arbitrary Hub cursors rather than forwarding caller data upstream', async () => {
  const f = await setup(1);
  await expect(
    f.agent.listResources({ cursor: 'SYNTHETIC-PRIVATE-CURSOR' }),
  ).rejects.not.toThrow('SYNTHETIC-PRIVATE-CURSOR');
  expect(f.starts).toEqual([]);
});
it('expires routes removed by a fresh catalog, without reusing a handle for another connector', async () => {
  const f = await setup(),
    resource = (await f.agent.listResources()).resources[0]!,
    prompt = (await f.agent.listPrompts()).prompts[0]!;
  f.definitions[0]!.resources = [];
  f.definitions[0]!.prompts = [];
  const resources = await f.agent.listResources(),
    prompts = await f.agent.listPrompts();
  expect(resources.resources).toHaveLength(1);
  expect(prompts.prompts).toHaveLength(1);
  await expect(f.agent.readResource({ uri: resource.uri })).rejects.toThrow();
  await expect(f.agent.getPrompt({ name: prompt.name })).rejects.toThrow();
  expect(resources.resources[0]!.uri).not.toBe(resource.uri);
});
it.each(['resources', 'prompts'] as const)(
  'rechecks scope after %s discovery I/O before returning metadata',
  async (kind) => {
    const f = await setup(1);
    f.definitions[0]!.listGate = deferred();
    const result =
      kind === 'resources' ? f.agent.listResources() : f.agent.listPrompts();
    await expect.poll(() => f.requests.length).toBe(1);
    f.state.agentProfileBindings = { cursor: 'profile' };
    f.state.profiles[0]!.connectorIds = [];
    f.definitions[0]!.listGate.resolve();
    const response = await result;
    expect(
      'resources' in response ? response.resources : response.prompts,
    ).toEqual([]);
  },
);
it.each(['resources', 'prompts'] as const)(
  'withholds in-flight %s content after reassignment',
  async (kind) => {
    const f = await setup(1),
      resource = (await f.agent.listResources()).resources[0]!,
      prompt = (await f.agent.listPrompts()).prompts[0]!;
    f.definitions[0]!.gate = deferred();
    const result =
      kind === 'resources'
        ? f.agent.readResource({ uri: resource.uri })
        : f.agent.getPrompt({ name: prompt.name });
    const checked = expect(result).rejects.toThrow();
    await expect
      .poll(
        () =>
          f.requests.filter(
            (request) =>
              request.method === 'resources/read' ||
              request.method === 'prompts/get',
          ).length,
      )
      .toBe(1);
    f.state.agentProfileBindings = { cursor: 'profile' };
    f.state.profiles[0]!.connectorIds = [];
    f.definitions[0]!.gate.resolve();
    await checked;
  },
);
it('rechecks queued reads before dispatch, and never starts outside the new assignment', async () => {
  const f = await setup(1),
    resource = (await f.agent.listResources()).resources[0]!;
  f.definitions[0]!.gate = deferred();
  const first = f.agent.readResource({ uri: resource.uri }),
    firstCheck = expect(first).rejects.toThrow();
  await expect
    .poll(
      () =>
        f.requests.filter((request) => request.method === 'resources/read')
          .length,
    )
    .toBe(1);
  const second = f.agent.readResource({ uri: resource.uri }),
    secondCheck = expect(second).rejects.toThrow();
  f.state.agentProfileBindings = { cursor: 'profile' };
  f.state.profiles[0]!.connectorIds = [];
  f.definitions[0]!.gate.resolve();
  await Promise.all([firstCheck, secondCheck]);
  expect(
    f.requests.filter((request) => request.method === 'resources/read'),
  ).toHaveLength(1);
});
it('sends static list-change notifications, invalidates routes, and drops notices from out-of-scope peers', async () => {
  const f = await setup(1);
  let resources = 0,
    prompts = 0;
  f.agent.setNotificationHandler(
    ResourceListChangedNotificationSchema,
    async () => {
      resources++;
    },
  );
  f.agent.setNotificationHandler(
    PromptListChangedNotificationSchema,
    async () => {
      prompts++;
    },
  );
  const resource = (await f.agent.listResources()).resources[0]!,
    prompt = (await f.agent.listPrompts()).prompts[0]!;
  await f.servers[0]!.sendResourceListChanged();
  await f.servers[0]!.sendPromptListChanged();
  await expect.poll(() => [resources, prompts]).toEqual([1, 1]);
  await expect(f.agent.readResource({ uri: resource.uri })).rejects.toThrow();
  await expect(f.agent.getPrompt({ name: prompt.name })).rejects.toThrow();
  f.state.agentProfileBindings = { cursor: 'profile' };
  f.state.profiles[0]!.connectorIds = [];
  await f.servers[0]!.sendResourceListChanged();
  await f.servers[0]!.sendPromptListChanged();
  await new Promise<void>((r) => setTimeout(r, 20));
  expect([resources, prompts]).toEqual([1, 1]);
});
it('invalidates both catalogs and emits list-change notices on Hub refresh', async () => {
  const f = await setup(1);
  let resources = 0,
    prompts = 0;
  f.agent.setNotificationHandler(
    ResourceListChangedNotificationSchema,
    async () => {
      resources++;
    },
  );
  f.agent.setNotificationHandler(
    PromptListChangedNotificationSchema,
    async () => {
      prompts++;
    },
  );
  const uri = (await f.agent.listResources()).resources[0]!.uri;
  await f.agent.listPrompts();
  await f.bridge.refresh();
  await expect.poll(() => [resources, prompts]).toEqual([1, 1]);
  await expect(f.agent.readResource({ uri })).rejects.toThrow();
});
it('bounds list sizes and repeated pagination and marks partial catalogs explicitly', async () => {
  const f = await setup(1);
  f.definitions[0]!.resources = Array.from({ length: 300 }, (_, index) => ({
    name: `resource-${index}`,
    uri: `fixture://resource/${index}`,
  }));
  const result = await f.agent.listResources();
  expect(result.resources).toHaveLength(256);
  expect(result._meta).toMatchObject({ 'wmh/truncated': true });
  f.definitions[0]!.resources = [{ name: 'resource', uri: 'fixture://one' }];
  f.definitions[0]!.cursor = true;
  const repeated = await f.agent.listResources();
  expect(repeated._meta).toMatchObject({ 'wmh/truncated': true });
  expect(repeated.resources).toHaveLength(1);
});
it('sanitizes registry failures and never exposes provider exceptions from get/read', async () => {
  const f = await setup(1),
    uri = (await f.agent.listResources()).resources[0]!.uri;
  f.failRead();
  await expect(f.agent.listResources()).rejects.not.toThrow(
    'SYNTHETIC-PRIVATE-REGISTRY',
  );
  await expect(f.agent.readResource({ uri })).rejects.not.toThrow(
    'SYNTHETIC-PRIVATE-REGISTRY',
  );
});
it('keeps subscription requests disabled even when sent directly past client capability checks', async () => {
  const f = await setup(1),
    transport = f.agent.transport!,
    original = transport.onmessage;
  const result = new Promise<unknown>((resolve) => {
    transport.onmessage = (message) => {
      if ('id' in message && message.id === 987654) {
        resolve(message);
        return;
      }
      original?.(message);
    };
  });
  await transport.send({
    jsonrpc: '2.0',
    id: 987654,
    method: 'resources/subscribe',
    params: { uri: 'SYNTHETIC-PRIVATE-URI' },
  });
  const response = await result;
  transport.onmessage = original;
  expect(response).toMatchObject({
    error: {
      code: -32601,
      message: expect.stringContaining(
        'Hub resource subscriptions are not supported.',
      ),
    },
  });
  expect(JSON.stringify(response)).not.toContain('SYNTHETIC-PRIVATE-URI');
  expect(f.starts).toEqual([]);
});
it('never trusts provider-spoofed Hub errors or forwards their private data', async () => {
  const f = await setup(1),
    uri = (await f.agent.listResources()).resources[0]!.uri,
    name = (await f.agent.listPrompts()).prompts[0]!.name;
  const error = new McpError(ErrorCode.InvalidParams, 'placeholder', {
    token: 'SYNTHETIC-PRIVATE-ERROR-DATA',
  });
  error.message =
    'The Hub resource or prompt handle is unknown, stale, or outside the current tool set. Refresh its catalog.';
  f.definitions[0]!.providerError = error;
  f.definitions[0]!.errors = new Set(['resources/read', 'prompts/get']);
  for (const invoke of [
    () => f.agent.readResource({ uri }),
    () => f.agent.getPrompt({ name }),
  ]) {
    try {
      await invoke();
      throw new Error('Expected refusal.');
    } catch (caught) {
      expect(caught).toBeInstanceOf(McpError);
      expect(JSON.stringify(caught)).not.toContain(
        'SYNTHETIC-PRIVATE-ERROR-DATA',
      );
      expect((caught as Error).message).toContain('content was withheld');
    }
  }
});
it('isolates method-not-found errors when an upstream advertises resources without implementing templates', async () => {
  const f = await setup(1);
  await f.agent.listResources();
  f.servers[0]!.removeRequestHandler('resources/templates/list');
  expect((await f.agent.listResourceTemplates()).resourceTemplates).toEqual([]);
  expect((await f.agent.listPrompts()).prompts).toHaveLength(1);
});
it('rechecks scope after peer startup, before issuing a resource read', async () => {
  const f = await setup(1),
    uri = (await f.agent.listResources()).resources[0]!.uri;
  const { agent } = await f.launch('codex');
  await agent.listResources();
  // Expire the first pool without changing the route grant; the next read must
  // still check scope after it has waited for the replacement peer to start.
  await f.servers[0]!.close();
  await new Promise<void>((r) => setImmediate(r));
  f.definitions[0]!.startupGate = deferred();
  const next = f.agent.readResource({ uri }),
    refusal = expect(next).rejects.toThrow();
  await expect.poll(() => f.starts.length).toBe(3);
  f.state.agentProfileBindings = { cursor: 'profile' };
  f.state.profiles[0]!.connectorIds = [];
  f.definitions[0]!.startupGate.resolve();
  await refusal;
  expect(
    f.requests.filter((request) => request.method === 'resources/read'),
  ).toHaveLength(0);
});
