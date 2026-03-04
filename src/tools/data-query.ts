/**
 * Data Query Tools
 * 
 * Implements: execute_data_query, get_abap_sql_syntax
 * Uses SAP ADT data preview / SQL console APIs
 */

import { SapAdtClient } from '../sap-client';
import { parseStringPromise } from 'xml2js';

// SAP ADT data preview content types
const DATA_PREVIEW_ACCEPT = [
  'application/vnd.sap.adt.datapreview.table.v1+xml',
  'application/xml',
].join(', ');

/**
 * Execute a data query / SQL preview on SAP tables
 * ADT API: POST /sap/bc/adt/datapreview/freestyle
 * or GET /sap/bc/adt/datapreview/ddic?objectName={table}&maxRows={n}
 */
export async function executeDataQuery(
  client: SapAdtClient,
  args: {
    query?: string;
    tableName?: string;
    maxRows?: number;
    whereClause?: string;
  }
): Promise<string> {
  try {
    const maxRows = args.maxRows || 100;

    if (args.query) {
      // Freestyle SQL query — body is plain text SQL, not XML
      const resp = await client.request('POST', '/sap/bc/adt/datapreview/freestyle', {
        headers: {
          'Content-Type': 'text/plain',
          Accept: DATA_PREVIEW_ACCEPT,
        },
        body: args.query,
        params: { rowNumber: String(maxRows) },
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        return `Error executing freestyle query (${resp.status} ${resp.statusText}):\n${errorText.substring(0, 1000)}`;
      }

      const text = await resp.text();
      const result = await parseStringPromise(text, { explicitArray: false, ignoreAttrs: false });
      return formatQueryResults(result);
    }

    if (args.tableName) {
      // Simple table preview — use freestyle SQL for reliability
      // (DDIC endpoint has parameter compatibility issues across SAP versions)
      const sql = args.whereClause
        ? `SELECT * FROM ${args.tableName.toUpperCase()} WHERE ${args.whereClause} UP TO ${maxRows} ROWS`
        : `SELECT * FROM ${args.tableName.toUpperCase()} UP TO ${maxRows} ROWS`;

      const resp = await client.request('POST', '/sap/bc/adt/datapreview/freestyle', {
        headers: {
          'Content-Type': 'text/plain',
          Accept: DATA_PREVIEW_ACCEPT,
        },
        body: sql,
        params: { rowNumber: String(maxRows) },
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        return `Error querying table ${args.tableName} (${resp.status} ${resp.statusText}):\n${errorText.substring(0, 1000)}`;
      }

      const text = await resp.text();
      const result = await parseStringPromise(text, { explicitArray: false, ignoreAttrs: false });
      return formatQueryResults(result);
    }

    return 'Error: Provide either a SQL query or a tableName.';
  } catch (err: any) {
    return `Error executing query: ${err.message}`;
  }
}

function formatQueryResults(result: any): string {
  try {
    // ADT data preview returns column-oriented data
    const dataPreview = result?.['dataPreview:tableData'] || result?.['tableData'] || result;
    const totalRows = dataPreview?.['dataPreview:totalRows'] || dataPreview?.['totalRows'] || '?';
    const execTime = dataPreview?.['dataPreview:queryExecutionTime'] || '';

    // Columns array — each element has metadata + dataSet
    let columns = dataPreview?.['dataPreview:columns'] || dataPreview?.['columns'] || [];
    const colArr: any[] = Array.isArray(columns) ? columns : [columns];

    if (colArr.length === 0) {
      return `Query executed. Raw result:\n${JSON.stringify(result, null, 2).substring(0, 3000)}`;
    }

    // Extract column names from metadata attributes
    const colNames = colArr.map((col: any) => {
      const meta = col?.['dataPreview:metadata'] || col?.['metadata'] || {};
      const attrs = meta?.['$'] || meta;
      return attrs?.['dataPreview:name'] || attrs?.['name'] || '?';
    });

    // Extract data arrays from each column's dataSet
    const dataArrays = colArr.map((col: any) => {
      const dataSet = col?.['dataPreview:dataSet'] || col?.['dataSet'] || {};
      const data = dataSet?.['dataPreview:data'] || dataSet?.['data'] || [];
      return Array.isArray(data) ? data : [data];
    });

    const rowCount = dataArrays[0]?.length || 0;

    if (rowCount === 0) {
      return `Query returned 0 rows. Columns: ${colNames.join(', ')}`;
    }

    // Calculate column widths for alignment
    const colWidths = colNames.map((name: string, i: number) => {
      let maxLen = name.length;
      for (let r = 0; r < rowCount; r++) {
        const val = String(dataArrays[i]?.[r] ?? '');
        if (val.length > maxLen) maxLen = val.length;
      }
      return Math.min(maxLen, 30); // cap at 30 chars
    });

    const output: string[] = [];

    // Header
    output.push(colNames.map((n: string, i: number) => n.padEnd(colWidths[i])).join(' | '));
    output.push(colWidths.map((w: number) => '─'.repeat(w)).join('─┼─'));

    // Rows
    for (let r = 0; r < rowCount; r++) {
      const row = colNames.map((_: string, i: number) => {
        const val = String(dataArrays[i]?.[r] ?? '');
        return val.substring(0, 30).padEnd(colWidths[i]);
      });
      output.push(row.join(' | '));
    }

    output.push(`\n${rowCount} row(s) returned (total: ${totalRows}).${execTime ? ` Query time: ${execTime}ms` : ''}`);
    return output.join('\n');
  } catch (e: any) {
    return `Query executed but could not parse results: ${e.message}\n${JSON.stringify(result, null, 2).substring(0, 3000)}`;
  }
}

/**
 * Get ABAP SQL syntax reference
 * Returns a static reference for ABAP SQL syntax (Open SQL / ABAP SQL)
 */
export async function getAbapSqlSyntax(): Promise<string> {
  return `ABAP SQL Syntax Quick Reference
═══════════════════════════════

SELECT
  SELECT [SINGLE] <fields> FROM <table> [WHERE <condition>] [INTO <target>].
  SELECT * FROM mara WHERE matnr = '12345' INTO TABLE @DATA(lt_result).
  SELECT SINGLE matnr, maktx FROM makt WHERE matnr = @lv_matnr AND spras = 'E' INTO @DATA(ls_material).

JOINs
  SELECT a~matnr, b~maktx FROM mara AS a
    INNER JOIN makt AS b ON a~matnr = b~matnr
    WHERE b~spras = 'E'
    INTO TABLE @DATA(lt_joined).

Aggregates
  SELECT vbeln, COUNT(*) AS item_count, SUM( netwr ) AS total
    FROM vbap GROUP BY vbeln
    INTO TABLE @DATA(lt_agg).

Subqueries
  SELECT * FROM mara WHERE matnr IN (SELECT matnr FROM mard WHERE werks = '1000')
    INTO TABLE @DATA(lt_sub).

CDS Views
  SELECT * FROM I_Product WHERE Product = '12345'
    INTO TABLE @DATA(lt_products).

String Functions: CONCAT, SUBSTRING, LENGTH, REPLACE, UPPER, LOWER
Numeric Functions: ABS, CEIL, FLOOR, ROUND, MOD, DIV
Date Functions: DATS_ADD_DAYS, DATS_ADD_MONTHS, DATS_DAYS_BETWEEN
CASE: CASE WHEN <cond> THEN <val> ELSE <val> END
COALESCE: COALESCE( field1, field2, 'default' )
CAST: CAST( field AS <type> )

For complete reference, see SAP Help: https://help.sap.com/doc/abapdocu_latest/latest/en-US/index.htm?file=abapselect.htm`;
}
