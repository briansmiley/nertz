import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReport } from './feedback';
import { startServer, type NertzServer } from './index';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
let server: NertzServer | undefined;
/** Reports delivered so far, for a test to wait on: the sender is answered before delivery. */
let delivered = 0;
const onDelivered = (): void => void delivered++;
const settled = async (n: number): Promise<void> => {
  for (let i = 0; i < 200 && delivered < n; i++) await new Promise((r) => setTimeout(r, 5));
  expect(delivered).toBe(n);
};
let dir: string | undefined;
afterEach(async () => {
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  server = dir = undefined;
  delivered = 0;
});

describe('feedback', () => {
  it('reads a report, and refuses what is not one', () => {
    expect(parseReport(JSON.stringify({ kind: 'bug', text: ' it broke ', name: 'Sam', room: 'ABCD' }))).toEqual({ kind: 'bug', text: 'it broke', name: 'Sam', room: 'ABCD' });
    expect(parseReport(JSON.stringify({ kind: 'idea', text: 'x', image: PNG }))?.image?.type).toBe('png');
    expect(parseReport(JSON.stringify({ kind: 'bug', text: '   ' }))).toBeNull();
    expect(parseReport(JSON.stringify({ kind: 'rant', text: 'x' }))).toBeNull();
    expect(parseReport(JSON.stringify({ kind: 'bug', text: 'x', image: 'data:text/html;base64,AAAA' }))).toBeNull();
    expect(parseReport('nope')).toBeNull();
  });

  it('a report posted to /feedback is kept on disk and sent to the webhook, screenshot and all; then the address is slowed down', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nertz-feedback-'));
    const sent: FormData[] = [];
    const real = fetch;
    server = await startServer({ port: 0, feedback: { dir, webhook: 'https://discord.invalid/hook', anthropic: '', onDelivered, fetch: (async (_url: unknown, init?: RequestInit) => (sent.push(init!.body as FormData), new Response(null, { status: 204 }))) as typeof fetch } });
    const send = (body: unknown) => real(`http://localhost:${server!.port}/feedback`, { method: 'POST', body: JSON.stringify(body) });

    const res = await send({ kind: 'bug', text: 'the ace made a noise @everyone', name: 'Sam', room: 'ABCD', image: PNG });
    expect(res.status).toBe(200);
    await settled(1);
    const line = JSON.parse(readFileSync(join(dir, 'feedback.jsonl'), 'utf8').trim()) as Record<string, string>;
    expect(line).toMatchObject({ kind: 'bug', text: 'the ace made a noise @everyone', name: 'Sam', room: 'ABCD' });
    expect(readdirSync(dir)).toContain(line.image);
    const payload = JSON.parse(sent[0]!.get('payload_json') as string) as { allowed_mentions: unknown; embeds: { description: string }[] };
    expect(payload.embeds[0]!.description).toContain('the ace');
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(sent[0]!.get('files[0]')).toBeInstanceOf(Blob);

    expect((await send({ kind: 'bug' })).status).toBe(400);
    expect((await real(`http://localhost:${server.port}/feedback`)).status).toBe(405);
    for (let i = 0; i < 8; i++) await send({ kind: 'idea', text: 'more' });
    expect((await send({ kind: 'idea', text: 'more' })).status).toBe(429);
    await settled(4); // (the three that got through, delivered after they were answered)
  });

  it('files a Linear issue too: [FEEDBACK] in the title, the Bug or Feature label (made if the team has none), the screenshot uploaded', async () => {
    const calls: { url: string; body: unknown; method?: string }[] = [];
    const fake = (async (url: unknown, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { query: string; variables: Record<string, unknown> }) : init?.body;
      calls.push({ url: String(url), body, method: init?.method });
        if (String(url) === 'https://discord.invalid/hook') return new Response(null, { status: 204 });
      if (String(url) !== 'https://api.linear.app/graphql') return new Response(null, { status: 200 }); // the upload
      const q = (body as { query: string }).query;
      const data = q.includes('viewer') ? { viewer: { id: 'me1' } } : q.includes('workflowStates') ? { workflowStates: { nodes: [{ id: 'todo1' }] } } : q.includes('projects(') ? { projects: { nodes: [] } } : q.includes('teams(') ? { teams: { nodes: [{ id: 'team1' }] } } : q.includes('issueLabels(') ? { issueLabels: { nodes: [{ id: 'bug1', name: 'bug', team: null }, { id: 'other', name: 'Feature', team: { id: 'team2' } }] } } : q.includes('issueLabelCreate') ? { issueLabelCreate: { issueLabel: { id: 'feat1' } } } : q.includes('fileUpload') ? { fileUpload: { uploadFile: { uploadUrl: 'https://upload.invalid/x', assetUrl: 'https://asset.invalid/x.png', headers: [{ key: 'x-h', value: '1' }] } } } : { issueCreate: { issue: { identifier: 'NRZ-7', url: 'https://linear.invalid/NRZ-7' } } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof fetch;
    const real = fetch;
    server = await startServer({ port: 0, feedback: { dir: '', webhook: 'https://discord.invalid/hook', linear: { key: 'lin_api_x', team: 'nrz', priority: 2, assignee: 'me', state: 'Todo', project: 'No such project' }, anthropic: '', onDelivered, fetch: fake } });
    const send = (body: unknown) => real(`http://localhost:${server!.port}/feedback`, { method: 'POST', body: JSON.stringify(body) });

    expect((await send({ kind: 'idea', text: 'a ready button\nwould be nice', name: 'Sam', image: PNG })).status).toBe(200);
    await settled(1);
    const issue = calls.find((c) => (c.body as { query?: string })?.query?.includes('issueCreate'))!.body as { variables: { input: { title: string; description: string; labelIds: string[]; teamId: string } } };
    expect(issue.variables.input).toMatchObject({ teamId: 'team1', title: '[FEEDBACK] a ready button', labelIds: ['feat1'] });
    // Priority, assignee and status as the server was told; a project nobody has is left out, and the issue is filed all the same.
    expect(issue.variables.input).toMatchObject({ priority: 2, assigneeId: 'me1', stateId: 'todo1' });
    expect(issue.variables.input).not.toHaveProperty('projectId');
    expect(issue.variables.input.description).toContain('> a ready button\n> would be nice');
    expect(issue.variables.input.description).toContain('![screenshot](https://asset.invalid/x.png)');
    expect(calls.some((c) => c.url === 'https://upload.invalid/x' && c.method === 'PUT')).toBe(true);

    // Discord is told afterwards, and its message links the issue.
    const told = JSON.parse((calls.find((c) => c.url === 'https://discord.invalid/hook')!.body as FormData).get('payload_json') as string) as { embeds: { title: string; url: string }[] };
    expect(told.embeds[0]).toMatchObject({ title: '💡 a ready button · NRZ-7', url: 'https://linear.invalid/NRZ-7' });

    // The team and its labels are looked up once: a second report (a bug) uses the workspace's label, and asks only to file and to tell.
    const before = calls.length;
    expect((await send({ kind: 'bug', text: 'it broke' })).status).toBe(200);
    await settled(2);
    expect(calls.length).toBe(before + 2);
    expect((calls.find((c, i) => i >= before && c.url.includes('linear.app'))!.body as typeof issue).variables.input.labelIds).toEqual(['bug1']);
  });

  it('with an Anthropic key, Claude names the report and sets its priority; if Claude fails, the report goes on unnamed', async () => {
    const calls: { url: string; body: unknown }[] = [];
    let claudeAnswers: 'named' | 'broken' = 'named';
    const fake = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      calls.push({ url: u, body });
      if (u.startsWith('https://api.anthropic.com/')) {
        if (claudeAnswers === 'broken') return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'no' } }), { status: 400, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify({ title: 'Ace  will not drop on a foundation', priority: 2 }) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u === 'https://discord.invalid/hook') return new Response(null, { status: 204 });
      const q = (body as { query: string }).query;
      const data = q.includes('teams(') ? { teams: { nodes: [{ id: 'team1' }] } } : q.includes('issueLabels(') ? { issueLabels: { nodes: [{ id: 'bug1', name: 'Bug', team: null }, { id: 'feat1', name: 'Feature', team: null }] } } : { issueCreate: { issue: { identifier: 'NRZ-8', url: 'https://linear.invalid/NRZ-8' } } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof fetch;
    const real = fetch;
    server = await startServer({ port: 0, feedback: { dir: '', webhook: 'https://discord.invalid/hook', linear: { key: 'lin_api_x', team: 'nrz', priority: 3 }, anthropic: 'sk-ant-test', onDelivered, fetch: fake } });
    const send = (body: unknown) => real(`http://localhost:${server!.port}/feedback`, { method: 'POST', body: JSON.stringify(body) });
    const filed = () => (calls.filter((c) => (c.body as { query?: string })?.query?.includes('issueCreate')).at(-1)!.body as { variables: { input: { title: string; priority: number; description: string } } }).variables.input;
    const told = () => (JSON.parse((calls.filter((c) => c.url === 'https://discord.invalid/hook').at(-1)!.body as FormData).get('payload_json') as string) as { embeds: { title: string; description: string }[] }).embeds[0]!;

    expect((await send({ kind: 'bug', text: 'so i was playing and then the ace i tried to put down just would not go anywhere??', context: 'table, 1280x800' })).status).toBe(200);
    await settled(1);
    const asked = calls.find((c) => c.url.startsWith('https://api.anthropic.com/'))!.body as { model: string; messages: { content: string }[]; output_config: { format: { type: string } } };
    expect(asked.model).toBe('claude-haiku-5-5');
    expect(asked.output_config.format.type).toBe('json_schema');
    expect(asked.messages[0]!.content).toContain('<report>\nso i was playing');
    expect(filed()).toMatchObject({ title: '[FEEDBACK] Ace will not drop on a foundation', priority: 2 });
    expect(filed().description).toContain('> so i was playing');
    expect(told().title).toBe('🐞 Ace will not drop on a foundation · NRZ-8');
    expect(told().description).toContain('so i was playing');

    claudeAnswers = 'broken';
    expect((await send({ kind: 'idea', text: 'a ready button\nplease' })).status).toBe(200);
    await settled(2);
    expect(filed()).toMatchObject({ title: '[FEEDBACK] a ready button', priority: 3 });
    expect(told().title).toBe('💡 a ready button · NRZ-8');
  });
});
