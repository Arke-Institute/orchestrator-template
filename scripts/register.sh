#!/bin/bash
set -e

# Registration script for Arke orchestrators
# Requires: arke-cli authenticated (arke auth set-api-key or ARKE_API_KEY env var)
# Requires: jq for JSON parsing

# Check dependencies
if ! command -v jq &> /dev/null; then
  echo "Error: jq is required but not installed"
  exit 1
fi

if ! command -v arke &> /dev/null; then
  echo "Error: arke-cli is required but not installed"
  echo "Install with: npm install -g @arke-institute/cli"
  exit 1
fi

# Check auth
if ! arke auth status &> /dev/null; then
  echo "Error: Not authenticated with Arke"
  echo "Run: arke auth set-api-key <your-key>"
  exit 1
fi

# Read agent.json
if [ ! -f agent.json ]; then
  echo "Error: agent.json not found"
  exit 1
fi

LABEL=$(jq -r '.label' agent.json)
DESCRIPTION=$(jq -r '.description' agent.json)
ENDPOINT=$(jq -r '.endpoint' agent.json)
ACTIONS=$(jq -c '.actions_required' agent.json)
USES_AGENTS=$(jq -c '.uses_agents // empty' agent.json)
INPUT_SCHEMA=$(jq -c '.input_schema // empty' agent.json)
COLLECTION=${AGENT_HOME_COLLECTION:-"01AGENT_HOME_COLLECTION"}

echo "Orchestrator: $LABEL"
echo "Endpoint: $ENDPOINT"
echo "Actions: $ACTIONS"
if [ -n "$USES_AGENTS" ] && [ "$USES_AGENTS" != "null" ]; then
  echo "Uses agents: $USES_AGENTS"
fi
echo ""

# Check if orchestrator already registered
if [ -f .agent-id ]; then
  AGENT_ID=$(cat .agent-id)
  echo "Updating existing orchestrator: $AGENT_ID"

  # Get current CID for CAS
  CID=$(arke agents get "$AGENT_ID" --json | jq -r '.cid')

  # Build update command
  CMD="arke agents update $AGENT_ID --expect_tip $CID --label \"$LABEL\" --description \"$DESCRIPTION\" --endpoint \"$ENDPOINT\""

  if [ -n "$USES_AGENTS" ] && [ "$USES_AGENTS" != "null" ]; then
    CMD="$CMD --uses_agents '$USES_AGENTS'"
  fi

  eval "$CMD --json"
  echo "Orchestrator updated: $AGENT_ID"
else
  echo "Creating new orchestrator..."

  # Build create command
  CMD="arke agents create --label \"$LABEL\" --description \"$DESCRIPTION\" --endpoint \"$ENDPOINT\" --actions_required '$ACTIONS' --collection \"$COLLECTION\""

  if [ -n "$USES_AGENTS" ] && [ "$USES_AGENTS" != "null" ]; then
    CMD="$CMD --uses_agents '$USES_AGENTS'"
  fi

  RESULT=$(eval "$CMD --json")

  AGENT_ID=$(echo "$RESULT" | jq -r '.id')
  echo "$AGENT_ID" > .agent-id
  echo "Orchestrator created: $AGENT_ID"

  # Activate orchestrator
  CID=$(echo "$RESULT" | jq -r '.cid')
  arke agents update "$AGENT_ID" \
    --expect_tip "$CID" \
    --status active \
    --json
  echo "Orchestrator activated"

  # Create API key
  echo ""
  echo "Creating API key..."
  arke agents create-keys "$AGENT_ID" --label "Production" --json
  echo ""
  echo "=========================================="
  echo "SAVE THE API KEY ABOVE!"
  echo "Set it with: wrangler secret put ARKE_API_KEY"
  echo "=========================================="
fi
