/**
 * Per-sport configuration validation (T-19).
 *
 * Structure is validated by the shared Zod schemas. This module enforces the
 * sport-specific rules that those loose schemas intentionally leave open:
 * required/forbidden config blocks, numeric ranges, no timeout, and clock-mode
 * constraints.
 */

import type { MatchConfig, Sport } from '@skoriva/shared';
import type { ValidationResult } from '@skoriva/shared';
import {
  BADMINTON_LIMITS,
  BASKETBALL_LIMITS,
  FUTSAL_LIMITS,
  VOLLEYBALL_LIMITS,
} from './constants.js';
import { validationFail, validationOk } from './types.js';

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function hasTimeout(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;

  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
    if (key === 'timeout' || key.startsWith('timeout')) return true;
    return hasTimeout(nested);
  });
}

function checkPeriods(
  config: MatchConfig,
  bounds: {
    minPeriodCount: number;
    maxPeriodCount: number;
    minPeriodDurationMs: number;
    maxPeriodDurationMs: number;
  },
): ValidationResult {
  const { count, durationMs } = config.periods;

  if (!isInteger(count) || count < bounds.minPeriodCount || count > bounds.maxPeriodCount) {
    return validationFail(
      'INVALID_CONFIG',
      `periods.count must be between ${bounds.minPeriodCount} and ${bounds.maxPeriodCount}.`,
    );
  }

  if (
    !isInteger(durationMs) ||
    durationMs < bounds.minPeriodDurationMs ||
    durationMs > bounds.maxPeriodDurationMs
  ) {
    return validationFail(
      'INVALID_CONFIG',
      `periods.durationMs must be between ${bounds.minPeriodDurationMs} and ${bounds.maxPeriodDurationMs}.`,
    );
  }

  if (config.periods.labels !== undefined && config.periods.labels.length !== count) {
    return validationFail('INVALID_CONFIG', 'periods.labels length must equal periods.count.');
  }

  return validationOk();
}

function checkNoForeignSportBlocks(
  config: MatchConfig,
  allowed: { volleyball: boolean; badminton: boolean },
): ValidationResult {
  if (!allowed.volleyball && config.volleyball !== undefined) {
    return validationFail('INVALID_CONFIG', 'volleyball config is not allowed for this sport.');
  }
  if (!allowed.badminton && config.badminton !== undefined) {
    return validationFail('INVALID_CONFIG', 'badminton config is not allowed for this sport.');
  }
  return validationOk();
}

function checkScoring(config: MatchConfig, allowedPoints: readonly number[]): ValidationResult {
  const points = config.scoring.pointsPerGoal;

  if (!Array.isArray(points) || points.length === 0) {
    return validationFail('INVALID_CONFIG', 'scoring.pointsPerGoal must not be empty.');
  }

  if (points.some((value) => !allowedPoints.includes(value))) {
    return validationFail(
      'INVALID_CONFIG',
      `scoring.pointsPerGoal must only contain ${allowedPoints.join(', ')}.`,
    );
  }

  return validationOk();
}

function validateBasketball(config: MatchConfig): ValidationResult {
  if (config.gameClock.mode !== 'timed') {
    return validationFail('INVALID_CONFIG', 'Basketball requires a timed game clock.');
  }

  if (config.shotClock.enabled !== true) {
    return validationFail('INVALID_CONFIG', 'Basketball requires an enabled shot clock.');
  }

  const shot = config.shotClock.durationMs;
  if (
    !isInteger(shot) ||
    shot < BASKETBALL_LIMITS.minShotClockMs ||
    shot > BASKETBALL_LIMITS.maxShotClockMs
  ) {
    return validationFail(
      'INVALID_CONFIG',
      `shotClock.durationMs must be between ${BASKETBALL_LIMITS.minShotClockMs} and ${BASKETBALL_LIMITS.maxShotClockMs}.`,
    );
  }

  return firstFailure([
    checkPeriods(config, BASKETBALL_LIMITS),
    checkScoring(config, [1, 2, 3]),
    checkNoForeignSportBlocks(config, { volleyball: false, badminton: false }),
  ]);
}

function validateFutsal(config: MatchConfig): ValidationResult {
  if (config.gameClock.mode === 'timed' && typeof config.gameClock.allowStop !== 'boolean') {
    return validationFail('INVALID_CONFIG', 'Futsal timed clock requires allowStop.');
  }

  if (config.shotClock.enabled !== false) {
    return validationFail('INVALID_CONFIG', 'Futsal does not support a shot clock.');
  }

  return firstFailure([
    checkPeriods(config, FUTSAL_LIMITS),
    checkScoring(config, [1]),
    checkNoForeignSportBlocks(config, { volleyball: false, badminton: false }),
  ]);
}

