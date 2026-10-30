import './style.css';
import './i18n.js';
import { startJoinForm } from './join-form.js';
import { solvePow } from './pow.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

startJoinForm(
  {
    form: $<HTMLFormElement>('join-form'),
    input: $<HTMLInputElement>('nickname'),
    button: $<HTMLButtonElement>('join'),
    error: $<HTMLParagraphElement>('error'),
    check: $<HTMLParagraphElement>('check'),
    progress: document.getElementById('check-progress') as HTMLProgressElement | null,
  },
  {
    // A wrapper: fetch called as a method of another object throws "Illegal invocation".
    fetch: (input, init) => fetch(input, init),
    solve: solvePow,
    go: (url) => location.replace(url),
  },
);
