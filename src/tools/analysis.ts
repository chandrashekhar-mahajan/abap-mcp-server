/**
 * Analysis & System Tools
 * 
 * Implements: analyze_abap_dumps, get_sap_system_info, manage_transport_requests
 */

import { SapAdtClient } from '../sap-client';
import { parseStringPromise } from 'xml2js';

// Accept headers that cover SAP ADT Atom feeds and generic XML
const ATOM_ACCEPT = 'application/atom+xml, application/xml, */*';

/**
 * Analyze ABAP runtime dumps (ST22 equivalent)
 * ADT API: GET /sap/bc/adt/runtime/dumps
 */
export async function analyzeAbapDumps(
  client: SapAdtClient,
  args: {
    dateFrom?: string;
    dateTo?: string;
    user?: string;
    maxResults?: number;
  }
): Promise<string> {
  try {
    const params: Record<string, string> = {};
    if (args.dateFrom) params['dateFrom'] = args.dateFrom;
    if (args.dateTo) params['dateTo'] = args.dateTo;
    if (args.user) params['user'] = args.user.toUpperCase();
    if (args.maxResults) params['maxResults'] = String(args.maxResults);

    // Use request() directly with proper Accept header for Atom feed
    const resp = await client.request('GET', '/sap/bc/adt/runtime/dumps', {
      headers: { Accept: ATOM_ACCEPT },
      params,
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      // Try alternative endpoint on older systems
      const resp2 = await client.request('GET', '/sap/bc/adt/runtime/dumps/feed', {
        headers: { Accept: ATOM_ACCEPT },
        params,
      });
      if (resp2.ok) {
        const text2 = await resp2.text();
        const result2 = await parseStringPromise(text2, { explicitArray: false, ignoreAttrs: false });
        return formatDumps(result2, args.maxResults);
      }
      return `Error retrieving dumps (${resp.status} ${resp.statusText}):\n${errorText.substring(0, 500)}`;
    }

    const text = await resp.text();
    const result = await parseStringPromise(text, { explicitArray: false, ignoreAttrs: false });
    return formatDumps(result, args.maxResults);
  } catch (err: any) {
    return `Error analyzing dumps: ${err.message}`;
  }
}

/**
 * Strip HTML tags and decode common entities
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h4>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' | ')
    .replace(/<\/th>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract key fields from the HTML dump summary
 */
function extractDumpDetails(html: string): Record<string, string> {
  const details: Record<string, string> = {};

  // Extract fields from HTML table in header section
  const fieldPatterns: [string, RegExp][] = [
    ['Runtime Error', /Runtime Error[^<]*<\/b><\/td><td[^>]*>\s*(.*?)\s*<\/td>/i],
    ['Exception', /Exception[^<]*<\/b><\/td><td[^>]*>\s*(.*?)\s*<\/td>/i],
    ['Program', /Program[^<]*<\/b><\/td><td[^>]*>\s*(.*?)\s*<\/td>/i],
    ['Short Text', /Short Text[^<]*<\/b><\/td><td[^>]*>\s*(.*?)\s*<\/td>/i],
    ['Date/Time', /Date\/Time[^<]*<\/b><\/td><td[^>]*>\s*(.*?)\s*<\/td>/i],
    ['User', /User[^<]*<\/b><\/td><td[^>]*>\s*(.*?)\s*<\/td>/i],
    ['Client', /Client[^<]*<\/b><\/td><td[^>]*>\s*(.*?)\s*<\/td>/i],
  ];

  for (const [name, pattern] of fieldPatterns) {
    const match = html.match(pattern);
    if (match) {
      details[name] = stripHtml(match[1]).replace(/\s*\|\s*$/, '').trim();
    }
  }

  // Extract "What happened?" section
  const whatMatch = html.match(/What happened\?<\/h4>([\s\S]*?)(?=<h4|$)/i);
  if (whatMatch) {
    const text = stripHtml(whatMatch[1]).trim();
    if (text) details['What happened'] = text.substring(0, 300);
  }

  // Extract "Error analysis" section
  const errorMatch = html.match(/Error analysis<\/h4>([\s\S]*?)(?=<h4|$)/i);
  if (errorMatch) {
    const text = stripHtml(errorMatch[1]).trim();
    if (text) details['Error analysis'] = text.substring(0, 500);
  }

  // Extract call stack (just procedure names)
  const stackMatch = html.match(/Active Calls\/Events<\/h4>[\s\S]*?<\/style>([\s\S]*?)$/i);
  if (stackMatch) {
    const rows = stackMatch[1].match(/<tr>([\s\S]*?)<\/tr>/gi);
    if (rows) {
      const calls: string[] = [];
      for (const row of rows.slice(0, 10)) {
        // Skip header rows
        if (/<th/i.test(row)) continue;
        // Extract all <td> cell contents, stripping inner HTML
        const cellMatches = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
        if (cellMatches && cellMatches.length >= 5) {
          const cellText = cellMatches.map(c => c.replace(/<[^>]+>/g, '').trim());
          // Columns: No, Event, Program, Include, Line
          const num = cellText[0];
          const event = cellText[1];
          const include = cellText[3];
          const line = cellText[4];
          if (event) calls.push(`  #${num}: ${event} (${include}:${line})`);
        }
      }
      if (calls.length > 0) details['Call Stack'] = '\n' + calls.join('\n');
    }
  }

  return details;
}

function formatDumps(result: any, maxResults?: number): string {
    const dumps = result?.['atom:feed']?.['atom:entry'] ||
                  result?.['feed']?.['entry'] ||
                  result?.['asx:abap']?.['asx:values'] ||
                  [];

    if (!dumps || (Array.isArray(dumps) && dumps.length === 0)) {
      return 'No runtime dumps found for the specified criteria.';
    }

    const dumpArr = Array.isArray(dumps) ? dumps : [dumps];
    const output: string[] = ['ABAP Runtime Dumps', '═'.repeat(50)];
    const limit = maxResults || 20;

    for (const dump of dumpArr.slice(0, limit)) {
      const title = dump['atom:title'] || dump['title'] || dump?.['$']?.['atom:title'] || 'Unknown';
      const titleStr = typeof title === 'object' ? (title?.['_'] || JSON.stringify(title)) : String(title);
      const updated = dump['atom:updated'] || dump['updated'] || '';
      const rawSummary = dump['atom:summary'] || dump['summary'] || '';
      const summaryStr = typeof rawSummary === 'string' ? rawSummary : (rawSummary?.['_'] || '');
      const author = dump['atom:author']?.['atom:name'] ||
                     dump['author']?.['name'] || '';

      output.push('');
      output.push(`─── ${titleStr} ───`);
      output.push(`  Date: ${updated} | User: ${author}`);

      if (summaryStr) {
        const details = extractDumpDetails(summaryStr);
        if (details['Runtime Error']) output.push(`  Runtime Error: ${details['Runtime Error']}`);
        if (details['Exception']) output.push(`  Exception: ${details['Exception']}`);
        if (details['Program']) output.push(`  Program: ${details['Program']}`);
        if (details['Error analysis']) output.push(`  Error: ${details['Error analysis']}`);
        if (details['Call Stack']) output.push(`  Call Stack:${details['Call Stack']}`);
      }
    }

    output.push('');
    output.push(`Total shown: ${Math.min(dumpArr.length, limit)} of ${dumpArr.length}`);
    return output.join('\n');
}

/**
 * Get SAP system information
 * ADT API: GET /sap/bc/adt/core/discovery
 */
export async function getSapSystemInfo(
  client: SapAdtClient
): Promise<string> {
  try {
    const resp = await client.request('GET', '/sap/bc/adt/core/discovery', {
      headers: { Accept: 'application/atomsvc+xml, application/xml, */*' },
    });
    if (!resp.ok) {
      return `Error getting discovery info: ${resp.status} ${resp.statusText}`;
    }
    const text = await resp.text();
    const result = await parseStringPromise(text, { explicitArray: false, ignoreAttrs: false });

    const output: string[] = ['SAP System Information', '═'.repeat(40)];

    // Extract from discovery response
    const app = result?.['app:service'] || result;
    if (app?.['$']) {
      for (const [key, value] of Object.entries(app['$'])) {
        output.push(`${key}: ${value}`);
      }
    }

    // Also try system info endpoint
    try {
      const sysResp = await client.request('GET', '/sap/bc/adt/system/info', {
        headers: { Accept: 'application/xml, */*' },
      });
      if (sysResp.ok) {
        const sysText = await sysResp.text();
        const sysInfo = await parseStringPromise(sysText, { explicitArray: false, ignoreAttrs: false });
        output.push('\nDetailed System Info:');
        const flatten = (obj: any, prefix: string = '  ') => {
          if (!obj || typeof obj !== 'object') return;
          for (const [key, value] of Object.entries(obj)) {
            if (key === '$') continue;
            if (typeof value === 'string') {
              output.push(`${prefix}${key}: ${value}`);
            }
          }
        };
        flatten(sysInfo);
      }
    } catch { }

    return output.join('\n');
  } catch (err: any) {
    return `Error getting system info: ${err.message}`;
  }
}

/**
 * Manage transport requests
 * ADT API: GET/POST /sap/bc/adt/cts/transportrequests
 */
export async function manageTransportRequests(
  client: SapAdtClient,
  args: {
    action: 'list' | 'create' | 'release';
    user?: string;
    requestNumber?: string;
    description?: string;
    targetSystem?: string;
  }
): Promise<string> {
  try {
    switch (args.action) {
      case 'list': {
        const params: Record<string, string> = {};
        if (args.user) params['user'] = args.user.toUpperCase();
        params['targets'] = 'true';
        params['modifiable'] = 'true';

        const resp = await client.request('GET', '/sap/bc/adt/cts/transportrequests', {
          headers: { Accept: 'application/vnd.sap.adt.transportrequests.v1+xml, application/xml, */*' },
          params,
        });

        if (!resp.ok) {
          const errorText = await resp.text();
          return `Error listing transports (${resp.status} ${resp.statusText}):\n${errorText.substring(0, 500)}`;
        }

        const text = await resp.text();
        const result = await parseStringPromise(text, { explicitArray: false, ignoreAttrs: false });

        const requests = result?.['tm:root']?.['tm:request'] ||
                         result?.['root']?.['request'] || [];
        if (!requests || (Array.isArray(requests) && requests.length === 0)) {
          return 'No modifiable transport requests found.';
        }

        const reqArr = Array.isArray(requests) ? requests : [requests];
        const output: string[] = ['Transport Requests', '═'.repeat(50)];

        for (const req of reqArr) {
          const attrs = req['$'] || {};
          output.push(`\n${attrs['tm:number'] || attrs['number'] || '?'}`);
          output.push(`  Description: ${attrs['tm:desc'] || attrs['desc'] || ''}`);
          output.push(`  Owner: ${attrs['tm:owner'] || attrs['owner'] || ''}`);
          output.push(`  Status: ${attrs['tm:status'] || attrs['status'] || ''}`);
          output.push(`  Target: ${attrs['tm:target'] || attrs['target'] || ''}`);
        }

        return output.join('\n');
      }

      case 'release': {
        if (!args.requestNumber) {
          return 'Error: requestNumber is required for release action.';
        }
        const result = await client.postXml(
          `/sap/bc/adt/cts/transportrequests/${args.requestNumber}/newreleasejobs`,
          ''
        );
        return `Transport ${args.requestNumber} release initiated.\n${JSON.stringify(result, null, 2).substring(0, 1000)}`;
      }

      case 'create': {
        const desc = args.description || 'Created via MCP Server';
        const body = `<?xml version="1.0" encoding="UTF-8"?>
<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"
         tm:useraction="newrequest"
         tm:desc="${desc}"
         ${args.targetSystem ? `tm:target="${args.targetSystem}"` : ''}>
</tm:root>`;

        const result = await client.postXml(
          '/sap/bc/adt/cts/transportrequests',
          body
        );
        return `Transport request created:\n${JSON.stringify(result, null, 2).substring(0, 1000)}`;
      }

      default:
        return `Unknown action: ${args.action}. Use 'list', 'create', or 'release'.`;
    }
  } catch (err: any) {
    return `Error managing transports: ${err.message}`;
  }
}
