/**
 * FE-G4 DOM tests — modal overlays (Dialog, AlertDialog, Sheet).
 *
 * Every case opens the overlay for real and asserts interactive behaviour,
 * not just the closed state.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

describe('Dialog', () => {
  it('opens from its trigger and moves focus into the dialog', async () => {
    const user = userEvent.setup();

    render(
      <Dialog>
        <DialogTrigger>Buka konfirmasi</DialogTrigger>
        <DialogContent>
          <DialogTitle>Konfirmasi Finish</DialogTitle>
          <DialogDescription>Akhiri pertandingan?</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Buka konfirmasi' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeVisible();
    expect(screen.getByText('Konfirmasi Finish')).toBeInTheDocument();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('closes when Escape is pressed', async () => {
    const user = userEvent.setup();

    render(
      <Dialog>
        <DialogTrigger>Buka</DialogTrigger>
        <DialogContent>
          <DialogTitle>Judul</DialogTitle>
          <DialogDescription>Deskripsi</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    await user.click(screen.getByRole('button', { name: 'Buka' }));
    expect(await screen.findByRole('dialog')).toBeVisible();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('AlertDialog', () => {
  function renderAlert(props: { onConfirm: () => void; onCancel: () => void }) {
    return render(
      <AlertDialog>
        <AlertDialogTrigger>Buang hasil</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Buang hasil?</AlertDialogTitle>
            <AlertDialogDescription>Hasil tidak akan disimpan.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={props.onCancel}>Batal</AlertDialogCancel>
            <AlertDialogAction onClick={props.onConfirm}>Buang</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );
  }

  it('invokes the confirm callback', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    renderAlert({ onConfirm, onCancel });

    await user.click(screen.getByRole('button', { name: 'Buang hasil' }));
    await user.click(await screen.findByRole('button', { name: 'Buang' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('invokes the cancel callback and closes', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    renderAlert({ onConfirm, onCancel });

    await user.click(screen.getByRole('button', { name: 'Buang hasil' }));
    await user.click(await screen.findByRole('button', { name: 'Batal' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });
});

describe('Sheet', () => {
  it('opens a side panel and closes from the close button', async () => {
    const user = userEvent.setup();

    render(
      <Sheet>
        <SheetTrigger>Buka panel</SheetTrigger>
        <SheetContent>
          <SheetTitle>Kontrol Operator</SheetTitle>
          <SheetDescription>Panel kontrol di layar kecil.</SheetDescription>
        </SheetContent>
      </Sheet>,
    );

    await user.click(screen.getByRole('button', { name: 'Buka panel' }));

    const sheet = await screen.findByRole('dialog');
    expect(sheet).toBeVisible();
    expect(screen.getByText('Kontrol Operator')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /close/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
