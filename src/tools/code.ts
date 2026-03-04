/**
 * Code Reading & Writing Tools
 * 
 * Implements: get_abap_object_lines, get_abap_object_info, write_abap_source, abap_activate
 * Uses SAP ADT source code and object metadata APIs
 */

import { SapAdtClient } from '../sap-client';

/** Map of common ABAP object types to their ADT URI base paths */
const OBJECT_TYPE_PATHS: Record<string, string> = {
  'PROG': '/sap/bc/adt/programs/programs/',
  'CLAS': '/sap/bc/adt/oo/classes/',
  'INTF': '/sap/bc/adt/oo/interfaces/',
  'FUGR': '/sap/bc/adt/functions/groups/',
  'FUNC': '/sap/bc/adt/functions/groups/',
  'TABL': '/sap/bc/adt/ddic/tables/',
  'VIEW': '/sap/bc/adt/ddic/views/',
  'DTEL': '/sap/bc/adt/ddic/dataelements/',
  'DOMA': '/sap/bc/adt/ddic/domains/',
  'TTYP': '/sap/bc/adt/ddic/tabletypes/',
  'SHLP': '/sap/bc/adt/ddic/searchhelps/',
  'DDLS': '/sap/bc/adt/ddic/ddl/sources/',
  'DCLS': '/sap/bc/adt/ddic/dcl/sources/',
  'BDEF': '/sap/bc/adt/bo/behaviordefinitions/',
  'SMIM': '/sap/bc/adt/mime/',
};

function resolveUri(objectType: string, objectName: string): string {
  const base = OBJECT_TYPE_PATHS[objectType.toUpperCase()];
  if (!base) {
    return `/sap/bc/adt/repository/informationsystem/objectReferences/${objectName.toLowerCase()}`;
  }
  return `${base}${objectName.toLowerCase()}`;
}

/**
 * Read ABAP object source code
 * ADT API: GET {objectUri}/source/main
 */
export async function getAbapObjectLines(
  client: SapAdtClient,
  args: {
    objectUri?: string;
    objectName?: string;
    objectType?: string;
    startLine?: number;
    endLine?: number;
  }
): Promise<string> {
  try {
    let uri = args.objectUri;
    if (!uri && args.objectName && args.objectType) {
      uri = resolveUri(args.objectType, args.objectName);
    }
    if (!uri) {
      return 'Error: Provide either objectUri or both objectName and objectType.';
    }

    // Append /source/main for source-bearing objects
    const sourcePath = uri.includes('/source/') ? uri : `${uri}/source/main`;

    const params: Record<string, string> = {};
    if (args.startLine) params['startLine'] = String(args.startLine);
    if (args.endLine) params['endLine'] = String(args.endLine);

    const source = await client.getText(sourcePath, params, 'text/plain');
    
    // Add line numbers
    const lines = source.split('\n');
    const numbered = lines.map((line, i) => {
      const lineNum = (args.startLine || 1) + i;
      return `${String(lineNum).padStart(5)} | ${line}`;
    });

    return numbered.join('\n');
  } catch (err: any) {
    return `Error reading source: ${err.message}`;
  }
}

/**
 * Get ABAP object metadata / info
 * ADT API: GET {objectUri}
 */
export async function getAbapObjectInfo(
  client: SapAdtClient,
  args: {
    objectUri?: string;
    objectName?: string;
    objectType?: string;
  }
): Promise<string> {
  try {
    let uri = args.objectUri;
    if (!uri && args.objectName && args.objectType) {
      uri = resolveUri(args.objectType, args.objectName);
    }
    if (!uri) {
      return 'Error: Provide either objectUri or both objectName and objectType.';
    }

    const result = await client.getXml(uri);

    // Extract key metadata
    const output: string[] = [];
    const flatten = (obj: any, prefix: string = '') => {
      if (!obj || typeof obj !== 'object') return;
      for (const [key, value] of Object.entries(obj)) {
        if (key === '$') {
          // Attributes
          for (const [attrKey, attrVal] of Object.entries(value as any)) {
            output.push(`${prefix}${attrKey}: ${attrVal}`);
          }
        } else if (typeof value === 'string') {
          output.push(`${prefix}${key}: ${value}`);
        } else if (typeof value === 'object' && value !== null) {
          output.push(`${prefix}${key}:`);
          flatten(value, prefix + '  ');
        }
      }
    };

    flatten(result);
    return output.join('\n');
  } catch (err: any) {
    return `Error getting object info: ${err.message}`;
  }
}

