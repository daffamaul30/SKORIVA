/**
 * FE-G3 render tests: every installed UI primitive is rendered for real via
 * `renderToStaticMarkup`. These are not file-existence checks — a component
 * that throws, loses its `data-slot`, or imports a missing dependency fails.
 *
 * Portals (dialog, sheet, dropdown, select, alert-dialog) do not emit markup on
 * the server, so those tests assert the closed-state root instead.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { useForm } from 'react-hook-form';
import { describe, expect, it } from 'vitest';
import { AlertDialog } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { DropdownMenu } from '@/components/ui/dropdown-menu';
import { Form, FormField, FormItem, FormLabel } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

describe('cn helper', () => {
  it('re-exports the cn package without duplicating the implementation', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-sm', undefined, 'hidden')).toBe('text-sm hidden');
  });
});

describe('ui primitives render', () => {
  it('renders Input and Textarea with their data-slot hooks', () => {
    expect(renderToStaticMarkup(<Input placeholder="Nama tim" />)).toContain('data-slot="input"');
    expect(renderToStaticMarkup(<Textarea placeholder="Deskripsi" />)).toContain(
      'data-slot="textarea"',
    );
  });

  it('renders Label and Separator', () => {
    expect(renderToStaticMarkup(<Label htmlFor="team">Nama tim</Label>)).toContain(
      'data-slot="label"',
    );
    expect(renderToStaticMarkup(<Separator />)).toContain('data-slot="separator"');
  });

  it('renders Card composition', () => {
    const html = renderToStaticMarkup(
      <Card>
        <CardHeader>
          <CardTitle>Event</CardTitle>
        </CardHeader>
      </Card>,
    );
    expect(html).toContain('data-slot="card"');
    expect(html).toContain('Event');
  });

  it('renders Badge variants', () => {
    expect(renderToStaticMarkup(<Badge>LIVE</Badge>)).toContain('data-slot="badge"');
    expect(renderToStaticMarkup(<Badge variant="destructive">CANCELLED</Badge>)).toContain(
      'data-variant="destructive"',
    );
  });

  it('renders Skeleton', () => {
    expect(renderToStaticMarkup(<Skeleton className="h-4 w-10" />)).toContain(
      'data-slot="skeleton"',
    );
  });

  it('renders Tabs composition', () => {
    const html = renderToStaticMarkup(
      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">Konfigurasi</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(html).toContain('data-slot="tabs"');
    expect(html).toContain('Konfigurasi');
  });

  it('renders the Button primitive', () => {
    expect(renderToStaticMarkup(<Button>Simpan</Button>)).toContain('data-slot="button"');
  });
});

describe('overlay roots render in the closed state', () => {
  it('renders Dialog, AlertDialog, Sheet, DropdownMenu and Select roots', () => {
    expect(renderToStaticMarkup(<Dialog open={false} />)).toBe('');
    expect(renderToStaticMarkup(<AlertDialog open={false} />)).toBe('');
    expect(renderToStaticMarkup(<Sheet open={false} />)).toBe('');
    expect(renderToStaticMarkup(<DropdownMenu open={false} />)).toBe('');
    // Radix Select renders a hidden native fallback even while closed.
    expect(renderToStaticMarkup(<Select open={false} />)).toContain('aria-hidden="true"');
  });
});

describe('form primitives', () => {
  function ExampleForm() {
    // `useForm` requires an error resolver shape that the UI layer stays
    // agnostic about; typing it explicitly keeps `no-explicit-any` satisfied.
    const form = useForm<{ teamName: string }>({ defaultValues: { teamName: '' } });

    return (
      <Form {...form}>
        <form>
          <FormField
            control={form.control}
            name="teamName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Nama tim</FormLabel>
                <Input {...field} placeholder="Tim A" />
              </FormItem>
            )}
          />
        </form>
      </Form>
    );
  }

  it('renders a FormField without throwing', () => {
    const html = renderToStaticMarkup(<ExampleForm />);

    expect(html).toContain('Nama tim');
    expect(html).toContain('data-slot="form-item"');
    expect(html).toContain('data-slot="input"');
  });
});
