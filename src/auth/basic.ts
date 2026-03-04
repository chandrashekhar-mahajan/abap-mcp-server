/**
 * Basic Authentication Strategy
 * 
 * Simple username/password authentication.
 * Works for dev/sandbox systems or technical/service users.
 */

import { AuthStrategy, AuthHeaders, AuthStatus } from './types';

export class BasicAuthStrategy implements AuthStrategy {
  readonly name = 'Basic Auth';
  private username: string;
  private password: string;

  constructor(username: string, password: string) {
    this.username = username;
    this.password = password;
  }

  isAuthenticated(): boolean {
    return !!(this.username && this.password);
  }

  getAuthHeaders(): AuthHeaders {
    const encoded = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }

  async authenticate(): Promise<boolean> {
    return this.isAuthenticated();
  }

  getStatus(): AuthStatus {
    return {
      method: 'Basic Auth',
      authenticated: this.isAuthenticated(),
      user: this.username,
      details: this.isAuthenticated() ? 'Credentials configured' : 'No credentials set',
    };
  }
}
