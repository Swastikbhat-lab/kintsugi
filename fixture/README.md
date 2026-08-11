# Kintsugi fixture

A deliberately-broken package the loop repairs. Version 0.1.0.

The planted defects, one per check domain:

- **lint** — an unused constant `TAX_RATE` in `src/pricing.ts`
- **typecheck** — an import path that points at a module that does not exist
  (`./shipping-costs.js` instead of `./shipping.js`) in `src/app.ts`
- **typecheck** — an import of `lineTotal`, which exists in `src/pricing.ts`
  but is not exported (TS2459)
- **test** — `applyTax` returns 8% when the tests assert 10%
- **version** — this README and `package.json` disagree on the version

One defect is deliberately unrepairable: `src/app.ts` imports `loadConfig`,
and no such function exists anywhere. No mechanical edit can write it — a
model would have to invent the implementation, and a human should decide.
The loop quarantines it with evidence instead of guessing.
