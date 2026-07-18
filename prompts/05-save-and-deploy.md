@Browser @Sites

Read `AGENTS.md`, `docs/visual-qa.md`, and `docs/generator-qa.md` if the generator redesign is included.

This task is release preparation only. Do not make visual or product changes unless a deployment blocker requires a narrowly scoped fix.

1. Run the full build and test suite.
2. Verify the production build locally.
3. Review Git changes and confirm no secrets, temporary reference files, or private assets will be published unintentionally.
4. Confirm the project is compatible with Sites.
5. Create a Git commit for the approved release candidate.
6. Ask Sites to SAVE A VERSION WITHOUT DEPLOYING.
7. Open and inspect that saved version at the required desktop and mobile viewports.
8. Report the saved version identifier, build result, and any difference from local.
9. Wait for explicit user approval.
10. Only after approval, deploy that exact saved version.

Never deploy an unreviewed build. Do not claim a preview URL is private without checking its access settings.
