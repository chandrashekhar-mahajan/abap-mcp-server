/**
 * Testing & Quality Tools
 * 
 * Implements: run_unit_tests, run_atc_analysis
 * Uses SAP ADT ABAP Unit and ATC APIs
 */

import { SapAdtClient } from '../sap-client';

/**
 * Run ABAP Unit tests for an object
 * ADT API: POST /sap/bc/adt/abapunit/testruns
 */
export async function runUnitTests(
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
      const typeMap: Record<string, string> = {
        'PROG': '/sap/bc/adt/programs/programs/',
        'CLAS': '/sap/bc/adt/oo/classes/',
        'FUGR': '/sap/bc/adt/functions/groups/',
        'INTF': '/sap/bc/adt/oo/interfaces/',
      };
      const base = typeMap[args.objectType.toUpperCase()] || '/sap/bc/adt/programs/programs/';
      uri = `${base}${args.objectName.toLowerCase()}`;
    }
    if (!uri) {
      return 'Error: Provide objectUri or objectName + objectType.';
    }

    const body = `<?xml version="1.0" encoding="UTF-8"?>
<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit">
  <external>
    <coverage active="false"/>
  </external>
  <options>
    <uriType value="semantic"/>
    <testDeterminationStrategy sameProgram="true" assignedTests="false" publicTestClasses="true"/>
    <testRiskLevels harmless="true" dangerous="true" critical="true"/>
    <testDurations short="true" medium="true" long="true"/>
  </options>
  <adtcore:objectSets xmlns:adtcore="http://www.sap.com/adt/core">
    <objectSet kind="inclusive">
      <adtcore:objectReferences>
        <adtcore:objectReference adtcore:uri="${uri}"/>
      </adtcore:objectReferences>
    </objectSet>
  </adtcore:objectSets>
</aunit:runConfiguration>`;

    const result = await client.postXml(
      '/sap/bc/adt/abapunit/testruns',
      body
    );

    return formatUnitTestResults(result);
  } catch (err: any) {
    return `Error running unit tests: ${err.message}`;
  }
}

function formatUnitTestResults(result: any): string {
  const output: string[] = ['ABAP Unit Test Results', '═'.repeat(40)];

  try {
    const program = result?.['aunit:runResult']?.['program'] ||
                    result?.['aunit:runResult']?.['aunit:program'];
    if (!program) {
      return 'No test results returned. The object may not contain any unit tests.';
    }

    const programs = Array.isArray(program) ? program : [program];
    let totalTests = 0;
    let passed = 0;
    let failed = 0;
    let errors = 0;

    for (const prog of programs) {
      const attrs = prog['$'] || {};
      output.push(`\nProgram: ${attrs['adtcore:name'] || 'Unknown'}`);

      const testClasses = prog['testClass'] || prog['aunit:testClass'];
      if (!testClasses) continue;

      const classes = Array.isArray(testClasses) ? testClasses : [testClasses];
      for (const tc of classes) {
        const tcAttrs = tc['$'] || {};
        output.push(`  Test Class: ${tcAttrs['adtcore:name'] || 'Unknown'}`);

        const methods = tc['testMethod'] || tc['aunit:testMethod'];
        if (!methods) continue;

        const methodArr = Array.isArray(methods) ? methods : [methods];
        for (const m of methodArr) {
          totalTests++;
          const mAttrs = m['$'] || {};
          const name = mAttrs['adtcore:name'] || 'Unknown';

          const alerts = m['alerts'] || m['aunit:alerts'];
          if (!alerts) {
            passed++;
            output.push(`    ✓ ${name} — PASSED`);
          } else {
            const alertArr = Array.isArray(alerts['alert'] || alerts['aunit:alert'])
              ? (alerts['alert'] || alerts['aunit:alert'])
              : [alerts['alert'] || alerts['aunit:alert']];

            for (const alert of alertArr) {
              const severity = alert?.['$']?.severity || alert?.['$']?.['aunit:severity'] || 'error';
              if (severity.toLowerCase().includes('error') || severity.toLowerCase().includes('fatal')) {
                errors++;
              } else {
                failed++;
              }
              const title = alert?.title || alert?.['aunit:title'] || '';
              const details = alert?.details || alert?.['aunit:details'] || '';
              output.push(`    ✗ ${name} — ${severity.toUpperCase()}: ${title} ${details}`);
            }
          }
        }
      }
    }

    output.push(`\n${'─'.repeat(40)}`);
    output.push(`Total: ${totalTests} | Passed: ${passed} | Failed: ${failed} | Errors: ${errors}`);
  } catch (e) {
    output.push(`\n(Could not fully parse results. Raw data returned.)`);
    output.push(JSON.stringify(result, null, 2).substring(0, 2000));
  }

  return output.join('\n');
}

