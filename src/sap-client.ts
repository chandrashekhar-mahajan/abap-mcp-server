/**
 * SAP ADT REST API Client
 * 
 * Communicates with SAP systems via the ADT (ABAP Development Tools) REST API.
 * These are the same APIs that Eclipse ADT and ABAP FS use internally.
 * 
 * Supports pluggable authentication strategies:
 *   - Basic Auth (username/password)
 *   - OAuth 2.0 (Bearer token)
 *   - Browser SSO (session cookies)
 *   - X.509 Certificate (mutual TLS)
 */

import fetch, { RequestInit, Response } from 'node-fetch';
import https from 'https';
import { parseStringPromise } from 'xml2js';
import { AuthStrategy } from './auth/types';

export interface SapConfig {
  baseUrl: string;
  client: string;
  language: string;
  skipSsl: boolean;
  // Legacy fields — used when no AuthStrategy is provided
  username?: string;
  password?: string;
}

export class SapAdtClient {
  private config: SapConfig;
  private csrfToken: string = '';
  private cookies: string[] = [];
  private agent: https.Agent | undefined;
  private authStrategy: AuthStrategy | null = null;

  constructor(config: SapConfig, authStrategy?: AuthStrategy) {
    this.config = config;
    this.authStrategy = authStrategy || null;

    // Only create HTTPS agent when the base URL actually uses HTTPS
    const isHttps = config.baseUrl.startsWith('https');
    if (isHttps) {
      if (authStrategy?.getHttpsAgent?.()) {
        this.agent = authStrategy.getHttpsAgent!();
      } else if (config.skipSsl) {
        this.agent = new https.Agent({ rejectUnauthorized: false });
      }
    }
  }

  /** Swap auth strategy at runtime (e.g., after browser SSO login) */
  setAuthStrategy(strategy: AuthStrategy): void {
    this.authStrategy = strategy;
    const isHttps = this.config.baseUrl.startsWith('https');
    if (isHttps && strategy.getHttpsAgent?.()) {
      this.agent = strategy.getHttpsAgent!();
    }
    // Clear cached tokens when switching auth
    this.csrfToken = '';
    this.cookies = [];
  }

  getAuthStrategy(): AuthStrategy | null {
    return this.authStrategy;
  }

  /**
   * Fetch a CSRF token (required for POST/PUT/DELETE operations)
   */
  async fetchCsrfToken(): Promise<void> {
    const resp = await this.request('GET', '/sap/bc/adt/discovery', {
      headers: { 'x-csrf-token': 'fetch' },
    });
    this.csrfToken = resp.headers.get('x-csrf-token') || '';
    // Capture any new session cookies from the response
    const setCookies = resp.headers.raw()['set-cookie'];
    if (setCookies) {
      const newCookies = setCookies.map((c: string) => c.split(';')[0]);
      this.mergeCookies(newCookies);
    }
  }

  /**
   * Merge new cookies into the client's cookie jar without duplicating keys.
   */
  private mergeCookies(newCookies: string[]): void {
    const cookieMap = new Map<string, string>();
    // Existing cookies first
    for (const c of this.cookies) {
      const eqIdx = c.indexOf('=');
      if (eqIdx > 0) cookieMap.set(c.substring(0, eqIdx), c);
    }
    // New cookies overwrite
    for (const c of newCookies) {
      const eqIdx = c.indexOf('=');
      if (eqIdx > 0) cookieMap.set(c.substring(0, eqIdx), c);
    }
    this.cookies = Array.from(cookieMap.values());
  }

