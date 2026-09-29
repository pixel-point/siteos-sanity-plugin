import { useState } from "react";
import { definePlugin, type DocumentActionComponent } from "sanity";
import { ReviewPanel } from "./review-panel.js";
import { validateMappings } from "./snapshot.js";
import type { DocumentValue, SiteosPluginOptions } from "./types.js";

export type * from "./types.js";
export type * from "./seo-types.js";
export { SiteosDocumentView, siteosDocumentView, withSiteosDocumentView } from "./document-view.js";

/** Optional actions-menu entry. Prefer withSiteosDocumentView for the native document tab. */
export const siteos = definePlugin<SiteosPluginOptions>((options) => {
  validateMappings(options.documentTypes);
  const SiteosAction: DocumentActionComponent = (props) => {
    const [open, setOpen] = useState(false);
    const close = () => {
      setOpen(false);
      props.onComplete();
    };
    return {
      label: "SiteOS content review",
      disabled: !props.draft && !props.published,
      onHandle: () => setOpen(true),
      dialog: open
        ? {
            type: "dialog",
            header: "SiteOS",
            onClose: close,
            content: (
              <ReviewPanel
                document={(props.draft ?? props.published) as DocumentValue | null}
                options={options}
                onNavigate={close}
              />
            ),
          }
        : undefined,
    };
  };
  SiteosAction.displayName = "SiteosContentReviewAction";
  return {
    name: "siteos",
    document: {
      actions: (previous, context) =>
        Object.hasOwn(options.documentTypes, context.schemaType)
          ? [...previous, SiteosAction]
          : previous,
    },
  };
});
