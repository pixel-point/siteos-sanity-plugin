import { describe, expect, it, vi } from "vitest";
import {
  ComponentViewBuilder,
  DocumentBuilder,
  FormViewBuilder,
  type DefaultDocumentNodeContext,
  type StructureBuilder,
  type StructureContext,
  type View,
  type ViewBuilder,
} from "sanity/structure";
import { withSiteosDocumentView } from "./document-view.js";

vi.mock("./review-panel.js", () => ({ ReviewPanel: () => null }));
const S = {
  document: () => new DocumentBuilder({} as StructureContext),
  view: {
    form: () => new FormViewBuilder(),
    component: (component) => new ComponentViewBuilder(component),
  },
} as StructureBuilder;
const context = { schemaType: "page" } as DefaultDocumentNodeContext;
const options = {
  documentTypes: { page: { fields: [{ path: ["title"], role: "title" as const }] } },
};
const serialize = (view: View | ViewBuilder) => ("serialize" in view ? view.serialize() : view);

describe("native SiteOS document view", () => {
  it("preserves custom editor/preview tabs and singleton identity while routing back to the actual form", () => {
    const preview = S.view
      .component(() => null)
      .id("preview")
      .title("Preview");
    const original = S.document()
      .documentId("homepage")
      .title("Home")
      .views([S.view.form().id("content"), preview]);
    const resolver = withSiteosDocumentView(options, () => original);
    const result = resolver(S, context)!;
    expect(result.getDocumentId()).toBe("homepage");
    expect(result.getTitle()).toBe("Home");
    expect(
      result
        .getViews()
        .map(serialize)
        .map((view) => view.id),
    ).toEqual(["content", "preview", "siteos"]);
    expect(result.getViews()[1]).toBe(preview);
    expect(serialize(result.getViews()[2])).toMatchObject({
      type: "component",
      options: { ...options, formViewId: "content" },
    });
    expect(original.getViews()).toHaveLength(2);
  });

  it("supplies an editor for mapped documents without views and does not duplicate the SiteOS tab", () => {
    const resolve = withSiteosDocumentView(options);
    const result = resolve(S, context)!;
    expect(
      result
        .getViews()
        .map(serialize)
        .map((view) => view.id),
    ).toEqual(["editor", "siteos"]);
    const wrapped = withSiteosDocumentView(options, () => result);
    expect(wrapped(S, context)).toBe(result);
  });

  it("does not change unmapped document configuration or claim Sanity's default resolver", () => {
    const author = { schemaType: "author" } as DefaultDocumentNodeContext;
    const original = S.document().documentId("author");
    expect(withSiteosDocumentView(options, () => original)(S, author)).toBe(original);
    expect(withSiteosDocumentView(options)(S, author)).toBeUndefined();
  });
});
