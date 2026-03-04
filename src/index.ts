/**
 * ABAP MCP Server - Main Entry Point
 * 
 * Replicates key ABAP FS MCP tools for use in Eclipse ADT or any MCP client.
 * Supports both stdio (local process) and SSE (HTTP server) transport modes.
 * 
 * Tools implemented:
 *   Search:     search_abap_objects, search_abap_object_lines, find_where_used
 *   Code:       get_abap_object_lines, get_abap_object_info, write_abap_source, abap_activate
 *   Testing:    run_unit_tests, run_atc_analysis
 *   Data:       execute_data_query, get_abap_sql_syntax
 *   Analysis:   analyze_abap_dumps, get_sap_system_info, manage_transport_requests, get_version_history
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';

import { SapAdtClient, SapConfig } from './sap-client';
import {
  AuthStrategy,
  BasicAuthStrategy,
  OAuthStrategy,
  BrowserSsoStrategy,
  CertAuthStrategy,
  KerberosAuthStrategy,
} from './auth';
import { createLoginRouter } from './login-ui';
import { searchAbapObjects, searchAbapObjectLines, findWhereUsed } from './tools/search';
import { getAbapObjectLines, getAbapObjectInfo, writeAbapSource, activateObject, getVersionHistory } from './tools/code';
import { runUnitTests, runAtcAnalysis } from './tools/testing';
import { executeDataQuery, getAbapSqlSyntax } from './tools/data-query';
import { analyzeAbapDumps, getSapSystemInfo, manageTransportRequests } from './tools/analysis';

dotenv.config();

// ─── SAP Connection Setup ──────────────────────────────────────────────
function getSapConfig(): SapConfig {
  return {
    baseUrl: process.env.SAP_BASE_URL || 'https://vhcala4hci:44300',
    client: process.env.SAP_CLIENT || '001',
    username: process.env.SAP_USERNAME || '',
    password: process.env.SAP_PASSWORD || '',
    language: process.env.SAP_LANGUAGE || 'en',
    skipSsl: process.env.SAP_SKIP_SSL === 'true',
  };
}

/**
 * Initialize authentication strategy based on AUTH_METHOD env var.
 * Returns { strategy, oauth?, browserSso? } for use in server + login UI.
 */
function initAuth(config: SapConfig): {
  current: AuthStrategy;
  oauth?: OAuthStrategy;
  browserSso?: BrowserSsoStrategy;
  cert?: CertAuthStrategy;
  kerberos?: KerberosAuthStrategy;
} {
  const method = (process.env.AUTH_METHOD || 'auto').toLowerCase();
  const port = parseInt(process.env.SSE_PORT || '3001', 10);

  // OAuth strategy (always create if client ID is configured)
  let oauth: OAuthStrategy | undefined;
  if (process.env.OAUTH_CLIENT_ID) {
    oauth = new OAuthStrategy({
      sapBaseUrl: config.baseUrl,
      clientId: process.env.OAUTH_CLIENT_ID,
      clientSecret: process.env.OAUTH_CLIENT_SECRET,
      scope: process.env.OAUTH_SCOPE || 'SAP_ADT',
      callbackPort: port,
      skipSsl: config.skipSsl,
    });
  }

  // Browser SSO strategy (always available)
  const browserSso = new BrowserSsoStrategy({
    sapBaseUrl: config.baseUrl,
    sapClient: config.client,
    skipSsl: config.skipSsl,
  });

  // Certificate strategy
  let cert: CertAuthStrategy | undefined;
  if (process.env.CLIENT_CERT_PATH && process.env.CLIENT_KEY_PATH) {
    cert = new CertAuthStrategy({
      certPath: process.env.CLIENT_CERT_PATH,
      keyPath: process.env.CLIENT_KEY_PATH,
      caPath: process.env.CA_CERT_PATH,
      passphrase: process.env.CLIENT_KEY_PASSPHRASE,
      skipSsl: config.skipSsl,
    });
  }

  // Kerberos/SPNEGO strategy
  let kerberos: KerberosAuthStrategy | undefined;
  const sapHostname = new URL(config.baseUrl).hostname;
  kerberos = new KerberosAuthStrategy({
    sapHostname,
    realm: process.env.KERBEROS_REALM || undefined,
    spn: process.env.KERBEROS_SPN || undefined,
    sapBaseUrl: config.baseUrl,
    sapClient: config.client,
    skipSsl: config.skipSsl,
  });

  // Select active strategy
  let current: AuthStrategy;

  switch (method) {
    case 'oauth':
      if (!oauth) throw new Error('AUTH_METHOD=oauth but OAUTH_CLIENT_ID not set');
      current = oauth;
      break;
    case 'certificate':
    case 'cert':
      if (!cert) throw new Error('AUTH_METHOD=certificate but CLIENT_CERT_PATH / CLIENT_KEY_PATH not set');
      current = cert;
      break;
    case 'browser_sso':
    case 'sso':
      current = browserSso;
      break;
    case 'kerberos':
    case 'spnego':
      current = kerberos;
      break;
    case 'basic':
      current = new BasicAuthStrategy(config.username || '', config.password || '');
      break;
    case 'auto':
    default:
      // Auto-detect: use basic if credentials exist, otherwise browser SSO
      if (config.username && config.password) {
        current = new BasicAuthStrategy(config.username, config.password);
      } else if (cert?.isAuthenticated()) {
        current = cert;
      } else if (oauth) {
        current = oauth;
      } else {
        current = browserSso;
      }
      break;
  }

  console.log(`Auth method: ${current.name} (${current.isAuthenticated() ? 'ready' : 'needs login'})`);

  return { current, oauth, browserSso, cert, kerberos };
}

