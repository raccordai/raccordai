## What & why

<!-- The problem solved or the feature added, in 2-3 sentences.
     Link the issue: Closes #… -->

## How it works

<!-- Chosen approach, notable architecture points, discarded alternatives. -->

## How to test

<!-- Concrete steps to verify the change in the app.
     Screenshot / screencast REQUIRED for any UI change. -->

## Known limitations

<!-- What this PR does not cover, accepted debt, planned follow-ups. -->

## Checklist

- [ ] `pnpm typecheck && pnpm test && pnpm build` pass locally
- [ ] Tests added for new logic, `coverage.include` scope updated
- [ ] UI strings added to `fr/common.json` **and** `en/common.json`
- [ ] Additive-only DB migration (if the schema changed)
- [ ] Colors via `styles.css` tokens (if UI)
- [ ] Feature flag created (if early-phase feature)
- [ ] Capability added to the MCP registry (if new app capability)
- [ ] Screenshot attached (if visible change)
