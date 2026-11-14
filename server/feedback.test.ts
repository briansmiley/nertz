import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReport } from './feedback';
import { startServer, type NertzServer } from './index';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
let server: NertzServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  server = dir = undefined;
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
    server = await startServer({ port: 0, feedback: { dir, webhook: 'https://discord.invalid/hook', fetch: (async (_url: unknown, init?: RequestInit) => (sent.push(init!.body as FormData), new Response(null, { status: 204 }))) as typeof fetch } });
    const send = (body: unknown) => real(`http://localhost:${server!.port}/feedback`, { method: 'POST', body: JSON.stringify(body) });

    const res = await send({ kind: 'bug', text: 'the ace made a noise @everyone', name: 'Sam', room: 'ABCD', image: PNG });
    expect(res.status).toBe(200);
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
    server = await startServer({ port: 0, feedback: { dir: '', webhook: 'https://discord.invalid/hook', linear: { key: 'lin_api_x', team: 'nrz', priority: 2, assignee: 'me', state: 'Todo', project: 'No such project' }, fetch: fake } });
    const send = (body: unknown) => real(`http://localhost:${server!.port}/feedback`, { method: 'POST', body: JSON.stringify(body) });

    expect((await send({ kind: 'idea', text: 'a ready button\nwould be nice', name: 'Sam', image: PNG })).status).toBe(200);
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
    expect(told.embeds[0]).toMatchObject({ title: '💡 Feature request · NRZ-7', url: 'https://linear.invalid/NRZ-7' });

    // The team and its labels are looked up once: a second report (a bug) uses the workspace's label, and asks only to file and to tell.
    const before = calls.length;
    expect((await send({ kind: 'bug', text: 'it broke' })).status).toBe(200);
    expect(calls.length).toBe(before + 2);
    expect((calls.find((c, i) => i >= before && c.url.includes('linear.app'))!.body as typeof issue).variables.input.labelIds).toEqual(['bug1']);
  });
});
