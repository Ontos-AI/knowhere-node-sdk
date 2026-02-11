import type { HttpClient } from '../lib/http-client.js';

/**
 * Base class for all API resources
 */
export abstract class BaseResource {
  protected httpClient: HttpClient;

  constructor(httpClient: HttpClient) {
    this.httpClient = httpClient;
  }
}
