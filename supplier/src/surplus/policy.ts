export interface SurplusCompetitor {
  id: string;
  inputMicroUsdPer1m: number;
  outputMicroUsdPer1m: number;
}

export interface SurplusPricePolicyInput {
  upstreamInputMicroUsdPer1m: number;
  upstreamOutputMicroUsdPer1m: number;
  recoveryBps: number;
  undercutBps: number;
  competitors: SurplusCompetitor[];
}

export interface SurplusPriceQuote {
  inputMicroUsdPer1m: number;
  outputMicroUsdPer1m: number;
  inputUsdPer1m: number;
  outputUsdPer1m: number;
  floorInputMicroUsdPer1m: number;
  floorOutputMicroUsdPer1m: number;
  competitorId: string | null;
  competitive: boolean;
}

const BPS_SCALE = 10_000n;
const MICRO_USD = 1_000_000;

export function quoteSurplusPrice(
  input: SurplusPricePolicyInput,
): SurplusPriceQuote {
  positiveSafeInteger(
    input.upstreamInputMicroUsdPer1m,
    "upstream input price",
  );
  positiveSafeInteger(
    input.upstreamOutputMicroUsdPer1m,
    "upstream output price",
  );
  boundedBps(input.recoveryBps, "recoveryBps", 1, 10_000);
  boundedBps(input.undercutBps, "undercutBps", 0, 9_999);

  const floorInput = multiplyBpsCeil(
    input.upstreamInputMicroUsdPer1m,
    input.recoveryBps,
  );
  const floorOutput = multiplyBpsCeil(
    input.upstreamOutputMicroUsdPer1m,
    input.recoveryBps,
  );

  const competitor = cheapestCompetitor(input.competitors);
  const candidateInput = competitor
    ? undercut(competitor.inputMicroUsdPer1m, input.undercutBps)
    : floorInput;
  const candidateOutput = competitor
    ? undercut(competitor.outputMicroUsdPer1m, input.undercutBps)
    : floorOutput;
  const quotedInput = Math.max(floorInput, candidateInput);
  const quotedOutput = Math.max(floorOutput, candidateOutput);

  return {
    inputMicroUsdPer1m: quotedInput,
    outputMicroUsdPer1m: quotedOutput,
    inputUsdPer1m: quotedInput / MICRO_USD,
    outputUsdPer1m: quotedOutput / MICRO_USD,
    floorInputMicroUsdPer1m: floorInput,
    floorOutputMicroUsdPer1m: floorOutput,
    competitorId: competitor?.id ?? null,
    competitive: competitor === null || (
      quotedInput < competitor.inputMicroUsdPer1m &&
      quotedOutput < competitor.outputMicroUsdPer1m
    ),
  };
}

export function usdPer1mToMicroUsd(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number`);
  }
  const result = Math.ceil(value * MICRO_USD);
  positiveSafeInteger(result, field);
  return result;
}

export function formatMicroUsd(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("micro-USD value must be a non-negative safe integer");
  }
  const whole = Math.floor(value / MICRO_USD);
  const fraction = (value % MICRO_USD).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

function cheapestCompetitor(
  competitors: SurplusCompetitor[],
): SurplusCompetitor | null {
  let result: SurplusCompetitor | null = null;
  for (const competitor of competitors) {
    positiveSafeInteger(competitor.inputMicroUsdPer1m, "competitor input price");
    positiveSafeInteger(competitor.outputMicroUsdPer1m, "competitor output price");
    if (result === null || compareCompetitors(competitor, result) < 0) {
      result = competitor;
    }
  }
  return result;
}

function compareCompetitors(
  left: SurplusCompetitor,
  right: SurplusCompetitor,
): number {
  return (
    left.inputMicroUsdPer1m + left.outputMicroUsdPer1m -
      (right.inputMicroUsdPer1m + right.outputMicroUsdPer1m) ||
    left.inputMicroUsdPer1m - right.inputMicroUsdPer1m ||
    left.outputMicroUsdPer1m - right.outputMicroUsdPer1m ||
    left.id.localeCompare(right.id)
  );
}

function undercut(value: number, bps: number): number {
  const discounted = Number(
    (BigInt(value) * BigInt(10_000 - bps)) / BPS_SCALE,
  );
  if (discounted >= value && value > 1) return value - 1;
  return Math.max(1, discounted);
}

function multiplyBpsCeil(value: number, bps: number): number {
  const numerator = BigInt(value) * BigInt(bps);
  return Number((numerator + BPS_SCALE - 1n) / BPS_SCALE);
}

function positiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

function boundedBps(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be from ${minimum} to ${maximum}`);
  }
}
