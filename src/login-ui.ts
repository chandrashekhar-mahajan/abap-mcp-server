/**
 * Login Web UI
 * 
 * Serves the /login page and handles authentication callbacks.
 * Supports:
 *   - OAuth 2.0 flow (redirect to SAP → IdP → back with code)
 *   - Browser SSO cookie capture (bookmarklet or manual paste)
 *   - Direct MYSAPSSO2 ticket input
 */

import express, { Router, Request, Response } from 'express';
import { AuthStrategy, OAuthStrategy, BrowserSsoStrategy } from './auth';
import { SapAdtClient } from './sap-client';

export function createLoginRouter(
  sapClient: SapAdtClient,
  authStrategies: { oauth?: OAuthStrategy; browserSso?: BrowserSsoStrategy; current: AuthStrategy },
  sapBaseUrl: string,
  sapClient_: string
): Router {
  const router = Router();

  // ─── Main Login Page ─────────────────────────────────────────────
  router.get('/login', (req: Request, res: Response) => {
    const currentAuth = authStrategies.current;
    const status = currentAuth.getStatus();

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ABAP MCP Server — Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1e1e2e; color: #cdd6f4; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 40px 20px; }
    h1 { color: #89b4fa; margin-bottom: 8px; }
    .subtitle { color: #6c7086; margin-bottom: 32px; }
    .status-bar { background: ${status.authenticated ? '#1e3a2f' : '#3a1e1e'}; border: 1px solid ${status.authenticated ? '#a6e3a1' : '#f38ba8'}; border-radius: 8px; padding: 16px 24px; margin-bottom: 32px; width: 100%; max-width: 640px; }
    .status-bar .label { font-size: 12px; text-transform: uppercase; color: #6c7086; }
    .status-bar .value { color: ${status.authenticated ? '#a6e3a1' : '#f38ba8'}; font-weight: 600; }
    .card { background: #313244; border-radius: 12px; padding: 24px; margin-bottom: 20px; width: 100%; max-width: 640px; }
    .card h2 { color: #cba6f7; margin-bottom: 12px; font-size: 18px; }
    .card p { color: #a6adc8; margin-bottom: 16px; line-height: 1.6; }
    .btn { display: inline-block; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; cursor: pointer; border: none; font-size: 14px; }
    .btn-primary { background: #89b4fa; color: #1e1e2e; }
    .btn-primary:hover { background: #74c7ec; }
    .btn-secondary { background: #45475a; color: #cdd6f4; }
    .btn-secondary:hover { background: #585b70; }
    textarea, input[type=text] { width: 100%; background: #1e1e2e; color: #cdd6f4; border: 1px solid #45475a; border-radius: 6px; padding: 10px; font-family: 'Cascadia Code', monospace; font-size: 13px; margin-bottom: 12px; resize: vertical; }
    textarea:focus, input:focus { outline: none; border-color: #89b4fa; }
    .tabs { display: flex; gap: 4px; margin-bottom: 16px; }
    .tab { padding: 8px 16px; border-radius: 6px 6px 0 0; cursor: pointer; background: #45475a; color: #a6adc8; border: none; font-size: 14px; }
    .tab.active { background: #313244; color: #cdd6f4; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .code { background: #1e1e2e; padding: 12px; border-radius: 6px; font-family: 'Cascadia Code', monospace; font-size: 12px; overflow-x: auto; margin: 12px 0; word-break: break-all; }
    .steps { counter-reset: step; list-style: none; padding: 0; }
    .steps li { counter-increment: step; padding: 8px 0 8px 36px; position: relative; color: #a6adc8; }
    .steps li::before { content: counter(step); position: absolute; left: 0; top: 8px; width: 24px; height: 24px; border-radius: 50%; background: #45475a; color: #cdd6f4; text-align: center; line-height: 24px; font-size: 12px; font-weight: 600; }
    .alert { padding: 12px 16px; border-radius: 6px; margin: 12px 0; }
    .alert-success { background: #1e3a2f; border: 1px solid #a6e3a1; color: #a6e3a1; }
    .alert-error { background: #3a1e1e; border: 1px solid #f38ba8; color: #f38ba8; }
    #result { display: none; }
  </style>
</head>
<body>
  <h1>ABAP MCP Server</h1>
  <p class="subtitle">Authentication for SAP ADT Tools</p>

  <div class="status-bar">
    <span class="label">Current Status:</span>
    <span class="value">${status.authenticated ? '✓ Authenticated' : '✗ Not Authenticated'}</span>
    <span style="color: #6c7086"> — ${status.method}: ${status.details || ''}</span>
  </div>

  <div id="result"></div>

  <div class="tabs">
    <button class="tab active" onclick="switchTab('oauth')">OAuth 2.0</button>
    <button class="tab" onclick="switchTab('sso')">Browser SSO</button>
    <button class="tab" onclick="switchTab('cookie')">Cookie / Ticket</button>
  </div>

  <!-- OAuth 2.0 Tab -->
  <div id="tab-oauth" class="tab-content active">
    <div class="card">
      <h2>OAuth 2.0 Authorization Code Flow</h2>
      <p>Best for SSO-enabled SAP systems with OAuth configured (transaction SOAUTH2). 
         Redirects to your corporate Identity Provider for authentication.</p>
      <ol class="steps">
        <li>Click "Login with OAuth" below</li>
        <li>Authenticate at your corporate IdP (SSO/SAML)</li>
        <li>You'll be redirected back here automatically</li>
      </ol>
      <br>
      <a href="/auth/oauth/start" class="btn btn-primary">Login with OAuth 2.0</a>
      <p style="margin-top:12px; color:#6c7086; font-size:12px;">
        Requires: OAuth client configured in SAP SOAUTH2 with redirect URI 
        <code style="color:#f9e2af;">http://localhost:${req.socket.localPort}/auth/callback</code>
      </p>
    </div>
  </div>

  <!-- Browser SSO Tab -->
  <div id="tab-sso" class="tab-content">
    <div class="card">
      <h2>Browser SSO — Cookie Capture</h2>
      <p>For SAML/Kerberos SSO systems without OAuth. Log in to SAP in your browser, 
         then use the bookmarklet to transfer your session to the MCP server.</p>
      <ol class="steps">
        <li>Open SAP in your browser: <a href="${sapBaseUrl}/sap/bc/gui/sap/its/webgui?sap-client=${sapClient_}" target="_blank" style="color:#89b4fa;">${sapBaseUrl}</a></li>
        <li>Authenticate via your corporate SSO</li>
        <li>Drag this bookmarklet to your bookmarks bar:</li>
      </ol>
      <div class="code" style="margin:16px 0;">
        <a href="javascript:void(fetch('http://localhost:${req.socket.localPort}/auth/cookies',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookies:document.cookie,url:location.href})}).then(r=>r.json()).then(d=>alert(d.message)).catch(e=>alert('Error: '+e)))" 
           style="color:#f9e2af; text-decoration:none; cursor:grab;"
           ondragstart="return true;">
          📋 Send SAP Cookies to MCP
        </a>
      </div>
      <p style="color:#6c7086; font-size:12px;">After logging into SAP in your browser, click the bookmarklet. It will transfer your session cookies to this MCP server.</p>
    </div>
  </div>

  <!-- Manual Cookie/Ticket Tab -->
  <div id="tab-cookie" class="tab-content">
    <div class="card">
      <h2>Manual Cookie / SSO Ticket Input</h2>
      <p>Paste SAP session cookies or MYSAPSSO2 logon ticket directly. 
         Get these from your browser's DevTools (F12 → Application → Cookies).</p>
      
      <label style="display:block; margin-bottom: 4px; color: #a6adc8; font-size: 13px;">MYSAPSSO2 Ticket:</label>
      <input type="text" id="ssoTicket" placeholder="Paste MYSAPSSO2 cookie value here...">
      
      <label style="display:block; margin-bottom: 4px; color: #a6adc8; font-size: 13px;">— or full cookie string —</label>
      <textarea id="cookieString" rows="4" placeholder="SAP_SESSIONID_A4H_001=xxx; MYSAPSSO2=xxx; sap-usercontext=xxx"></textarea>
      
      <button class="btn btn-primary" onclick="submitCookies()">Set Cookies</button>
      <button class="btn btn-secondary" onclick="validateSession()" style="margin-left:8px;">Validate Session</button>
    </div>
  </div>

  <script>
    function switchTab(tab) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
      document.getElementById('tab-' + tab).classList.add('active');
      event.target.classList.add('active');
    }

    function showResult(message, isError) {
      const el = document.getElementById('result');
      el.style.display = 'block';
      el.className = 'alert ' + (isError ? 'alert-error' : 'alert-success');
      el.textContent = message;
      setTimeout(() => { el.style.display = 'none'; }, 8000);
    }

    async function submitCookies() {
      const ticket = document.getElementById('ssoTicket').value.trim();
      const cookieStr = document.getElementById('cookieString').value.trim();

      if (!ticket && !cookieStr) {
        showResult('Please enter a MYSAPSSO2 ticket or cookie string', true);
        return;
      }

      try {
        const resp = await fetch('/auth/cookies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ssoTicket: ticket || undefined,
            cookies: cookieStr || undefined,
          }),
        });
        const data = await resp.json();
        showResult(data.message, !data.success);
        if (data.success) setTimeout(() => location.reload(), 1500);
      } catch (e) {
        showResult('Error: ' + e.message, true);
      }
    }

    async function validateSession() {
      try {
        const resp = await fetch('/auth/validate');
        const data = await resp.json();
        showResult(data.message, !data.valid);
      } catch (e) {
        showResult('Error: ' + e.message, true);
      }
    }
  </script>
</body>
</html>`);
  });

  // ─── OAuth 2.0: Start Authorization ──────────────────────────────
  router.get('/auth/oauth/start', (req: Request, res: Response) => {
    if (!authStrategies.oauth) {
      res.status(400).json({
        error: 'OAuth not configured. Set OAUTH_CLIENT_ID in .env',
      });
      return;
    }
    const authUrl = authStrategies.oauth.getAuthorizationUrl();
    res.redirect(authUrl);
  });

  // ─── OAuth 2.0: Callback ────────────────────────────────────────
  router.get('/auth/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    const error = req.query.error as string;

    if (error) {
      res.send(`<h2>OAuth Error</h2><p>${error}: ${req.query.error_description || ''}</p><a href="/login">Try again</a>`);
      return;
    }

    if (!code || !authStrategies.oauth) {
      res.redirect('/login');
      return;
    }

    const success = await authStrategies.oauth.exchangeCode(code, state);
    if (success) {
      // Switch the SAP client to use OAuth
      sapClient.setAuthStrategy(authStrategies.oauth);
      authStrategies.current = authStrategies.oauth;
      res.redirect('/login');
    } else {
      res.send(`<h2>Authentication Failed</h2><p>Could not exchange authorization code for token.</p><a href="/login">Try again</a>`);
    }
  });

  // ─── Browser SSO: Receive Cookies ───────────────────────────────
  router.post('/auth/cookies', express.json(), async (req: Request, res: Response) => {
    const { cookies, ssoTicket, url } = req.body;

    if (!authStrategies.browserSso) {
      // Create browser SSO strategy on the fly
      const { BrowserSsoStrategy } = require('./auth/browser-sso');
      authStrategies.browserSso = new BrowserSsoStrategy({
        sapBaseUrl,
        sapClient: sapClient_,
        skipSsl: true,
      });
    }

    const sso = authStrategies.browserSso!;

    if (ssoTicket) {
      sso.setSsoTicket(ssoTicket);
    } else if (cookies) {
      // Parse cookie string into array
      const cookieArr = typeof cookies === 'string'
        ? cookies.split(';').map((c: string) => c.trim()).filter(Boolean)
        : cookies;
      sso.setCookies(cookieArr);
    } else {
      res.json({ success: false, message: 'No cookies or SSO ticket provided' });
      return;
    }

    // Validate the session
    const valid = await sso.validate();
    if (valid) {
      sapClient.setAuthStrategy(sso);
      authStrategies.current = sso;
      res.json({ success: true, message: '✓ Authenticated! SAP session captured. MCP tools are now active.' });
    } else {
      res.json({ success: false, message: '✗ Session validation failed. Cookies may be expired or invalid.' });
    }
  });

  // ─── Validate Current Session ───────────────────────────────────
  router.get('/auth/validate', async (req: Request, res: Response) => {
    const strategy = sapClient.getAuthStrategy() || authStrategies.current;

    if (!strategy.isAuthenticated()) {
      res.json({ valid: false, message: 'Not authenticated. Visit /login to authenticate.' });
      return;
    }

    // For browser SSO, validate against SAP
    if (strategy instanceof BrowserSsoStrategy) {
      const valid = await strategy.validate();
      res.json({ valid, message: valid ? '✓ Session is valid' : '✗ Session expired' });
      return;
    }

    // For OAuth, check expiry
    if (strategy instanceof OAuthStrategy) {
      if (!strategy.isAuthenticated()) {
        const refreshed = await strategy.refresh?.();
        res.json({ valid: !!refreshed, message: refreshed ? '✓ Token refreshed' : '✗ Token expired, re-login required' });
        return;
      }
    }

    res.json({ valid: true, message: `✓ Authenticated via ${strategy.name}`, ...strategy.getStatus() });
  });

  // ─── Auth Status API ────────────────────────────────────────────
  router.get('/auth/status', (req: Request, res: Response) => {
    res.json(authStrategies.current.getStatus());
  });

  return router;
}
