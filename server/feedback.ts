// Bug reports and feature requests: POST /feedback, from the bug button in the corner (client/Feedback.tsx).
// A report goes to whichever of two places is set up, and to both if both are:
// - FEEDBACK_WEBHOOK: a Discord webhook URL. The report is posted to its channel, the screenshot attached.
// - FEEDBACK_DIR: a directory (a mounted volume, in production). One line of JSON per report is added to
//   feedback.jsonl there, and the screenshot is saved beside it. Outside production it defaults to ./feedback.
// - LINEAR_API_KEY and LINEAR_TEAM (a team's key, like NRZ): an issue is filed in that team, titled "[FEEDBACK] ...",
//   labelled Bug or Feature (the label is made if the team has none of that name), the screenshot in its description.
//   Optional, each left alone if unset: LINEAR_PRIORITY (1 urgent, 2 high, 3 medium, 4 low), LINEAR_ASSIGNEE (an
//   email address, or `me` for whoever the key belongs to), LINEAR_STATE (a status of the team by name, like Todo)
//   and LINEAR_PROJECT (a project by name).
// With none of them, the sender is told that feedback is not set up.
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

export const FEEDBACK_MAX_TEXT = 2000;
/** The whole request: the text and one picture (the client scales it down first). */
const MAX_BODY_BYTES = 3 << 20;
/** Per address: this many reports in this long. */
const RATE_MAX = 10;
const RATE_WINDOW_MS = 60_000;
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

export interface Report {
  kind: 'bug' | 'idea';
  text: string;
  name?: string;
  room?: string;
  /** Where they were and on what: free text the client puts together (screen, window size, browser). */
  context?: string;
  image?: { type: string; data: Buffer };
}

const short = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** What was sent, if it is a report: null otherwise. */
export function parseReport(raw: string): Report | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const text = short(v.text, FEEDBACK_MAX_TEXT);
  if (!text || (v.kind !== 'bug' && v.kind !== 'idea')) return null;
  const m = typeof v.image === 'string' ? IMAGE_RE.exec(v.image) : null;
  if (v.image !== undefined && v.image !== null && !m) return null;
  const name = short(v.name, 40);
  const room = short(v.room, 8);
  const context = short(v.context, 400);
  return { kind: v.kind, text, ...(name ? { name } : {}), ...(room ? { room } : {}), ...(context ? { context } : {}), ...(m ? { image: { type: m[1]!, data: Buffer.from(m[2]!, 'base64') } } : {}) };
}

export interface FeedbackOptions {
  webhook?: string;
  dir?: string;
  /** A Linear personal API key, and the key of the team the issues go to. */
  linear?: { key: string; team: string; priority?: number; assignee?: string; state?: string; project?: string };
  /** For tests. */
  fetch?: typeof fetch;
}

