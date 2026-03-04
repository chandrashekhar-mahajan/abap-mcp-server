/**
 * Search Tools
 * 
 * Implements: search_abap_objects, search_abap_object_lines, find_where_used
 * Uses SAP ADT repository information system APIs
 */

import { SapAdtClient } from '../sap-client';

/**
 * Search for ABAP objects by name/pattern
 * ADT API: GET /sap/bc/adt/repository/informationsystem/search
 */
export async function searchAbapObjects(
  client: SapAdtClient,
  args: {
    query: string;
    objectType?: string;
    maxResults?: number;
  }
): Promise<string> {
  try {
    const params: Record<string, string> = {
      operation: 'quickSearch',
      query: args.query.toUpperCase(),
      maxResults: String(args.maxResults || 50),
    };
    if (args.objectType) {
      params['objectType'] = args.objectType;
    }

    const result = await client.getXml(
      '/sap/bc/adt/repository/informationsystem/search',
      params
    );

    // Parse the search results into a readable format
    const refs = result?.['adtcore:objectReferences']?.['adtcore:objectReference'];
    if (!refs) return 'No objects found.';

    const items = Array.isArray(refs) ? refs : [refs];
    const lines = items.map((item: any) => {
      const attrs = item['$'] || {};
      return `${attrs['adtcore:type'] || '?'} | ${attrs['adtcore:name'] || '?'} | ${attrs['adtcore:uri'] || ''}`;
    });

    return `Found ${lines.length} object(s):\n\nType | Name | URI\n${'─'.repeat(60)}\n${lines.join('\n')}`;
  } catch (err: any) {
    return `Error searching objects: ${err.message}`;
  }
}

/**
 * Search within ABAP source code (code search / grep)
 * ADT API: POST /sap/bc/adt/repository/informationsystem/textsearch
 */
export async function searchAbapObjectLines(
  client: SapAdtClient,
  args: {
    searchQuery: string;
    objectName?: string;
    objectType?: string;
    maxResults?: number;
  }
): Promise<string> {
  try {
    const params: Record<string, string> = {
      searchQuery: args.searchQuery,
      maxResults: String(args.maxResults || 100),
    };
    if (args.objectName) {
      params['objectName'] = args.objectName.toUpperCase();
    }
    if (args.objectType) {
      params['objectType'] = args.objectType;
    }

    const result = await client.postXml(
      '/sap/bc/adt/repository/informationsystem/textsearch',
      '',
      params
    );

    // Parse code search results
    const objects = result?.['cdsSearch:searchResult']?.['cdsSearch:searchResultObject'];
    if (!objects) return 'No matches found.';

    const items = Array.isArray(objects) ? objects : [objects];
    const output: string[] = [];

    for (const obj of items) {
      const attrs = obj['$'] || {};
      const name = attrs['adtcore:name'] || 'Unknown';
      const type = attrs['adtcore:type'] || '?';
      output.push(`\n── ${type}: ${name} ──`);

      const matches = obj['cdsSearch:searchResultMatch'];
      if (matches) {
        const matchArr = Array.isArray(matches) ? matches : [matches];
        for (const m of matchArr) {
          const line = m['$']?.['line'] || '?';
          const snippet = m['_'] || m['cdsSearch:snippet'] || '';
          output.push(`  Line ${line}: ${snippet.trim()}`);
        }
      }
    }

    return `Code search results for "${args.searchQuery}":\n${output.join('\n')}`;
  } catch (err: any) {
    return `Error in code search: ${err.message}`;
  }
}

/**
 * Where-Used analysis for ABAP objects
 * ADT API: POST /sap/bc/adt/repository/informationsystem/usageReferences
 */
export async function findWhereUsed(
  client: SapAdtClient,
  args: {
    objectUri: string;
    objectName?: string;
    objectType?: string;
  }
): Promise<string> {
  try {
    let uri = args.objectUri;

    // If name+type provided instead of URI, construct it
    if (!uri && args.objectName && args.objectType) {
      const typeMap: Record<string, string> = {
        'CLAS': '/sap/bc/adt/oo/classes/',
        'INTF': '/sap/bc/adt/oo/interfaces/',
        'PROG': '/sap/bc/adt/programs/programs/',
        'FUGR': '/sap/bc/adt/functions/groups/',
        'FUNC': '/sap/bc/adt/functions/groups/',
        'TABL': '/sap/bc/adt/ddic/tables/',
        'DTEL': '/sap/bc/adt/ddic/dataelements/',
        'DOMA': '/sap/bc/adt/ddic/domains/',
      };
      const basePath = typeMap[args.objectType.toUpperCase()] || '/sap/bc/adt/repository/informationsystem/objectReferences/';
      uri = `${basePath}${args.objectName.toLowerCase()}`;
    }

    const body = `<?xml version="1.0" encoding="UTF-8"?>
<usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">
  <adtcore:objectReference xmlns:adtcore="http://www.sap.com/adt/core" adtcore:uri="${uri}"/>
</usagereferences:usageReferenceRequest>`;

    const result = await client.postXml(
      '/sap/bc/adt/repository/informationsystem/usageReferences',
      body
    );

    const refs = result?.['usagereferences:usageReferenceResult']?.['usagereferences:usageReference'];
    if (!refs) return 'No usages found.';

    const items = Array.isArray(refs) ? refs : [refs];
    const output: string[] = [];

    for (const ref of items) {
      const attrs = ref['$'] || {};
      const snippets = ref['usagereferences:snippet'];
      const snippetArr = snippets ? (Array.isArray(snippets) ? snippets : [snippets]) : [];

      output.push(`${attrs['adtcore:type'] || '?'}: ${attrs['adtcore:name'] || '?'}`);
      for (const s of snippetArr) {
        output.push(`  Line ${s['$']?.line || '?'}: ${(s['_'] || '').trim()}`);
      }
    }

    return `Where-used results:\n\n${output.join('\n')}`;
  } catch (err: any) {
    return `Error in where-used search: ${err.message}`;
  }
}
