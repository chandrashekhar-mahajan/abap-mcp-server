/**
 * Kerberos / SPNEGO Authentication Strategy
 * 
 * Uses Windows SSPI (via the 'kerberos' npm package) to obtain SPNEGO tokens
 * from the current user's Kerberos TGT. This allows the MCP server to
 * authenticate to SAP systems that use SNC/Kerberos authentication (like those
 * managed by SAP Secure Login Client).
 * 
 * Flow:
 *   1. User is logged into Windows domain → has Kerberos TGT
 *   2. SAP Secure Login Client manages Kerberos tokens
 *   3. This strategy uses SSPI to get a SPNEGO token for the SAP HTTP service
 *   4. Sends "Authorization: Negotiate <token>" header
 *   5. SAP returns MYSAPSSO2 cookie → reused for subsequent requests
 * 
 * Prerequisites:
 *   - Windows domain-joined machine
 *   - SAP Secure Login Client running (with valid Kerberos token)
 *   - SAP ICF service has SPNego authentication enabled
 *   - npm package 'kerberos' installed
 */

import { AuthStrategy, AuthHeaders, AuthStatus } from './types';

export interface KerberosConfig {
  /** SAP server hostname (e.g., sapserver.corp.example.com) */
  sapHostname: string;
  /** Kerberos realm (e.g., CORP.EXAMPLE.COM). Auto-detected from hostname if not set. */
  realm?: string;
  /** Service Principal Name override (e.g., HTTP/sapserver.corp.example.com@CORP.EXAMPLE.COM) */
  spn?: string;
  /** SAP base URL — used for session validation */
  sapBaseUrl: string;
  /** SAP client number */
  sapClient: string;
  /** Skip SSL verification */
  skipSsl?: boolean;
}

export class KerberosAuthStrategy implements AuthStrategy {
  readonly name = 'Kerberos/SPNEGO';

  private config: KerberosConfig;
  private negotiateToken: string = '';
  private sessionCookies: string[] = [];
  private authenticated: boolean = false;
  private lastError: string = '';
  private kerberos: any = null;

  constructor(config: KerberosConfig) {
    this.config = config;
  }

  /**
   * Lazily load the 'kerberos' package (native module)
   */
  private async getKerberos(): Promise<any> {
    if (!this.kerberos) {
      try {
        this.kerberos = require('kerberos');
      } catch (e: any) {
        throw new Error(
          `Kerberos package not available: ${e.message}\n` +
          `Install it with: npm install kerberos\n` +
          `Requires: Python 3 + Visual Studio Build Tools (for native compilation)`
        );
      }
    }
    return this.kerberos;
  }

  /**
   * Build the SPN (Service Principal Name) for the SAP server.
   * Format: HTTP/hostname or HTTP@hostname (depends on SAP config)
   */
  private getSpn(): string {
    if (this.config.spn) return this.config.spn;

    // Standard SPN format for HTTP services
    // SAP ICF SPNego typically expects HTTP/<hostname>@<REALM>
    const hostname = this.config.sapHostname.toLowerCase();
    if (this.config.realm) {
      return `HTTP/${hostname}@${this.config.realm}`;
    }
    return `HTTP/${hostname}`;
  }

  /**
   * Perform Kerberos/SPNEGO authentication.
   * Uses Windows SSPI to obtain a SPNEGO token from the current user's TGT.
   */
  async authenticate(): Promise<boolean> {
    try {
      const kerberos = await this.getKerberos();
      const spn = this.getSpn();
      
      console.log(`[Kerberos] Initiating SPNEGO auth for SPN: ${spn}`);

      // Initialize Kerberos client using SSPI (Windows) or GSSAPI (Linux/Mac)
      const client = await kerberos.initializeClient(spn, {
        mechOID: kerberos.GSS_MECH_OID_SPNEGO,  // Use SPNEGO mechanism
      });

      // Step 1: Get the initial SPNEGO token
      const response = await client.step('');
      this.negotiateToken = response || '';

      if (!this.negotiateToken) {
        this.lastError = 'SSPI returned empty token — check Kerberos TGT (run "klist" to verify)';
        console.error(`[Kerberos] ${this.lastError}`);
        return false;
      }

      console.log(`[Kerberos] Got SPNEGO token (${this.negotiateToken.length} chars)`);

      // Step 2: Send the token to SAP to get a session
      const validated = await this.validateWithSap();
      
      if (validated) {
        this.authenticated = true;
        this.lastError = '';
        console.log(`[Kerberos] ✓ Authenticated successfully`);
      }

      return validated;
    } catch (error: any) {
      this.lastError = error.message;
      this.authenticated = false;
      console.error(`[Kerberos] Authentication failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Validate the SPNEGO token against SAP and capture session cookies.
   */
  private async validateWithSap(): Promise<boolean> {
    try {
      const fetch = (await import('node-fetch')).default;

      const url = `${this.config.sapBaseUrl}/sap/bc/adt/discovery?sap-client=${this.config.sapClient}`;

      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Negotiate ${this.negotiateToken}`,
          'x-csrf-token': 'fetch',
        },
        redirect: 'manual',
      });

