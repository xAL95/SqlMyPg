import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Info, TriangleAlert, X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/format';

/* ------------------------------- tab actions ------------------------------ */

/**
 * The tab strip's right-hand slot, owned by whichever tab is active.
 *
 * Both tab kinds used to carry their own toolbar directly under the strip - a second bar, and on a
 * browse tab a relation name printed twice. Each active tab now renders its controls into this slot
 * instead, so the editor or the grid starts immediately beneath the tabs.
 */
export const TAB_ACTIONS_ID = 'tab-actions';

/** Hidden tabs stay mounted, so the caller decides who is allowed to fill the slot. */
export function TabActions({ children }: { children: ReactNode }) {
  // The shell renders the slot above us, so it only exists from the first commit onward.
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.getElementById(TAB_ACTIONS_ID)), []);
  return host ? createPortal(children, host) : null;
}

/* --------------------------------- basics --------------------------------- */

/** Three easing dots: the busy signal this tool class uses. Markup lives in `.scanner`. */
export function Spinner({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('scanner shrink-0 text-accent-text', className)}>
      <i />
      <i />
      <i />
    </span>
  );
}

/* Controls are objects with a body: a rounded plate, a border that separates it from the panel, and
   one step of tone on hover. Only the primary action is filled - if every button is filled, none of
   them is primary, which is the single most common way this class of UI loses its hierarchy. */
const BUTTON_VARIANTS = {
  default: 'border-line-strong bg-elevated text-fg shadow-sm hover:bg-hover hover:border-faint',
  ghost: 'border-transparent bg-transparent text-muted hover:bg-hover hover:text-fg',
  danger: 'border-danger/50 bg-transparent text-danger hover:bg-danger-soft hover:border-danger',
  primary: 'border-accent bg-accent text-accent-fg shadow-sm hover:brightness-110',
};

export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ComponentProps<'button'> & {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: 'sm' | 'md';
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap',
        'rounded-md border font-medium',
        'disabled:pointer-events-none disabled:screened disabled:border-line disabled:bg-transparent disabled:text-faint disabled:shadow-none',
        // 32px is the hit target this tool class settled on; sm is for controls inside a data row.
        size === 'sm' ? 'h-7 px-2 text-sm' : 'h-8 px-3',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className={variant === 'primary' ? 'text-accent-fg' : undefined} /> : null}
      {children}
    </button>
  );
}

/* A field is a plate you can type into, not a well cut out of the panel: it stands on the surface
   with its own border, and the border takes the accent plus a ring when it holds the caret. */
const FIELD =
  'w-full rounded-md border border-line-strong bg-elevated text-fg placeholder:text-faint ' +
  'disabled:screened focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30';

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return <input className={cn(FIELD, 'h-8 px-2.5', className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  return <textarea className={cn(FIELD, 'px-2.5 py-2', className)} {...rest} />;
}

/** native select on purpose: keyboard, type-ahead and screen readers all come for free */
export function Select({ className, children, ...rest }: ComponentProps<'select'>) {
  return (
    <span className="relative inline-flex w-full items-center">
      <select className={cn(FIELD, 'h-8 appearance-none pl-2.5 pr-8', className)} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 size-4 text-muted" aria-hidden />
    </span>
  );
}

export function Checkbox({ className, ...rest }: ComponentProps<'input'>) {
  return (
    <input
      type="checkbox"
      className={cn('size-4 shrink-0 rounded-xs accent-accent disabled:screened', className)}
      {...rest}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label ? (
        <label htmlFor={htmlFor} className="placard">
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <span className="text-sm text-danger">{error}</span>
      ) : hint ? (
        <span className="text-sm text-faint">{hint}</span>
      ) : null}
    </div>
  );
}

/* A badge is a soft pill in its own state colour. Tinted rather than filled, because a badge
   annotates something else on the row and must not out-shout it. */
