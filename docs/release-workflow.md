# Release Workflow

This repository uses [Changesets](https://github.com/changesets/changesets)
for release coordination.

## Stable Release Flow

Normal feature and fix pull requests:

1. Add a changeset with `npm run changeset` when the change should publish a new
   package version.
2. Merge the pull request into `main`.

What happens after merge:

1. The `Release Management` GitHub Actions workflow runs on `main`.
2. Changesets creates or updates the `Release package` pull request.
3. That release pull request contains the version bump and changelog updates.
4. Merge the `Release package` pull request when you are ready to publish.
5. The merge publishes the package to npm under the `latest` dist-tag, creates
   the matching GitHub release, and creates the `v<version>` git tag.

Important notes:

- The release artifact is a pull request, not a GitHub issue.
- CI requires a changeset on pull requests targeting `main`, except for the
  auto-generated `changeset-release/*` release pull request.
- The stable publish path is implemented in `.github/workflows/release.yml`.

## Beta Release Flow

Beta releases are manual on purpose.

1. Go to GitHub Actions and run the `Release Management` workflow manually.
2. Choose the git ref to publish from. The default is `main`.
3. Choose the npm dist-tag. The default is `beta`.

What happens during the workflow:

1. The workflow validates the selected ref with the normal repository checks.
2. Pending changesets are converted into a snapshot prerelease version such as
   `0.2.0-beta.20260407170000`.
3. The package is published to npm using the selected dist-tag, usually
   `beta`.
4. GitHub creates a prerelease entry and a matching `v<version>` tag.

Important notes:

- Beta publishes do not commit prerelease state back to the branch.
- Stable and beta publishes share the same workflow file because npm trusted
  publishing is configured per workflow path.

## Repository Setup

Before the first automated publish:

1. Preferred: configure npm trusted publishing for this package and allow the
   workflow `.github/workflows/release.yml` in the npm package settings.
2. Alternative: set the GitHub Actions secret `NPM_TOKEN` with publish access
   to `@ontos-ai/knowhere-sdk`. The workflow maps that secret to
   `NODE_AUTH_TOKEN` for `npm publish`.
3. Provenance is currently disabled because npm does not accept GitHub Actions
   provenance from private source repositories. Re-enable `--provenance` if
   this repository becomes public.

## Maintainer Commands

- `npm run changeset`: create a release note and semver bump entry
- `npm run release:version`: run `changeset version`
- `npm run release:publish`: publish a stable release and create the GitHub release
- `npm run release:beta`: publish a beta snapshot and create the GitHub prerelease
