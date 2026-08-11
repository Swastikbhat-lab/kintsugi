# Contributing

Thanks for caring about this repo. The loop is small by design — keep it
that way.

## The bar

- **A new rule class** belongs in `src/propose.ts` and needs a test in
  `test/propose.test.ts` plus a planted defect in the fixture. If the defect
  has no *objectively correct* edit, the rule does not exist — that is what
  the model path is for.
- **A new check parser** belongs in `src/parsers.ts` with a test. The
  contract is one sentence: give me typed failures.
- **Never weaken the verify gate.** A patch that cannot be re-verified is a
  patch that cannot be shipped. If you are tempted to skip the re-run for
  speed, the answer is fewer checks, not weaker verification.

## Running it

```bash
npm install
cd fixture && npm install
npm run typecheck
npm test                 # includes an end-to-end loop run against the fixture
npm run demo             # watch the loop repair the fixture, keyless
```

The end-to-end test copies the fixture to a temp dir, so your checkout stays
pristine. Reset a mutated fixture with `git checkout -- fixture`.

## Releasing

Version bumps in `package.json` plus the fixture README version (they must
agree — the version check says so). Commit each logical change separately;
`git log` in this repo is the style guide.