export function feedbackHandler(options: FeedbackOptions = {}) {
  const webhook = options.webhook ?? process.env.FEEDBACK_WEBHOOK;
  const dir = options.dir ?? process.env.FEEDBACK_DIR ?? (process.env.NODE_ENV === 'production' ? undefined : 'feedback');
  const post = options.fetch ?? fetch;
  const recent = new Map<string, number[]>();
  const env = process.env;
  const linear =
    options.linear ??
    (env.LINEAR_API_KEY && env.LINEAR_TEAM
      ? { key: env.LINEAR_API_KEY, team: env.LINEAR_TEAM, priority: /^[1-4]$/.test(env.LINEAR_PRIORITY ?? '') ? Number(env.LINEAR_PRIORITY) : undefined, assignee: env.LINEAR_ASSIGNEE || undefined, state: env.LINEAR_STATE || undefined, project: env.LINEAR_PROJECT || undefined }
      : undefined);

  /** One call to Linear's GraphQL API: its `data`, or an error. */
  const gql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const res = await post('https://api.linear.app/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: linear!.key }, body: JSON.stringify({ query, variables }) });
    const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
    if (!res.ok || !body?.data || body.errors?.length) throw new Error(`Linear: ${body?.errors?.[0]?.message ?? res.status}`);
    return body.data;
  };

  /**
   * The team's id and the Bug and Feature labels, looked up once. A label of that name is used if the team has one,
   * or the workspace has one for every team; otherwise it is made for the team. (Asked in two small queries: one that
   * reads every label of a team inside the team is refused by Linear as too complex.)
   */
  let team: Promise<{ id: string; labels: Record<Report['kind'], string>; extra: Record<string, unknown> }> | null = null;
  const findTeam = (): NonNullable<typeof team> =>
    (team ??= (async () => {
      const found = await gql<{ teams: { nodes: { id: string }[] } }>('query($key: String!) { teams(filter: { key: { eq: $key } }, first: 1) { nodes { id } } }', { key: linear!.team.toUpperCase() });
      const id = found.teams.nodes[0]?.id;
      if (!id) throw new Error(`Linear: no team with the key ${linear!.team}`);
      const have = await gql<{ issueLabels: { nodes: { id: string; name: string; isGroup?: boolean; team: { id: string } | null }[] } }>('query { issueLabels(first: 50, filter: { or: [{ name: { eqIgnoreCase: "Bug" } }, { name: { eqIgnoreCase: "Feature" } }] }) { nodes { id name isGroup team { id } } } }', {});
      const label = async (name: string, color: string): Promise<string> => {
        const fits = have.issueLabels.nodes.filter((l) => !l.isGroup && l.name.toLowerCase() === name.toLowerCase() && (!l.team || l.team.id === id));
        const has = fits.find((l) => l.team) ?? fits[0]; // the team's own before the workspace's
        if (has) return has.id;
        const made = await gql<{ issueLabelCreate: { issueLabel: { id: string } } }>('mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id } } }', { input: { name, color, teamId: id } });
        return made.issueLabelCreate.issueLabel.id;
      };
      // What else an issue is given, where the server was told: each looked up by name, and left out (with a word in the log) if there is no such thing.
      const extra: Record<string, unknown> = {};
      const lookup = async (what: string, field: string, find: () => Promise<string | undefined>): Promise<void> => {
        try {
          const found = await find();
          if (found) extra[field] = found;
          else console.error(`feedback: Linear has no ${what}; issues are filed without it`);
        } catch (e) {
          console.error(`feedback: looking up the Linear ${what}`, e);
        }
      };
      if (linear!.priority) extra.priority = linear!.priority;
      const { assignee, state, project } = linear!;
      if (assignee) await lookup(`user ${assignee}`, 'assigneeId', async () => (assignee.toLowerCase() === 'me' ? (await gql<{ viewer: { id: string } }>('query { viewer { id } }', {})).viewer.id : (await gql<{ users: { nodes: { id: string }[] } }>('query($email: String!) { users(filter: { email: { eq: $email } }, first: 1) { nodes { id } } }', { email: assignee })).users.nodes[0]?.id));
      if (state) await lookup(`status "${state}" in the team`, 'stateId', async () => (await gql<{ workflowStates: { nodes: { id: string }[] } }>('query($team: ID!, $name: String!) { workflowStates(filter: { team: { id: { eq: $team } }, name: { eqIgnoreCase: $name } }, first: 1) { nodes { id } } }', { team: id, name: state })).workflowStates.nodes[0]?.id);
      if (project) await lookup(`project "${project}"`, 'projectId', async () => (await gql<{ projects: { nodes: { id: string }[] } }>('query($name: String!) { projects(filter: { name: { eqIgnoreCase: $name } }, first: 1) { nodes { id } } }', { name: project })).projects.nodes[0]?.id);
      return { id, labels: { bug: await label('Bug', '#cf2233'), idea: await label('Feature', '#f2b320') }, extra };
    })().catch((e: unknown) => {
      team = null; // (not remembered: the next report tries again)
      throw e;
    }));

  /** Files the issue; answers with its number and address, for the other places to point at. */
  const toLinear = async (id: string, r: Report): Promise<{ identifier: string; url: string }> => {
    const t = await findTeam();
    // The screenshot goes up to Linear's own storage first; without it the issue is still filed.
    let picture = '';
    if (r.image) {
      try {
        const type = `image/${r.image.type}`;
        const up = await gql<{ fileUpload: { uploadFile: { uploadUrl: string; assetUrl: string; headers: { key: string; value: string }[] } } }>('mutation($type: String!, $name: String!, $size: Int!) { fileUpload(contentType: $type, filename: $name, size: $size) { uploadFile { uploadUrl assetUrl headers { key value } } } }', { type, name: `feedback-${id}.${r.image.type === 'jpeg' ? 'jpg' : r.image.type}`, size: r.image.data.length });
        const f = up.fileUpload.uploadFile;
        const put = await post(f.uploadUrl, { method: 'PUT', headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000', ...Object.fromEntries(f.headers.map((h) => [h.key, h.value])) }, body: new Uint8Array(r.image.data) });
        if (!put.ok) throw new Error(`upload answered ${put.status}`);
        picture = `\n\n![screenshot](${f.assetUrl})`;
      } catch (e) {
        console.error('feedback', id, 'screenshot to Linear', e);
      }
    }
    const first = r.text.split('\n')[0]!.trim();
    const title = `[FEEDBACK] ${first.length > 80 ? `${first.slice(0, 79)}…` : first}`;
    const about = [r.name && `**From:** ${r.name}`, r.room && `**Table:** ${r.room}`, r.context && `**Where:** ${r.context}`, `**Report:** ${id}`].filter(Boolean).join('  \n');
    // (What a stranger typed is quoted, so that it cannot pass for the issue's own text.)
    const description = `${r.text.split('\n').map((l) => `> ${l}`).join('\n')}${picture}\n\n${about}`;
    const made = await gql<{ issueCreate: { issue: { identifier: string; url: string } } }>('mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier url } } }', { input: { teamId: t.id, title, description, labelIds: [t.labels[r.kind]], ...t.extra } });
    return made.issueCreate.issue;
  };

  const toDisk = async (id: string, at: string, r: Report, issue?: { identifier: string; url: string }): Promise<void> => {
    await mkdir(dir!, { recursive: true });
    const file = r.image ? `${id}.${r.image.type === 'jpeg' ? 'jpg' : r.image.type}` : undefined;
    if (file) await writeFile(join(dir!, file), r.image!.data);
    const { image: _, ...rest } = r;
    await appendFile(join(dir!, 'feedback.jsonl'), JSON.stringify({ id, at, ...rest, ...(file ? { image: file } : {}), ...(issue ? { linear: issue.url } : {}) }) + '\n');
  };

  const toDiscord = async (id: string, r: Report, issue?: { identifier: string; url: string }): Promise<void> => {
    const file = r.image ? `screenshot.${r.image.type === 'jpeg' ? 'jpg' : r.image.type}` : undefined;
    const payload = {
      allowed_mentions: { parse: [] }, // what a stranger typed never pings anyone
      embeds: [
        {
          title: `${r.kind === 'bug' ? '🐞 Bug report' : '💡 Feature request'}${issue ? ` · ${issue.identifier}` : ''}`,
          ...(issue ? { url: issue.url } : {}), // the title is then a link to the issue
          description: r.text,
          color: r.kind === 'bug' ? 0xcf2233 : 0xf2b320,
          fields: [...(r.name ? [{ name: 'From', value: r.name, inline: true }] : []), ...(r.room ? [{ name: 'Table', value: r.room, inline: true }] : []), ...(r.context ? [{ name: 'Where', value: r.context }] : []), ...(issue ? [{ name: 'Linear', value: `[${issue.identifier}](${issue.url})`, inline: true }] : [])],
          footer: { text: id },
          ...(file ? { image: { url: `attachment://${file}` } } : {}),
        },
      ],
    };
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    if (file) form.append('files[0]', new Blob([new Uint8Array(r.image!.data)], { type: `image/${r.image!.type}` }), file);
    const res = await post(webhook!, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Discord answered ${res.status}`);
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const answer = (status: number, message?: string): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(message ? { ok: false, message } : { ok: true }));
    };
    if (req.method !== 'POST') return answer(405, 'Method not allowed');
    if (!webhook && !dir && !linear) return answer(503, 'Feedback is not set up on this server.');

    const from = String(req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? '');
    const now = Date.now();
    const times = (recent.get(from) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (times.length >= RATE_MAX) return answer(429, 'That is a lot of reports. Try again in a minute.');
    recent.set(from, [...times, now]);
    if (recent.size > 5000) for (const [k, v] of recent) if (v.every((t) => now - t >= RATE_WINDOW_MS)) recent.delete(k);

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        answer(413, 'That screenshot is too large.');
        return void req.destroy();
      }
      chunks.push(chunk);
    }
    const report = parseReport(Buffer.concat(chunks).toString('utf8'));
    if (!report) return answer(400, 'That report could not be read.');

    const id = randomUUID().slice(0, 8);
    // Linear first, so that the other two can point at the issue. If it fails, they still get the report.
    const issue = linear ? await toLinear(id, report).catch((e: unknown) => void console.error('feedback', id, e)) : undefined;
    const done = await Promise.allSettled([...(dir ? [toDisk(id, new Date(now).toISOString(), report, issue ?? undefined)] : []), ...(webhook ? [toDiscord(id, report, issue ?? undefined)] : [])]);
    for (const d of done) if (d.status === 'rejected') console.error('feedback', id, d.reason);
    // Kept somewhere is enough: the sender need not hear that one of the places failed.
    return issue || done.some((d) => d.status === 'fulfilled') ? answer(200) : answer(502, 'The report could not be delivered. Try again later.');
  };
}
