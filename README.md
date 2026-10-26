<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/header/graph.svg?title=Kronik&amp;subtitle=Public+GitHub+activity,+presented+clearly.&amp;logo=github&amp;align=left&amp;font=geist-mono&amp;border=false&amp;mode=dark" />
    <img alt="Kronik" src="https://shieldcn.dev/header/graph.svg?title=Kronik&amp;subtitle=Public+GitHub+activity,+presented+clearly.&amp;logo=github&amp;align=left&amp;font=geist-mono&amp;border=false&amp;mode=light" />
  </picture>
</p>

<p align="center">
  A focused API that turns a GitHub user's public development activity into portfolio-friendly summaries.
</p>

<p align="center">
  <a href="https://github.com/Matthieusz/kronik/actions/workflows/ci.yml"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/ci/Matthieusz/kronik.svg?workflow=ci.yml&amp;branch=main&amp;variant=secondary&amp;size=xs&amp;mode=dark" /><img alt="CI status" src="https://shieldcn.dev/github/ci/Matthieusz/kronik.svg?workflow=ci.yml&amp;branch=main&amp;variant=secondary&amp;size=xs&amp;mode=light" /></picture></a>
  <a href="https://github.com/Matthieusz/kronik/stargazers"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/stars/Matthieusz/kronik.svg?variant=secondary&amp;size=xs&amp;mode=dark" /><img alt="GitHub stars" src="https://shieldcn.dev/github/stars/Matthieusz/kronik.svg?variant=secondary&amp;size=xs&amp;mode=light" /></picture></a>
  <a href="LICENSE"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/license/Matthieusz/kronik.svg?variant=secondary&amp;size=xs&amp;mode=dark" /><img alt="License" src="https://shieldcn.dev/github/license/Matthieusz/kronik.svg?variant=secondary&amp;size=xs&amp;mode=light" /></picture></a>
</p>

## What it does

- Lists public default-branch commits attributed to a GitHub user.
- Summarizes changes and repository language composition over a bounded activity window.
- Reports current and longest contribution streaks.

Built with **TypeScript**, **Effect**, **Bun**, and **Cloudflare Workers**.

## Local development

```bash
bun install
cp .env.example .env
# Add the required credentials to .env
bun dev
```

Run the full verification suite with `bun run verify`.

### Documentation

The [Blume](https://useblume.dev/) site in `apps/docs` requires Node.js 22.19 or newer.
Its Markdown/MDX content lives in `apps/docs/content`; API reference pages are generated
directly from `packages/contract/openapi.json`.

```bash
cd apps/docs
bun run dev
bun run build
bun run validate
```

Static output is written to `apps/docs/dist`. Alchemy serves it through the existing
Worker gateway, forwarding `/api/*` to the API. `API_URL` sets the build-time playground
server (Alchemy supplies it; standalone builds default to `https://kronik.informati.dev/api`).
The unmodified Kronik contract remains available at `/openapi.json`; Blume's separate
JSON docs API is disabled to avoid colliding with these routes.

## License

[MIT](LICENSE)
