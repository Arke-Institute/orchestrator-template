#!/usr/bin/env npx tsx
/**
 * Orchestrator Registration Script
 *
 * Registers the orchestrator with Arke API. By default registers on test network.
 * Use --production flag to register on production network.
 *
 * Usage:
 *   npm run register           # Register on test network (default)
 *   npm run register:prod      # Register on production network
 *
 * Environment:
 *   ARKE_API_KEY    - Required: Your user API key for registration
 *   ARKE_API_URL    - Optional: API URL (default: https://arke-v1.arke.institute)
 *   AGENT_HOME      - Optional: Collection ID for agent home
 */

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Configuration
// =============================================================================

const isProduction = process.argv.includes('--production');
const network = isProduction ? 'main' : 'test';
const networkLabel = isProduction ? 'production' : 'test';

const API_URL = process.env.ARKE_API_URL || 'https://arke-v1.arke.institute';
const API_KEY = process.env.ARKE_API_KEY;
const AGENT_HOME = process.env.AGENT_HOME;

// File paths
const agentJsonPath = path.resolve(process.cwd(), 'agent.json');
const agentIdPath = path.resolve(process.cwd(), isProduction ? '.agent-id.prod' : '.agent-id');

// =============================================================================
// Helpers
// =============================================================================

function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), '.env.test');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const eqIndex = line.indexOf('=');
      if (eqIndex > 0 && !line.trim().startsWith('#')) {
        const key = line.slice(0, eqIndex).trim();
        const value = line.slice(eqIndex + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const apiKey = process.env.ARKE_API_KEY || API_KEY;
  if (!apiKey) {
    throw new Error('ARKE_API_KEY is required');
  }

  const headers: Record<string, string> = {
    'Authorization': `ApiKey ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Arke-Network': network,
  };

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`API error (${res.status}): ${error}`);
  }

  return res.json();
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log(`\n📦 Orchestrator Registration (${networkLabel} network)\n`);

  // Load .env.test
  loadEnvFile();

  // Check API key
  const apiKey = process.env.ARKE_API_KEY;
  if (!apiKey) {
    console.error('❌ ARKE_API_KEY is required');
    console.error('   Set it in .env.test or as environment variable');
    process.exit(1);
  }

  // Load agent.json
  if (!fs.existsSync(agentJsonPath)) {
    console.error('❌ agent.json not found');
    process.exit(1);
  }

  const agentConfig = JSON.parse(fs.readFileSync(agentJsonPath, 'utf-8'));
  console.log(`Orchestrator: ${agentConfig.label}`);
  console.log(`Endpoint: ${agentConfig.endpoint}`);
  console.log(`Actions: ${JSON.stringify(agentConfig.actions_required)}`);
  if (agentConfig.uses_agents) {
    console.log(`Uses agents: ${agentConfig.uses_agents.length} sub-agent(s)`);
  }
  console.log('');

  // Check if agent already registered
  if (fs.existsSync(agentIdPath)) {
    const agentId = fs.readFileSync(agentIdPath, 'utf-8').trim();
    console.log(`Updating existing orchestrator: ${agentId}`);

    try {
      // Get current CID for CAS
      const agent = await apiRequest<{ cid: string }>('GET', `/agents/${agentId}`);

      const updateBody: Record<string, unknown> = {
        expect_tip: agent.cid,
        properties: {
          label: agentConfig.label,
          description: agentConfig.description,
          endpoint: agentConfig.endpoint,
        },
      };

      // Include uses_agents if present
      if (agentConfig.uses_agents) {
        updateBody.uses_agents = agentConfig.uses_agents;
      }

      await apiRequest('PUT', `/agents/${agentId}`, updateBody);

      console.log(`✅ Orchestrator updated: ${agentId}`);
    } catch (error) {
      console.error(`❌ Failed to update orchestrator: ${error}`);
      process.exit(1);
    }
  } else {
    console.log('Creating new orchestrator...');

    try {
      // Get or create agent home collection
      let agentHome = AGENT_HOME;
      if (!agentHome) {
        console.log('Creating agent home collection...');
        const homeResult = await apiRequest<{ id: string }>('POST', '/collections', {
          label: 'Agent Home',
          description: 'Home collection for agents',
        });
        agentHome = homeResult.id;
        console.log(`✅ Created agent home: ${agentHome}`);
      }

      // Create orchestrator
      const createBody: Record<string, unknown> = {
        label: agentConfig.label,
        description: agentConfig.description,
        endpoint: agentConfig.endpoint,
        actions_required: agentConfig.actions_required,
        input_schema: agentConfig.input_schema,
        collection: agentHome,
      };

      // Include uses_agents if present (orchestrators need this)
      if (agentConfig.uses_agents) {
        createBody.uses_agents = agentConfig.uses_agents;
      }

      const result = await apiRequest<{ id: string; cid: string }>('POST', '/agents', createBody);

      const agentId = result.id;
      fs.writeFileSync(agentIdPath, agentId);
      console.log(`✅ Orchestrator created: ${agentId}`);

      // Activate orchestrator
      await apiRequest('PUT', `/agents/${agentId}`, {
        expect_tip: result.cid,
        status: 'active',
      });
      console.log('✅ Orchestrator activated');

      // Create API key
      console.log('\nCreating API key...');
      const keyResult = await apiRequest<{ key: string; prefix: string }>(
        'POST',
        `/agents/${agentId}/keys`,
        { label: networkLabel }
      );

      console.log('\n==========================================');
      console.log('🔑 SAVE THIS API KEY (shown only once):');
      console.log(`   ${keyResult.key}`);
      console.log('');
      console.log('Set it with:');
      console.log(`   wrangler secret put ARKE_API_KEY`);
      console.log('==========================================\n');

    } catch (error) {
      console.error(`❌ Failed to create orchestrator: ${error}`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
