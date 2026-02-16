import DecimalModule from 'decimal.js';

const Decimal = DecimalModule.default ?? DecimalModule;
type DecimalInstance = InstanceType<typeof Decimal>;

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export function D(value: string | number | DecimalInstance): DecimalInstance {
  return new Decimal(value);
}

export function add(a: string, b: string): string {
  return D(a).plus(D(b)).toString();
}

export function sub(a: string, b: string): string {
  return D(a).minus(D(b)).toString();
}

export function mul(a: string, b: string): string {
  return D(a).times(D(b)).toString();
}

export function div(a: string, b: string): string {
  return D(a).div(D(b)).toString();
}

export function gt(a: string, b: string): boolean {
  return D(a).greaterThan(D(b));
}

export function lt(a: string, b: string): boolean {
  return D(a).lessThan(D(b));
}

export function gte(a: string, b: string): boolean {
  return D(a).greaterThanOrEqualTo(D(b));
}

export function lte(a: string, b: string): boolean {
  return D(a).lessThanOrEqualTo(D(b));
}

export function isZero(a: string): boolean {
  return D(a).isZero();
}

export function abs(a: string): string {
  return D(a).abs().toString();
}

export function neg(a: string): string {
  return D(a).negated().toString();
}

export function min(a: string, b: string): string {
  return Decimal.min(D(a), D(b)).toString();
}

export function max(a: string, b: string): string {
  return Decimal.max(D(a), D(b)).toString();
}

export function roundToDecimals(value: string, decimals: number): string {
  return D(value).toDecimalPlaces(decimals, Decimal.ROUND_DOWN).toString();
}

export function roundPx(value: string): string {
  return D(value).toSignificantDigits(5).toString();
}
