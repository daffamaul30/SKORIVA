/**
 * FE-G4 DOM tests — DropdownMenu (keyboard) and Select (pointer + keyboard).
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

describe('DropdownMenu', () => {
  it('opens, moves the roving focus with ArrowDown and closes on Escape', async () => {
    const user = userEvent.setup();

    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Menu akun</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Arsipkan</DropdownMenuItem>
          <DropdownMenuItem>Hapus</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByRole('button', { name: 'Menu akun' }));

    expect(await screen.findByRole('menuitem', { name: 'Arsipkan' })).toBeVisible();
    // Radix focuses the menu container first; ArrowDown enters the item list.
    expect(screen.getByRole('menu')).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Arsipkan' })).toHaveFocus(),
    );

    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Hapus' })).toHaveFocus());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('selects the first item with a single ArrowDown then Enter', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();

    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Menu akun</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onArchive}>Arsipkan</DropdownMenuItem>
          <DropdownMenuItem>Hapus</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByRole('button', { name: 'Menu akun' }));
    await screen.findByRole('menu');

    await user.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Arsipkan' })).toHaveFocus(),
    );

    await user.keyboard('{Enter}');

    expect(onArchive).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });
});

describe('Select', () => {
  it('opens the listbox and reports the chosen option', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <Select onValueChange={onChange}>
        <SelectTrigger aria-label="Cabang olahraga">
          <SelectValue placeholder="Pilih cabang" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="basketball">Basketball</SelectItem>
          <SelectItem value="futsal">Futsal</SelectItem>
        </SelectContent>
      </Select>,
    );

    const trigger = screen.getByRole('combobox', { name: 'Cabang olahraga' });
    await user.click(trigger);

    const option = await screen.findByRole('option', { name: 'Futsal' });
    await user.click(option);

    expect(onChange).toHaveBeenCalledWith('futsal');
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('Futsal'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