// ─── Tool Definitions ──────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_abap_objects',
    description: 'Search for ABAP objects (programs, classes, interfaces, tables, etc.) by name pattern. Use wildcards like * for partial matches.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search pattern (e.g., "Z*MATERIAL*", "CL_ABAP*"). Case-insensitive. Use * as wildcard.' },
        objectType: { type: 'string', description: 'Filter by type: PROG, CLAS, INTF, FUGR, FUNC, TABL, VIEW, DTEL, DOMA, DDLS, DCLS, BDEF, etc.' },
        maxResults: { type: 'number', description: 'Max results to return (default: 50)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_abap_object_lines',
    description: 'Search within ABAP source code for a text pattern (like grep). Finds occurrences across multiple objects.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        searchQuery: { type: 'string', description: 'Text to search for in source code' },
        objectName: { type: 'string', description: 'Limit search to objects matching this name pattern' },
        objectType: { type: 'string', description: 'Limit search to this object type (PROG, CLAS, etc.)' },
        maxResults: { type: 'number', description: 'Max results (default: 100)' },
      },
      required: ['searchQuery'],
    },
  },
  {
    name: 'find_where_used',
    description: 'Find all places where an ABAP object is used (where-used analysis). Works for classes, methods, function modules, data elements, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        objectUri: { type: 'string', description: 'ADT URI of the object (e.g., /sap/bc/adt/oo/classes/cl_my_class)' },
        objectName: { type: 'string', description: 'Object name (alternative to URI, requires objectType)' },
        objectType: { type: 'string', description: 'Object type: CLAS, INTF, PROG, FUNC, TABL, DTEL, DOMA, etc.' },
      },
    },
  },
  {
    name: 'get_abap_object_lines',
    description: 'Read ABAP source code of a program, class, interface, function module, etc. Returns numbered source lines.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        objectUri: { type: 'string', description: 'ADT URI (e.g., /sap/bc/adt/programs/programs/zmyprogram)' },
        objectName: { type: 'string', description: 'Object name (alternative to URI, requires objectType)' },
        objectType: { type: 'string', description: 'Object type: PROG, CLAS, INTF, FUGR, DDLS, etc.' },
        startLine: { type: 'number', description: 'Start line number (optional)' },
        endLine: { type: 'number', description: 'End line number (optional)' },
      },
    },
  },
  {
    name: 'get_abap_object_info',
    description: 'Get metadata about an ABAP object: description, package, author, creation date, transport, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        objectUri: { type: 'string', description: 'ADT URI of the object' },
        objectName: { type: 'string', description: 'Object name (alternative to URI)' },
        objectType: { type: 'string', description: 'Object type' },
      },
    },
  },
  {
    name: 'write_abap_source',
    description: 'Write/update the source code of an ABAP object. Handles lock/unlock automatically. IMPORTANT: Always activate after writing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        objectUri: { type: 'string', description: 'ADT URI of the object' },
        objectName: { type: 'string', description: 'Object name (alternative to URI)' },
        objectType: { type: 'string', description: 'Object type' },
        source: { type: 'string', description: 'Complete ABAP source code to write' },
      },
      required: ['source'],
    },
  },
  {
    name: 'abap_activate',
    description: 'Activate one or more ABAP objects. Must be called after modifying source code.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        objectUris: { type: 'array', items: { type: 'string' }, description: 'Array of ADT URIs to activate' },
        objectName: { type: 'string', description: 'Object name (alternative to URIs)' },
        objectType: { type: 'string', description: 'Object type' },
      },
    },
  },
  {
    name: 'run_unit_tests',
    description: 'Execute ABAP Unit tests for a program, class, or function group. Returns test results with pass/fail status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        objectUri: { type: 'string', description: 'ADT URI of the object to test' },
        objectName: { type: 'string', description: 'Object name (alternative to URI)' },
        objectType: { type: 'string', description: 'Object type: PROG, CLAS, FUGR' },
      },
    },
  },
  {
    name: 'run_atc_analysis',
    description: 'Run ABAP Test Cockpit (ATC) static code analysis. Returns findings with priorities (errors, warnings, info).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        objectUri: { type: 'string', description: 'ADT URI of the object to analyze' },
        objectName: { type: 'string', description: 'Object name (alternative to URI)' },
        objectType: { type: 'string', description: 'Object type' },
        checkVariant: { type: 'string', description: 'ATC check variant (default: DEFAULT)' },
      },
    },
  },
  {
    name: 'execute_data_query',
    description: 'Execute SQL queries against SAP database tables or preview table data. Supports ABAP SQL syntax.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Full SQL query (e.g., "SELECT * FROM mara WHERE matnr LIKE \'%000001%\' UP TO 10 ROWS")' },
        tableName: { type: 'string', description: 'Table name for simple preview (alternative to full query)' },
        maxRows: { type: 'number', description: 'Maximum rows to return (default: 100)' },
        whereClause: { type: 'string', description: 'WHERE clause for table preview' },
      },
    },
  },
  {
    name: 'get_abap_sql_syntax',
    description: 'Get ABAP SQL syntax quick reference with examples for SELECT, JOIN, aggregates, subqueries, CDS views, string/date functions.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'analyze_abap_dumps',
    description: 'List and analyze ABAP runtime dumps (equivalent to transaction ST22). Filter by date, user, or program.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dateFrom: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        dateTo: { type: 'string', description: 'End date (YYYY-MM-DD)' },
        user: { type: 'string', description: 'Filter by SAP username' },
        maxResults: { type: 'number', description: 'Max dumps to return (default: 20)' },
      },
    },
  },
  {
    name: 'get_sap_system_info',
    description: 'Get SAP system information: system ID, release, kernel version, database, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'manage_transport_requests',
    description: 'List, create, or release transport requests (CTS).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'release'], description: 'Action to perform' },
        user: { type: 'string', description: 'Filter by owner (for list action)' },
        requestNumber: { type: 'string', description: 'Transport number (for release action, e.g., A4HK900001)' },
        description: { type: 'string', description: 'Description (for create action)' },
        targetSystem: { type: 'string', description: 'Target system (for create action)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'get_version_history',
    description: 'Get the version history of an ABAP object, showing all saved versions with dates and authors.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        objectUri: { type: 'string', description: 'ADT URI of the object' },
        objectName: { type: 'string', description: 'Object name (alternative to URI)' },
        objectType: { type: 'string', description: 'Object type' },
      },
    },
  },
];

