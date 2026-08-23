import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConnectionInfo, ConnectionInput, SslMode } from '@shared/protocol';
import {
  createConnection,
  queryKeys,
  testConnection,
  testConnectionInput,
  updateConnection,
} from '@/lib/api';
import { cn } from '@/lib/format';
import { Check } from 'lucide-react';
import { Button, Dialog, ErrorBanner, Field, Input, Select, toast } from '@/components/ui';

const SSL_MODES: SslMode[] = ['disable', 'prefer', 'require', 'verify-full'];

/** Fixed palette - the colour tints this connection everywhere in the UI. */
const COLORS: { value: string; label: string }[] = [
  { value: '#ef4444', label: 'Red' },
  { value: '#f59e0b', label: 'Amber' },
  { value: '#10b981', label: 'Emerald' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#8b5cf6', label: 'Violet' },
  { value: '#ec4899', label: 'Pink' },
];

type Form = {
  name: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  sslMode: SslMode;
  color: string | null;
  readOnly: boolean;
};

const blank = (c?: ConnectionInfo | null): Form => ({
  name: c?.name ?? '',
  host: c?.host ?? 'localhost',
  port: String(c?.port ?? 5432),
  database: c?.database ?? 'postgres',
  user: c?.user ?? 'postgres',
  password: '',
  sslMode: c?.sslMode ?? 'prefer',
  color: c?.color ?? null,
  readOnly: c?.readOnly ?? false,
});

export default function ConnectionDialog({
  open,
  onOpenChange,
  existing,
  prefill,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing?: ConnectionInfo | null;
  /** seed a NEW connection from this one - the stored password cannot be copied, so it is retyped */
  prefill?: ConnectionInfo | null;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(() => blank(existing ?? prefill));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    if (open) {
      const seed = existing ?? prefill;
      const f = blank(seed);
      // a duplicate needs a name of its own, and the database is the field you came here to change
      setF(!existing && prefill ? { ...f, name: `${prefill.name} copy`, database: '' } : f);
    }
  }, [open, existing, prefill]);

  const input = (): ConnectionInput => ({
    name: f.name.trim(),
    host: f.host.trim(),
    port: Number(f.port) || 5432,
    database: f.database.trim(),
    user: f.user.trim(),
    sslMode: f.sslMode,
    color: f.color,
    readOnly: f.readOnly,
    // omitted on edit when left empty = keep the stored password
    ...(f.password ? { password: f.password } : {}),
  });

  const test = useMutation({
    // editing without retyping the password: test the stored credentials by id
    mutationFn: () =>
      existing && !f.password ? testConnection(existing.id) : testConnectionInput(input()),
  });

  const save = useMutation({
    mutationFn: () =>
      existing ? updateConnection(existing.id, input()) : createConnection(input()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.connections });
      toast(existing ? 'Connection saved' : 'Connection created');
      onOpenChange(false);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={existing ? `Edit ${existing.name}` : prefill ? `New connection from ${prefill.name}` : 'New connection'}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.error && <ErrorBanner error={save.error} />}

        <Field label="Name" htmlFor="cd-name">
          <Input
            id="cd-name"
            required
            value={f.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Production replica"
          />
        </Field>

        <div className="flex gap-3">
          <Field label="Host" htmlFor="cd-host" className="flex-1">
            <Input id="cd-host" required value={f.host} onChange={(e) => set('host', e.target.value)} />
          </Field>
          <Field label="Port" htmlFor="cd-port" className="w-28">
            <Input
              id="cd-port"
              type="number"
              min={1}
              max={65535}
              required
              value={f.port}
              onChange={(e) => set('port', e.target.value)}
            />
          </Field>
        </div>

        <Field label="Database" htmlFor="cd-db">
          <Input id="cd-db" required value={f.database} onChange={(e) => set('database', e.target.value)} />
        </Field>

        <div className="flex gap-3">
          <Field label="User" htmlFor="cd-user" className="flex-1">
            <Input
              id="cd-user"
              required
              autoComplete="off"
              value={f.user}
              onChange={(e) => set('user', e.target.value)}
            />
          </Field>
          <Field label="Password" htmlFor="cd-pw" className="flex-1">
            <Input
              id="cd-pw"
              type="password"
              autoComplete="new-password"
              value={f.password}
              onChange={(e) => set('password', e.target.value)}
              placeholder={existing ? 'unchanged' : ''}
            />
          </Field>
        </div>

        <Field label="SSL mode" htmlFor="cd-ssl">
          <Select id="cd-ssl" value={f.sslMode} onChange={(e) => set('sslMode', e.target.value as SslMode)}>
            {SSL_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>

        <fieldset>
          <legend className="placard">Colour</legend>
          <div className="mt-1 flex items-center gap-2">
            {COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                aria-label={c.label}
                aria-pressed={f.color === c.value}
                onClick={() => set('color', c.value)}
                style={{ background: c.value }}
                className={cn(
                  'grid size-7 place-items-center rounded-md border border-line-strong shadow-sm',
                  f.color === c.value && 'ring-2 ring-accent ring-offset-2 ring-offset-elevated',
                )}
              >
                {f.color === c.value ? <Check className="size-4 text-white" aria-hidden /> : null}
              </button>
            ))}
            <button
              type="button"
              aria-label="No colour"
              aria-pressed={f.color === null}
              onClick={() => set('color', null)}
              // The swatches take a ring because a swatch IS its colour; this one is a control
              // like any other, so it states selection by filling.
              className={cn(
                'h-7 rounded-md border px-2.5 text-sm font-medium',
                f.color === null
                  ? 'border-accent bg-accent text-accent-fg'
                  : 'border-line-strong bg-elevated text-muted hover:bg-hover',
              )}
            >
              None
            </button>
          </div>
        </fieldset>

        <label className="flex items-start gap-2.5 text-sm text-muted">
          <input
            type="checkbox"
            className="mt-0.5 size-4 rounded-xs accent-accent outline-none"
            checked={f.readOnly}
            onChange={(e) => set('readOnly', e.target.checked)}
          />
          <span>
            <span className="font-medium text-fg">Read only</span>
            <br />
            Sets <code>default_transaction_read_only</code> on every session opened through
            this connection.
          </span>
        </label>

        <div
          className="min-h-8 text-xs"
          role="status"
          aria-live="polite"
        >
          {test.isPending && <span className="text-muted">Testing...</span>}
          {test.data?.ok && (
            <span className="text-ok">
              Connected: PostgreSQL {test.data.serverVersion} in {test.data.latencyMs} ms
            </span>
          )}
          {test.data && !test.data.ok && (
            <span className="text-danger">{test.data.error}</span>
          )}
          {test.error instanceof Error && (
            <span className="text-danger">{test.error.message}</span>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button type="button" onClick={() => test.mutate()} disabled={test.isPending}>
            Test connection
          </Button>
          <span className="flex-1" />
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {existing ? 'Save' : 'Create'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
