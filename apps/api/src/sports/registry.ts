/**
 * Sport engine registry (T-19).
 *
 * Engines are selected by `match.sport`. Registration is explicit so the
 * application boundary controls which engines are available; core never imports
 * `sports/`.
 */

import type { Sport } from '@skoriva/shared';
import type { SportEngineRuntime } from './shared/types.js';

export type SportRegistryErrorCode = 'ENGINE_NOT_FOUND' | 'ENGINE_ALREADY_REGISTERED';

export class SportRegistryError extends Error {
  constructor(
    readonly code: SportRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SportRegistryError';
  }
}

export class SportRegistry {
  private readonly engines = new Map<Sport, SportEngineRuntime>();

  register(engine: SportEngineRuntime): void {
    if (this.engines.has(engine.sport)) {
      throw new SportRegistryError(
        'ENGINE_ALREADY_REGISTERED',
        `A sport engine is already registered for ${engine.sport}.`,
      );
    }

    this.engines.set(engine.sport, engine);
  }

  get(sport: Sport): SportEngineRuntime {
    const engine = this.engines.get(sport);

    if (!engine) {
      throw new SportRegistryError('ENGINE_NOT_FOUND', `No sport engine registered for ${sport}.`);
    }

    return engine;
  }

  has(sport: Sport): boolean {
    return this.engines.has(sport);
  }

  list(): SportEngineRuntime[] {
    return [...this.engines.values()];
  }
}

/** Default process registry; built-in engines are registered by `builtins.ts`. */
export const sportRegistry = new SportRegistry();
