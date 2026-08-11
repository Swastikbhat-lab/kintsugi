export function calculateShipping(weightKg: number): number {
  return weightKg <= 5 ? 4.99 : 9.99;
}