/**
 * Run ATC (ABAP Test Cockpit) analysis
 * ADT API: POST /sap/bc/adt/atc/runs  then GET /sap/bc/adt/atc/runs/{id}/results
 */
export async function runAtcAnalysis(
  client: SapAdtClient,
  args: {
    objectUri?: string;
    objectName?: string;
    objectType?: string;
    checkVariant?: string;
  }
): Promise<string> {
  try {
    let uri = args.objectUri;
    if (!uri && args.objectName && args.objectType) {
      const typeMap: Record<string, string> = {
        'PROG': '/sap/bc/adt/programs/programs/',
        'CLAS': '/sap/bc/adt/oo/classes/',
        'FUGR': '/sap/bc/adt/functions/groups/',
        'INTF': '/sap/bc/adt/oo/interfaces/',
        'TABL': '/sap/bc/adt/ddic/tables/',
      };
      const base = typeMap[args.objectType.toUpperCase()] || '/sap/bc/adt/programs/programs/';
      uri = `${base}${args.objectName.toLowerCase()}`;
    }
    if (!uri) {
      return 'Error: Provide objectUri or objectName + objectType.';
    }

    const variant = args.checkVariant || 'DEFAULT';

    // Step 1: Create ATC run
    const runBody = `<?xml version="1.0" encoding="UTF-8"?>
<atc:run xmlns:atc="http://www.sap.com/adt/atc"
         maximumVerdicts="100">
  <objectSets xmlns:adtcore="http://www.sap.com/adt/core">
    <objectSet kind="inclusive">
      <adtcore:objectReferences>
        <adtcore:objectReference adtcore:uri="${uri}"/>
      </adtcore:objectReferences>
    </objectSet>
  </objectSets>
</atc:run>`;

    const runResult = await client.postXml(
      '/sap/bc/adt/atc/runs',
      runBody,
      { checkVariant: variant }
    );

    // Extract the worklist URI from the run result
    const worklistUri = runResult?.['atc:run']?.['$']?.['atc:worklistUri'] ||
                        runResult?.['worklist']?.['$']?.['id'] || '';

    if (!worklistUri) {
      return 'ATC run submitted but could not retrieve worklist URI. Check the system.';
    }

    // Step 2: Get ATC results
    const resultsPath = worklistUri.startsWith('/') ? worklistUri : `/sap/bc/adt/atc/worklists/${worklistUri}`;
    const results = await client.getXml(resultsPath);

    return formatAtcResults(results);
  } catch (err: any) {
    return `Error running ATC analysis: ${err.message}`;
  }
}

function formatAtcResults(results: any): string {
  const output: string[] = ['ATC Analysis Results', '═'.repeat(40)];

  try {
    const objects = results?.['atc:worklist']?.['atc:object'] ||
                    results?.['worklist']?.['object'];
    if (!objects) return 'No ATC findings.';

    const items = Array.isArray(objects) ? objects : [objects];
    let totalFindings = 0;

    for (const obj of items) {
      const attrs = obj['$'] || {};
      output.push(`\nObject: ${attrs['adtcore:name'] || attrs['name'] || 'Unknown'}`);

      const findings = obj['atc:finding'] || obj['finding'];
      if (!findings) continue;

      const findingArr = Array.isArray(findings) ? findings : [findings];
      for (const f of findingArr) {
        totalFindings++;
        const fAttrs = f['$'] || {};
        const priority = fAttrs['priority'] || fAttrs['atc:priority'] || '?';
        const checkId = fAttrs['checkId'] || fAttrs['atc:checkId'] || '';
        const message = fAttrs['checkTitle'] || fAttrs['atc:checkTitle'] || '';
        const line = fAttrs['location'] || fAttrs['atc:location'] || '';

        const priorityIcon = priority === '1' ? '🔴' : priority === '2' ? '🟡' : '🔵';
        output.push(`  ${priorityIcon} P${priority} | ${checkId}: ${message} ${line ? `(${line})` : ''}`);
      }
    }

    output.push(`\n${'─'.repeat(40)}`);
    output.push(`Total findings: ${totalFindings}`);
  } catch (e) {
    output.push('(Could not fully parse ATC results)');
    output.push(JSON.stringify(results, null, 2).substring(0, 2000));
  }

  return output.join('\n');
}
