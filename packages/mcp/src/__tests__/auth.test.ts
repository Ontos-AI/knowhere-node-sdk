import { get } from 'http';
import { mkdtemp, readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpCredentialManager } from '../auth.js';

describe('McpCredentialManager', () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.KNOWHERE_API_KEY;

  beforeEach(() => {
    delete process.env.KNOWHERE_API_KEY;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalApiKey) {
      process.env.KNOWHERE_API_KEY = originalApiKey;
    } else {
      delete process.env.KNOWHERE_API_KEY;
    }
    vi.restoreAllMocks();
  });

  it('should store a dashboard MCP login and remove it on logout', async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'knowhere-mcp-auth-'));
    const authFilePath = path.join(tempDirectory, 'auth.json');
    const manager = new McpCredentialManager(authFilePath);
    const fetchMock = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = getRequestUrl(input);
      if (url.pathname === '/api/mcp/token') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              accessToken: 'jwt_access',
              expiresInSeconds: 3600,
              permission: 'read_only',
              refreshToken: 'refresh_secret',
              refreshTokenExpiresAt: '2027-01-01T00:00:00.000Z',
              tokenType: 'Bearer',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.pathname === '/api/mcp/revoke') {
        return Promise.resolve(
          new Response(JSON.stringify({ revoked: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ message: 'not found' }), { status: 404 }),
      );
    });
    global.fetch = fetchMock;

    const result = await manager.login({
      dashboardUrl: 'https://dashboard.example',
      baseURL: 'https://api.example',
      openBrowser: false,
      onLoginUrl: (loginUrl) => {
        const url = new URL(loginUrl);
        const redirectUri = url.searchParams.get('redirect_uri');
        const state = url.searchParams.get('state');
        if (!redirectUri || !state) {
          throw new Error('login URL missing callback params');
        }
        setImmediate(() => {
          get(`${redirectUri}?code=auth_code&state=${state}`, (response) => {
            response.resume();
          });
        });
      },
    });

    expect(result.authFilePath).toBe(authFilePath);
    expect(result.permission).toBe('read_only');
    expect(await manager.getAccessToken()).toBe('jwt_access');
    await expect(manager.getStatus()).resolves.toMatchObject({
      permission: 'read_only',
      source: 'stored_login',
    });
    expect(JSON.parse(await readFile(authFilePath, 'utf8'))).toMatchObject({
      dashboardUrl: 'https://dashboard.example/',
      apiBaseUrl: 'https://api.example',
      permission: 'read_only',
      refreshToken: 'refresh_secret',
    });

    const logoutResult = await manager.logout();
    expect(logoutResult.hadStoredLogin).toBe(true);
    await expect(readFile(authFilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function getRequestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === 'string') {
    return new URL(input);
  }
  return new URL(input.url);
}
