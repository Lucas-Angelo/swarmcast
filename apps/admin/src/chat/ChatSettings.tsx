import { useEffect, useState } from 'preact/hooks';
import {
  CHAT_BLOCKED_WORDS_MAX,
  CHAT_DUPLICATE_WINDOW_MAX_S,
  CHAT_HISTORY_ON_JOIN_MAX,
  CHAT_MAX_EMOJI_MAX,
  CHAT_MAX_EMOJI_MIN,
  CHAT_MAX_GRAPHEMES_MAX,
  CHAT_MAX_GRAPHEMES_MIN,
  CHAT_NEW_VIEWER_WAIT_MAX_S,
  CHAT_SLOW_MODE_MAX_S,
  CHAT_SLOW_MODE_PRESETS_S,
  CHAT_STREAMER_NAME_MAX,
  GIF_KEY_RE,
  type ChatSettings as Settings,
  type MessageKey,
} from '@swarmcast/shared';
import { t } from '@swarmcast/shared/i18n';
import { errorText } from '../api.js';
import { Info } from '../Info.js';
import { CONTENT_PRESETS, parseBlockedWords, presetNeedsGifs, presetOf, sameSettings } from './logic.js';

type Patch = (p: Partial<Settings>) => void;

/**
 * Chat settings (plan §5.2 / §5.3), grouped like the plan: what viewers can send, pace, safety,
 * looks, GIFs, emotes. One explicit Save, enabled only when something changed.
 */
