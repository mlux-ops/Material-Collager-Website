# Apply the Material Collager patch

1. Close the local development server.
2. Back up or commit the current project state.
3. Open `project-files/` from this package.
4. Copy everything inside `project-files/` into:

   `C:\Users\cowey\OneDrive\Documents\Material Collager`

5. Allow Windows to merge folders and replace existing files.
6. Open PowerShell in the project directory and run:

```powershell
npm ci
npm run validate:rights
npm run test:release-readiness
npm run test:scene-lab
$env:PYTHONPATH = "src"
python -m unittest discover -s tests -v
python artifacts/reference-audit/validate_reference_audit.py
npm run lint
npm run build
npm audit --omit=dev
```

Do not copy the `verification/` folder into the project. It contains the results from this implementation workspace only.
