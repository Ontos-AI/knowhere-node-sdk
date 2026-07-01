import type { HttpClient } from '../lib/http-client.js';

/**
 * Base class for all API resources
 */
export abstract class BaseResource {
  protected httpClient: HttpClient;

  constructor(httpClient: HttpClient) {
    this.httpClient = httpClient;
  }

  protected endpoint(path: string): string {
    return `/v2${path.startsWith('/') ? path : `/${path}`}`;
  }
}
