import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseReport } from './feedback';
import { startServer, type NertzServer } from './index';
import { openDb } from './db';
import { imageFile, openReports } from './reports';
import { ACCOUNTS, ADA, Browser, fakeGoogle, rows } from './testkit';

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
let server: NertzServer | undefined;
/** Reports delivered so far, for a test to wait on: the sender is answered before delivery. */
let delivered = 0;
const onDelivered = (): void => void delivered++;
const settled = async (n: number): Promise<void> => {
  for (let i = 0; i < 200 && delivered < n; i++) await new Promise((r) => setTimeout(r, 5));
  expect(delivered).toBe(n);
};
let dir: string | undefined;
/** The reports kept, read from beside the server. */
const kept = (): Record<string, unknown>[] => rows(join(dir!, 'nertz.db'), 'report');
afterEach(async () => {
  vi.unstubAllGlobals();
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  server = dir = undefined;
  delivered = 0;
});

describe('feedback', () => {
  it('reads a report, and refuses what is not one', () => {
    expect(parseReport(JSON.stringify({ kind: 'bug', text: ' it broke ', name: 'Sam', room: 'ABCD' }))).toEqual({ kind: 'bug', text: 'it broke', name: 'Sam', room: 'ABCD' });
    expect(parseReport(JSON.stringify({ kind: 'idea', text: 'x', image: JPEG }))?.image?.toString('base64')).toBe(JPEG.split(',')[1]);
    // Only a JPEG: what the bug button makes of any picture.
    expect(parseReport(JSON.stringify({ kind: 'idea', text: 'x', image: 'data:image/png;base64,iVBORw0KGgo=' }))).toBeNull();
    expect(parseReport(JSON.stringify({ kind: 'bug', text: '   ' }))).toBeNull();
    expect(parseReport(JSON.stringify({ kind: 'rant', text: 'x' }))).toBeNull();
    expect(parseReport(JSON.stringify({ kind: 'bug', text: 'x', image: 'data:text/html;base64,AAAA' }))).toBeNull();
    expect(parseReport('nope')).toBeNull();
  });

  it('a report posted to /feedback is kept and sent to the webhook, screenshot and all; then the address is slowed down', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nertz-feedback-'));
    const sent: FormData[] = [];
    const real = fetch;
    server = await startServer({ port: 0, data: join(dir, 'nertz.db'), feedback: { webhook: 'https://discord.invalid/hook', anthropic: '', onDelivered, fetch: (async (_url: unknown, init?: RequestInit) => (sent.push(init!.body as FormData), new Response(null, { status: 204 }))) as typeof fetch } });
    const send = (body: unknown) => real(`http://localhost:${server!.port}/feedback`, { method: 'POST', body: JSON.stringify(body) });

    const res = await send({ kind: 'bug', text: 'the ace made a noise @everyone', name: 'Sam', room: 'ABCD', image: JPEG });
    expect(res.status).toBe(200);
    // It is kept by the time the sender is answered, as it came; what it was titled is noted once it has been passed on.
    expect(kept()).toMatchObject([{ kind: 'bug', text: 'the ace made a noise @everyone', name: 'Sam', room: 'ABCD', account: null }]);
    // The screenshot is a file beside the database, named by the report's id; the row says only how big it is.
    const { id, image_bytes } = kept()[0] as { id: string; image_bytes: number };
    expect(readFileSync(join(dir, 'reports', `${id}.jpg`)).toString('base64')).toBe(JPEG.split(',')[1]);
    expect(image_bytes).toBe(Buffer.from(JPEG.split(',')[1]!, 'base64').length);
    await settled(1);
    expect(kept()[0]).toMatchObject({ title: 'the ace made a noise @everyone', priority: null, issue: null });
    const payload = JSON.parse(sent[0]!.get('payload_json') as string) as { allowed_mentions: unknown; embeds: { description: string }[] };
    expect(payload.embeds[0]!.description).toContain('the ace');
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(sent[0]!.get('files[0]')).toBeInstanceOf(Blob);

    expect((await send({ kind: 'bug' })).status).toBe(400);
    expect((await real(`http://localhost:${server.port}/feedback`)).status).toBe(405);
    for (let i = 0; i < 8; i++) await send({ kind: 'idea', text: 'more' });
    expect((await send({ kind: 'idea', text: 'more' })).status).toBe(429);
    await settled(9); // (the eight that got through, delivered after they were answered)
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
    server = await startServer({ port: 0, feedback: { webhook: 'https://discord.invalid/hook', linear: { key: 'lin_api_x', team: 'nrz', priority: 2, assignee: 'me', state: 'Todo', project: 'No such project' }, anthropic: '', onDelivered, fetch: fake } });
    const send = (body: unknown) => real(`http://localhost:${server!.port}/feedback`, { method: 'POST', body: JSON.stringify(body) });

    expect((await send({ kind: 'idea', text: 'a ready button\nwould be nice', name: 'Sam', image: JPEG })).status).toBe(200);
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

  it('a lookup Linear did not answer is left out of that issue only, and asked again for the next; and no call out waits for ever', async () => {
    let asked = 0;
    const inputs: Record<string, unknown>[] = [];
    const waits: boolean[] = [];
    const fake = (async (_url: unknown, init?: RequestInit) => {
      waits.push(init?.signal instanceof AbortSignal);
      const { query: q, variables } = JSON.parse(String(init!.body)) as { query: string; variables: { input: Record<string, unknown> } };
      if (q.includes('projects(') && asked++ === 0) throw new Error('no answer');
      if (q.includes('issueCreate')) inputs.push(variables.input);
      const data = q.includes('projects(') ? { projects: { nodes: [{ id: 'proj1' }] } } : q.includes('teams(') ? { teams: { nodes: [{ id: 'team1' }] } } : q.includes('issueLabels(') ? { issueLabels: { nodes: [{ id: 'bug1', name: 'Bug', team: null }, { id: 'feat1', name: 'Feature', team: null }] } } : { issueCreate: { issue: { identifier: 'NRZ-9', url: 'https://linear.invalid/NRZ-9' } } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof fetch;
    const real = fetch;
    server = await startServer({ port: 0, feedback: { linear: { key: 'lin_api_x', team: 'nrz', project: 'Nertz' }, anthropic: '', onDelivered, fetch: fake } });
    const send = (body: unknown) => real(`http://localhost:${server!.port}/feedback`, { method: 'POST', body: JSON.stringify(body) });
    for (const n of [1, 2, 3]) {
      expect((await send({ kind: 'bug', text: 'it broke' })).status).toBe(200);
      await settled(n);
    }
    expect(inputs.map((i) => i.projectId)).toEqual([undefined, 'proj1', 'proj1']);
    expect(asked).toBe(2); // (found: not asked a third time)
    expect(waits.every(Boolean)).toBe(true);
  });

  it('a report from someone signed in is kept as theirs, and what became of it is noted: its title, and the issue filed', async () => {
    fakeGoogle();
    dir = mkdtempSync(join(tmpdir(), 'nertz-feedback-'));
    const fake = (async (_url: unknown, init?: RequestInit) => {
      const q = (JSON.parse(String(init!.body)) as { query: string }).query;
      const data = q.includes('teams(') ? { teams: { nodes: [{ id: 'team1' }] } } : q.includes('issueLabels(') ? { issueLabels: { nodes: [{ id: 'bug1', name: 'Bug', team: null }, { id: 'feat1', name: 'Feature', team: null }] } } : { issueCreate: { issue: { identifier: 'NRZ-9', url: 'https://linear.invalid/NRZ-9' } } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof fetch;
    server = await startServer({ port: 0, data: join(dir, 'nertz.db'), accounts: ACCOUNTS, feedback: { linear: { key: 'lin_api_x', team: 'nrz' }, anthropic: '', onDelivered, fetch: fake } });
    const ada = new Browser(server.port);
    await ada.signIn(ADA);
    const { user } = (await (await ada.ask('/api/auth/get-session')).json()) as { user: { id: string } };

    expect((await ada.ask('/feedback', { kind: 'idea', text: 'a ready button' })).status).toBe(200);
    expect((await new Browser(server.port).ask('/feedback', { kind: 'bug', text: 'it broke' })).status).toBe(200);
    await settled(2);
    expect(kept()).toMatchObject([
      { text: 'a ready button', account: user.id, title: 'a ready button', issue: 'https://linear.invalid/NRZ-9', image_bytes: null },
      { text: 'it broke', account: null },
    ]);
  });

  it('with nowhere to keep a report and nowhere to pass it on, the sender is told so; with only somewhere to keep it, it is kept', async () => {
    server = await startServer({ port: 0, feedback: { webhook: '', anthropic: '', onDelivered } });
    const bare = await fetch(`http://localhost:${server.port}/feedback`, { method: 'POST', body: JSON.stringify({ kind: 'bug', text: 'it broke' }) });
    expect(bare.status).toBe(503);
    await server.close();

    dir = mkdtempSync(join(tmpdir(), 'nertz-feedback-'));
    server = await startServer({ port: 0, data: join(dir, 'nertz.db'), feedback: { webhook: '', anthropic: '', onDelivered } });
    expect((await fetch(`http://localhost:${server.port}/feedback`, { method: 'POST', body: JSON.stringify({ kind: 'bug', text: 'it broke' }) })).status).toBe(200);
    await settled(1);
    expect(kept()).toMatchObject([{ text: 'it broke', title: 'it broke' }]);
  });

  it('a report that cannot be kept: passed on all the same where there is somewhere, and the sender told so where there is not', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    /** The table taken away from under the server: nothing can be kept. */
    const broken = (): void => {
      const db = new DatabaseSync(join(dir!, 'nertz.db'));
      db.exec('drop table report');
      db.close();
    };
    try {
      dir = mkdtempSync(join(tmpdir(), 'nertz-feedback-'));
      server = await startServer({ port: 0, data: join(dir, 'nertz.db'), feedback: { webhook: '', anthropic: '', onDelivered } });
      broken();
      expect((await fetch(`http://localhost:${server.port}/feedback`, { method: 'POST', body: JSON.stringify({ kind: 'bug', text: 'it broke' }) })).status).toBe(500);
      await server.close();
      rmSync(dir, { recursive: true, force: true });

      dir = mkdtempSync(join(tmpdir(), 'nertz-feedback-'));
      const sent: unknown[] = [];
      server = await startServer({ port: 0, data: join(dir, 'nertz.db'), feedback: { webhook: 'https://discord.invalid/hook', anthropic: '', onDelivered, fetch: (async (_url: unknown, init?: RequestInit) => (sent.push(init!.body), new Response(null, { status: 204 }))) as typeof fetch } });
      broken();
      expect((await fetch(`http://localhost:${server.port}/feedback`, { method: 'POST', body: JSON.stringify({ kind: 'bug', text: 'it broke' }) })).status).toBe(200);
      await settled(1);
      expect(sent).toHaveLength(1);
    } finally {
      said.mockRestore();
    }
  });

  it('the screenshots kept come to no more than they may: past that a report is kept without its picture', () => {
    dir = mkdtempSync(join(tmpdir(), 'nertz-feedback-'));
    const db = openDb(':memory:');
    const reports = openReports(db, { dir, maxImageBytes: 10 });
    const picture = (bytes: number) => ({ kind: 'bug' as const, text: 'x', image: Buffer.alloc(bytes) });
    reports.add('00000000000a', 1, picture(6), null);
    reports.add('00000000000b', 2, picture(6), null); // would make twelve
    reports.add('00000000000c', 3, picture(4), null);
    expect(db.prepare('select id, image_bytes as bytes from report order by created_at').all()).toEqual([
      { id: '00000000000a', bytes: 6 },
      { id: '00000000000b', bytes: null },
      { id: '00000000000c', bytes: 4 },
    ]);
    expect(readdirSync(dir).sort()).toEqual(['00000000000a.jpg', '00000000000c.jpg']);
    reports.passedOn('00000000000b', { title: 'A title', priority: 3 }, 'https://linear.invalid/NRZ-1');
    expect(db.prepare(`select title, priority, issue from report where id = '00000000000b'`).get()).toEqual({ title: 'A title', priority: 3, issue: 'https://linear.invalid/NRZ-1' });
    db.close();
  });

  it('a screenshot that cannot be written is left out: the report is kept without it', () => {
    dir = mkdtempSync(join(tmpdir(), 'nertz-feedback-'));
    const blocked = join(dir, 'reports');
    writeFileSync(blocked, 'not a directory');
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = openDb(':memory:');
    try {
      openReports(db, { dir: blocked }).add('0123456789ab', 1, { kind: 'bug', text: 'x', image: Buffer.from('picture') }, null);
      expect(db.prepare('select id, image_bytes from report').all()).toEqual([{ id: '0123456789ab', image_bytes: null }]);
      expect(said).toHaveBeenCalled();
    } finally {
      said.mockRestore();
      db.close();
    }
  });

  it('a screenshot is a file named by the server alone: an id that is not one of its own names no file at all', () => {
    dir = mkdtempSync(join(tmpdir(), 'nertz-feedback-'));
    const db = openDb(':memory:');
    const reports = openReports(db, { dir });
    const report = () => ({ kind: 'bug' as const, text: 'x', image: Buffer.from('picture') });
    expect(imageFile('/data/reports', '0123456789ab')).toBe(join('/data/reports', '0123456789ab.jpg'));
    for (const id of ['../../nertz', '0123456789ab/../x', '/etc/passwd', 'ABCDEF012345', '0123456789a', '']) {
      expect(() => reports.add(id, 1, report(), null)).toThrow();
    }
    expect(readdirSync(dir)).toEqual([]);
    expect(db.prepare('select count(*) as n from report').get()).toEqual({ n: 0 });

    // A row that cannot be written takes its picture with it; a file already there is never written over.
    reports.add('0123456789ab', 1, report(), null);
    expect(() => reports.add('0123456789ab', 2, report(), null)).toThrow();
    expect(readFileSync(join(dir, '0123456789ab.jpg'), 'utf8')).toBe('picture');
    db.exec('delete from report');
    rmSync(join(dir, '0123456789ab.jpg'));
    db.exec('drop table report');
    expect(() => reports.add('0123456789ab', 1, report(), null)).toThrow();
    expect(readdirSync(dir)).toEqual([]);
    db.close();
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
    server = await startServer({ port: 0, feedback: { webhook: 'https://discord.invalid/hook', linear: { key: 'lin_api_x', team: 'nrz', priority: 3 }, anthropic: 'sk-ant-test', onDelivered, fetch: fake } });
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
