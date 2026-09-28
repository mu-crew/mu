# Releasing

A `v*` tag publishes `@mu-crew/mu` to npm. There is no token: npmjs.com
trusts this repo's `.github/workflows/release.yml` through OIDC (trusted
publishing: owner `mu-crew`, repository `mu`, workflow `release.yml`).

1. Bump `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`)
   and move the CHANGELOG's Unreleased entries under it.
2. Run the full local gate. CI cannot: the tests drive real tmux panes and a pi binary.

   ```sh
   npm run typecheck && npm run lint && npm run test
   ```

3. Commit, tag the same version, push both:

   ```sh
   git tag -a vX.Y.Z -m "mu X.Y.Z"
   git push origin main vX.Y.Z
   ```

The workflow refuses a tag that does not match `package.json`.

The workflow also creates the GitHub release for the tag, with the matching
CHANGELOG section as its notes. It fails if that section is missing, so add
the CHANGELOG entry before tagging.
