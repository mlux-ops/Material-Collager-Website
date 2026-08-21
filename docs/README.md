# Material Collager Documentation

Browser app for creating high-end interior design material collage boards from real image references, self-hosted on Cloudflare Workers. Governing documents: [`AGENTS.md`](../AGENTS.md) (binding fidelity rules) and [`directive/foundation.md`](../directive/foundation.md) (project foundation, v1.0.0).

## Generated reference

| Doc | Contents |
|---|---|
| [Architecture](architecture.md) | System overview, component hierarchy, state, data flow, rendering strategy |
| [API Reference](api-reference.md) | Route handlers, custom hooks, environment variables, bindings |
| [Developer Setup](setup.md) | Prerequisites, install, dev server, tests, QA states |
| [Component Guide](component-guide.md) | Shared primitives, workbench, scene surfaces, styling system |
| [Deployment](deployment.md) | CI pipeline, bindings, Access, release gates — defers to [DEPLOYING.md](DEPLOYING.md) |
| [Troubleshooting](troubleshooting.md) | Known constraints and their fixes, from dev to production |

## Project records (hand-authored)

### Deploy & release
- [DEPLOYING.md](DEPLOYING.md) — authoritative one-time deployment setup
- [Staging deployment checklist](staging-deployment-checklist.md)
- [Production readiness](production-readiness.md)
- [Release decisions](release-decisions.md)
- [Release rights worksheet](release-rights-worksheet.md) · [release-collage-rights.json](release-collage-rights.json) ([schema](release-collage-rights.schema.json))
- [Device release QA](device-release-qa.md)

### Fidelity & visual QA
- [Reference spec](reference-spec.md) — approved reference behavior
- [Fidelity ledger](fidelity-ledger.md)
- [Visual QA](visual-qa.md)
- [Library integration QA](library-integration-qa.md)
- [Scene Lab visual QA](scene-lab-visual-qa.md)
- [Transitions QA](transitions-qa.md)
- [Pre-Scene-Lab regression baseline](pre-scene-lab-regression-baseline.md)

### Design & planning
- [Implementation plan](implementation-plan.md)
- [Workbench node editor design](workbench-node-editor-design.md)
- [Workbench interaction inventory](workbench-interaction-inventory.md)
- [Scene Lab compatibility spike](scene-lab-compatibility-spike.md)

## Quick start

```bash
git clone https://github.com/mlux-ops/Material-Collager-Website.git
cd Material-Collager-Website
npm install
cp .dev.vars.example .dev.vars   # fill in OPENAI_API_KEY
npm run dev
```

Requires Node >= 22.13. No Cloudflare account needed locally — Miniflare simulates the D1/R2 bindings. Full details in [setup.md](setup.md).
