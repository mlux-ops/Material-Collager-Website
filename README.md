# Material Collager

A browser app for creating high-end interior design material collage boards from real image references.

The app preserves selected source files in a browser draft and transfers each original reference in small request-safe chunks. Generation then retrieves those prepared files and sends them through the documented multipart Image API workflow as actual `gpt-image-2` inputs. References are not reduced to text descriptions or silently compressed into a small combined browser request.

Generation uses high input fidelity, item-by-item image mapping, explicit editorial art direction, and optional post-generation vision review. A board can use up to 16 PNG, JPEG, or WebP references, each under 50 MB.

## Local Development

```powershell
npm install
npm run dev
```

Open the local URL shown in the terminal.

## Production Build

```powershell
npm run build
```

## Runtime Environment

The hosted app uses `OPENAI_API_KEY` when configured as a Sites runtime secret.

If the server key is not configured, the UI also accepts a per-request API key in the password field. That key is sent only with the generation request and is not stored by the app.

Optional:

```text
MATERIAL_COLLAGER_QA_MODEL=gpt-5.6
```

## App Workflow

- Choose a collage type.
- Use the preset item rows or add custom rows.
- Add, remove, and prioritize item-level reference images.
- Choose composition, spacing, lighting, styling, hero item, and output resolution.
- Run Dry Run to preview the exact prompt.
- Generate to receive a downloadable high-resolution PNG.
- Keep QA review enabled for an item-by-item fidelity check after generation.

## Legacy CLI

The original Python CLI remains available:

```powershell
material-collager dry-run --input request.json
material-collager generate --input request.json --output out.png
```
