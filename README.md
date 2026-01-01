# Orchestrator Template

Template for Arke orchestrator agents that dispatch work to sub-agents. Fork this to create orchestrators like `description-orchestrator`, `ocr-orchestrator`, etc.

## Quick Start

1. **Copy this template**
   ```bash
   cp -r orchestrator-template my-orchestrator
   cd my-orchestrator
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Update configuration**
   - `wrangler.jsonc`: Change `name`, domain, `AGENT_ID`
   - `config.ts`: Set `SUB_AGENT_ID`, `SUB_AGENT_ENDPOINT`
   - `agent.json`: Set `label`, `description`, `endpoint`, `uses_agents`
   - `package.json`: Update `name`

4. **Create KV namespace**
   ```bash
   wrangler kv:namespace create JOBS
   # Copy the ID to wrangler.jsonc
   ```

5. **Authenticate with Arke**
   ```bash
   arke auth set-api-key uk_your_api_key
   ```

6. **Deploy and register**
   ```bash
   npm run deploy:full
   ```

7. **Set the orchestrator API key**
   ```bash
   wrangler secret put ARKE_API_KEY
   # Paste the ak_* key from registration output
   ```

## Project Structure

```
my-orchestrator/
├── package.json
├── wrangler.jsonc        # Cloudflare Worker config
├── tsconfig.json
├── agent.json            # Agent manifest (includes uses_agents)
├── scripts/
│   └── register.sh       # Registration script
├── .agent-id             # Created after first registration
└── src/
    ├── index.ts          # Hono app entry point
    ├── env.ts            # Environment bindings
    ├── types.ts          # Job types with per-entity tracking
    ├── verify.ts         # Ed25519 signature verification
    ├── state.ts          # KV state management with progress
    ├── logger.ts         # Job logger
    ├── config.ts         # SUB-AGENT CONFIGURATION
    └── dispatcher.ts     # Sub-agent dispatch + polling
```

## Key Configuration

### `config.ts`

```typescript
// The sub-agent this orchestrator dispatches to
export const SUB_AGENT_ID = '01DESCRIPTION_AGENT_XYZ';
export const SUB_AGENT_ENDPOINT = 'https://description-agent.arke.institute';

// Default settings
export const DEFAULT_CONFIG = {
  max_retries: 3,
  concurrency: 5,
  poll_interval_ms: 2000,
  poll_timeout_ms: 300000,
};
```

### `agent.json`

```json
{
  "uses_agents": [
    {
      "pi": "01DESCRIPTION_AGENT_XYZ",
      "actions_required": ["entity:view", "entity:update"]
    }
  ]
}
```

**Important**: `uses_agents` tells Arke to pre-grant permissions to sub-agents when the orchestrator is invoked.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `POST /process` | Receive batch job from Arke |
| `GET /status/:job_id` | Poll job status with progress |

## How It Works

1. Arke invokes orchestrator via `POST /process` with `entity_ids` array
2. Orchestrator creates per-entity tracking state
3. For each entity (with concurrency limit):
   - Dispatch to sub-agent via `POST /agents/{id}/invoke`
   - Poll sub-agent status until done/error
   - Retry on failure (up to `max_retries`)
4. Aggregate results and update overall status
5. Write summary log to log file entity

## Status Response

```json
{
  "job_id": "job_abc123",
  "status": "running",
  "progress": {
    "total": 10,
    "pending": 3,
    "dispatched": 2,
    "done": 4,
    "error": 1
  },
  "started_at": "2024-01-15T10:00:00Z"
}
```

## Development

```bash
npm run dev       # Run locally
npm run deploy    # Deploy to Cloudflare
npm run register  # Register/update in Arke
npm run type-check
```

## Workflow

### 1. Create Sub-Agent First

```bash
cp -r agent-template description-agent
cd description-agent
# Customize and deploy
npm run deploy:full
# Note the returned agent ID
```

### 2. Create Orchestrator

```bash
cp -r orchestrator-template description-orchestrator
cd description-orchestrator

# Update config.ts with sub-agent ID
# Update agent.json uses_agents
# Deploy
npm run deploy:full
```

### 3. Invoke Orchestrator

```bash
curl -X POST https://arke-v1.arke.institute/agents/01ORCH_ID/invoke \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "target": "01MY_COLLECTION",
    "input": {
      "entity_ids": ["01ENTITY_A", "01ENTITY_B", "01ENTITY_C"],
      "options": { "concurrency": 3 }
    },
    "confirm": true
  }'
```

Arke pre-grants permissions to both orchestrator AND sub-agent, then calls the orchestrator which dispatches to the sub-agent.
