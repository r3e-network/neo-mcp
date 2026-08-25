import fs from 'fs';
import path from 'path';

describe('documentation surface', () => {
  const repoRoot = path.resolve(__dirname, '..');

  test('website API docs describe the generic contract flow', () => {
    const websiteApiDoc = fs.readFileSync(path.join(repoRoot, 'website/docs/api.html'), 'utf8');

    expect(websiteApiDoc).toContain('get_contract_status');
    expect(websiteApiDoc).toContain('"name": "call_contract"');
    expect(websiteApiDoc).toContain('known name, script hash, or Neo address');
    expect(websiteApiDoc).not.toContain('invoke_read_contract');
    expect(websiteApiDoc).not.toContain('invoke_write_contract');
    expect(websiteApiDoc).not.toContain('#blockchain-resources');
    expect(websiteApiDoc).not.toContain('#contract-resources');
  });

  test('website API docs document the chain parameter and the read-only MCP surface', () => {
    const websiteApiDoc = fs.readFileSync(path.join(repoRoot, 'website/docs/api.html'), 'utf8');

    expect(websiteApiDoc).toContain('id="chains"');
    expect(websiteApiDoc).toContain('"chain": "n3"');
    expect(websiteApiDoc).toContain('build_contract_call');
    expect(websiteApiDoc).toContain('none of the 56 default tools holds a private key');
    expect(websiteApiDoc).toContain('analyze_address');
    expect(websiteApiDoc).toContain('analyze_account_graph');
    expect(websiteApiDoc).toContain('analyze_consensus_health');
    expect(websiteApiDoc).toContain('analyze_address_connection');
    expect(websiteApiDoc).toContain('analyze_transaction');
    expect(websiteApiDoc).toContain('investigate_transactions');
    expect(websiteApiDoc).toContain('analyze_contract');
    expect(websiteApiDoc).toContain('analyze_contract_upgrades');
    expect(websiteApiDoc).toContain('get_contract_source_verification');
    expect(websiteApiDoc).toContain('inspect_contract_code');
    expect(websiteApiDoc).toContain('analyze_neox_transaction');
    expect(websiteApiDoc).toContain('analyze_neox_block');
    expect(websiteApiDoc).toContain('analyze_neox_address');
    expect(websiteApiDoc).toContain('analyze_neox_contract');
    expect(websiteApiDoc).toContain('analyze_neox_token');

    const toolsTableStart = websiteApiDoc.indexOf('id="tools"');
    const toolsTableEnd = websiteApiDoc.indexOf('Optional local signing tools');
    expect(toolsTableStart).toBeGreaterThan(-1);
    expect(toolsTableEnd).toBeGreaterThan(toolsTableStart);

    const registeredToolsSection = websiteApiDoc.slice(toolsTableStart, toolsTableEnd);
    for (const signingTool of ['transfer_assets', 'invoke_contract_write', 'claim_gas', 'deploy_contract']) {
      expect(registeredToolsSection).not.toContain(signingTool);
    }
  });

  test('website API docs describe the HTTP write intent protocol, not key submission', () => {
    const websiteApiDoc = fs.readFileSync(path.join(repoRoot, 'website/docs/api.html'), 'utf8');

    expect(websiteApiDoc).toContain('/api/write-intents/');
    expect(websiteApiDoc).toContain('awaiting_approval');
    expect(websiteApiDoc).toContain('Idempotency-Key');
    expect(websiteApiDoc).toContain('HTTP_WRITE_APPROVAL_API_KEY');
    expect(websiteApiDoc).not.toContain('Requires WIF');
    expect(websiteApiDoc).not.toContain('boolean confirmation');
  });

  test('user-facing website pages do not advertise stale tool or resource counts', () => {
    const pages = [
      'website/index.html',
      'website/docs/getting-started.html',
      'website/docs/index.html',
      'website/404.html',
      'website/docs/testing.html',
    ];

    for (const relativePath of pages) {
      const content = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(content).not.toContain('34 tools');
      expect(content).not.toContain('34+ tools');
      expect(content).not.toContain('9 resources');
    }
  });
});
