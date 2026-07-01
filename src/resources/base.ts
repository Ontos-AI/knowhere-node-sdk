import type { HttpClient } from '../lib/http-client.js';
import type { KnowhereApiVersion } from '../types/client.js';

/**
 * Base class for all API resources
 */
export abstract class BaseResource {
  protected httpClient: HttpClient;
  protected defaultApiVersion: KnowhereApiVersion;

  constructor(httpClient: HttpClient, defaultApiVersion: KnowhereApiVersion = 'v1') {
    this.httpClient = httpClient;
    this.defaultApiVersion = defaultApiVersion;
  }

  protected getApiVersion(apiVersion?: KnowhereApiVersion): KnowhereApiVersion {
    return apiVersion ?? this.defaultApiVersion;
  }

  protected endpoint(path: string, apiVersion?: KnowhereApiVersion): string {
    return `/${this.getApiVersion(apiVersion)}${path.startsWith('/') ? path : `/${path}`}`;
  }
}
