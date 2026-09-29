# Contributing

This repository is a generated projection of `packages/sanity-plugin` in the SiteOS platform
monorepo. Report issues and propose changes here; maintainers apply accepted changes upstream,
verify them with the platform contracts, then regenerate this public source tree.

Do not release changes authored only in this repository. `release.json` records the canonical
source commit, file hashes and whether a projection is a development preview.

Use Node.js 22.12+ and pnpm 10.11.0. For a standalone checkout, run `pnpm install` and `pnpm verify`.
Releases are generated from a clean canonical main commit, verified independently, and
reconciled into this repository with file hashes and source provenance. Hosted backend acceptance
is required before npm publication. Local packing is supported for development testing.
