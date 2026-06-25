import { spawn } from 'child_process';
import crypto from 'crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import os from 'os';
import path from 'path';
import { mkdir, readFile, rm, writeFile, chmod } from 'fs/promises';
import { ValidationError } from '@ontos-ai/knowhere-sdk';

const DEFAULT_BASE_URL = 'https://knowhereto.ai';
const AUTH_FILE_ENV = 'KNOWHERE_MCP_AUTH_FILE';
const BASE_URL_ENV = 'KNOWHERE_BASE_URL';
const API_KEY_ENV = 'KNOWHERE_API_KEY';
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const RANDOM_BYTE_LENGTH = 32;
const DEFAULT_CLIENT_NAME = 'knowhere-mcp';

export type Permission = 'read_only' | 'full_access';

const DEFAULT_PERMISSION: Permission = 'full_access';
const PERMISSION_VALUES = new Set<Permission>(['read_only', 'full_access']);

/** Knowhere URLs derived from a single site base origin. */
interface McpUrls {
  readonly base: string;
  readonly api: string;
  readonly mcpLogin: string;
  readonly token: string;
  readonly revoke: string;
}

/**
 * Resolve every Knowhere URL from a single site base origin. The API and OAuth
 * routes hang off the base so callers configure one value; point it at
 * https://staging.knowhereto.ai to target staging.
 */
function resolveMcpUrls(base: string): McpUrls {
  const normalized = base.replace(/\/+$/, '');
  return {
    base: normalized,
    api: `${normalized}/api`,
    mcpLogin: `${normalized}/mcp/login`,
    token: `${normalized}/api/oauth/token`,
    revoke: `${normalized}/api/oauth/revoke`,
  };
}

type TokenResponse = {
  accessToken: string;
  expiresInSeconds: number;
  permission: Permission;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  tokenType: 'Bearer';
};

