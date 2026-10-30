# Security

## Reporting a problem

Please don't open a public issue for a security problem. Report it privately instead:
[**Report a vulnerability**](https://github.com/OwenWright8/tagarr/security/advisories/new) (on the repo's **Security** tab).

Say what you found, which version (Settings → About shows it), and how to reproduce it if you can. You'll get a reply within a week. Once it's fixed in a release, the advisory is published, with credit to you if you'd like.

## Supported versions

Only the latest release gets fixes. Updating is a `docker compose pull && docker compose up -d`; see [Updating](README.md#updating).

## What's in scope

Tagarr holds admin API keys for Jellyfin and Seerr, so these matter most:

- Getting past the sign-in, or reading or changing anything without a session
- Getting the Jellyfin or Seerr API keys out of Tagarr
- The webhook, widget keys or season cover uploads doing more than they should
- Anything that lets one Jellyfin user see another's hidden titles because of something Tagarr did

Out of scope: problems that need someone who's already signed in to Tagarr (they're the admin), Jellyfin's or Seerr's own vulnerabilities (report those upstream), and running Tagarr on the open internet without HTTPS (see [Security notes](README.md#security-notes)).
