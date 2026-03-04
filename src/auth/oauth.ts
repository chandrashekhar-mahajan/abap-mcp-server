/**
 * OAuth 2.0 Authentication Strategy
 * 
 * Uses SAP's OAuth 2.0 provider (AS ABAP).
 * Supports Authorization Code + PKCE flow (browser-based SSO).
 * 
 * Prerequisites on SAP side:
 *   1. OAuth 2.0 configured in transaction SOAUTH2
 *   2. OAuth client registered with redirect URI: http://localhost:{port}/auth/callback
 *   3. Scope includes ADT access
 * 
 * Flow:
 *   1. User visits http://localhost:3001/login
 *   2. Server redirects to SAP /sap/bc/sec/oauth2/authorize
 *   3. SAP triggers SSO (SAML/Kerberos) via IdP
 *   4. After auth, SAP redirects back with authorization code
 *   5. Server exchanges code for access + refresh tokens
 *   6. Bearer token used for all ADT API calls
 */

import fetch from 'node-fetch';
import crypto from 'crypto';
import https from 'https';
import { AuthStrategy, AuthHeaders, AuthStatus } from './types';

export interface OAuthConfig {
  sapBaseUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  callbackPort: number;
  skipSsl: boolean;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export class OAuthStrategy implements AuthStrategy {
  readonly name = 'OAuth 2.0';

  private config: OAuthConfig;
  private accessToken: string = '';
  private refreshToken: string = '';
  private expiresAt: Date | null = null;
  private codeVerifier: string = '';
  private codeChallenge: string = '';
  private state: string = '';
  private agent: https.Agent | undefined;

  constructor(config: OAuthConfig) {
    this.config = config;
    if (config.skipSsl) {
      this.agent = new https.Agent({ rejectUnauthorized: false });
    }
  }

  isAuthenticated(): boolean {
    if (!this.accessToken) return false;
    if (this.expiresAt && this.expiresAt < new Date()) return false;
    return true;
  }

  getAuthHeaders(): AuthHeaders {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  getHttpsAgent(): https.Agent | undefined {
    return this.agent;
  }

  /**
   * Generate the authorization URL for the browser redirect.
   * User visits this URL → SSO login → redirect back with code.
   */
  getAuthorizationUrl(): string {
    // Generate PKCE code verifier and challenge
    this.codeVerifier = crypto.randomBytes(32).toString('base64url');
    this.codeChallenge = crypto
      .createHash('sha256')
      .update(this.codeVerifier)
      .digest('base64url');
    this.state = crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: `http://localhost:${this.config.callbackPort}/auth/callback`,
      scope: this.config.scope || 'SAP_ADT',
      state: this.state,
      code_challenge: this.codeChallenge,
      code_challenge_method: 'S256',
    });

    // SAP OAuth authorization endpoint
    return `${this.config.sapBaseUrl}/sap/bc/sec/oauth2/authorize?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(code: string, receivedState: string): Promise<boolean> {
    if (receivedState !== this.state) {
      console.error('OAuth state mismatch — possible CSRF attack');
      return false;
    }

    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `http://localhost:${this.config.callbackPort}/auth/callback`,
        client_id: this.config.clientId,
        code_verifier: this.codeVerifier,
      });

      if (this.config.clientSecret) {
        body.set('client_secret', this.config.clientSecret);
      }

      const resp = await fetch(
        `${this.config.sapBaseUrl}/sap/bc/sec/oauth2/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          agent: this.agent,
        }
      );

      if (!resp.ok) {
        const errorText = await resp.text();
        console.error(`OAuth token exchange failed: ${resp.status} ${errorText}`);
        return false;
      }

      const tokens = (await resp.json()) as TokenResponse;
      this.accessToken = tokens.access_token;
      this.refreshToken = tokens.refresh_token || '';
      this.expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

      console.log(`OAuth authentication successful. Token expires at ${this.expiresAt.toISOString()}`);
      return true;
    } catch (err: any) {
      console.error(`OAuth token exchange error: ${err.message}`);
      return false;
    }
  }

  /**
   * Refresh the access token using the refresh token
   */
  async refresh(): Promise<boolean> {
    if (!this.refreshToken) return false;

    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.config.clientId,
      });

      if (this.config.clientSecret) {
        body.set('client_secret', this.config.clientSecret);
      }

      const resp = await fetch(
        `${this.config.sapBaseUrl}/sap/bc/sec/oauth2/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          agent: this.agent,
        }
      );

      if (!resp.ok) return false;

      const tokens = (await resp.json()) as TokenResponse;
      this.accessToken = tokens.access_token;
      if (tokens.refresh_token) this.refreshToken = tokens.refresh_token;
      this.expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

      return true;
    } catch {
      return false;
    }
  }

  async authenticate(): Promise<boolean> {
    // OAuth requires browser interaction — handled by getAuthorizationUrl() + exchangeCode()
    // If we have a refresh token, try that first
    if (this.refreshToken) {
      return this.refresh();
    }
    return false;
  }

  getStatus(): AuthStatus {
    return {
      method: 'OAuth 2.0',
      authenticated: this.isAuthenticated(),
      expiresAt: this.expiresAt?.toISOString(),
      details: this.isAuthenticated()
        ? `Token valid until ${this.expiresAt?.toISOString()}`
        : this.refreshToken
        ? 'Token expired, refresh available'
        : 'Not authenticated — visit /login to authenticate',
    };
  }
}
