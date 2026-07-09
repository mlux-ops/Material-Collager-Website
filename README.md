# Material Collager

A browser app for creating high-end interior design material collage boards from real image references.

The app uploads each selected reference image to the server for the current generation request and sends those files to OpenAI's Image API as actual `gpt-image-2` image inputs. The references are not reduced to text descriptions.

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
MATERIAL_COLLAGER_QA_MODEL=gpt-5.5
```

## App Workflow

- Choose a collage type.
- Use the preset item rows or add custom rows.
- Upload item-level reference images.
- Run Dry Run to preview the exact prompt.
- Generate to receive a downloadable PNG.
- Toggle QA review when you want a vision check after generation.

## Legacy CLI

The original Python CLI remains available:

```powershell
material-collager dry-run --input request.json
material-collager generate --input request.json --output out.png
```

