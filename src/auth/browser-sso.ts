/**
 * Browser SSO Login Strategy
 * 
 * For SAP systems using SAML 2.0 / Kerberos SSO where OAuth is not configured.
 * 
 * How it works:
 *   1. User visits http://localhost:3001/login
 *   2. Login page opens SAP URL in a popup window
 *   3. SAP triggers SAML/Kerberos SSO → user authenticates at IdP
 *   4. After auth, SAP returns session cookies (MYSAPSSO2, SAP_SESSIONID_*)
 *   5. A bookmarklet or helper script extracts cookies and POSTs them to /auth/cookies
 *   6. MCP server stores cookies and uses them for ADT API calls
 * 
 * Alternative: User can manually paste cookies from browser DevTools.
 */

import fetch from 'node-fetch';
import https from 'https';
import { AuthStrategy, AuthHeaders, AuthStatus } from './types';

export interface BrowserSsoConfig {
  sapBaseUrl: string;
  sapClient: string;
  skipSsl: boolean;
}

export class BrowserSsoStrategy implements AuthStrategy {
  readonly name = 'Browser SSO';

  private config: BrowserSsoConfig;
  private cookies: string[] = [];
  private authenticatedUser: string = '';
  private sessionValidUntil: Date | null = null;
  private agent: https.Agent | undefined;

  constructor(config: BrowserSsoConfig) {
    this.config = config;
    if (config.skipSsl) {
      this.agent = new https.Agent({ rejectUnauthorized: false });
    }
  }

  isAuthenticated(): boolean {
    if (this.cookies.length === 0) return false;
    if (this.sessionValidUntil && this.sessionValidUntil < new Date()) return false;
    return true;
  }

  getAuthHeaders(): AuthHeaders {
    return {
      Cookie: this.cookies.join('; '),
    };
  }

  getHttpsAgent(): https.Agent | undefined {
    return this.agent;
  }

  /**
   * Set cookies captured from the browser.
   * Accepts raw cookie strings (name=value format).
   */
  setCookies(cookies: string[]): void {
    this.cookies = cookies.filter((c) => c.includes('='));
    // Session typically valid for 30 minutes
    this.sessionValidUntil = new Date(Date.now() + 30 * 60 * 1000);
  }

  /**
   * Set MYSAPSSO2 logon ticket directly.
   * This can be extracted from any SAP browser session.
   */
  setSsoTicket(ticket: string): void {
    // Remove any existing MYSAPSSO2 cookie
    this.cookies = this.cookies.filter((c) => !c.startsWith('MYSAPSSO2='));
    this.cookies.push(`MYSAPSSO2=${ticket}`);
    this.sessionValidUntil = new Date(Date.now() + 8 * 60 * 60 * 1000); // SSO tickets last ~8h
  }

  /**
   * Validate the current session by making a test request to SAP
   */
  async validate(): Promise<boolean> {
    if (this.cookies.length === 0) return false;

    try {
      const url = `${this.config.sapBaseUrl}/sap/bc/adt/discovery?sap-client=${this.config.sapClient}`;
      const resp = await fetch(url, {
        headers: { Cookie: this.cookies.join('; ') },
        agent: this.agent,
        redirect: 'manual', // Don't follow SAML redirects
      });

      if (resp.status === 200) {
        this.sessionValidUntil = new Date(Date.now() + 30 * 60 * 1000);
        return true;
      }

      // If we get a redirect (302 to IdP), session has expired
      if (resp.status === 302 || resp.status === 401) {
        this.cookies = [];
        this.sessionValidUntil = null;
        return false;
      }

      return false;
    } catch {
      return false;
    }
  }

  async authenticate(): Promise<boolean> {
    return this.validate();
  }

  async refresh(): Promise<boolean> {
    return this.validate();
  }

  /**
   * Get the SAP URL that users should visit to trigger SSO login
   */
  getLoginUrl(): string {
    return `${this.config.sapBaseUrl}/sap/bc/adt/discovery?sap-client=${this.config.sapClient}`;
  }

  /**
   * Get the bookmarklet code that extracts cookies from a SAP browser session
   */
  getBookmarkletCode(callbackUrl: string): string {
    return `javascript:void(fetch('${callbackUrl}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookies:document.cookie,url:location.href})}).then(r=>r.json()).then(d=>alert(d.message||'Done')).catch(e=>alert('Error: '+e)))`;
  }

  getStatus(): AuthStatus {
    return {
      method: 'Browser SSO',
      authenticated: this.isAuthenticated(),
      user: this.authenticatedUser || undefined,
      expiresAt: this.sessionValidUntil?.toISOString(),
      details: this.isAuthenticated()
        ? `Session active until ${this.sessionValidUntil?.toISOString()}`
        : 'Not authenticated — visit /login to authenticate via browser SSO',
    };
  }
}