type StoredMcpAuth = {
  baseUrl: string;
  permission: Permission;
  refreshToken: string;
  refreshTokenExpiresAt?: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type McpAuthStatus = {
  source: 'api_key' | 'stored_login' | 'none';
  authFilePath: string;
  baseUrl?: string;
  permission?: Permission;
  refreshTokenExpiresAt?: string;
  accessTokenExpiresAt?: string;
};

export type McpLoginOptions = {
  baseUrl?: string;
  authFilePath?: string;
  openBrowser?: boolean;
  clientName?: string;
  onLoginUrl?: (url: string) => void;
};

export type McpLoginResult = {
  authFilePath: string;
  baseUrl: string;
  permission: Permission;
  refreshTokenExpiresAt?: string;
};

export type McpLogoutResult = {
  authFilePath: string;
  hadStoredLogin: boolean;
  revokeError?: string;
};

export class McpCredentialManager {
  private readonly authFilePath: string;
  private refreshPromise?: Promise<string>;

  constructor(authFilePath: string = getDefaultAuthFilePath()) {
    this.authFilePath = authFilePath;
  }

  getAuthFilePath(): string {
    return this.authFilePath;
  }

  async getStatus(): Promise<McpAuthStatus> {
    if (process.env[API_KEY_ENV]) {
      return {
        source: 'api_key',
        authFilePath: this.authFilePath,
        baseUrl: process.env[BASE_URL_ENV],
        permission: DEFAULT_PERMISSION,
      };
    }

    const storedAuth = await this.readAuth();
    if (!storedAuth) {
      return { source: 'none', authFilePath: this.authFilePath };
    }

    return {
      source: 'stored_login',
      authFilePath: this.authFilePath,
      baseUrl: process.env[BASE_URL_ENV] ?? storedAuth.baseUrl,
      permission: storedAuth.permission,
      refreshTokenExpiresAt: storedAuth.refreshTokenExpiresAt,
      accessTokenExpiresAt: storedAuth.accessTokenExpiresAt,
    };
  }

  async hasStoredLogin(): Promise<boolean> {
    return (await this.readAuth()) !== undefined;
  }

  async getAccessToken(): Promise<string> {
    const storedAuth = await this.readAuth();
    if (!storedAuth) {
      throw new ValidationError(
        'Knowhere MCP is not logged in. Run "npx -y @ontos-ai/knowhere-mcp login" or set KNOWHERE_API_KEY.',
      );
    }

    if (isUsableAccessToken(storedAuth)) {
      return storedAuth.accessToken;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAccessToken(storedAuth).finally(() => {
        this.refreshPromise = undefined;
      });
    }

    return this.refreshPromise;
  }

  async login(options: McpLoginOptions = {}): Promise<McpLoginResult> {
    const baseUrl = normalizeBaseUrl(
      options.baseUrl ?? process.env[BASE_URL_ENV] ?? DEFAULT_BASE_URL,
    );
    const urls = resolveMcpUrls(baseUrl);
    const codeVerifier = createRandomToken();
    const state = createRandomToken();
    const codeChallenge = createPkceChallenge(codeVerifier);
    const callback = await createLoopbackCallback(state);

    try {
      const loginUrl = buildLoginUrl({
        loginEndpoint: urls.mcpLogin,
        redirectUri: callback.redirectUri,
        state,
        codeChallenge,
        clientName: options.clientName ?? DEFAULT_CLIENT_NAME,
      });

      options.onLoginUrl?.(loginUrl);
      if (options.openBrowser !== false) {
        openBrowser(loginUrl);
      }

      const code = await callback.waitForCode();
      const tokenResponse = await requestToken(urls.token, {
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_name: options.clientName ?? DEFAULT_CLIENT_NAME,
      });
      const storedAuth = buildStoredAuth({
        baseUrl,
        tokenResponse,
        previous: await this.readAuth(),
      });
      await this.writeAuth(storedAuth);

      return {
        authFilePath: this.authFilePath,
        baseUrl,
        permission: tokenResponse.permission,
        refreshTokenExpiresAt: tokenResponse.refreshTokenExpiresAt,
      };
    } finally {
      await callback.close();
    }
  }

  async logout(): Promise<McpLogoutResult> {
    const storedAuth = await this.readAuth();
    let revokeError: string | undefined;

    if (storedAuth) {
      try {
        await requestRevoke(resolveMcpUrls(storedAuth.baseUrl).revoke, storedAuth.refreshToken);
      } catch (error: unknown) {
        revokeError = error instanceof Error ? error.message : 'Failed to revoke MCP login';
      }
    }

    await rm(this.authFilePath, { force: true });

    return {
      authFilePath: this.authFilePath,
      hadStoredLogin: storedAuth !== undefined,
      revokeError,
    };
  }

  async resolveBaseURL(): Promise<string | undefined> {
    const envBase = process.env[BASE_URL_ENV];
    if (envBase) {
      return resolveMcpUrls(envBase).api;
    }
    const storedAuth = await this.readAuth();
    return storedAuth ? resolveMcpUrls(storedAuth.baseUrl).api : undefined;
  }

  private async refreshAccessToken(storedAuth: StoredMcpAuth): Promise<string> {
    const tokenResponse = await requestToken(resolveMcpUrls(storedAuth.baseUrl).token, {
      grant_type: 'refresh_token',
      refresh_token: storedAuth.refreshToken,
    });
    const refreshedAuth = buildStoredAuth({
      baseUrl: storedAuth.baseUrl,
      tokenResponse,
      previous: storedAuth,
    });
    await this.writeAuth(refreshedAuth);
    return refreshedAuth.accessToken ?? '';
  }

  private async readAuth(): Promise<StoredMcpAuth | undefined> {
    try {
      const rawAuth = await readFile(this.authFilePath, 'utf8');
      return parseStoredAuth(JSON.parse(rawAuth));
    } catch (error: unknown) {
      if (isFileMissingError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async writeAuth(storedAuth: StoredMcpAuth): Promise<void> {
    await mkdir(path.dirname(this.authFilePath), { recursive: true, mode: 0o700 });
    await writeFile(this.authFilePath, `${JSON.stringify(storedAuth, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(this.authFilePath, 0o600);
  }
}

export function getDefaultAuthFilePath(): string {
  return (
    process.env[AUTH_FILE_ENV] ?? path.join(os.homedir(), '.knowhere-node-sdk', 'mcp', 'auth.json')
  );
}

function isUsableAccessToken(storedAuth: StoredMcpAuth): storedAuth is StoredMcpAuth & {
  accessToken: string;
} {
  if (!storedAuth.accessToken || !storedAuth.accessTokenExpiresAt) {
    return false;
  }

  const expiresAt = Date.parse(storedAuth.accessTokenExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS;
}

function buildStoredAuth({
  baseUrl,
  tokenResponse,
  previous,
}: {
  baseUrl: string;
  tokenResponse: TokenResponse;
  previous?: StoredMcpAuth;
}): StoredMcpAuth {
  const now = new Date();
  const accessTokenExpiresAt = new Date(
    now.getTime() + tokenResponse.expiresInSeconds * 1000,
  ).toISOString();

  const refreshToken = tokenResponse.refreshToken ?? previous?.refreshToken;
  if (!refreshToken) {
    throw new Error('Knowhere MCP token response did not include a refresh token');
  }

  return {
    baseUrl,
    permission: tokenResponse.permission,
    refreshToken,
    refreshTokenExpiresAt: tokenResponse.refreshTokenExpiresAt ?? previous?.refreshTokenExpiresAt,
    accessToken: tokenResponse.accessToken,
    accessTokenExpiresAt,
    createdAt: previous?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function parseStoredAuth(value: unknown): StoredMcpAuth {
  if (!isRecord(value)) {
    throw new Error('Invalid Knowhere MCP auth file');
  }

  const baseUrl = readRequiredString(value, 'baseUrl');
  const refreshToken = readRequiredString(value, 'refreshToken');
  const createdAt = readRequiredString(value, 'createdAt');
  const updatedAt = readRequiredString(value, 'updatedAt');

  return {
    baseUrl,
    permission: normalizePermission(readOptionalString(value, 'permission')),
    refreshToken,
    refreshTokenExpiresAt: readOptionalString(value, 'refreshTokenExpiresAt'),
    accessToken: readOptionalString(value, 'accessToken'),
    accessTokenExpiresAt: readOptionalString(value, 'accessTokenExpiresAt'),
    createdAt,
    updatedAt,
  };
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`Invalid Knowhere MCP auth file: ${key} is required`);
  }
  return field;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function readRequiredPermission(value: Record<string, unknown>, key: string): Permission {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`Invalid Knowhere MCP token response: ${key} is required`);
  }
  if (!PERMISSION_VALUES.has(field as Permission)) {
    throw new Error(`Invalid Knowhere MCP token response: ${key} is invalid`);
  }
  return field as Permission;
}

function createPkceChallenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

function buildLoginUrl({
  loginEndpoint,
  redirectUri,
  state,
  codeChallenge,
  clientName,
}: {
  loginEndpoint: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  clientName: string;
}): string {
  const url = new URL(loginEndpoint);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('client_name', clientName);
  return url.toString();
}

async function createLoopbackCallback(expectedState: string): Promise<{
  redirectUri: string;
  waitForCode: () => Promise<string>;
  close: () => Promise<void>;
}> {
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((error: Error) => void) | undefined;
  let isSettled = false;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const timeout = setTimeout(() => {
    if (!isSettled) {
      isSettled = true;
      rejectCode?.(new Error('Timed out waiting for Dashboard login callback'));
    }
  }, LOGIN_TIMEOUT_MS);

  const server = createServer((request, response) => {
    handleCallbackRequest({
      request,
      response,
      expectedState,
      resolveCode: (code) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeout);
          resolveCode?.(code);
        }
      },
      rejectCode: (error) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeout);
          rejectCode?.(error);
        }
      },
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start loopback login callback server');
  }

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCode: () => codePromise,
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearTimeout(timeout);
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function handleCallbackRequest({
  request,
  response,
  expectedState,
  resolveCode,
  rejectCode,
}: {
  request: IncomingMessage;
  response: ServerResponse;
  expectedState: string;
  resolveCode: (code: string) => void;
  rejectCode: (error: Error) => void;
}): void {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (requestUrl.pathname !== '/callback') {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  const code = requestUrl.searchParams.get('code');
  const callbackError = requestUrl.searchParams.get('error');
  const state = requestUrl.searchParams.get('state');
  if (callbackError) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Knowhere MCP login was denied. You can close this window.');
    rejectCode(new Error(`Dashboard login failed: ${callbackError}`));
    return;
  }
  if (!code || state !== expectedState) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Knowhere MCP login failed. You can close this window.');
    rejectCode(new Error('Dashboard login callback did not include a valid code and state'));
    return;
  }

  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(
    '<!doctype html><title>Knowhere MCP</title><p>Knowhere MCP login complete. You can close this window.</p>',
  );
  resolveCode(code);
}

async function requestToken(
  tokenUrl: string,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseBody = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(getResponseMessage(responseBody, 'Knowhere MCP token request failed'));
  }

  return parseTokenResponse(responseBody);
}

async function requestRevoke(revokeUrl: string, refreshToken: string): Promise<void> {
  const response = await fetch(revokeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const responseBody = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(getResponseMessage(responseBody, 'Knowhere MCP revoke request failed'));
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (!isRecord(value)) {
    throw new Error('Invalid Knowhere MCP token response');
  }

  const accessToken = readRequiredString(value, 'accessToken');
  const tokenType = readRequiredString(value, 'tokenType');
  const expiresInSeconds = value.expiresInSeconds;
  const permission = readRequiredPermission(value, 'permission');
  if (tokenType !== 'Bearer') {
    throw new Error('Invalid Knowhere MCP token type');
  }
  if (typeof expiresInSeconds !== 'number' || !Number.isFinite(expiresInSeconds)) {
    throw new Error('Invalid Knowhere MCP token expiry');
  }

  return {
    accessToken,
    expiresInSeconds,
    permission,
    refreshToken: readOptionalString(value, 'refreshToken'),
    refreshTokenExpiresAt: readOptionalString(value, 'refreshTokenExpiresAt'),
    tokenType,
  };
}

function getResponseMessage(responseBody: unknown, fallback: string): string {
  if (isRecord(responseBody) && typeof responseBody.message === 'string') {
    return responseBody.message;
  }
  return fallback;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function normalizePermission(value: string | undefined): Permission {
  if (value && PERMISSION_VALUES.has(value as Permission)) {
    return value as Permission;
  }

  return DEFAULT_PERMISSION;
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function createRandomToken(): string {
  return crypto.randomBytes(RANDOM_BYTE_LENGTH).toString('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileMissingError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
