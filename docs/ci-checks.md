# CI checks

## WordPress checks and link checking (2026-10-06)
- **Links**: `links.yml` checks the links in Markdown and `readme.txt` files with [lychee](https://github.com/lycheeverse/lychee). It runs on pull requests that change them, monthly and on demand. It is not part of the security gate, because a third-party site being down should not block a merge. Exclusions are in `.lychee.toml`; adventistai.lt is excluded because its Cloudflare bot protection answers GitHub runners with 403.
