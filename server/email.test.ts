// Signing in with a code sent to one's email, end to end against a real server: Resend played by a fake `fetch` (and
// Google too, for one email coming in both ways).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_PATH } from './accounts';
import { startServer, type NertzServer } from './index';
import { ACCOUNTS, ADA, Browser, codeIn, fakeGoogle, fakeResend, rows as allRows, type Sent } from './testkit';

describe('signing in by email', () => {
  let server: NertzServer;
  let dir: string;
  let sent: Sent[];
  const rows = (table: string): Record<string, unknown>[] => allRows(join(dir, 'nertz.db'), table);
  const send = (browser: Browser, email: string): Promise<Response> => browser.ask(`${AUTH_PATH}/email-otp/send-verification-otp`, { email, type: 'sign-in' });
  const enter = (browser: Browser, email: string, otp: string): Promise<Response> => browser.ask(`${AUTH_PATH}/sign-in/email-otp`, { email, otp });
  const profile = async (browser: Browser): Promise<unknown> => (await browser.ask('/profile')).json();

  beforeEach(async () => {
    fakeGoogle();
    sent = fakeResend();
    dir = mkdtempSync(join(tmpdir(), 'nertz-email-'));
    server = await startServer({ port: 0, dist: '/nonexistent', data: join(dir, 'nertz.db'), accounts: ACCOUNTS });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends a code, and signs in someone new with it, who has no name yet', async () => {
    const browser = new Browser(server.port);
    expect(await (await browser.ask('/profile')).json()).toEqual({ ways: ['google', 'email'] });
    expect((await send(browser, 'grace@example.com')).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: ACCOUNTS.email!.from, to: ['grace@example.com'] });
    const code = codeIn(sent, 'grace@example.com');
    expect(sent[0]!.text).toContain(code);

    expect((await enter(browser, 'grace@example.com', code)).status).toBe(200);
    expect(await profile(browser)).toEqual({ id: expect.any(String), name: null, image: null });
    expect(rows('user')).toMatchObject([{ email: 'grace@example.com', emailVerified: 1 }]);
    // Kept hashed: the code is not in the database.
    expect(JSON.stringify(rows('verification'))).not.toContain(code);
  });

  it('takes three wrong codes at most: after them, not even the right one', async () => {
    const browser = new Browser(server.port);
    await send(browser, 'grace@example.com');
    const code = codeIn(sent, 'grace@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i++) expect((await enter(browser, 'grace@example.com', wrong)).status).toBeGreaterThanOrEqual(400);
    expect((await enter(browser, 'grace@example.com', code)).status).toBeGreaterThanOrEqual(400);
    expect((await browser.ask('/profile')).status).toBe(401);
  });

  it('is one account for one email, whichever way they come in', async () => {
    // With Google first, then by email: the same account, its name kept.
    const google = new Browser(server.port);
    await google.signIn(ADA);
    const byEmail = new Browser(server.port);
    await send(byEmail, ADA.email);
    expect((await enter(byEmail, ADA.email, codeIn(sent, ADA.email))).status).toBe(200);
    expect(await profile(byEmail)).toEqual(await profile(google));

    // By email first, then with Google: the same account too.
    const first = new Browser(server.port);
    await send(first, 'bob@example.com');
    await enter(first, 'bob@example.com', codeIn(sent, 'bob@example.com'));
    const then = new Browser(server.port);
    await then.signIn({ sub: 'google-456', email: 'bob@example.com', name: 'Bob Byte' });
    expect((await profile(then)) as { id: string }).toMatchObject({ id: ((await profile(first)) as { id: string }).id });
    expect(rows('user')).toHaveLength(2);
  });

  it('when the code cannot be sent, says so in the log and nowhere else, and signs nobody in', async () => {
    vi.unstubAllGlobals();
    const refused = fakeResend({ refuse: true });
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    const browser = new Browser(server.port);
    expect((await send(browser, 'grace@example.com')).status).toBe(200); // (Better Auth's way: nothing told about the address)
    expect(refused).toHaveLength(0);
    expect(said.mock.calls.flat().join(' ')).toContain('Resend: 422');
    said.mockRestore();
    expect((await enter(browser, 'grace@example.com', '123456')).status).toBeGreaterThanOrEqual(400);
  });

  it('does nothing but sign in: no verifying, resetting or changing by email', async () => {
    const browser = new Browser(server.port);
    for (const path of ['/email-otp/verify-email', '/email-otp/check-verification-otp', '/forget-password/email-otp', '/email-otp/request-email-change']) {
      expect((await browser.ask(`${AUTH_PATH}${path}`, { email: 'grace@example.com', otp: '123456', type: 'sign-in' })).status).toBe(404);
    }
    expect((await send(browser, 'not an email')).status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});
