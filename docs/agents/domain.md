# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root: points at one `CONTEXT.md` per context (app or package). Read each one relevant to the topic.
- **`docs/adr/`** at the repo root: system-wide decisions. Also check `apps/<app>/docs/adr/` and `packages/<package>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, proceed silently. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This is a pnpm monorepo (`apps/*`, `packages/*`) — each app or package is one context. Config-only packages (`packages/eslint-config`, `packages/typescript-config`) are not contexts.

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 저장소 전체에 걸친 결정
├── apps/
│   └── demo/
│       ├── CONTEXT.md
│       └── docs/adr/                  ← apps/demo 범위의 결정
└── packages/
    └── pyodide-repl/
        ├── CONTEXT.md
        └── docs/adr/                  ← packages/pyodide-repl 범위의 결정
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
