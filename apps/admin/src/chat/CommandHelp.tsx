import { CHAT_COMMANDS, commandNames, type ChatCommandDef } from '@swarmcast/shared';
import { getLang, t } from '@swarmcast/shared/i18n';

/**
 * The panel's command list (docs/CHAT.md, "Slash commands"): every command with how to write it and
 * what it does, its name in the panel's language and, muted, in the other one (both always work).
 * Opened with the "?" next to Send; a click puts the command in the box.
 */
export function CommandHelp({ onPick, onClose }: { onPick: (c: ChatCommandDef) => void; onClose: () => void }) {
  const lang = getLang();
  return (
    <div class="chat-cmd-help" data-testid="chat-cmd-help" role="region" aria-label={t('admin.chat.cmd.list')}>
      <div class="row tight">
        <strong class="small">{t('admin.chat.cmd.list')}</strong>
        <span class="spacer" />
        <button type="button" class="small" data-testid="chat-cmd-help-close" aria-label={t('chat.viewer.help.close')} title={t('chat.viewer.help.close')} onClick={onClose}>
          ✕
        </button>
      </div>
      <p class="muted small">{t('admin.chat.cmd.help.tip')}</p>
      <ul>
        {CHAT_COMMANDS.map((c) => {
          const names = commandNames(c, lang);
          return (
            <li key={c.id}>
              <button type="button" class="chat-cmd-pick" data-testid="chat-cmd-pick" data-cmd={c.id} onClick={() => onPick(c)}>
                <code>{t(c.usage)}</code>
                {names.other !== names.main && <span class="muted small"> · /{names.other}</span>}
              </button>
              <span class="small"> {t(c.help)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
