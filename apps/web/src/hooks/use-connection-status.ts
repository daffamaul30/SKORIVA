/**
 * Connection status projection (T-31.7).
 *
 * Turns the store's raw connection state into the labels the UI will need
 * (§20). No UI is built here — this is a data hook only.
 */

import { useMatchSession } from '@/features/match-session/store/match-session.store';
import type { ConnectionState } from '@/features/match-session/store/match-session.store';

export type ConnectionStatus = 'idle' | 'connected' | 'reconnecting' | 'disconnected';

export interface ConnectionStatusView {
  status: ConnectionStatus;
  /** Operator controls must be disabled while false. */
  interactive: boolean;
  label: string;
}

const LABELS: Record<ConnectionStatus, string> = {
  idle: 'Belum terhubung',
  connected: 'Terhubung',
  reconnecting: 'Menghubungkan ulang…',
  disconnected: 'Terputus',
};

export function toConnectionStatusView(state: ConnectionState): ConnectionStatusView {
  return {
    status: state,
    interactive: state === 'connected',
    label: LABELS[state],
  };
}

export function useConnectionStatus(): ConnectionStatusView {
  const connection = useMatchSession((state) => state.connection);

  return toConnectionStatusView(connection);
}
