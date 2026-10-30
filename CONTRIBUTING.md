# Contributing

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

[Open an issue](https://github.com/OwenWright8/tagarr/issues/new/choose) with:

- the Tagarr version (Settings → About) and your Jellyfin and Seerr versions
- what you expected and what happened
- anything relevant from the **Activity** page or `docker compose logs tagarr`

Remove API keys and webhook addresses before pasting logs or settings.

## Suggesting a feature

Open a feature request and start with the problem: what you're trying to do and what gets in the way. That makes it much easier to find a fix that suits other households too.

## Making a change

Tagarr is a small codebase on purpose: a Node 24 server (TypeScript run directly, built-in SQLite, Fastify) and a React + Tailwind UI. Getting going:

```sh
npm ci
npx playwright install chromium   # once, for the UI smoke test
npm run dev:mock                  # fake Jellyfin on :8096 and Seerr on :5055
npm run dev                       # API on :8686, UI on http://localhost:5173
```

Point the setup wizard at `http://localhost:8096` (key `jellyfin-key`) and `http://localhost:5055` (key `seerr-key`). The fakes in `scripts/mock-servers.ts` hold a small demo library.

Before opening a pull request:

```sh
npm run typecheck
npm test                                  # server and sync engine end to end against the fakes
npm run build && npm run screenshots      # walks every page in Chromium
```

A few house rules:

- **Leave Jellyfin as you found it.** Tagarr only adds and removes people's tags (and manages the collections it made). Every edit sends back only the fields Jellyfin's editor reads; see `editableFields` in `server/jellyfin.ts`.
- **If the fakes and real Jellyfin disagree, the fakes are wrong.** When you fix a bug that real Jellyfin showed you, teach `scripts/mock-servers.ts` to behave the same way, and add a test that fails without your fix.
- **Migrations are append-only.** Never edit one that has shipped in a release; add a new one to the end of the list in `server/db.ts`.
- **Write UI text for the person using it.** Plain words, no internal jargon, and say what will happen ("hidden until Oct 1"), not how.
- **Update the README** when a setting or a self-hosting step changes.

Label your pull request `feature`, `fix`, `self-hosting` or `breaking`; the release notes are grouped by label.

## License

By contributing, you agree your contribution is released under the [MIT License](LICENSE).
