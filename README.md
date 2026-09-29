<img src="https://raw.githubusercontent.com/pixel-point/siteos-sanity-plugin/main/assets/siteos-logo.png" width="80" height="80" alt="SiteOS" />

# SiteOS for Sanity

Check SEO fields and review writing before publishing, directly in Sanity Studio. The plugin adds
a **🔍 SEO/GEO Audit** document tab with **SEO** first and **Text** second. An administrator connects
the Studio to a SiteOS Project once; authorized Sanity editors use that shared connection.

**First release: 0.1.0.** Supported Studio versions and setup are listed below. Shared connection
persistence has been tested against a real Sanity dataset. Access from a second actual Sanity
editor account and custom Sanity roles has not yet been verified; confirm the secret-document
permissions described below before a team rollout.

## Before you start

- A Sanity Studio codebase and access to its `sanity.config.ts`. Install in the package that owns
  Studio, including when Studio is embedded in a Next.js application.
- Node.js 22.12+, Sanity `^6.16.0`, React and React DOM `^19.2.8`, styled-components `^6.1.15`.
  Verified with Sanity 6.16.0 and React 19.2.8. Older major versions are not supported by this release;
  do not force installation or upgrade an existing Studio without reviewing its other plugins.
- A SiteOS Organization and Project with SEO attached to the intended environment. The connecting
  person needs SiteOS Owner/Admin access and permission to write the connection document in Sanity.
- A SiteOS deployment with the Studio API. AI Text checks additionally require enabled content
  checks, a running worker and available Organization SEO credits. Deterministic SEO checks use
  no AI provider, content worker or credits.

The plugin does not create schemas or infer your website's routes. Only document types and fields
you map are checked. It never publishes documents automatically.

## 1. Install in your Studio

Use your project's existing package manager:

```sh
pnpm add @siteoshq/sanity
# npm install @siteoshq/sanity
# yarn add @siteoshq/sanity
```

Do not run all three commands or introduce another lockfile. Installing the package alone does
not add the document tab: configure the existing Structure tool next.

For local development, install a reviewed packed artifact instead:

```sh
pnpm add /absolute/path/to/siteoshq-sanity-0.1.0.tgz
```

## 2. Configure your existing document types

Copy [examples/siteos.config.ts](./examples/siteos.config.ts) into your Studio and adapt its mapping.
Replace `page` and the field paths with **schema names**, not the labels shown to editors.
Remove fields/references that do not exist in your schema. The example file also shows how to map
a related author so Text checks include its content.

Add `withSiteosDocumentView` to your existing `structureTool` in `sanity.config.ts`. Keep your
current `schema`, other plugins and any custom `structure` options. Do not add a second Structure
tool just for SiteOS. After adapting the example mapping, replace only the existing Structure
tool entry (this fragment is not a replacement for the whole config):

```ts
import { structureTool } from "sanity/structure";
import { withSiteosDocumentView } from "@siteoshq/sanity";
import { siteosOptions } from "./siteos.config";

// Inside your existing plugins array:
structureTool({
  // Keep your existing structure and other Structure tool options here.
  defaultDocumentNode: withSiteosDocumentView(siteosOptions),
});
```

If the project already has `defaultDocumentNode`, preserve it as the second argument:

```ts
defaultDocumentNode: withSiteosDocumentView(siteosOptions, existingDefaultDocumentNode);
```

The helper preserves existing editor and preview tabs. A custom singleton using `S.document()`
directly may bypass `defaultDocumentNode`; append the view to that node explicitly:

```ts
import { siteosDocumentView } from "@siteoshq/sanity";

S.document()
  .documentId("homepage")
  .schemaType("page")
  .views([S.view.form().id("editor"), siteosDocumentView(S, siteosOptions, "editor")]);
```

The `siteos(siteosOptions)` plugin export is an optional **SiteOS content review** actions-menu
entry for projects that want it. It is not needed when using the native tab.

Restart your Studio dev server. Once the local setup is verified, rebuild and deploy Studio using
that project's existing workflow. A package/config change does not update a previously deployed
Studio by itself.

## 3. Connect once for the team

1. Open a mapped document and its **🔍 SEO/GEO Audit** tab. Select **Connect SiteOS**.
2. Sign into SiteOS in the popup as an Organization Owner/Admin. Select the Organization,
   Project and environment with SEO attached. Use the intended environment explicitly.
3. Select **Connect for the team** and return to Studio. The plugin saves a separate installation
   credential in a protected, non-root `secrets.siteos.*` document in this dataset.
