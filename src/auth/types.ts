/**
 * Authentication Strategy Interface
 * 
 * All SAP authentication methods implement this interface.
 * The MCP server supports multiple auth strategies:
 * 
 *  1. Basic Auth        — username/password (for dev/sandbox systems)
 *  2. OAuth 2.0         — Authorization Code + PKCE (for SSO-enabled systems)
 *  3. Browser SSO Login — Interactive browser login with cookie capture
 *  4. X.509 Certificate — Client certificate authentication
 */

import https from 'https';

export interface AuthHeaders {
  Authorization?: string;
  Cookie?: string;
  [key: string]: string | undefined;
}

export interface AuthStrategy {
  /** Human-readable name of this auth method */
  readonly name: string;

  /** Whether this strategy is currently authenticated / has valid credentials */
  isAuthenticated(): boolean;

  /** Get HTTP headers to attach to SAP ADT requests */
  getAuthHeaders(): AuthHeaders;

  /** Get HTTPS agent (for client certificates or custom SSL) */
  getHttpsAgent?(): https.Agent | undefined;

  /** 
   * Initialize / refresh authentication. 
   * For interactive strategies, this may require user action.
   * Returns true if authentication succeeded.
   */
  authenticate(): Promise<boolean>;

  /** Handle session expiry / token refresh */
  refresh?(): Promise<boolean>;

  /** Get status info for health endpoint */
  getStatus(): AuthStatus;
}

export interface AuthStatus {
  method: string;
  authenticated: boolean;
  user?: string;
  expiresAt?: string;
  details?: string;
}