function validateBadminton(config: MatchConfig): ValidationResult {
  if (config.gameClock.mode !== 'none') {
    return validationFail('INVALID_CONFIG', 'Badminton must not have a timed game clock.');
  }

  if (config.shotClock.enabled !== false) {
    return validationFail('INVALID_CONFIG', 'Badminton does not support a shot clock.');
  }

  if (!config.badminton) {
    return validationFail('INVALID_CONFIG', 'Badminton config is required.');
  }

  const rules = config.badminton;

  if (rules.bestOf !== 3) {
    return validationFail('INVALID_CONFIG', 'Badminton bestOf must be 3.');
  }

  if (
    !isInteger(rules.pointTarget) ||
    rules.pointTarget < BADMINTON_LIMITS.minPointTarget ||
    rules.pointTarget > BADMINTON_LIMITS.maxPointTarget
  ) {
    return validationFail('INVALID_CONFIG', 'Badminton pointTarget is out of range.');
  }

  if (
    !isInteger(rules.winByDiff) ||
    rules.winByDiff < BADMINTON_LIMITS.minWinByDiff ||
    rules.winByDiff > BADMINTON_LIMITS.maxWinByDiff
  ) {
    return validationFail('INVALID_CONFIG', 'Badminton winByDiff is out of range.');
  }

  if (
    !isInteger(rules.pointCap) ||
    rules.pointCap < BADMINTON_LIMITS.minPointCap ||
    rules.pointCap > BADMINTON_LIMITS.maxPointCap
  ) {
    return validationFail('INVALID_CONFIG', 'Badminton pointCap is out of range.');
  }

  if (!isInteger(rules.intervalAt) || rules.intervalAt <= 0) {
    return validationFail('INVALID_CONFIG', 'Badminton intervalAt must be positive.');
  }

  if (!isInteger(rules.intervalDurationMs) || rules.intervalDurationMs <= 0) {
    return validationFail('INVALID_CONFIG', 'Badminton intervalDurationMs must be positive.');
  }

  if (!isInteger(rules.changeEndsAtDecidingSet) || rules.changeEndsAtDecidingSet < 0) {
    return validationFail('INVALID_CONFIG', 'Badminton changeEndsAtDecidingSet is invalid.');
  }

  if (config.periods.count !== 3 || config.periods.durationMs !== 0) {
    return validationFail('INVALID_CONFIG', 'Badminton periods must be 3 sets with no duration.');
  }

  return firstFailure([
    checkScoring(config, [1]),
    checkNoForeignSportBlocks(config, { volleyball: false, badminton: true }),
  ]);
}

function validateVolleyball(config: MatchConfig): ValidationResult {
  if (config.gameClock.mode !== 'none') {
    return validationFail('INVALID_CONFIG', 'Volleyball must not have a timed game clock.');
  }

  if (config.shotClock.enabled !== false) {
    return validationFail('INVALID_CONFIG', 'Volleyball does not support a shot clock.');
  }

  if (!config.volleyball) {
    return validationFail('INVALID_CONFIG', 'Volleyball config is required.');
  }

  const rules = config.volleyball;

  if (rules.bestOf !== 3 && rules.bestOf !== 5) {
    return validationFail('INVALID_CONFIG', 'Volleyball bestOf must be 3 or 5.');
  }

  if (
    !isInteger(rules.pointTarget) ||
    rules.pointTarget < VOLLEYBALL_LIMITS.minPointTarget ||
    rules.pointTarget > VOLLEYBALL_LIMITS.maxPointTarget
  ) {
    return validationFail('INVALID_CONFIG', 'Volleyball pointTarget is out of range.');
  }

  if (!isInteger(rules.tiebreakTarget) || rules.tiebreakTarget <= 0) {
    return validationFail('INVALID_CONFIG', 'Volleyball tiebreakTarget must be positive.');
  }

  if (
    !isInteger(rules.winByDiff) ||
    rules.winByDiff < VOLLEYBALL_LIMITS.minWinByDiff ||
    rules.winByDiff > VOLLEYBALL_LIMITS.maxWinByDiff
  ) {
    return validationFail('INVALID_CONFIG', 'Volleyball winByDiff is out of range.');
  }

  if (config.periods.count !== rules.bestOf || config.periods.durationMs !== 0) {
    return validationFail(
      'INVALID_CONFIG',
      'Volleyball periods.count must equal bestOf and duration must be 0.',
    );
  }

  return firstFailure([
    checkScoring(config, [1]),
    checkNoForeignSportBlocks(config, { volleyball: true, badminton: false }),
  ]);
}

function firstFailure(results: ValidationResult[]): ValidationResult {
  for (const result of results) {
    if (!result.ok) return result;
  }
  return validationOk();
}

/** Validate a match config for a sport. */
export function validateSportConfig(sport: Sport, config: MatchConfig): ValidationResult {
  if (hasTimeout(config)) {
    return validationFail('INVALID_CONFIG', 'Timeout configuration is not part of the MVP.');
  }

  switch (sport) {
    case 'basketball':
      return validateBasketball(config);
    case 'futsal':
      return validateFutsal(config);
    case 'badminton':
      return validateBadminton(config);
    case 'volleyball':
      return validateVolleyball(config);
  }
}
