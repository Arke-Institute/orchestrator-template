# Orchestrator Template

Template for Arke orchestrator agents that dispatch work to sub-agents. Fork this to create orchestrators like `description-orchestrator`, `ocr-orchestrator`, etc.

## Authentication Model

Agents in Arke have their own identity and credentials, separate from your user account:

| Key Type | Format | Used For |
|----------|--------|----------|
| **User API Key** | `uk_*` | You use this to register/manage agents (admin actions) |
| **Agent API Key** | `ak_*` | The deployed worker uses this to call Arke API at runtime |

When you register an orchestrator, Arke creates an agent entity and generates an agent-specific API key. This key is what your worker uses when dispatching to sub-agents.

## Setup

### 1. Clone and configure

```bash
cp -r orchestrator-template my-orchestrator
cd my-orchestrator
npm install
```

Update these files with your orchestrator's details:
- `wrangler.jsonc`: Change `name`, domain, `AGENT_ID`
- `src/config.ts`: Set `SUB_AGENT_ID`, `SUB_AGENT_ENDPOINT`
- `agent.json`: Set `label`, `description`, `endpoint`, `uses_agents`
- `package.json`: Update `name`

### 2. Create KV namespace

```bash
wrangler kv:namespace create JOBS
# Copy the ID to wrangler.jsonc
```

### 3. Deploy the worker

```bash
npm run deploy
```

### 4. Register the orchestrator with Arke

This step uses your **user API key** to create the orchestrator and generate its credentials.

```bash
# Set your user API key for registration
export ARKE_API_KEY=uk_your_user_key

# Register (creates orchestrator, generates agent key)
npm run register
```

On first run, this will:
1. Create the orchestrator entity in Arke
2. Register the `uses_agents` dependencies (sub-agents it will invoke)
3. Activate it
4. Generate an agent API key (`ak_*`)
5. Print the key (save it!)

### 5. Configure the worker with the agent key

Set the **agent API key** (from step 4) as a Cloudflare secret:

```bash
wrangler secret put ARKE_API_KEY
# Paste the ak_* key from registration output
```

Your orchestrator is now deployed and registered.

## Development

```bash
npm run dev          # Run locally
npm run deploy       # Deploy to Cloudflare
npm run register     # Register/update in Arke (test network)
npm run register:prod # Register on production network
npm run type-check
```

## Project Structure

```
my-orchestrator/
├── agent.json            # Agent manifest (includes uses_agents)
├── wrangler.jsonc        # Cloudflare Worker config
├── .agent-id             # Created after first registration (test)
├── .agent-id.prod        # Created after first registration (prod)
├── scripts/
│   └── register.ts       # Registration script
└── src/
    ├── index.ts          # HTTP endpoints (don't modify)
    ├── verify.ts         # Signature verification (don't modify)
    ├── state.ts          # KV state management (don't modify)
    ├── logger.ts         # Job logger (don't modify)
    ├── dispatcher.ts     # Sub-agent dispatch + polling (don't modify)
    ├── env.ts            # Environment bindings
    ├── types.ts          # Job types with per-entity tracking
    └── config.ts         # YOUR CONFIGURATION
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

## How It Works

1. Arke invokes orchestrator via `POST /process` with `target` collection
2. Orchestrator discovers entities to process (or uses explicit `entity_ids` if provided)
3. Creates per-entity tracking state
4. For each entity (with concurrency limit):
   - Dispatch to sub-agent via `POST /agents/{id}/invoke`
   - Poll sub-agent status until done/error
   - Retry on failure (up to `max_retries`)
5. Aggregate results and update overall status
6. Write summary log to job collection
7. Arke polls `/status/:job_id` for completion

## Entity Discovery

By default, the orchestrator discovers all entities owned by the `target` collection. This is the primary mode of operation - you invoke the orchestrator on a collection and it processes everything in it.

**Explicit `entity_ids`** is an override for when you want to process a specific subset.

```typescript
// Discovery mode (default) - process all entities in collection
{ "target": "01MY_COLLECTION" }

// With type filter - only discover files, skip collections
{ "target": "01MY_COLLECTION", "input": { "options": { "discover_type": "file" } } }

// Override mode - process only these specific entities
{ "target": "01MY_COLLECTION", "input": { "entity_ids": ["01A", "01B"] } }
```

Discovery uses `GET /collections/{id}/entities` with pagination to fetch all entities owned by the collection.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `POST /process` | Receive batch job from Arke (signature verified) |
| `GET /status/:job_id` | Poll job status with progress |

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

## Workflow

### 1. Create Sub-Agent First

```bash
cp -r agent-template description-agent
cd description-agent
# Customize and deploy
npm run setup
# Note the returned agent ID
```

### 2. Create Orchestrator

```bash
cp -r orchestrator-template description-orchestrator
cd description-orchestrator

# Update config.ts with sub-agent ID
# Update agent.json uses_agents
# Deploy
npm run setup
```

### 3. Invoke Orchestrator

```bash
# Discovery mode (default) - process all entities in collection
curl -X POST https://arke-v1.arke.institute/agents/01ORCH_ID/invoke \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "target": "01MY_COLLECTION",
    "confirm": true
  }'

# Discovery with type filter - only process files
curl -X POST https://arke-v1.arke.institute/agents/01ORCH_ID/invoke \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "target": "01MY_COLLECTION",
    "input": { "options": { "discover_type": "file" } },
    "confirm": true
  }'

# Override mode - process specific entities only
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
