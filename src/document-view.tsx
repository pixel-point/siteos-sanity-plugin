import { Container } from "@sanity/ui";
import type {
  DefaultDocumentNodeResolver,
  StructureBuilder,
  UserViewComponent,
} from "sanity/structure";
import { ReviewPanel } from "./review-panel.js";
import { validateMappings } from "./snapshot.js";
import type { DocumentValue, SiteosPluginOptions } from "./types.js";

type ViewOptions = SiteosPluginOptions & { formViewId?: string };

/** Native document tab: Sanity supplies the currently displayed draft or published revision. */
export const SiteosDocumentView: UserViewComponent<ViewOptions> = ({
  document,
  documentId,
  options,
}) => {
  const displayed = document.displayed;
  const value =
    typeof displayed._id === "string" &&
    typeof displayed._type === "string" &&
    typeof displayed._rev === "string"
      ? (displayed as DocumentValue)
      : null;
  return (
    <Container width={3}>
      <ReviewPanel
        key={documentId}
        document={value}
        options={options}
        formViewId={options.formViewId ?? "editor"}
      />
    </Container>
  );
};

/** Use this directly in .views([...]) for singleton/custom document nodes. */
export function siteosDocumentView(
  S: StructureBuilder,
  options: SiteosPluginOptions,
  formViewId = "editor",
) {
  validateMappings(options.documentTypes);
  return S.view
    .component(SiteosDocumentView)
    .id("siteos")
    .title("🔍 SEO/GEO Audit")
    .options({ ...options, formViewId });
}

/** Append the SiteOS tab while retaining the project's existing editor and preview views. */
export function withSiteosDocumentView(
  options: SiteosPluginOptions,
  previous?: DefaultDocumentNodeResolver,
): DefaultDocumentNodeResolver {
  validateMappings(options.documentTypes);
  return (S, context) => {
    const existing = previous?.(S, context);
    if (!Object.hasOwn(options.documentTypes, context.schemaType)) return existing;
    const node = existing ?? S.document();
    const views = node.getViews();
    const resolved = views.map((view) => ("serialize" in view ? view.serialize() : view));
    if (resolved.some((view) => view.id === "siteos")) return node;
    const form = resolved.find((view) => view.type === "form");
    return node.views([
      ...(form ? views : [S.view.form(), ...views]),
      siteosDocumentView(S, options, form?.id ?? "editor"),
    ]);
  };
}
