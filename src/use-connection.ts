import { useMemo } from "react";
import { useClient, useDataset, useProjectId } from "sanity";
import {
  createHostedConnection,
  secretDocumentId,
  siteosOrigin,
  type StoredConnection,
} from "./connection.js";
import type { SiteosPluginOptions } from "./types.js";
export function useSiteosConnection(options: SiteosPluginOptions) {
  const client = useClient({ apiVersion: "2025-02-19" }),
    dataset = useDataset(),
    sanityProjectId = useProjectId();
  return useMemo(() => {
    if (options.connection) return options.connection;
    if (typeof window === "undefined") return null;
    const origin = siteosOrigin(options.siteosUrl),
      studioOrigin = window.location.origin;
    const documentId = secretDocumentId(origin, studioOrigin);
    return createHostedConnection({
      siteosUrl: origin,
      studioOrigin,
      sanityProjectId,
      dataset,
      store: {
        async read(signal) {
          const id = await documentId;
          const row = await client
            .withConfig({ useCdn: false, perspective: "raw" })
            .fetch<{ connection?: StoredConnection } | null>(
              "*[_id == $id][0]",
              { id },
              { signal },
            );
          return row?.connection ?? null;
        },
        async write(connection, signal) {
          const id = await documentId;
          const existing = await client.getDocument<{ _id: string; _rev: string }>(id);
          signal.throwIfAborted();
          if (existing)
            await client.patch(id).ifRevisionId(existing._rev).set({ connection }).commit();
          else await client.create({ _id: id, _type: "siteos.connection", connection });
          signal.throwIfAborted();
        },
      },
    });
  }, [client, dataset, sanityProjectId, options.connection, options.siteosUrl]);
}
