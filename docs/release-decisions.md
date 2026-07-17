# Release decisions

Decision date: **2026-07-13**

## Approved decisions

### Environment

Initial release acceptance will use a **private staging/review environment** with resources isolated from production:

- dedicated Cloudflare D1 database bound as `DB`;
- dedicated Cloudflare R2 bucket bound as `OUTPUTS`;
- the exact release-candidate commit deployed to the review URL;
- access control or another non-public review mechanism;
- no production D1 or R2 binding reuse.

Staging may receive paid final renders only after a separate authorization. Production deployment is not authorized by this decision.

### Typography

**Inter** is the approved application font for the current release candidate. The project self-hosts the supplied Inter 4.001 variable fonts as WOFF2, including normal and italic styles, weights 100–900, and optical-size data. The font license is stored with the binaries under `app/fonts/`.

### Device acceptance

- A physical iPhone is available for Safari acceptance.
- A physical Android phone is not currently available.
- Android acceptance may be completed using a borrowed device or a cloud-hosted real Android device.
- An emulator is useful for preliminary checks but does not independently close the Android release gate.
- Missing Android evidence does not block staging setup, rights preparation, or populated-Library QA; it blocks final public-release acceptance.

## Still requires explicit authorization

- creation or mutation of Cloudflare staging resources;
- deployment of a review build;
- generation of paid final collages;
- production deployment;
- public release.
