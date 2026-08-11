import { lineTotal } from './pricing.js';

export function cartTotal(items: Array<{ quantity: number; price: number }>): number {
  return items.reduce((sum, item) => sum + lineTotal(item.quantity, item.price), 0);
}
