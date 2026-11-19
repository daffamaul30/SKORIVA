/**
 * FE-G4 DOM tests — Form primitives with real Zod validation.
 *
 * The schema comes from the shared contract package, so this also proves the
 * UI layer can drive shared validation without duplicating rules.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';

const teamFormSchema = z.object({
  teamName: z.string().trim().min(3, 'Nama tim minimal 3 karakter'),
});

type TeamFormValues = z.infer<typeof teamFormSchema>;

function TeamForm({ onSubmit }: { onSubmit: (values: TeamFormValues) => void }) {
  const form = useForm<TeamFormValues>({
    resolver: zodResolver(teamFormSchema),
    defaultValues: { teamName: '' },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <FormField
          control={form.control}
          name="teamName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nama tim</FormLabel>
              <FormControl>
                <Input placeholder="Tim A" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <button type="submit">Simpan</button>
      </form>
    </Form>
  );
}

describe('Form with Zod validation', () => {
  it('shows the Zod error message when the field is invalid', async () => {
    const user = userEvent.setup();
    render(<TeamForm onSubmit={vi.fn()} />);

    await user.type(screen.getByLabelText('Nama tim'), 'AB');
    await user.click(screen.getByRole('button', { name: 'Simpan' }));

    expect(await screen.findByText('Nama tim minimal 3 karakter')).toBeInTheDocument();
    expect(screen.getByLabelText('Nama tim')).toHaveAttribute('aria-invalid', 'true');
  });

  it('submits parsed values when the input is valid', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TeamForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('Nama tim'), '  Garuda  ');
    await user.click(screen.getByRole('button', { name: 'Simpan' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // `trim()` is applied by the shared contract before submit.
    expect(onSubmit).toHaveBeenCalledWith({ teamName: 'Garuda' }, expect.anything());
    expect(screen.queryByText('Nama tim minimal 3 karakter')).not.toBeInTheDocument();
  });
});