/**
 * Write/update ABAP source code
 * Locks the object, writes source, then unlocks
 */
export async function writeAbapSource(
  client: SapAdtClient,
  args: {
    objectUri?: string;
    objectName?: string;
    objectType?: string;
    source: string;
  }
): Promise<string> {
  let uri = args.objectUri;
  if (!uri && args.objectName && args.objectType) {
    uri = resolveUri(args.objectType, args.objectName);
  }
  if (!uri) {
    return 'Error: Provide either objectUri or both objectName and objectType.';
  }

  const sourcePath = uri.includes('/source/') ? uri : `${uri}/source/main`;
  let lockHandle = '';

  try {
    // 1. Lock the object
    lockHandle = await client.lock(uri);
    if (!lockHandle) {
      return 'Error: Could not acquire lock on the object.';
    }

    // 2. Write the source
    await client.putText(sourcePath, args.source, lockHandle);

    // 3. Unlock
    await client.unlock(uri, lockHandle);

    return `Source written successfully to ${uri}`;
  } catch (err: any) {
    // Try to unlock if we acquired a lock
    if (lockHandle) {
      try {
        await client.unlock(uri, lockHandle);
      } catch { }
    }
    return `Error writing source: ${err.message}`;
  }
}

/**
 * Activate ABAP objects
 * ADT API: POST /sap/bc/adt/activation
 */
export async function activateObject(
  client: SapAdtClient,
  args: {
    objectUris?: string[];
    objectName?: string;
    objectType?: string;
  }
): Promise<string> {
  try {
    let uris = args.objectUris || [];
    if (uris.length === 0 && args.objectName && args.objectType) {
      uris = [resolveUri(args.objectType, args.objectName)];
    }
    if (uris.length === 0) {
      return 'Error: Provide objectUris array or objectName + objectType.';
    }

    const result = await client.activate(uris);

    if (result.includes('error') || result.includes('Error')) {
      return `Activation completed with issues:\n${result}`;
    }
    return `Activation successful for ${uris.length} object(s).`;
  } catch (err: any) {
    return `Activation error: ${err.message}`;
  }
}

/**
 * Get version history of an ABAP object
 * ADT API: GET {objectUri}/versions
 */
export async function getVersionHistory(
  client: SapAdtClient,
  args: {
    objectUri?: string;
    objectName?: string;
    objectType?: string;
  }
): Promise<string> {
  try {
    let uri = args.objectUri;
    if (!uri && args.objectName && args.objectType) {
      uri = resolveUri(args.objectType, args.objectName);
    }
    if (!uri) {
      return 'Error: Provide either objectUri or both objectName and objectType.';
    }

    const result = await client.getXml(`${uri}/versions`);

    const versions = result?.['versions:versions']?.['versions:version'];
    if (!versions) return 'No version history found.';

    const items = Array.isArray(versions) ? versions : [versions];
    const output = items.map((v: any) => {
      const attrs = v['$'] || {};
      return `Version ${attrs['versions:versionNumber'] || '?'} | ${attrs['versions:date'] || '?'} | ${attrs['versions:author'] || '?'} | ${attrs['versions:description'] || ''}`;
    });

    return `Version History:\n\n${output.join('\n')}`;
  } catch (err: any) {
    return `Error getting version history: ${err.message}`;
  }
}
