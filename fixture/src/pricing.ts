/**
 * Pricing for the fixture storefront.
 *
 * Two planted defects:
 *   - `TAX_RATE` is declared and never used (lint finding)
 *   - `applyTax` hardcodes 8% instead of using the declared rate (test finding)
 *   - `lineTotal` is not exported, but cart.ts imports it (typecheck finding)
 */
const TAX_RATE = 0.08;

export function applyTax(amount: number): number {
  return amount * 0.08;
}

function lineTotal(quantity: number, price: number): number {
  return quantity * price;
}
