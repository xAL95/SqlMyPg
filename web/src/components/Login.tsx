import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gauge, Plug } from 'lucide-react';
import { bootstrap, getAuthConfig, login, queryKeys } from '@/lib/api';
import { Badge, Button, ErrorBanner, Field, Input } from '@/components/ui';

/** The mark: three ascending bars in a filled tile, the same one the app bar carries. */
function Mark({ size = 28 }: { size?: number }) {
  const bar = Math.round(size * 0.19);
  return (
    <span
      className="grid shrink-0 place-items-center rounded-md bg-accent"
      style={{ width: size, height: size }}
    >
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 12 12" aria-hidden className="text-accent-fg">
        <rect x="0" y="8" width={bar} height="4" rx="1" fill="currentColor" />
        <rect x="4.5" y="4" width={bar} height="8" rx="1" fill="currentColor" />
        <rect x="9" y="0" width={bar} height="12" rx="1" fill="currentColor" />
      </svg>
    </span>
  );
}

/**
 * Sign-on is the one surface that has to explain the product to someone who did not build it,
 * because this is self-hosted by strangers: the left side states the mechanism, the right side
 * takes the credentials.
 */
export default function Login({ mode }: { mode: 'login' | 'bootstrap' }) {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: queryKeys.authConfig, queryFn: getAuthConfig });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  const submit = useMutation({
    mutationFn: () => (mode === 'bootstrap' ? bootstrap({ email, password, name }) : login({ email, password })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.me });
      qc.invalidateQueries({ queryKey: queryKeys.authConfig });
    },
  });

  const authError = new URLSearchParams(window.location.search).get('authError');
  const localEnabled = cfg.data?.localEnabled ?? true;
  const oidc = cfg.data?.oidcEnabled ? (cfg.data.oidcLabel ?? 'Single sign-on') : null;

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <header className="flex h-10 shrink-0 items-center gap-2.5 rule-b bg-surface px-3">
        <Mark size={22} />
        <span className="font-display text-base font-semibold">SqlMyPg</span>
        <span aria-hidden className="h-4 w-px bg-line" />
        <span className="text-sm text-muted">{mode === 'bootstrap' ? 'First run' : 'Sign in'}</span>
        <span className="flex-1" />
        <Badge tone="warn">Not signed in</Badge>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_30rem]">
        {/* Left: what this thing is. A stranger runs this, so the mechanism is stated once here
            rather than assumed. */}
        <section className="mx-auto flex min-h-0 w-full max-w-2xl flex-col justify-center gap-8 px-8 py-12">
          <h1 className="max-w-[46ch] text-balance text-[34px] leading-[42px] font-semibold tracking-[-0.02em] text-fg">
            A Postgres client where every tab holds one real backend for as long as it lives.
          </h1>

          <div className="flex flex-col gap-4">
            {[
              {
                icon: <Plug className="size-4" aria-hidden />,
                title: 'The session is real',
                body: (
                  <>
                    A <Code>BEGIN</Code> here opens a transaction on a pinned connection and keeps it. Temp tables,{' '}
                    <Code>SET LOCAL</Code>, advisory locks, cursors and <Code>pg_temp</Code> all behave exactly as
                    they do in psql, because it is the same kind of session.
                  </>
                ),
              },
              {
                icon: <Gauge className="size-4" aria-hidden />,
                title: 'Built for tables that are already large',
                body: (
                  <>
                    Nothing here counts rows, offsets pages, or buffers a whole result set. Estimates come from the
                    planner, paging seeks by key, and an export streams straight to the response.
                  </>
                ),
              },
            ].map((f) => (
              <div key={f.title} className="flex gap-3.5 rounded-lg border border-line bg-surface p-4">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text">
                  {f.icon}
                </span>
                <div className="min-w-0">
                  <h2 className="font-display font-semibold text-fg">{f.title}</h2>
                  <p className="mt-1 text-sm text-muted">{f.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Right: the form, on the chrome plane so it reads as the thing to act on. */}
        <section className="flex flex-col justify-center gap-5 border-t border-line bg-surface px-8 py-12 lg:border-t-0 lg:border-l lg:px-10">
          <div className="flex flex-col gap-1.5">
            <h2 className="font-display text-xl font-semibold text-fg">
              {mode === 'bootstrap' ? 'Create the admin account' : 'Sign in'}
            </h2>
            <p className="text-sm text-muted">
              {mode === 'bootstrap'
                ? 'No account exists on this server yet. The first one created becomes the admin.'
                : 'Credentials are checked against this server only.'}
            </p>
          </div>

          {authError ? <ErrorBanner error={authError} /> : null}
          {submit.error ? <ErrorBanner error={submit.error} /> : null}

          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit.mutate();
            }}
          >
            {mode === 'bootstrap' ? (
              <Field label="Name" htmlFor="lg-name">
                <Input id="lg-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </Field>
            ) : null}
            <Field label="Email" htmlFor="lg-email">
              <Input
                id="lg-email"
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                disabled={!localEnabled}
              />
            </Field>
            <Field label="Password" htmlFor="lg-pw">
              <Input
                id="lg-pw"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'bootstrap' ? 'new-password' : 'current-password'}
                disabled={!localEnabled}
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              className="mt-1 h-10 w-full"
              disabled={!localEnabled}
              loading={submit.isPending}
            >
              {mode === 'bootstrap' ? 'Create admin account' : 'Sign in'}
            </Button>
          </form>

          {!localEnabled ? (
            <p className="rounded-md border border-line bg-elevated p-3 text-sm text-muted">
              Password sign-in is disabled on this server. Use single sign-on below.
            </p>
          ) : null}

          {oidc ? (
            <a
              href="/api/auth/oidc/start"
              className="flex h-10 w-full items-center justify-center rounded-md border border-line-strong bg-elevated font-medium text-fg shadow-sm hover:bg-hover"
            >
              Continue with {oidc}
            </a>
          ) : null}
        </section>
      </div>

      {/* The facts sit below both columns: inside one column their contents wrapped while the
          border stopped at the column edge. */}
      <dl className="flex shrink-0 flex-wrap items-center gap-x-7 gap-y-1 rule-t bg-surface px-8 py-2.5 lg:px-14">
        {[
          ['Paging', 'keyset seek'],
          ['Row counts', 'planner estimate'],
          ['Export', 'COPY streamed'],
          ['Cancel', 'pg_cancel_backend'],
          ['Session', 'one pinned pg.Client'],
        ].map(([k, v]) => (
          <div key={k} className="annot">
            <dt className="k">{k}</dt>
            <dd className="v">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Inline SQL inside prose: mono, tinted, and not a full code block. */
function Code({ children }: { children: string }) {
  return (
    <code className="rounded-xs bg-elevated px-1 font-mono text-[0.9em] text-ident">{children}</code>
  );
}
