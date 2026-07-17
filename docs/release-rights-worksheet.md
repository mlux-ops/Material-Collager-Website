# Release collage rights worksheet

Use this worksheet to collect the eight minimum approvals required before a populated private-staging Library can be created. It is a planning aid only; once each row is approved, transfer the data to `docs/release-collage-rights.json` and run `npm run validate:rights -- --release`.

An approved row requires all of the following:

- a stable, lowercase `assetKey` (letters, numbers, `.`, `_`, and `-` only);
- a user-facing collage title;
- permission for both public preview and download;
- one rights basis: `owned`, `licensed`, or `permission`;
- the person approving it and the approval timestamp; and
- every source image or material package used to create the collage, with its rights basis and any useful license or permission reference.

Do not add a collage to the release dataset if any source asset's public preview or download rights are unclear.

| # | Asset key | Collage title | Preview + download approved? | Rights basis | Source assets and license/permission reference | Approved by | Approved at (UTC) | Notes |
|---:|---|---|---|---|---|---|---|---|
| 1 | `chrome-bathroom-package` | Chrome Bathroom Package | Yes | Owned | Hansgrohe plumbing fixtures; `material-collage (1).png` | ML | 2026-07-16T02:20:22Z | Approved |
| 2 | `chrome-bathroom-package-v2` | Chrome Bathroom Package v2 | Yes | Owned | Kohler plumbing fixtures; `bath2_fixtures.png` | ML | 2026-07-16T02:20:22Z | Approved |
| 3 | `matte-black-bathroom-package` | Matte Black Bathroom Package | Yes | Owned | Kohler plumbing fixtures; `bath3_fixtures.png` | ML | 2026-07-16T02:20:22Z | Approved |
| 4 | `kitchen-cabinet-package` | Kitchen Cabinet Package | Yes | Owned | Brizo faucet; `material_collage.png` | ML | 2026-07-16T02:20:22Z | Approved |
| 5 | `matte-white-terrazzo-bathroom-package` | Matte White Terrazzo Bathroom Package | Yes | Owned | Hansgrohe plumbing fixtures; `material-collage2 (6).png` | ML | 2026-07-16T02:20:22Z | Approved |
| 6 | `primary-bathroom-brizo-package` | Primary Bathroom Brizo Package | Yes | Owned | Brizo plumbing fixtures and Elm Surfaces tiles; `material-collage2 (7).png` | ML | 2026-07-16T02:20:22Z | Approved |
| 7 | `primary-bathroom-kohler-package` | Primary Bathroom Kohler Package | Yes | Owned | Kohler plumbing fixtures; `primary_bath_fixtures.png` | ML | 2026-07-16T02:20:22Z | Approved |
| 8 | `bathroom-tile-package` | Bathroom Tile Package | Yes | Owned | Elm Surfaces tiles; `bath3_tiles.png` | ML | 2026-07-16T02:20:22Z | Approved |

## Transfer checklist

- [x] Each release collage has a unique `assetKey`.
- [x] `approvedForPublicPreview` is `true` for each collage.
- [x] `approvedForDownload` is `true` for each collage.
- [x] Every listed source asset has a documented rights basis.
- [x] Approval timestamps use ISO 8601 UTC, for example `2026-07-15T20:30:00Z`.
- [x] The final JSON passes release mode.
