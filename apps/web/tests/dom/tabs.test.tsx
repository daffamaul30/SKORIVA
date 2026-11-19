/**
 * FE-G4 DOM tests — Tabs switching and accessibility state.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

function renderTabs() {
  return render(
    <Tabs defaultValue="config">
      <TabsList aria-label="Pengaturan match">
        <TabsTrigger value="config">Konfigurasi</TabsTrigger>
        <TabsTrigger value="teams">Tim</TabsTrigger>
      </TabsList>
      <TabsContent value="config">Panel konfigurasi</TabsContent>
      <TabsContent value="teams">Panel tim</TabsContent>
    </Tabs>,
  );
}

describe('Tabs', () => {
  it('marks the initial tab as selected and shows its panel', () => {
    renderTabs();

    const configTab = screen.getByRole('tab', { name: 'Konfigurasi' });
    expect(configTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel konfigurasi');
  });

  it('switches panel and aria-selected when another tab is clicked', async () => {
    const user = userEvent.setup();
    renderTabs();

    await user.click(screen.getByRole('tab', { name: 'Tim' }));

    expect(screen.getByRole('tab', { name: 'Tim' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Konfigurasi' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel tim');
  });
});