4. Other editors who can read that document use the saved connection without a SiteOS account.
   Verify this with an actual editor account before rolling it out to the team.

Only public settings and field mappings go into Studio configuration. No SiteOS token, AI key,
Organization ID or Project ID is required in `sanity.config.ts`; the connection flow selects them.
`siteosUrl` optionally selects a different HTTPS SiteOS deployment. The default is
`https://app.siteos.sh`; localhost HTTP is supported for development.

Local and hosted Studio origins need separate connections. After deploying Studio, connect from
its actual URL as well. See [Connection and permissions](#connection-and-permissions) for details.

## 4. Run the first check

1. Save a draft and open **🔍 SEO/GEO Audit**. Confirm the displayed Project and environment.
2. Select **Check SEO**. Review metadata, headings, images, links, slug and duplicate results.
   Missing configuration or unavailable evidence remains visible; it is not a successful check.
3. Use **Open field** to jump to the editor. Fix the value, then run the check again.
4. For spelling, grammar and content consistency, switch to **Text → Check text**. This is an
   explicit AI check billed to the selected Organization; it is separate from the SEO check.

Opening the tab never starts a check. **Text → Preview content** reads the selected fields and
related content inside Studio without sending document text to SiteOS. AI results highlight the
original and suggested words. **Content included in this check** is a collapsible preview.
**Apply correction** writes only the selected, still-current plain-text draft field; Portable Text
and related-document suggestions open their source for manual editing. Publishing remains unchanged.

## SEO mapping and coverage

Map only fields that your website actually uses. The `seo` configuration is optional; title and
description fall back to the first content field with that role, and `portableText` falls back to
mapped Portable Text fields. Override them with `seo.title`, `seo.description` and
`seo.portableText: [["body"]]` when the content and SEO mappings differ. No slug or primary H1
is guessed. Missing configuration and read failures remain visibly unverified.

- Metadata: empty title/description and length guidance. Title over 60 characters, description
  under 70 or over 160 prompt review. These are recommendations, not Google limits or SEO scores.
- Headings: explicit primary heading plus standard Portable Text `h1`–`h6` blocks, empty headings
  and forward level skips. Missing page H1 is not checked without `primaryHeading` mapping.
- Images: standard Portable Text image blocks and configured image fields/arrays. `alt` and
  `decorative` paths are relative to each image; defaults are `alt` and `decorative`. Empty alt is
  accepted with explicit decorative intent. The image asset reference is checked for presence.
- Links: standard Portable Text `link` (`href`) and `internalLink` (`reference`) annotations,
  plus configured object fields/arrays. `href`, `text` and `reference` mappings are relative paths.
  Checks cover syntax, placeholders, empty labels and linked-document availability. No HTTP
  fetches or fragment-target checks occur. Custom blocks need explicit mappings.
- Slugs: mapped string (typically `slug.current`), empty values and suspicious path characters.
  Unicode slugs are accepted. Final website routes and redirects are not inferred.
- Duplicates: exact title/description/slug values among accessible documents of the same type and
  mapped locale, in `drafts` or `published` perspective. Both versions of the current document
  are excluded; at most 10 matching documents per field are shown. Set `seo.duplicates: false` to
  disable these reads. This is not a whole-website or cross-schema duplicate audit.

Each SEO check inspects at most 200 entries per configured collection, includes at most 100 items
per section, and sends at most 128 KB. Limits and unsupported content remain visible.
The endpoint evaluates evidence without AI, a worker or saved history. Results belong to that
revision; opening either section does not launch a check. Other documents may change after the
check; rerun it before relying on duplicate results. Canonical, robots, HTTP status, rendered markup
and actual indexing still require a website audit.

## Connection and permissions

Only public settings and field mapping go into `sanity.config.ts`. `siteosUrl` optionally selects
another HTTPS SiteOS origin (localhost HTTP is supported for development). Never put a SiteOS
key in the config or `SANITY_STUDIO_*` environment variables. The popup uses a one-time proof
exchange; SiteOS cookies remain on the SiteOS origin.

The connection is specific to the Studio origin, Sanity project/dataset and SiteOS environment.
Local development and hosted Studio use separate connections. **Manage connection** opens
SiteOS, where an administrator can revoke access for the team. Signing out of SiteOS does not
revoke the installation. To rotate the key, reconnect and revoke the previous connection.

The saved key is shared authority: authenticated users allowed to read its Sanity document can
extract it, and dataset exports may include it. It is limited to this connection's content checks
and results. Verify custom Sanity roles can read the secret document; the connecting administrator
also needs permission to create/update it. No additional permissions are granted by the plugin.

AI Text checks use the selected Organization's SEO credits. Identical text snapshots reuse a saved result for
seven days. Credit-limited jobs pause and can be resumed by an explicit Check text action;
interrupted jobs return partial results and are not silently retried. Fixed daily limits are
50 AI checks per installation and 500 per Organization. Deterministic SEO checks do not use these
AI jobs or credits. API failure never blocks Sanity publication.

## Troubleshooting

| Symptom                                   | What to check                                                                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No audit tab                              | The document type is mapped and the existing Structure tool uses the helper. Check custom singleton views separately. Restart or redeploy Studio after config changes. |
| Peer dependency conflict                  | Compare Studio/React versions with the supported versions above. Do not bypass incompatible majors with force flags.                                                   |
| Connect opens no window                   | Allow the SiteOS connection popup for this Studio and retry the explicit button.                                                                                       |
| Organization/Project missing              | Sign in as its SiteOS Owner/Admin and attach SEO to the intended Project environment.                                                                                  |
| Connection fails with 404                 | Confirm this SiteOS deployment includes the Studio API; an npm installation does not deploy the backend.                                                               |
| Works locally, not in hosted Studio       | Connect from the hosted origin. Keep the exact host and dataset; installations are origin-bound.                                                                       |
| Other editors cannot use the connection   | Verify their Sanity role can read the shared connection document and the mapped content. Do not expose the credential in config or make it a public root document.     |
| Section is not configured                 | Map the actual field names under `seo`; title/description and Portable Text have the documented fallbacks.                                                             |
| Unsupported custom blocks                 | Map their supported string, image or link fields explicitly. The plugin does not guess an arbitrary page-builder schema.                                               |
| Text check is disabled, paused or partial | Check the selected environment's AI availability, credits and worker. SEO checks are independent. Resume a paused Text check explicitly.                               |
| Correction is stale                       | Wait for Sanity to finish saving, run a new check and review its result.                                                                                               |

Report issues in [GitHub Issues](https://github.com/pixel-point/siteos-sanity-plugin/issues) with
plugin/Studio versions, the affected mapping and a synthetic reproduction. Omit credentials and
private document content.

## Update or remove

Use the Studio project's package manager to update `@siteoshq/sanity`, review release notes, then
rebuild and deploy Studio. To uninstall, remove the view/helper configuration and package. Revoke
the shared installation in SiteOS using **Manage connection**; removing the npm package alone
does not revoke it. Existing Sanity content is not removed.

The npm install is independent of a Sanity Exchange listing. Exchange makes the plugin easier to
discover; it is not required to install a published package.

## Content boundaries

- Field paths use schema names and stable `{ _key: "item-key" }` selectors. Map the Portable Text
  field itself; its text blocks retain their keyed source paths.
- Related document types must also be mapped. Draft reviews prefer referenced drafts; published
  reviews only read published references. Cross-dataset references and release versions are not
  supported in this preview.
- Reviews are bounded to 20 documents, depth 3, 100 reference lookups, 100 text sections, 24,000 text
  characters and a 128 KB serialized snapshot. Missing or omitted context is surfaced explicitly.
- Reference reads use the current Studio user's permissions. Source revisions and exact selected
  content contribute to the fingerprint used to reject stale results.
- Applying SiteOS suggestions requires an explicit click and a revision-checked patch
  to a saved draft. Only mapped plain-text fields in the active document can be changed. Rich-text
  and related-document findings navigate to their source for manual editing.
- This is content evidence, not a rendered-site audit or an indexing verdict.

## Source and releases

The canonical source lives in `siteos-platform/packages/sanity-plugin`. The downstream repository
is [pixel-point/siteos-sanity-plugin](https://github.com/pixel-point/siteos-sanity-plugin).
Maintainers generate a reviewed projection containing only allowlisted files and `release.json`
provenance. Preview projections and this private alpha package cannot be publicly released.

The MIT license covers this plugin source. SiteOS backend services are distributed separately.
See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution workflow.

For local source development, use pnpm 10.11.0: `pnpm install`, `pnpm verify`, then
`pnpm pack --pack-destination /tmp/siteos-sanity-pack`. The public package includes the SiteOS
black-square S logo under `assets/` and an editable mapping example under `examples/`.