const BADGE_TONES = {
  default: 'border-line-strong bg-surface text-muted',
  accent: 'border-accent/40 bg-accent-soft text-accent-text',
  ok: 'border-ok/40 bg-ok/12 text-ok',
  warn: 'border-warn/40 bg-warn/12 text-warn',
  danger: 'border-danger/40 bg-danger-soft text-danger',
};

export function Badge({
  tone = 'default',
  className,
  children,
}: {
  tone?: keyof typeof BADGE_TONES;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-full border px-2 text-xs font-medium',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A key cap: the shortcut is printed the way the platform prints it. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 items-center rounded-xs border border-line-strong bg-surface px-1.5 font-mono text-xs text-muted',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  hint,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    // Centred and given room: an empty state is the first thing a new operator reads, so it gets
    // the weight of a page and not the weight of a caption.
    <div className={cn('flex h-full flex-col items-center justify-center gap-3 p-8 text-center', className)}>
      {icon ? (
        <span className="grid size-11 place-items-center rounded-full bg-surface text-muted">{icon}</span>
      ) : null}
      <span className="text-lg font-semibold text-fg">{title}</span>
      {(description ?? hint) ? (
        <p className="max-w-md text-sm text-muted">{description ?? hint}</p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function ErrorBanner({
  error,
  message,
  code,
  hint,
  onRetry,
  onDismiss,
  className,
}: {
  error?: unknown;
  message?: ReactNode;
  /** Postgres SQLSTATE, e.g. 42P01 */
  code?: string;
  /** Postgres HINT line - often the actual answer, so it is shown, not swallowed */
  hint?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
}) {
  const text = message ?? (error instanceof Error ? error.message : error == null ? null : String(error));
  if (text == null) return null;
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2.5 rounded-md border border-danger/50 bg-danger-soft px-3 py-2.5 text-danger',
        className,
      )}
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <div className="whitespace-pre-wrap break-words">
          {/* SQLSTATE is a permanent annotation, not a decoration to fade out. */}
          {code ? (
            <span className="mr-1.5 rounded-xs border border-danger/40 px-1 font-mono text-xs">{code}</span>
          ) : null}
          {text}
        </div>
        {hint ? (
          <div className="mt-1 flex gap-1.5 whitespace-pre-wrap break-words">
            <span className="shrink-0 text-xs font-medium opacity-80">Hint</span>
            <span className="opacity-90">{hint}</span>
          </div>
        ) : null}
      </div>
      {onRetry ? (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
      {onDismiss ? (
        <Button size="sm" variant="ghost" onClick={onDismiss} aria-label="Dismiss error">
          <X className="size-4" aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

/* --------------------------------- dialog --------------------------------- */

/* An overlay floats above the panel and says so with a real shadow: offset down, softly spread.
   The old world had no shadows and faked depth with a double hairline; this one does not need to. */
const LIFTED = 'rounded-lg border border-line-strong bg-elevated shadow-lg';

export function Dialog({
  open,
  onOpenChange,
  onClose,
  title,
  description,
  footer,
  width = 480,
  children,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  onClose?: () => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  width?: number;
  children?: ReactNode;
}) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange?.(next);
        if (!next) onClose?.();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <DialogPrimitive.Content
          style={{ width: `min(92vw, ${width}px)` }}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden',
            LIFTED,
          )}
        >
          {/* The header states what this is and offers the way out. It does not need to be a
              coloured field to be read as the active surface - the shadow already says that. */}
          <div className="flex shrink-0 items-start justify-between gap-4 px-4 pt-3.5 pb-3">
            <div className="min-w-0">
              <DialogPrimitive.Title className="truncate font-display text-lg font-semibold text-fg">
                {title}
              </DialogPrimitive.Title>
              {/* Radix wants a Description for aria-describedby; fall back to the title rather than nothing. */}
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-sm text-muted">
                  {description}
                </DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="-mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
            >
              <X className="size-4" aria-hidden />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">{children}</div>
          {footer ? (
            <div className="flex shrink-0 items-center justify-end gap-2 rule-t bg-surface px-4 py-3">{footer}</div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* ---------------------------------- menus --------------------------------- */

export type MenuItem = {
  label: ReactNode;
  onSelect?: () => void | Promise<void>;
  disabled?: boolean;
  /** native tooltip, e.g. why a disabled item is disabled */
  title?: string;
};

const MENU_CONTENT = cn('z-50 min-w-52 p-1', LIFTED);
/* The row under the cursor lifts one tone. A full accent inversion on every hover is how a menu
   starts to flash at you while you are only travelling through it. */
const MENU_ITEM =
  'flex cursor-default select-none items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm outline-none ' +
  'data-[highlighted]:bg-hover data-[highlighted]:text-fg ' +
  'data-[disabled]:pointer-events-none data-[disabled]:screened';

export function DropdownMenu({
  trigger,
  items,
  align = 'end',
  className,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'center' | 'end';
  className?: string;
}) {
  return (
    <DropdownPrimitive.Root>
      <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content align={align} sideOffset={4} className={cn(MENU_CONTENT, className)}>
          {items.map((item, i) => (
            <DropdownPrimitive.Item
              key={i}
              className={MENU_ITEM}
              disabled={item.disabled}
              title={item.title}
              onSelect={() => void item.onSelect?.()}
            >
              {item.label}
            </DropdownPrimitive.Item>
          ))}
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  );
}

export function ContextMenu({
  items,
  className,
  children,
}: {
  items: MenuItem[];
  className?: string;
  children: ReactNode;
}) {
  // An empty menu is not a menu: leave the platform's own in place instead of opening a blank card.
  if (!items.length) return <>{children}</>;
  return (
    <ContextMenuPrimitive.Root>
      {/* display:contents - the trigger must not disturb the grid/tree layout it wraps, and not every
          child forwards a ref, so asChild is off the table. */}
      <ContextMenuPrimitive.Trigger className="contents" onContextMenu={(e) => e.stopPropagation()}>
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content className={cn(MENU_CONTENT, className)}>
          {items.map((item, i) => (
            <ContextMenuPrimitive.Item
              key={i}
              className={MENU_ITEM}
              disabled={item.disabled}
              title={item.title}
              onSelect={() => void item.onSelect?.()}
            >
              {item.label}
            </ContextMenuPrimitive.Item>
          ))}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

/* ---------------------------------- toast --------------------------------- */

type Toast = { id: number; msg: string; kind: 'error' | 'info' };

let toasts: Toast[] = [];
let seq = 0;
const toastCbs = new Set<() => void>();

function emit(): void {
  for (const cb of toastCbs) cb();
}

function dismiss(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function toast(msg: string, kind: 'error' | 'info' = 'info'): void {
  const id = ++seq;
  toasts = [...toasts, { id, msg, kind }];
  emit();
  setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4000);
}

export function Toaster() {
  const list = useSyncExternalStore(
    (cb) => {
      toastCbs.add(cb);
      return () => toastCbs.delete(cb);
    },
    () => toasts,
  );
  return (
    // Clear of the status rail, stacked from the bottom right, each one its own card.
    <div className="pointer-events-none fixed bottom-10 right-4 z-[60] flex w-96 flex-col gap-2">
      {list.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            'pointer-events-auto flex items-start gap-2.5 rounded-md border px-3 py-2.5 shadow-lg',
            t.kind === 'error'
              ? 'border-danger/50 bg-danger-soft text-danger'
              : 'border-line-strong bg-elevated text-fg',
          )}
        >
          {t.kind === 'error' ? (
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0 text-accent-text" aria-hidden />
          )}
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm">{t.msg}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="-mr-1 grid size-5 shrink-0 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg"
            onClick={() => dismiss(t.id)}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