  /**
   * Core HTTP request method
   */
  async request(
    method: string,
    path: string,
    options: {
      headers?: Record<string, string>;
      body?: string;
      params?: Record<string, string>;
    } = {}
  ): Promise<Response> {
    const url = new URL(path, this.config.baseUrl);

    // Always add sap-client and sap-language
    url.searchParams.set('sap-client', this.config.client);
    url.searchParams.set('sap-language', this.config.language);

    // Add additional query params
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        url.searchParams.set(key, value);
      }
    }

    // Build auth headers from strategy or legacy basic auth
    const headers: Record<string, string> = { ...options.headers };

    // Collect all cookies: auth strategy cookies + client session cookies
    const allCookies = new Map<string, string>();

    if (this.authStrategy && this.authStrategy.isAuthenticated()) {
      const authHeaders = this.authStrategy.getAuthHeaders();
      for (const [key, value] of Object.entries(authHeaders)) {
        if (!value) continue;
        if (key === 'Cookie') {
          // Parse auth strategy cookies into the map
          for (const c of value.split(';')) {
            const trimmed = c.trim();
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) allCookies.set(trimmed.substring(0, eqIdx), trimmed);
          }
        } else {
          headers[key] = value;
        }
      }
    } else if (this.authStrategy?.refresh) {
      // Strategy exists but not authenticated — try to refresh
      const refreshed = await this.authStrategy.refresh();
      if (refreshed) {
        const authHeaders = this.authStrategy.getAuthHeaders();
        for (const [key, value] of Object.entries(authHeaders)) {
          if (!value) continue;
          if (key === 'Cookie') {
            for (const c of value.split(';')) {
              const trimmed = c.trim();
              const eqIdx = trimmed.indexOf('=');
              if (eqIdx > 0) allCookies.set(trimmed.substring(0, eqIdx), trimmed);
            }
          } else {
            headers[key] = value;
          }
        }
      }
    } else if (this.config.username && this.config.password) {
      // Legacy basic auth fallback
      const auth = Buffer.from(
        `${this.config.username}:${this.config.password}`
      ).toString('base64');
      headers['Authorization'] = `Basic ${auth}`;
    }

    // Add client-level session cookies (from CSRF fetch, etc.)
    for (const c of this.cookies) {
      const eqIdx = c.indexOf('=');
      if (eqIdx > 0) allCookies.set(c.substring(0, eqIdx), c);
    }

    // Set merged Cookie header
    if (allCookies.size > 0) {
      headers['Cookie'] = Array.from(allCookies.values()).join('; ');
    }

    // Include CSRF token for modifying requests
    if (['POST', 'PUT', 'DELETE'].includes(method) && this.csrfToken) {
      headers['x-csrf-token'] = this.csrfToken;
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
      body: options.body,
      // Only attach agent for HTTPS URLs — node-fetch rejects https.Agent on HTTP
      ...(url.protocol === 'https:' && this.agent ? { agent: this.agent } : {}),
    };

    console.log(`[SAP] ${method} ${url.pathname} — cookies: ${allCookies.size}, csrf: ${!!this.csrfToken}, auth: ${this.authStrategy?.isAuthenticated() ?? 'no-strategy'}`);

    const resp = await fetch(url.toString(), fetchOptions);

    // If we get a 401, try refreshing auth and retry once
    if (resp.status === 401 && this.authStrategy?.refresh) {
      console.log('[SAP] 401 received — refreshing auth and retrying...');
      const refreshed = await this.authStrategy.refresh();
      if (refreshed) {
        // Rebuild cookie map with refreshed auth cookies
        const retryCookies = new Map<string, string>();
        const freshAuthHeaders = this.authStrategy.getAuthHeaders();
        for (const [key, value] of Object.entries(freshAuthHeaders)) {
          if (!value) continue;
          if (key === 'Cookie') {
            for (const c of value.split(';')) {
              const trimmed = c.trim();
              const eqIdx = trimmed.indexOf('=');
              if (eqIdx > 0) retryCookies.set(trimmed.substring(0, eqIdx), trimmed);
            }
          } else {
            headers[key] = value;
          }
        }
        for (const c of this.cookies) {
          const eqIdx = c.indexOf('=');
          if (eqIdx > 0) retryCookies.set(c.substring(0, eqIdx), c);
        }
        if (retryCookies.size > 0) {
          headers['Cookie'] = Array.from(retryCookies.values()).join('; ');
        }
        // Re-fetch CSRF token with new cookies
        await this.fetchCsrfToken();
        if (this.csrfToken && ['POST', 'PUT', 'DELETE'].includes(method)) {
          headers['x-csrf-token'] = this.csrfToken;
        }
        return fetch(url.toString(), { ...fetchOptions, headers });
      }
    }

    // If we get a 403 with token required, re-fetch and retry
    if (resp.status === 403) {
      const tokenHeader = resp.headers.get('x-csrf-token');
      if (tokenHeader === 'Required') {
        await this.fetchCsrfToken();
        headers['x-csrf-token'] = this.csrfToken;
        // Rebuild merged cookies for retry
        const retryCookies = new Map<string, string>();
        if (this.authStrategy?.isAuthenticated()) {
          const authHeaders = this.authStrategy.getAuthHeaders();
          const cookieVal = authHeaders['Cookie'];
          if (cookieVal) {
            for (const c of cookieVal.split(';')) {
              const trimmed = c.trim();
              const eqIdx = trimmed.indexOf('=');
              if (eqIdx > 0) retryCookies.set(trimmed.substring(0, eqIdx), trimmed);
            }
          }
        }
        for (const c of this.cookies) {
          const eqIdx = c.indexOf('=');
          if (eqIdx > 0) retryCookies.set(c.substring(0, eqIdx), c);
        }
        if (retryCookies.size > 0) {
          headers['Cookie'] = Array.from(retryCookies.values()).join('; ');
        }
        return fetch(url.toString(), { ...fetchOptions, headers });
      }
    }

    return resp;
  }

  /**
   * GET request returning text
   */
  async getText(path: string, params?: Record<string, string>, accept?: string): Promise<string> {
    const resp = await this.request('GET', path, {
      headers: { Accept: accept || 'text/plain' },
      params,
    });
    if (!resp.ok) {
      throw new Error(`SAP ADT GET ${path} failed: ${resp.status} ${resp.statusText}`);
    }
    return resp.text();
  }

  /**
   * GET request returning parsed XML
   */
  async getXml(path: string, params?: Record<string, string>, accept?: string): Promise<any> {
    const text = await this.getText(path, params, accept || 'application/xml, application/atom+xml, */*');
    return parseStringPromise(text, { explicitArray: false, ignoreAttrs: false });
  }

  /**
   * POST request with XML body, returning parsed XML
   */
  async postXml(path: string, body: string, params?: Record<string, string>): Promise<any> {
    if (!this.csrfToken) {
      await this.fetchCsrfToken();
    }
    const resp = await this.request('POST', path, {
      headers: {
        'Content-Type': 'application/xml',
        Accept: 'application/xml, */*',
      },
      body,
      params,
    });
    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`SAP ADT POST ${path} failed: ${resp.status} ${resp.statusText}\n${errorText}`);
    }
    const text = await resp.text();
    if (text.trim()) {
      return parseStringPromise(text, { explicitArray: false, ignoreAttrs: false });
    }
    return { status: 'ok' };
  }

  /**
   * PUT request (for writing source code)
   */
  async putText(path: string, body: string, lockHandle?: string): Promise<void> {
    if (!this.csrfToken) {
      await this.fetchCsrfToken();
    }
    const params: Record<string, string> = {};
    if (lockHandle) {
      params['lockHandle'] = lockHandle;
    }
    const resp = await this.request('PUT', path, {
      headers: { 'Content-Type': 'text/plain' },
      body,
      params,
    });
    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`SAP ADT PUT ${path} failed: ${resp.status} ${resp.statusText}\n${errorText}`);
    }
  }

  /**
   * Lock an object for editing
   */
  async lock(objectUri: string): Promise<string> {
    if (!this.csrfToken) {
      await this.fetchCsrfToken();
    }
    const resp = await this.request('POST', objectUri, {
      headers: { Accept: 'application/xml' },
      params: { _action: 'LOCK', accessMode: 'MODIFY' },
    });
    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Lock failed for ${objectUri}: ${resp.status}\n${errorText}`);
    }
    const text = await resp.text();
    // Extract lock handle from response
    const match = text.match(/LOCK_HANDLE>(.*?)<\//);
    return match ? match[1] : '';
  }

  /**
   * Unlock an object
   */
  async unlock(objectUri: string, lockHandle: string): Promise<void> {
    await this.request('POST', objectUri, {
      params: { _action: 'UNLOCK', lockHandle },
    });
  }

  /**
   * Activate one or more objects
   */
  async activate(objectUris: string[]): Promise<string> {
    if (!this.csrfToken) {
      await this.fetchCsrfToken();
    }
    const entries = objectUris
      .map((uri) => `<adtcore:objectReference adtcore:uri="${uri}"/>`)
      .join('\n');

    const body = `<?xml version="1.0" encoding="UTF-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
${entries}
</adtcore:objectReferences>`;

    const resp = await this.request('POST', '/sap/bc/adt/activation', {
      headers: {
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
      },
      body,
      params: { method: 'activate', preauditRequested: 'true' },
    });

    return resp.text();
  }

  /**
   * Get system info
   */
  async getSystemInfo(): Promise<any> {
    return this.getXml('/sap/bc/adt/core/discovery');
  }
}
