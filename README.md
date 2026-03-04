# ABAP MCP Server

A Node.js [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that connects AI assistants to SAP ABAP systems via SAP's ADT REST APIs.  
Built for **Eclipse ADT + GitHub Copilot**, but works with any MCP-compatible client (VS Code, Cursor, etc.).

Supports enterprise SSO-only environments with **5 pluggable authentication strategies** including Kerberos/SPNEGO, OAuth 2.0, X.509 certificates, Browser SSO, and basic auth.

---

## Features

- **15 ABAP development tools** exposed via MCP — search, read/write code, run tests, query data, analyze dumps
- **Kerberos/SPNEGO** support for corporate SSO systems (SAP Secure Login Client / Windows SSPI)
- **Dual MCP transport** — Streamable HTTP (modern) and legacy SSE (fallback), both on a single `/sse` endpoint
- **Automatic CSRF token management** and SAP session cookie handling
- **Login Web UI** at `/login` for interactive OAuth and Browser SSO authentication
- **Health endpoint** at `/health` to verify connectivity and auth status
- **stdio mode** available for clients that spawn the server as a child process

---

## Tools (15)

| Category | Tool | Description |
|----------|------|-------------|
| **Search** | `search_abap_objects` | Search for objects by name pattern with wildcards (programs, classes, tables, etc.) |
| **Search** | `search_abap_object_lines` | Full-text search within ABAP source code (grep-like) |
| **Search** | `find_where_used` | Where-used analysis for classes, methods, function modules, data elements |
| **Code** | `get_abap_object_lines` | Read source code with line numbers (supports line range) |
| **Code** | `get_abap_object_info` | Object metadata — package, author, creation date, transport |
| **Code** | `write_abap_source` | Write/update source code (auto lock/unlock) |
| **Code** | `abap_activate` | Activate one or more ABAP objects |
| **Code** | `get_version_history` | Version history with dates and authors |
| **Testing** | `run_unit_tests` | Execute ABAP Unit tests, returns pass/fail results |
| **Testing** | `run_atc_analysis` | Run ATC static code checks, returns findings with priorities |
| **Data** | `execute_data_query` | Execute freestyle ABAP SQL or preview table contents |
| **Data** | `get_abap_sql_syntax` | ABAP SQL quick reference (joins, aggregates, CDS, functions) |
| **System** | `analyze_abap_dumps` | List runtime dumps (ST22) — extracts error, call stack, source context |
| **System** | `get_sap_system_info` | System ID, release, kernel, database info |
| **System** | `manage_transport_requests` | List, create, or release transport requests (CTS) |

---

## Quick Start

### Prerequisites

- **Node.js 18+**
- SAP system with ADT services enabled (ICF service `/sap/bc/adt` active)
- Network access to the SAP server
- One of: domain credentials (Kerberos), SAP username/password, OAuth client, X.509 cert, or browser SSO access

### Install & Build

```bash
cd abap-mcp-server
npm install
npm run build
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
# SAP connection
SAP_BASE_URL=http://your-sap-server:8000
SAP_CLIENT=100
SAP_LANGUAGE=en

# Authentication (see Authentication section below)
AUTH_METHOD=kerberos          # or: basic, oauth, certificate, browser_sso, auto

# Server
SERVER_MODE=sse
SSE_PORT=3001
```

### Run

```bash
# SSE mode (recommended for Eclipse ADT)
npm run start:sse

# stdio mode (for clients that spawn the process)
npm start
```

The server starts at `http://localhost:3001`:

| Endpoint | Purpose |
|----------|---------|
| `/sse` | MCP endpoint (Streamable HTTP + legacy SSE) |
| `/login` | Interactive login UI (OAuth / Browser SSO) |
| `/health` | Health check with auth status (JSON) |
| `/auth/status` | Current authentication status |
| `/auth/validate` | Validate current session |

---

## Authentication

Five pluggable strategies. Set `AUTH_METHOD` in `.env`:

| Method | `AUTH_METHOD` value | When to use |
|--------|-------------------|-------------|
| **Kerberos/SPNEGO** | `kerberos` or `spnego` | Corporate SSO with SAP Secure Login Client on Windows |
| **Basic Auth** | `basic` | Dev/sandbox systems with username + password |
| **OAuth 2.0** | `oauth` | SSO environments with OAuth configured in SAP (SOAUTH2) |
| **X.509 Certificate** | `certificate` or `cert` | Certificate-based mutual TLS systems |
| **Browser SSO** | `browser_sso` or `sso` | Any SSO mechanism (SAML, Kerberos) via cookie capture |
| **Auto-detect** | `auto` (default) | Tries basic → certificate → OAuth → browser SSO |

### Kerberos/SPNEGO (Recommended for Corporate SSO)

Uses Windows SSPI to obtain SPNEGO tokens from the current user's Kerberos TGT. Works seamlessly with SAP Secure Login Client — no passwords stored.

```env
AUTH_METHOD=kerberos

# Optional — auto-detected from SAP_BASE_URL hostname
# KERBEROS_REALM=CORP.EXAMPLE.COM
# KERBEROS_SPN=HTTP/sapserver.corp.example.com@CORP.EXAMPLE.COM
```

**Requirements:**
- Windows domain-joined machine
- SAP Secure Login Client running (with valid Kerberos token)
- SAP ICF service has SPNego authentication enabled

**How it works:**
1. Server starts → uses SSPI to get a SPNEGO token from your Kerberos TGT
2. Sends `Authorization: Negotiate <token>` to SAP
3. SAP returns MYSAPSSO2 session cookies → reused for all subsequent API calls
4. MCP tools are immediately available — fully automatic, no interactive login needed

### Basic Auth

```env
AUTH_METHOD=basic
SAP_USERNAME=developer
SAP_PASSWORD=your_password
```

### OAuth 2.0

Requires an OAuth client configured in SAP (transaction `SOAUTH2`):

```env
AUTH_METHOD=oauth
OAUTH_CLIENT_ID=your_client_id
OAUTH_CLIENT_SECRET=your_client_secret
OAUTH_SCOPE=SAP_ADT
```

**Flow:**
1. Start server → open `http://localhost:3001/login`
2. Click **Start OAuth Login** → redirected to SAP → SAML/SSO → authorized
3. SAP redirects back with authorization code → server exchanges for access token
4. Token auto-refreshes; MCP tools are now active

### X.509 Client Certificate

```env
AUTH_METHOD=certificate
CLIENT_CERT_PATH=./certs/client.pem
CLIENT_KEY_PATH=./certs/client-key.pem
CA_CERT_PATH=./certs/ca.pem              # optional
CLIENT_KEY_PASSPHRASE=optional_passphrase  # optional
```

### Browser SSO / Cookie Capture

Works with any SSO mechanism. No SAP-side configuration needed.

```env
AUTH_METHOD=browser_sso
```

**Flow:**
1. Start server → open `http://localhost:3001/login`
2. Log into SAP in your browser (SSO handles it)
3. Use the provided bookmarklet to capture your session cookies
4. Paste into the login page → MCP tools are now active

---

## Eclipse ADT Setup

### 1. Start the Server

```bash
cd abap-mcp-server
npm run start:sse
```

### 2. Configure MCP in Eclipse

1. Open **Window → Preferences → GitHub Copilot → Model Context Protocol**
2. In **Server Configurations**, enter:

```json
{
  "servers": {
    "abap-tools": {
      "url": "http://localhost:3001/sse"
    }
  }
}
```

3. Click **Apply and Close**

### 3. Verify

Open GitHub Copilot chat in Eclipse ADT and ask:

> "What ABAP tools are available?"

---

## Usage Examples

### Search

- _"Search for all classes starting with ZCL\_MATERIAL"_
- _"Find all code that references BAPI\_SALESORDER\_CREATEFROMDAT2"_
- _"Where is class ZCL\_MY\_HELPER used?"_

### Code

- _"Show me the source code of program ZSALES\_REPORT"_
- _"What's the metadata for table MARA?"_
- _"Write this code to program ZTEST and activate it"_
- _"Show the version history of class ZCL\_MY\_CLASS"_

### Testing & Quality

- _"Run unit tests for class ZCL\_MY\_CLASS"_
- _"Run ATC analysis on program ZSALES\_REPORT"_

### Data Queries

- _"Show me the first 10 rows from table MARA"_
- _"SELECT matnr, maktx FROM makt WHERE spras = 'E' UP TO 20 ROWS"_

### System & Analysis

- _"Show me recent runtime dumps"_
- _"Show dumps for user JSMITH from today"_
- _"List my open transport requests"_
- _"What SAP system am I connected to?"_

---

## Architecture

```
┌──────────────────┐    Streamable HTTP     ┌─────────────────────┐   ADT REST API   ┌─────────────┐
│  Eclipse ADT     │◄──────────── /sse ───►│  ABAP MCP Server    │◄────────────────►│  SAP System │
│  + GitHub        │    (or legacy SSE)     │  (Node.js/Express)  │  /sap/bc/adt/*   │  (ABAP)     │
│    Copilot       │                        │                     │                  │             │
├──────────────────┤    MCP Protocol        │  15 Tools           │                  │  ADT APIs:  │
│  or: VS Code     │                        │  ├─ Search (3)      │                  │  - Search   │
│  or: Cursor      │                        │  ├─ Code (5)        │                  │  - Source   │
│  or: any MCP     │                        │  ├─ Testing (2)     │                  │  - Tests    │
│    client        │                        │  ├─ Data (2)        │                  │  - ATC      │
└──────────────────┘                        │  └─ System (3)      │                  │  - Dumps    │
                                            │                     │                  │  - CTS      │
┌──────────────────┐   /login               │  Auth Strategies:   │                  └─────────────┘
│  Browser         │──────────────────────►│  ├─ Kerberos/SPNEGO │                        ▲
│  (for SSO login) │                        │  ├─ Basic Auth      │   SPNEGO / mTLS /     │
└──────────────────┘                        │  ├─ OAuth 2.0 PKCE  │   SAP cookies         │
                                            │  ├─ X.509 Cert      │────────────────────────┘
                                            │  └─ Browser SSO     │
                                            └─────────────────────┘
```

---

## Multiple SAP Systems

Run multiple instances on different ports:

```bash
# Terminal 1 — Development
SAP_BASE_URL=http://dev-server:8000 SAP_CLIENT=100 SSE_PORT=3001 AUTH_METHOD=kerberos node dist/index.js

# Terminal 2 — Quality
SAP_BASE_URL=http://qa-server:8000  SAP_CLIENT=200 SSE_PORT=3002 AUTH_METHOD=kerberos node dist/index.js
```

Configure all in Eclipse ADT:

```json
{
  "servers": {
    "abap-dev": { "url": "http://localhost:3001/sse" },
    "abap-qa":  { "url": "http://localhost:3002/sse" }
  }
}
```

---

## Project Structure

```
abap-mcp-server/
├── src/
│   ├── index.ts              # Entry point — Express server, MCP transport, tool routing
│   ├── sap-client.ts         # SAP ADT HTTP client (CSRF, cookies, request/response)
│   ├── login-ui.ts           # Login web UI and auth routes
│   ├── auth/
│   │   ├── types.ts          # AuthStrategy interface
│   │   ├── basic.ts          # Basic Auth (username/password)
│   │   ├── oauth.ts          # OAuth 2.0 Authorization Code + PKCE
│   │   ├── kerberos.ts       # Kerberos/SPNEGO via Windows SSPI
│   │   ├── certificate.ts    # X.509 client certificate (mTLS)
│   │   ├── browser-sso.ts    # Browser SSO cookie capture
│   │   └── index.ts          # Auth barrel export
│   └── tools/
│       ├── search.ts         # search_abap_objects, search_abap_object_lines, find_where_used
│       ├── code.ts           # get/write source, activate, object info, version history
│       ├── testing.ts        # run_unit_tests, run_atc_analysis
│       ├── data-query.ts     # execute_data_query, get_abap_sql_syntax
│       └── analysis.ts       # analyze_abap_dumps, get_sap_system_info, manage_transport_requests
├── .env                      # Local configuration (not committed)
├── .env.example              # Configuration template
├── package.json
└── tsconfig.json
```

---

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `SAP_BASE_URL` | `https://vhcala4hci:44300` | SAP system URL (HTTP or HTTPS) |
| `SAP_CLIENT` | `001` | SAP client number |
| `SAP_LANGUAGE` | `en` | Logon language |
| `SAP_SKIP_SSL` | `false` | Skip SSL verification (for self-signed certs) |
| `AUTH_METHOD` | `auto` | `auto`, `basic`, `oauth`, `kerberos`, `certificate`, `browser_sso` |
| `SAP_USERNAME` | | SAP username (basic auth) |
| `SAP_PASSWORD` | | SAP password (basic auth) |
| `OAUTH_CLIENT_ID` | | OAuth 2.0 client ID |
| `OAUTH_CLIENT_SECRET` | | OAuth 2.0 client secret |
| `OAUTH_SCOPE` | `SAP_ADT` | OAuth scope |
| `CLIENT_CERT_PATH` | | Path to X.509 client certificate |
| `CLIENT_KEY_PATH` | | Path to private key |
| `CA_CERT_PATH` | | Path to CA certificate (optional) |
| `CLIENT_KEY_PASSPHRASE` | | Private key passphrase (optional) |
| `KERBEROS_REALM` | _(auto)_ | Kerberos realm (auto-detected from hostname) |
| `KERBEROS_SPN` | _(auto)_ | Kerberos Service Principal Name |
| `SERVER_MODE` | `sse` | `sse` (HTTP server) or `stdio` (child process) |
| `SSE_PORT` | `3001` | HTTP server port |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Connection refused | Ensure server is running and port matches Eclipse config |
| 401 Unauthorized | Check credentials; for Kerberos, verify SAP Secure Login Client is running |
| 403 Forbidden | CSRF token issue — usually resolves automatically on retry |
| 406 Not Acceptable | Server handles ADT Accept headers automatically — update to latest build |
| SSL certificate error | Set `SAP_SKIP_SSL=true` or add the CA cert |
| Tools not appearing in Copilot | Restart Eclipse ADT after changing MCP config |
| Kerberos auth fails | Check: domain-joined? SAP Secure Login Client active? SPNego enabled in SAP ICF? |
| ICF service inactive | Ask Basis to activate `/sap/bc/adt` in SICF |
| SSO session expired | For Kerberos: restart server. For browser SSO: visit `/login` |
| OAuth redirect fails | Verify `OAUTH_CLIENT_ID` and callback URI in SOAUTH2 |
| Port already in use | Change `SSE_PORT` in `.env` or kill orphaned node processes |

---

## Security

- Credentials in `.env` — add to `.gitignore` (already excluded)
- Server runs locally on `localhost` — no credentials sent externally
- Kerberos/SPNEGO never stores passwords — uses Windows domain TGT
- CSRF tokens auto-managed, session cookies kept in memory only
- Restrict the SAP user's authorizations to ADT-relevant objects
