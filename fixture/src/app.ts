import { calculateShipping } from './shipping-costs.js';
import { loadConfig } from './config.js';

export function estimate(weightKg: number): string {
  const { currency } = loadConfig();
  return `${currency} ${calculateShipping(weightKg)}`;
}
