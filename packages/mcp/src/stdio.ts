#!/usr/bin/env node
import { runKnowhereMcpServer } from './index.js';
import { McpCredentialManager, type McpAuthStatus } from './auth.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case 'serve':
      await runKnowhereMcpServerWithAuth();
      return;
    case 'login':
      await runLogin(args);
      return;
    case 'logout':
      await runLogout();
      return;
    case 'status':
      await runStatus();
      return;
    case '--help':
    case '-h':
    case 'help':
      printHelp();
      return;
    default:
      throw new Error(`Unknown knowhere-mcp command: ${command}`);
  }
}

async function runKnowhereMcpServerWithAuth(): Promise<void> {
  const credentialManager = new McpCredentialManager();
  const status = await credentialManager.getStatus();

  if (process.env.KNOWHERE_API_KEY) {
    await runKnowhereMcpServer({ permission: status.permission });
    return;
  }

  await runKnowhereMcpServer({
    authTokenProvider: () => credentialManager.getAccessToken(),
    baseURL: await credentialManager.resolveBaseURL(),
    permission: status.permission,
    recoverPendingJobsOnStart: status.source === 'stored_login',
  });
}

async function runLogin(args: readonly string[]): Promise<void> {
  const options = parseLoginArgs(args);
  const credentialManager = new McpCredentialManager(options.authFilePath);
  const result = await credentialManager.login({
    baseUrl: options.baseUrl,
    openBrowser: options.openBrowser,
    clientName: options.clientName,
    onLoginUrl: (url) => {
      console.log(`Open this URL to log in to Knowhere:\n${url}`);
    },
  });

  console.log(`Knowhere MCP login saved to ${result.authFilePath}`);
  console.log(`Permission: ${result.permission}`);
  if (result.refreshTokenExpiresAt) {
    console.log(`Refresh token expires at ${result.refreshTokenExpiresAt}`);
  }
}

async function runLogout(): Promise<void> {
  const credentialManager = new McpCredentialManager();
  const result = await credentialManager.logout();
  if (result.revokeError) {
    console.error(
      `Knowhere MCP login was removed locally, but revoke failed: ${result.revokeError}`,
    );
  }
  console.log(
    result.hadStoredLogin
      ? `Knowhere MCP login removed from ${result.authFilePath}`
      : `No Knowhere MCP login found at ${result.authFilePath}`,
  );
}

async function runStatus(): Promise<void> {
  const credentialManager = new McpCredentialManager();
  const status = await credentialManager.getStatus();
  console.log(formatStatus(status));
}

function parseLoginArgs(args: readonly string[]): {
  baseUrl?: string;
  authFilePath?: string;
  clientName?: string;
  openBrowser: boolean;
} {
  const options: {
    baseUrl?: string;
    authFilePath?: string;
    clientName?: string;
    openBrowser: boolean;
  } = {
    openBrowser: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--base-url':
        options.baseUrl = readFlagValue(args, index, arg);
        index += 1;
        break;
      case '--auth-file':
        options.authFilePath = readFlagValue(args, index, arg);
        index += 1;
        break;
      case '--client-name':
        options.clientName = readFlagValue(args, index, arg);
        index += 1;
        break;
      case '--no-open':
        options.openBrowser = false;
        break;
      default:
        throw new Error(`Unknown login option: ${arg}`);
    }
  }

  return options;
}

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function formatStatus(status: McpAuthStatus): string {
  switch (status.source) {
    case 'api_key':
      return [
        'Knowhere MCP is authenticated with KNOWHERE_API_KEY',
        `Auth file: ${status.authFilePath}`,
        `Permission: ${status.permission ?? 'full_access'}`,
      ].join('\n');
    case 'stored_login':
      return [
        'Knowhere MCP is authenticated with dashboard login',
        `Auth file: ${status.authFilePath}`,
        `Base URL: ${status.baseUrl ?? 'unknown'}`,
        `Permission: ${status.permission ?? 'full_access'}`,
        `Refresh token expires: ${status.refreshTokenExpiresAt ?? 'unknown'}`,
        `Access token expires: ${status.accessTokenExpiresAt ?? 'not cached'}`,
      ].join('\n');
    case 'none':
      return `Knowhere MCP is not logged in\nRun: npx -y @ontos-ai/knowhere-mcp login\nAuth file: ${status.authFilePath}`;
  }
}

function printHelp(): void {
  console.log(`Usage:
  knowhere-mcp                 Run the stdio MCP server
  knowhere-mcp serve           Run the stdio MCP server
  knowhere-mcp login           Log in through the Knowhere dashboard
  knowhere-mcp status          Show local MCP auth status
  knowhere-mcp logout          Remove and revoke local MCP login

Login options:
  --base-url <url>             Knowhere site base URL, defaults to KNOWHERE_BASE_URL or https://knowhereto.ai
  --auth-file <path>           Override local auth file path
  --client-name <name>         Label shown in dashboard token records
  --no-open                    Print login URL without opening a browser`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
