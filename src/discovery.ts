import type { ArkeClient } from '@arke-institute/sdk';

// =============================================================================
// Entity Discovery
// =============================================================================

export interface DiscoveryOptions {
  // Optional: filter by entity type (e.g., 'file', 'collection')
  // Useful for orchestrators that only process specific entity types
  // Example: type: 'file' to only process files, skip collections
  type?: string;
}

/**
 * Discover all entities owned by a collection.
 *
 * Uses the GET /collections/{id}/entities endpoint with pagination
 * to fetch all entities. This is the default behavior when entity_ids
 * is not explicitly provided.
 *
 * @param client - ArkeClient instance
 * @param collectionId - The target collection to discover entities from
 * @param options - Optional discovery options (e.g., type filter)
 * @returns Array of entity IDs
 */
export async function discoverEntities(
  client: ArkeClient,
  collectionId: string,
  options?: DiscoveryOptions
): Promise<string[]> {
  const entityIds: string[] = [];
  let offset: number | null = 0;
  const limit = 1000;

  while (true) {
    const { data, error } = await client.api.GET('/collections/{id}/entities', {
      params: {
        path: { id: collectionId },
        query: {
          limit,
          offset,
          type: options?.type,
        },
      },
    });

    if (error) {
      throw new Error(`Discovery failed: ${JSON.stringify(error)}`);
    }

    if (!data) {
      throw new Error('Discovery failed: No data returned');
    }

    // Collect entity IDs from this page
    for (const entity of data.entities) {
      entityIds.push(entity.pi);
    }

    // Check if there are more pages
    if (!data.pagination.has_more) {
      break;
    }

    offset = (offset ?? 0) + limit;
  }

  return entityIds;
}
