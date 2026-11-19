# Releasing

A `v*` tag creates the GitHub release for `@mu-crew/mu`, with the matching
CHANGELOG section as its notes. Publishing to npm is manual for now (step 5).

1. Bump `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`)
   and move the CHANGELOG's Unreleased entries under `## [x.y.z] — <date>`.
   Keep the section short: over GitHub's 125000-character body limit the
   release fails.
2. Run the fast gate locally, then commit:

   ```sh
   npm run typecheck && npm run lint && npm run test:fast
   git commit -am "release: mu X.Y.Z (<headline>)"
   ```

3. Run the full gate on that exact commit in CI: push it to a `ci/**` branch
   and wait for the Test workflow (fast job plus four integration shards,
   about 5 minutes) to go green.

   ```sh
   git push origin HEAD:refs/heads/ci/release-X.Y.Z
   gh run watch "$(gh run list --branch ci/release-X.Y.Z --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
   ```

4. Tag the same commit and push both:

   ```sh
   git tag -a vX.Y.Z -m "mu X.Y.Z"
   git push origin main vX.Y.Z
   ```

   The Release workflow refuses a tag that does not match `package.json`, and
   one whose commit has no successful Test run. A re-run updates the existing
   GitHub release.

5. Publish from the tagged checkout (`prepare` builds; npm asks for 2FA):

   ```sh
   npm publish --access public
   ```

   CI does not publish: trusted publishing (OIDC) failed with `ENEEDAUTH` on
   every release since the repo moved to `mu-crew/mu`. Re-add the trusted
   publisher on npmjs.com (owner `mu-crew`, repository `mu`, workflow
   `release.yml`) and restore an `npm publish` step (with `id-token: write`
   and npm 11.5.1+) to bring it back.

Delete the `ci/release-X.Y.Z` branch afterwards.
