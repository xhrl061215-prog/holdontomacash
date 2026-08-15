// Type surface for the consultant rules, so the TS test file can import them.
export interface Insight { id: string; tone: string; text: string }
export function buildInsights(ctx: any, limit?: number): Insight[]
export function money(value: string | number, currency: string): string
export function percentOf(part: string | number, whole: string | number): string | null
export function percentChange(before: string | number, after: string | number): string | null
export function decSub(a: string | number, b: string | number): string
export function decCompare(a: string | number, b: string | number): number
export function isZero(a: string | number): boolean
