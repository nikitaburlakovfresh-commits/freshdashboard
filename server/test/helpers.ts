import request from 'supertest';
import { createApp } from '../src/app';

export const ORIGIN = 'http://localhost:5173';
export const TEST_PASSWORD = process.env.SEED_FIXTURE_PASSWORD ?? 'Test#Fixture2026Pilot';

export const app = createApp();

export interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

export async function login(login: string, password = TEST_PASSWORD): Promise<Session> {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .send({ login, password });
  if (res.status !== 200) {
    throw new Error(`login failed for ${login}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const setCookie = res.headers['set-cookie'];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : (setCookie as unknown as string);
  const cookie = cookieHeader.split(';')[0];
  return { cookie, csrf: res.body.csrf_token, userId: res.body.user.id };
}

let idemCounter = 0;
export function idemKey(prefix: string): string {
  idemCounter += 1;
  return `${prefix}-${Date.now()}-${idemCounter}`.padEnd(16, '0').slice(0, 60);
}

export function authed(session: Session) {
  return {
    get: (url: string) => request(app).get(url).set('Cookie', session.cookie).set('Origin', ORIGIN),
    post: (url: string) =>
      request(app)
        .post(url)
        .set('Cookie', session.cookie)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', session.csrf),
    patch: (url: string) =>
      request(app)
        .patch(url)
        .set('Cookie', session.cookie)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', session.csrf),
  };
}
