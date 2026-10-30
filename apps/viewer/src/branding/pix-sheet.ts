// The Pix support sheet (branding plan 2.6, BR6; user decision: copy key, "copia e cola" and QR
// code). A modal dialog with a focus trap and Escape. The receiver's name is shown so the payer
// can check it against what their bank app shows before confirming. No amount: the payer types
// it in their bank app.
import { t, type MessageKey } from '@swarmcast/shared/i18n';
import { drawQr, qrMatrix, type PixKeyType } from '@swarmcast/shared/branding';

export interface PixInfo {
  type: PixKeyType;
  key: string;
  name: string;
  payload: string;
}

/** A BR Code is printable ASCII and short; anything else is not drawn or offered for copying. */
const PAYLOAD = /^[\x20-\x7e]{20,512}$/;

async function copy(text: string, source: HTMLInputElement | HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      source.focus();
      source.select();
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

function copyRow(label: string, buttonKey: MessageKey, value: string, multiline: boolean, testid: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pix-field';
  const id = `pix-${testid}`;
  const l = document.createElement('label');
  l.htmlFor = id;
  l.textContent = label;
  const field = multiline ? document.createElement('textarea') : document.createElement('input');
  field.id = id;
  field.readOnly = true;
  field.value = value;
  field.dataset.testid = testid;
  field.setAttribute('spellcheck', 'false');
  if (field instanceof HTMLTextAreaElement) field.rows = 3;
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = t(buttonKey);
  b.dataset.testid = `${testid}-copy`;
  const note = document.createElement('span');
  note.className = 'pix-copied small';
  note.setAttribute('role', 'status');
  b.addEventListener('click', () => {
    void copy(value, field).then((ok) => {
      note.textContent = t(ok ? 'pix.sheet.copied' : 'pix.sheet.copyFailed');
    });
  });
  const row = document.createElement('div');
  row.className = 'pix-row';
  row.append(field, b);
  wrap.append(l, row, note);
  return wrap;
}

let open: HTMLElement | null = null;

export function openPixSheet(pix: PixInfo, returnFocus: HTMLElement | null): HTMLElement {
  open?.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'pix-backdrop';
  const dlg = document.createElement('div');
  dlg.className = 'pix-sheet';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.dataset.testid = 'pix-sheet';
  const title = document.createElement('h2');
  title.id = 'pix-title';
  title.textContent = t('pix.sheet.title');
  dlg.setAttribute('aria-labelledby', title.id);

  const receiver = document.createElement('p');
  receiver.className = 'pix-receiver';
  const marker = '\u0000';
  const [before, after] = t('pix.sheet.name', { name: marker }).split(marker);
  const name = document.createElement('bdi');
  name.setAttribute('dir', 'auto');
  name.textContent = pix.name;
  receiver.append(before ?? '', name, after ?? '');

  const parts: HTMLElement[] = [title, receiver];
  if (PAYLOAD.test(pix.payload)) {
    const canvas = document.createElement('canvas');
    canvas.className = 'pix-qr';
    canvas.dataset.testid = 'pix-qr';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', t('pix.sheet.qr'));
    try {
      const matrix = qrMatrix(pix.payload);
      const scale = 6;
      const side = (matrix.length + 8) * scale;
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext('2d');
      if (ctx) drawQr(ctx, matrix, scale);
      parts.push(canvas);
    } catch {
      /* no QR code: the key and the code below still work */
    }
  }
  const typeKey = `pix.type.${pix.type}` as MessageKey;
  parts.push(copyRow(`${t('pix.sheet.key')} (${t(typeKey)})`, 'pix.sheet.copyKey', pix.key, false, 'pix-key'));
  if (PAYLOAD.test(pix.payload)) parts.push(copyRow(t('pix.sheet.code'), 'pix.sheet.copyCode', pix.payload, true, 'pix-code'));
  const check = document.createElement('p');
  check.className = 'pix-check small muted';
  check.textContent = t('pix.sheet.check');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'secondary pix-close';
  close.textContent = t('pix.sheet.close');
  close.dataset.testid = 'pix-close';
  parts.push(check, close);
  dlg.append(...parts);
  backdrop.append(dlg);

  const done = (): void => {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (open === backdrop) open = null;
    returnFocus?.focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      done();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = [...dlg.querySelectorAll<HTMLElement>('button, input, textarea')].filter((x) => !x.hidden);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  close.addEventListener('click', done);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) done();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  open = backdrop;
  close.focus();
  return dlg;
}