// ─── Server Creation ───────────────────────────────────────────────────
function createServer(sapClient: SapAdtClient): Server {
  const server = new Server(
    {
      name: 'abap-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Register tool execution handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: string;

      switch (name) {
        case 'search_abap_objects':
          result = await searchAbapObjects(sapClient, args as any);
          break;
        case 'search_abap_object_lines':
          result = await searchAbapObjectLines(sapClient, args as any);
          break;
        case 'find_where_used':
          result = await findWhereUsed(sapClient, args as any);
          break;
        case 'get_abap_object_lines':
          result = await getAbapObjectLines(sapClient, args as any);
          break;
        case 'get_abap_object_info':
          result = await getAbapObjectInfo(sapClient, args as any);
          break;
        case 'write_abap_source':
          result = await writeAbapSource(sapClient, args as any);
          break;
        case 'abap_activate':
          result = await activateObject(sapClient, args as any);
          break;
        case 'run_unit_tests':
          result = await runUnitTests(sapClient, args as any);
          break;
        case 'run_atc_analysis':
          result = await runAtcAnalysis(sapClient, args as any);
          break;
        case 'execute_data_query':
          result = await executeDataQuery(sapClient, args as any);
          break;
        case 'get_abap_sql_syntax':
          result = await getAbapSqlSyntax();
          break;
        case 'analyze_abap_dumps':
          result = await analyzeAbapDumps(sapClient, args as any);
          break;
        case 'get_sap_system_info':
          result = await getSapSystemInfo(sapClient);
          break;
        case 'manage_transport_requests':
          result = await manageTransportRequests(sapClient, args as any);
          break;
        case 'get_version_history':
          result = await getVersionHistory(sapClient, args as any);
          break;
        default:
          result = `Unknown tool: ${name}`;
      }

      return {
        content: [{ type: 'text', text: result }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ─── Transport: stdio or SSE ───────────────────────────────────────────
async function main() {
  const useSSE = process.argv.includes('--sse') || process.env.SERVER_MODE === 'sse';
  const sapConfig = getSapConfig();
  const authStrategies = initAuth(sapConfig);

  // If Kerberos is the active strategy, auto-authenticate on startup
  if (authStrategies.current instanceof KerberosAuthStrategy) {
    console.log('\nAttempting Kerberos/SPNEGO authentication...');
    const success = await authStrategies.current.authenticate();
    if (success) {
      console.log('✓ Kerberos authentication successful — MCP tools are ready');
    } else {
      console.error('⚠ Kerberos authentication failed — tools may not work');
      console.error('  Check: Is SAP Secure Login Client running? Does SAP ICF have SPNego enabled?');
    }
  }

  const sapClient = new SapAdtClient(sapConfig, authStrategies.current);

  if (useSSE) {
    // SSE mode: Run as HTTP server (Eclipse ADT connects via URL)
    const app = express();
    app.use(express.json());
    const port = parseInt(process.env.SSE_PORT || '3001', 10);

    // Mount login UI and auth routes
    const loginRouter = createLoginRouter(
      sapClient,
      authStrategies,
      sapConfig.baseUrl,
      sapConfig.client
    );
    app.use(loginRouter);

    // ─── Streamable HTTP Transport (modern MCP clients) ──────────
    // Eclipse ADT's Copilot MCP client uses this transport first.
    // Single endpoint handles POST (messages), GET (SSE stream), DELETE (close).
    const streamableTransports: Map<string, StreamableHTTPServerTransport> = new Map();

    app.post('/sse', async (req, res) => {
      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && streamableTransports.has(sessionId)) {
        const transport = streamableTransports.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // New session — create server + transport
      const server = createServer(sapClient);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          streamableTransports.set(sid, transport);
        }
      });

      transport.onclose = () => {
        const sid = (transport as any).sessionId;
        if (sid) streamableTransports.delete(sid);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    app.get('/sse', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && streamableTransports.has(sessionId)) {
        const transport = streamableTransports.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }
      // If no session ID, this might be a legacy SSE client — handle below
      // Create a legacy SSE transport for backwards compatibility
      const server = createServer(sapClient);
      const transport = new SSEServerTransport('/messages', res);
      legacySseTransports.set(transport.sessionId, transport);
      res.on('close', () => {
        legacySseTransports.delete(transport.sessionId);
      });
      await server.connect(transport);
    });

    app.delete('/sse', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && streamableTransports.has(sessionId)) {
        const transport = streamableTransports.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
      } else {
        res.status(404).send('Session not found');
      }
    });

    // ─── Legacy SSE Transport (fallback for older clients) ───────
    const legacySseTransports: Map<string, SSEServerTransport> = new Map();

    app.post('/messages', async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const transport = legacySseTransports.get(sessionId);
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        res.status(404).send('Session not found');
      }
    });

    // Health check endpoint
    app.get('/health', (req, res) => {
      const authStatus = authStrategies.current.getStatus();
      res.json({
        status: 'ok',
        server: 'abap-mcp-server',
        version: '1.0.0',
        tools: TOOLS.length,
        sapSystem: sapConfig.baseUrl,
        auth: authStatus,
      });
    });

    app.listen(port, () => {
      console.log(`\nABAP MCP Server (SSE) running at http://localhost:${port}`);
      console.log(`  SSE endpoint:    http://localhost:${port}/sse`);
      console.log(`  Login page:      http://localhost:${port}/login`);
      console.log(`  Health check:    http://localhost:${port}/health`);
      console.log(`  SAP system:      ${sapConfig.baseUrl}`);
      console.log(`  Auth method:     ${authStrategies.current.name}`);
      console.log(`  Auth status:     ${authStrategies.current.isAuthenticated() ? '✓ Ready' : '⚠ Visit /login to authenticate'}`);
      console.log(`  Tools available: ${TOOLS.length}`);
      console.log(`\nEclipse ADT → Preferences → GitHub Copilot → MCP:`);
      console.log(`  { "servers": { "abap-tools": { "url": "http://localhost:${port}/sse" } } }`);
      if (!authStrategies.current.isAuthenticated()) {
        console.log(`\n⚠ No credentials configured. Open http://localhost:${port}/login to authenticate via SSO.`);
      }
    });
  } else {
    // stdio mode: Eclipse ADT runs this as a child process
    const server = createServer(sapClient);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('ABAP MCP Server (stdio) running');
  }
}

main().catch((err) => {
  console.error('Failed to start ABAP MCP Server:', err);
  process.exit(1);
});
