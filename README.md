# SWE-bench Science Leaderboard

A static, interactive leaderboard for the SWE-bench Science benchmark. The site is built with Next.js and exported as static HTML for GitHub Pages.

## Requirements

- Node.js `>=22.13.0`
- npm

## Local development

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

## Updating benchmark data

All benchmark content lives in [`data/benchmark.json`](data/benchmark.json). Update that file to change:

- the last-updated date;
- task, repository, and domain totals;
- model configurations, scores, harnesses, and token counts.

Public and private scores are task-level macro-averages: compute each task's test pass fraction first, then average the 119 task fractions with equal weight. Pass@1 is the mean binary reward across the same 119 tasks.

Presentation details such as colors, chart labels, and responsive layout remain in the application code.

Validate an edit before committing:

```bash
npm run data:validate
```

The validator rejects duplicate IDs, missing fields, invalid dates, percentages outside `0–100`, negative token counts, and aggregate scores that disagree with the task matrix. `npm run build` runs this validation automatically.

## Static build

```bash
npm run build
```

The deployable site is generated in `out/`.

## GitHub Pages

The workflow at [`.github/workflows/pages.yml`](.github/workflows/pages.yml) validates, builds, and deploys the site whenever `main` is updated.

In the repository settings, select:

1. **Settings → Pages**
2. **Build and deployment → Source → GitHub Actions**

Project repositories are automatically built with their repository name as the Next.js base path, so both `owner.github.io` sites and `owner.github.io/repository` sites are supported.

## Commands

- `npm run dev` — start local development
- `npm run data:validate` — validate benchmark data
- `npm run build` — validate and export the static site
- `npm test` — build and test the generated HTML
- `npm run lint` — run ESLint
