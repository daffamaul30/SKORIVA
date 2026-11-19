/**
 * FE-G1 proof: the frontend consumes `@skoriva/shared` for both
 * compile-time types and runtime values (Zod schemas / constants).
 *
 * This test intentionally stays tiny and feature-free: it proves the
 * workspace package resolves from `apps/web` under TypeScript strict mode,
 * is transpiled by Next.js, and exposes its runtime exports.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  MATCH_STATUSES,
  SPORTS,
  getDefaultSportConfig,
  matchStatusSchema,
  sportSchema,
  type MatchStatus,
  type ScoreboardView,
  type Sport,
  type SportState,
  type TeamSide,
} from '@skoriva/shared';

describe('@skoriva/shared integration', () => {
  it('exposes the MVP domain constants with their exact union types', () => {
    // Typed bindings make TypeScript verify the exported types, not only values.
    const sports: readonly Sport[] = SPORTS;
    const statuses: readonly MatchStatus[] = MATCH_STATUSES;

    expect(sports).toStrictEqual(['basketball', 'futsal', 'badminton', 'volleyball']);
    expect(statuses).toStrictEqual(['ready', 'live', 'finished', 'cancelled']);
  });

  it('parses shared Zod schemas at runtime', () => {
    expect(sportSchema.safeParse('basketball').success).toBe(true);
    // Soccer is out of scope (PRD D-11), so it must be rejected.
    expect(sportSchema.safeParse('soccer').success).toBe(false);
    expect(matchStatusSchema.safeParse('live').success).toBe(true);
    expect(matchStatusSchema.safeParse('paused').success).toBe(false);
  });

  it('returns sport default configurations from the shared selector', () => {
    const basketball = getDefaultSportConfig('basketball');
    const volleyball = getDefaultSportConfig('volleyball');

    expect(basketball.shotClock.enabled).toBe(true);
    // Volleyball never has a game clock (Tech Spec §4.7).
    expect(volleyball.gameClock.mode).toBe('none');
  });

  it('renders a typed ScoreboardView server-side from shared types', () => {
    const home: TeamSide = 'home';
    const sportState: SportState = {};
    const view: ScoreboardView = {
      matchStatus: 'ready',
      resultDecision: 'undecided',
      teams: {
        home: { name: 'Tim A' },
        away: { name: 'Tim B' },
      },
      score: { home: 0, away: 0 },
      period: { index: 1, label: 'Q1' },
    };

    expect(view.teams[home].name).toBe('Tim A');
    expect(Object.keys(sportState)).toHaveLength(0);

    const html = renderToStaticMarkup(
      <output data-view-status={view.matchStatus}>
        {view.teams.home.name} vs {view.teams.away.name}
      </output>,
    );

    expect(html).toContain('Tim A vs Tim B');
    expect(html).toContain('data-view-status="ready"');
  });
});
