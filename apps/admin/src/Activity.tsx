import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ActivityEntry } from '@swarmcast/shared';
import { getLang, t, tc, type MessageKey } from '@swarmcast/shared/i18n';
import { Info } from './Info.js';

type Filter = 'all' | 'actions' | 'warnings' | 'errors';
const FILTERS: { id: Filter; label: MessageKey }[] = [
  { id: 'all', label: 'admin.log.all' },
  { id: 'actions', label: 'admin.log.actions' },
  { id: 'warnings', label: 'admin.log.warnings' },
  { id: 'errors', label: 'admin.log.errors' },
];

function matches(e: ActivityEntry, f: Filter): boolean {
  if (f === 'actions') return e.kind === 'action' || e.kind === 'viewer';
  if (f === 'warnings') return e.level === 'warn';
  if (f === 'errors') return e.level === 'error';
  return true;
}

const LEVEL_TAG: Record<ActivityEntry['level'], string> = { info: 'INFO', warn: 'WARN', error: 'ERR ' };

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/** Terminal-like live activity log with filters, auto-scroll (paused while scrolled up), clear and copy. */
export function ActivityConsole({ entries, onClear, onCopy, copied }: { entries: ActivityEntry[]; onClear: () => void; onCopy: (text: string) => void; copied: boolean }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const shown = entries.filter((e) => matches(e, filter));
  const lastId = shown[shown.length - 1]?.id ?? 0;

  useLayoutEffect(() => {
    const el = box.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [lastId, follow, filter]);

  const onScroll = (): void => {
    const el = box.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const lineText = (e: ActivityEntry): string => `${clock(e.at)} ${LEVEL_TAG[e.level]} ${tc(e, e.text)}`;

  return (
    <section class="card mt" data-testid="activity">
      <h2 class="row-title">
        {t('admin.log.title')} <Info text={t('admin.log.tip')} />
      </h2>
      <div class="row console-tools">
        <div class="chips" role="group" aria-label={t('admin.log.filter.tip')}>
          {FILTERS.map((f) => (
            <button key={f.id} type="button" class={`chip ${filter === f.id ? 'active' : ''}`} aria-pressed={filter === f.id} title={t('admin.log.filter.tip')} onClick={() => setFilter(f.id)}>
              {t(f.label)}
            </button>
          ))}
        </div>
        <span class="spacer" />
        <button type="button" class="small" title={t('admin.log.copy.tip')} onClick={() => onCopy(shown.map(lineText).join('\n'))}>
          {copied ? t('common.copied') : t('admin.log.copy')}
        </button>
        <button type="button" class="small" title={t('admin.log.clear.tip')} onClick={onClear}>
          {t('admin.log.clear')}
        </button>
      </div>
      <div class="console-wrap">
        <div class="console" ref={box} onScroll={onScroll} role="log" aria-live="polite" tabIndex={0}>
          {shown.length === 0 ? (
            <div class="console-line muted">{t('admin.log.empty')}</div>
          ) : (
            shown.map((e) => (
              <div key={e.id} class={`console-line lvl-${e.level} kind-${e.kind}`}>
                <span class="console-time">{clock(e.at)}</span> <span class="console-lvl">{LEVEL_TAG[e.level]}</span> {tc(e, e.text)}
              </div>
            ))
          )}
        </div>
        {!follow && (
          <button type="button" class="small console-resume" title={t('admin.log.resume.tip')} onClick={() => setFollow(true)}>
            {t('admin.log.paused')} · {t('admin.log.resume')} ↓
          </button>
        )}
      </div>
    </section>
  );
}