export function ChatSettingsForm({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => Promise<void> }) {
  const [v, setV] = useState<Settings>(settings);
  const [words, setWords] = useState(settings.blockedWords.join('\n'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setV(settings);
    setWords(settings.blockedWords.join('\n'));
  }, [JSON.stringify(settings)]);

  const blocked = parseBlockedWords(words);
  const draft: Settings = { ...v, blockedWords: blocked.words };
  const dirty = !sameSettings(draft, settings);
  const noContent = !v.content.text && !v.content.emotes && !v.content.gifs;
  const keyOk = v.gif.key === '' || GIF_KEY_RE.test(v.gif.key);
  const gifsNeedKey = v.content.gifs && v.gif.key === '';
  const invalid = noContent || !keyOk || gifsNeedKey || blocked.tooLong.length > 0;
  const patch: Patch = (p) => {
    setSaved(false);
    setV({ ...v, ...p });
  };
  const preset = presetOf(v.content);

  const save = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await onSave(draft);
      setSaved(true);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      class="chat-settings"
      data-testid="chat-settings"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !invalid) void save();
      }}
    >
      <h3 class="small strong">{t('admin.chat.settings')}</h3>

      <fieldset class="chat-group">
        <legend>
          {t('admin.chat.content')} <Info text={t('admin.chat.content.tip')} />
        </legend>
        <div class="chat-presets" role="group">
          {CONTENT_PRESETS.map((p) => (
            <button
              type="button"
              key={p.id}
              class={`small${preset === p.id ? ' primary' : ''}`}
              aria-pressed={preset === p.id}
              data-testid={`chat-preset-${p.id}`}
              disabled={presetNeedsGifs(p.id) && !v.gif.key}
              onClick={() => patch({ content: { ...p.content } })}
            >
              {t(p.key)}
            </button>
          ))}
        </div>
        <div class="row tight">
          <Check label="admin.chat.content.text" checked={v.content.text} testid="chat-content-text" onChange={(c) => patch({ content: { ...v.content, text: c } })} />
          <Check label="admin.chat.content.emotes" checked={v.content.emotes} testid="chat-content-emotes" onChange={(c) => patch({ content: { ...v.content, emotes: c } })} />
          <Check label="admin.chat.content.gifs" checked={v.content.gifs} testid="chat-content-gifs" disabled={!v.gif.key} onChange={(c) => patch({ content: { ...v.content, gifs: c } })} />
        </div>
        {noContent && <p class="small danger-text">{t('admin.chat.content.none')}</p>}
      </fieldset>

      <fieldset class="chat-group">
        <legend>{t('admin.chat.group.pace')}</legend>
        <div class="field">
          <label>
            {t('admin.chat.slowMode')}{' '}
            <select class="text-input"
              data-testid="chat-slow-preset"
              value={(CHAT_SLOW_MODE_PRESETS_S as readonly number[]).includes(v.slowModeS) ? String(v.slowModeS) : 'custom'}
              onChange={(e) => {
                const val = (e.target as HTMLSelectElement).value;
                if (val !== 'custom') patch({ slowModeS: Number(val) });
              }}
            >
              {CHAT_SLOW_MODE_PRESETS_S.map((s) => (
                <option key={s} value={String(s)}>
                  {s === 0 ? t('admin.chat.slowMode.off') : `${s} s`}
                </option>
              ))}
              <option value="custom">{t('admin.chat.slowMode.custom')}</option>
            </select>
          </label>{' '}
          <Num value={v.slowModeS} min={0} max={CHAT_SLOW_MODE_MAX_S} testid="chat-slow" onChange={(n) => patch({ slowModeS: n })} unit="admin.chat.unit.seconds" />
          <Info text={t('admin.chat.slowMode.tip')} />
        </div>
        <NumField label="admin.chat.maxGraphemes" tip="admin.chat.maxGraphemes.tip" unit="admin.chat.unit.characters" value={v.maxGraphemes} min={CHAT_MAX_GRAPHEMES_MIN} max={CHAT_MAX_GRAPHEMES_MAX} testid="chat-max-length" onChange={(n) => patch({ maxGraphemes: n })} />
        <NumField label="admin.chat.maxEmoji" tip="admin.chat.maxEmoji.tip" value={v.maxEmoji} min={CHAT_MAX_EMOJI_MIN} max={CHAT_MAX_EMOJI_MAX} testid="chat-max-emoji" onChange={(n) => patch({ maxEmoji: n })} />
        <NumField label="admin.chat.newViewerWait" tip="admin.chat.newViewerWait.tip" unit="admin.chat.unit.seconds" value={v.newViewerWaitS} min={0} max={CHAT_NEW_VIEWER_WAIT_MAX_S} testid="chat-new-wait" onChange={(n) => patch({ newViewerWaitS: n })} />
        <NumField label="admin.chat.duplicateWindow" tip="admin.chat.duplicateWindow.tip" unit="admin.chat.unit.seconds" value={v.duplicateWindowS} min={0} max={CHAT_DUPLICATE_WINDOW_MAX_S} testid="chat-dup" onChange={(n) => patch({ duplicateWindowS: n })} />
        <NumField label="admin.chat.historyOnJoin" tip="admin.chat.historyOnJoin.tip" unit="admin.chat.unit.messages" value={v.historyOnJoin} min={0} max={CHAT_HISTORY_ON_JOIN_MAX} testid="chat-history" onChange={(n) => patch({ historyOnJoin: n })} />
      </fieldset>

      <fieldset class="chat-group">
        <legend>{t('admin.chat.group.safety')}</legend>
        <div class="field">
          <Check label="admin.chat.autoProtect" checked={v.autoProtect} testid="chat-auto-protect" onChange={(c) => patch({ autoProtect: c })} /> <Info text={t('admin.chat.autoProtect.tip')} />
        </div>
        <div class="field">
          <label class="chat-block">
            <span>
              {t('admin.chat.blockedWords')} <Info text={t('admin.chat.blockedWords.tip')} />
            </span>
            <textarea class="text-input"
              rows={4}
              data-testid="chat-blocked"
              placeholder={t('admin.chat.blockedWords.placeholder')}
              value={words}
              onInput={(e) => {
                setSaved(false);
                setWords((e.target as HTMLTextAreaElement).value);
              }}
            />
          </label>
          <span class="muted small">{t('admin.chat.blockedWords.count', { count: blocked.words.length, max: CHAT_BLOCKED_WORDS_MAX })}</span>
          {blocked.tooLong.length > 0 && <p class="small danger-text">{t('admin.chat.err.blockedWord')}</p>}
        </div>
        <div class="field">
          <label>
            {t('admin.chat.links')}{' '}
            <select class="text-input" data-testid="chat-links" value={v.links} onChange={(e) => patch({ links: (e.target as HTMLSelectElement).value as Settings['links'] })}>
              <option value="text">{t('admin.chat.links.text')}</option>
              <option value="block">{t('admin.chat.links.block')}</option>
            </select>
          </label>{' '}
          <Info text={t('admin.chat.links.tip')} />
        </div>
        <div class="field">
          <label>
            {t('admin.chat.scripts')}{' '}
            <select class="text-input" data-testid="chat-scripts" value={v.scripts} onChange={(e) => patch({ scripts: (e.target as HTMLSelectElement).value as Settings['scripts'] })}>
              <option value="any">{t('admin.chat.scripts.any')}</option>
              <option value="latin">{t('admin.chat.scripts.latin')}</option>
            </select>
          </label>{' '}
          <Info text={t('admin.chat.scripts.tip')} />
        </div>
      </fieldset>

      <fieldset class="chat-group">
        <legend>{t('admin.chat.group.looks')}</legend>
        <div class="field">
          <Check label="admin.chat.viewerColors" checked={v.viewerColors} testid="chat-viewer-colors" onChange={(c) => patch({ viewerColors: c })} /> <Info text={t('admin.chat.viewerColors.tip')} />
        </div>
        <div class="field">
          <label>
            {t('admin.chat.streamerName')}{' '}
            <input class="text-input"
              type="text"
              data-testid="chat-streamer-name"
              maxLength={100}
              size={CHAT_STREAMER_NAME_MAX}
              placeholder={t('admin.chat.streamerName.placeholder')}
              value={v.streamerName}
              onInput={(e) => patch({ streamerName: (e.target as HTMLInputElement).value })}
            />
          </label>{' '}
          <Info text={t('admin.chat.streamerName.tip')} />
        </div>
        <div class="field">
          <Check label="admin.chat.announceMutes" checked={v.announceMutes} testid="chat-announce" onChange={(c) => patch({ announceMutes: c })} /> <Info text={t('admin.chat.announceMutes.tip')} />
        </div>
      </fieldset>

      <fieldset class="chat-group">
        <legend>{t('admin.chat.gifs')}</legend>
        <p class="small chat-privacy" data-testid="chat-gif-privacy">
          {t('admin.chat.gif.privacy')}
        </p>
        <div class="field">
          <label>
            {t('admin.chat.gif.key')}{' '}
            <input class="text-input"
              type="text"
              data-testid="chat-gif-key"
              autocomplete="off"
              spellcheck={false}
              maxLength={128}
              placeholder={t('admin.chat.gif.key.placeholder')}
              aria-invalid={!keyOk}
              value={v.gif.key}
              onInput={(e) => {
                const key = (e.target as HTMLInputElement).value.trim();
                // Without a key GIFs cannot stay on.
                patch({ gif: { ...v.gif, provider: 'klipy', key }, content: key ? v.content : { ...v.content, gifs: false } });
              }}
            />
          </label>{' '}
          <Info text={t('admin.chat.gif.key.tip')} />
          <p class="muted small">{t('admin.chat.gif.key.how')}</p>
          {!keyOk && <p class="small danger-text">{t('admin.chat.gif.key.invalid')}</p>}
        </div>
        <div class="field">
          <Check label="admin.chat.gif.enable" checked={v.content.gifs} testid="chat-gif-enable" disabled={!v.gif.key || !keyOk} onChange={(c) => patch({ content: { ...v.content, gifs: c } })} /> <Info text={t('admin.chat.gif.enable.tip')} />
        </div>
        <div class="field">
          <label>
            {t('admin.chat.gif.rating')}{' '}
            <select class="text-input" data-testid="chat-gif-rating" value={v.gif.rating} onChange={(e) => patch({ gif: { ...v.gif, rating: (e.target as HTMLSelectElement).value as Settings['gif']['rating'] } })}>
              {(['g', 'pg', 'pg-13'] as const).map((r) => (
                <option key={r} value={r}>
                  {t(`admin.chat.gif.rating.${r}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>{' '}
          <Info text={t('admin.chat.gif.rating.tip')} />
        </div>
        <div class="field">
          <Check
            label="admin.chat.gif.consent"
            checked={v.gif.consent === 'ask'}
            testid="chat-gif-consent"
            onChange={(c) => patch({ gif: { ...v.gif, consent: c ? 'ask' : 'auto' } })}
          />{' '}
          <Info text={t('admin.chat.gif.consent.tip')} />
        </div>
      </fieldset>

      <fieldset class="chat-group">
        <legend>{t('admin.chat.group.emotes')}</legend>
        <div class="field">
          <Check label="admin.chat.emotes.builtin" checked={v.emotes.builtin} testid="chat-emotes-builtin" onChange={(c) => patch({ emotes: { builtin: c } })} />{' '}
          <Info text={t('admin.chat.emotes.builtin.tip')} />
        </div>
      </fieldset>

      <div class="row tight">
        <button type="submit" class="primary" data-testid="chat-save" disabled={!dirty || invalid || busy} title={t('admin.chat.save.tip')}>
          {t('admin.chat.save')}
        </button>
        {saved && !dirty && <span class="ok small">{t('admin.chat.saved')}</span>}
        {dirty && <span class="muted small">{t('admin.chat.unsaved')}</span>}
      </div>
      {err !== null && (
        <div class="err small" data-testid="chat-settings-error">
          {errorText(err)}
        </div>
      )}
    </form>
  );
}

function Check({ label, checked, onChange, testid, disabled }: { label: MessageKey; checked: boolean; onChange: (c: boolean) => void; testid: string; disabled?: boolean }) {
  return (
    <label class="row tight chat-check">
      <input type="checkbox" data-testid={testid} checked={checked} disabled={disabled} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      {t(label)}
    </label>
  );
}

/** A whole number in [min, max]: any text may be typed, only valid values reach the settings; blur shows the value in force. */
function Num({ value, min, max, onChange, testid, unit }: { value: number; min: number; max: number; onChange: (n: number) => void; testid: string; unit?: MessageKey }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <>
      <input
        type="number"
        data-testid={testid}
        min={min}
        max={max}
        step={1}
        value={text}
        aria-invalid={String(value) !== text.trim()}
        onInput={(e) => {
          const raw = (e.target as HTMLInputElement).value;
          setText(raw);
          const n = Number(raw);
          if (raw.trim() !== '' && Number.isInteger(n) && n >= min && n <= max) onChange(n);
        }}
        onBlur={() => setText(String(value))}
      />
      {unit && <span class="muted small"> {t(unit)}</span>}
    </>
  );
}

function NumField({ label, tip, ...rest }: { label: MessageKey; tip: MessageKey; value: number; min: number; max: number; onChange: (n: number) => void; testid: string; unit?: MessageKey }) {
  return (
    <div class="field">
      <label>
        {t(label)} <Num {...rest} />
      </label>{' '}
      <Info text={t(tip)} />
    </div>
  );
}
