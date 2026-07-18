# Release QA evidence

Create a dated, ignored working directory with:

```powershell
npm run qa:scaffold -- --date YYYY-MM-DD --commit COMMIT_SHA --base-url https://PRIVATE-REVIEW-URL
```

The generated date directory is intentionally ignored because it may contain environment details, screenshots, recordings, and generated reports. Reusable templates remain tracked in `templates/`.
