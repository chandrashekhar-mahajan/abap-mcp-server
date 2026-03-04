/**
 * X.509 Client Certificate Authentication Strategy
 * 
 * Uses client certificates for mutual TLS authentication with SAP.
 * No password required — authentication is based on the certificate.
 * 
 * Prerequisites:
 *   1. Client certificate mapped to SAP user (via transaction CERTRULE or STRUST)
 *   2. ICF services configured for certificate login
 *   3. Certificate + private key files available on the MCP server
 */

import https from 'https';
import fs from 'fs';
import { AuthStrategy, AuthHeaders, AuthStatus } from './types';

export interface CertAuthConfig {
  certPath: string;       // Path to client certificate (PEM)
  keyPath: string;        // Path to private key (PEM)
  caPath?: string;        // Path to CA cert (for SAP's server cert)
  passphrase?: string;    // Private key passphrase
  skipSsl: boolean;
}

export class CertAuthStrategy implements AuthStrategy {
  readonly name = 'X.509 Certificate';

  private config: CertAuthConfig;
  private agent: https.Agent | undefined;
  private certLoaded: boolean = false;

  constructor(config: CertAuthConfig) {
    this.config = config;
    this.loadCertificate();
  }

  private loadCertificate(): void {
    try {
      const agentOptions: https.AgentOptions = {
        rejectUnauthorized: !this.config.skipSsl,
      };

      if (this.config.certPath && fs.existsSync(this.config.certPath)) {
        agentOptions.cert = fs.readFileSync(this.config.certPath);
      }
      if (this.config.keyPath && fs.existsSync(this.config.keyPath)) {
        agentOptions.key = fs.readFileSync(this.config.keyPath);
      }
      if (this.config.passphrase) {
        agentOptions.passphrase = this.config.passphrase;
      }
      if (this.config.caPath && fs.existsSync(this.config.caPath)) {
        agentOptions.ca = fs.readFileSync(this.config.caPath);
      }

      this.agent = new https.Agent(agentOptions);
      this.certLoaded = !!(agentOptions.cert && agentOptions.key);

      if (this.certLoaded) {
        console.log(`Certificate loaded from ${this.config.certPath}`);
      }
    } catch (err: any) {
      console.error(`Failed to load certificate: ${err.message}`);
      this.certLoaded = false;
    }
  }

  isAuthenticated(): boolean {
    return this.certLoaded;
  }

  getAuthHeaders(): AuthHeaders {
    // Certificate auth doesn't need Authorization header — TLS handles it
    return {};
  }

  getHttpsAgent(): https.Agent | undefined {
    return this.agent;
  }

  async authenticate(): Promise<boolean> {
    this.loadCertificate();
    return this.certLoaded;
  }

  getStatus(): AuthStatus {
    return {
      method: 'X.509 Certificate',
      authenticated: this.certLoaded,
      details: this.certLoaded
        ? `Certificate: ${this.config.certPath}`
        : `Certificate not loaded. Cert: ${this.config.certPath}, Key: ${this.config.keyPath}`,
    };
  }
}
