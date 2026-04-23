# Contributing

Thanks for contributing to the Knowhere Node.js SDK.

## Development Setup

Requirements:

- Node.js 20.19.0+
- npm 10+

Install dependencies:

```bash
npm ci
```

## Local Checks

Run these commands before opening a pull request:

```bash
npm run format:check
npm run typecheck
npm run lint
npm run test:ci
npm run build
```

If you change public behavior, also update the relevant materials in:

- `README.md`
- `examples/`
- `docs/release-workflow.md` if you change the release contract

## Release Notes

Pull requests that should publish a package release must include a changeset:

```bash
npm run changeset
```

Maintainers handle versioning and publishing through the release workflow.