      // Capture session cookies (MYSAPSSO2, SAP_SESSIONID, etc.)
      const setCookies = resp.headers.raw()['set-cookie'];
      if (setCookies) {
        this.sessionCookies = setCookies.map((c: string) => c.split(';')[0]);
        console.log(`[Kerberos] Captured ${this.sessionCookies.length} session cookies`);

        // Check for MYSAPSSO2 — if present, authentication was successful
        const hasSso = this.sessionCookies.some(c => c.startsWith('MYSAPSSO2='));
        if (hasSso) {
          console.log('[Kerberos] ✓ MYSAPSSO2 token received — SSO session active');
        }
      }

      if (resp.status === 200 || resp.status === 302) {
        return true;
      }

      // Handle mutual auth — SAP may send back a Negotiate challenge
      const wwwAuth = resp.headers.get('www-authenticate');
      if (resp.status === 401 && wwwAuth?.startsWith('Negotiate ')) {
        // Mutual authentication step — process server's response token
        const serverToken = wwwAuth.substring('Negotiate '.length);
        console.log(`[Kerberos] Mutual auth: processing server response token`);

        try {
          const kerberos = await this.getKerberos();
          const client = await kerberos.initializeClient(this.getSpn(), {
            mechOID: kerberos.GSS_MECH_OID_SPNEGO,
          });
          await client.step('');
          await client.step(serverToken);
          // Retry with updated token if needed
        } catch {
          // Mutual auth step failed — but we may still have cookies
        }

        // If we got cookies despite 401, the session might still work
        if (this.sessionCookies.length > 0) {
          return true;
        }
      }

      this.lastError = `SAP returned ${resp.status}: ${resp.statusText}`;
      console.error(`[Kerberos] Validation failed: ${this.lastError}`);
      return false;
    } catch (error: any) {
      this.lastError = `SAP connection error: ${error.message}`;
      console.error(`[Kerberos] ${this.lastError}`);
      return false;
    }
  }

  isAuthenticated(): boolean {
    return this.authenticated && (this.negotiateToken.length > 0 || this.sessionCookies.length > 0);
  }

  getAuthHeaders(): AuthHeaders {
    // Prefer session cookies over Negotiate token (session cookies are lighter)
    if (this.sessionCookies.length > 0) {
      return {
        Cookie: this.sessionCookies.join('; '),
      };
    }

    // Fall back to Negotiate token
    if (this.negotiateToken) {
      return {
        Authorization: `Negotiate ${this.negotiateToken}`,
      };
    }

    return {};
  }

  /**
   * Re-authenticate (get fresh Kerberos token + SAP session)
   */
  async refresh(): Promise<boolean> {
    console.log('[Kerberos] Refreshing SPNEGO token...');
    this.negotiateToken = '';
    this.sessionCookies = [];
    this.authenticated = false;
    return this.authenticate();
  }

  getStatus(): AuthStatus {
    return {
      method: this.name,
      authenticated: this.isAuthenticated(),
      details: this.isAuthenticated()
        ? `Authenticated via Kerberos/SPNEGO. ${this.sessionCookies.length} session cookies active.`
        : this.lastError
          ? `Not authenticated: ${this.lastError}`
          : 'Not authenticated — call authenticate() or visit /login',
    };
  }

  getHttpsAgent?(): any {
    return undefined; // SPNEGO works over regular HTTP too
  }
}
