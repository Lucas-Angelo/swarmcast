import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CHAT_COMMANDS, CHAT_POLL_SECONDS_DEFAULT, COMMAND_MUTE_DEFAULT_MIN, commandNames, foldCommandWord, parseCommand, parseCommandDuration, suggestCommands, type ChatCommand } from '@swarmcast/shared';
import { en } from '../../src/i18n/en.js';
import { ptBR } from '../../src/i18n/pt-BR.js';
import { anyUnicode, hostile } from './arbitraries.js';

// Slash commands (docs/CHAT.md, "Slash commands"): a pure parser, both languages always, case and
// accents folded, never throws, linear, and text that is not a known command stays text.

const RUNS = Number(process.env.CHAT_FUZZ_RUNS ?? 2000);
const params = { numRuns: RUNS, seed: Number(process.env.CHAT_FUZZ_SEED ?? 0x5ca7) };

const ok = (input: string, who: 'streamer' | 'viewer' = 'streamer'): ChatCommand => {
  const r = parseCommand(input, who);
  if (!r || !r.ok) throw new Error(`not a command: ${input} → ${JSON.stringify(r)}`);
  return r.cmd;
};

describe('parseCommand: names in both languages', () => {
  it.each([
    ['/help', 'help'],
    ['/?', 'help'],
    ['/ajuda', 'help'],
    ['/AJUDA', 'help'],
    ['/Ajúda', 'help'],
    ['/end', 'end'],
    ['/encerrar', 'end'],
    ['/cancel', 'cancel'],
    ['/cancelar', 'cancel'],
    ['/unpin', 'unpin'],
    ['/desafixar', 'unpin'],
    ['/clear', 'clear'],
    ['/limpar', 'clear'],
    ['/LIMPAR', 'clear'],
    ['  /clear  ', 'clear'],
  ])('%s → %s', (input, id) => {
    // Act
    const cmd = ok(input);
    // Assert
    expect(cmd.id).toBe(id);
  });

  it('a poll in English and in Portuguese, with accents and upper case in the name, reads the same', () => {
    // Act
    const a = ok('/poll Pizza or burger? | Pizza | Burger');
    const b = ok('/ENQUETE Pizza or burger? | Pizza | Burger');
    const c = ok('/Enquête Pizza or burger? | Pizza | Burger');
    // Assert
    expect(a).toEqual({ id: 'poll', question: 'Pizza or burger?', options: ['Pizza', 'Burger'], seconds: CHAT_POLL_SECONDS_DEFAULT });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('every alias of every command is recognised, and no two commands share one', () => {
    // Arrange
    const seen = new Map<string, string>();
    // Act
    for (const c of CHAT_COMMANDS) {
      for (const a of [...c.aliases.en, ...c.aliases.pt]) {
        const k = foldCommandWord(a);
        expect(seen.get(k) ?? c.id).toBe(c.id);
        seen.set(k, c.id);
        const r = parseCommand(`/${a}`, 'streamer');
        // Assert
        expect(r).not.toBeNull();
        expect(r!.ok ? r.cmd.id : r.id).toBe(c.id);
      }
    }
  });

  it('usage and help texts exist in both dictionaries for every command', () => {
    // Assert
    for (const c of CHAT_COMMANDS) {
      expect(en[c.usage]).toBeTypeOf('string');
      expect(ptBR[c.usage]).toBeTypeOf('string');
      expect(en[c.help]).toBeTypeOf('string');
      expect(ptBR[c.help]).toBeTypeOf('string');
      expect(en[c.usage]).toContain(`/${c.aliases.en[0]}`);
      expect(ptBR[c.usage]).toContain(`/${c.aliases.pt[0]}`);
    }
  });
});

describe('parseCommand: what is not a command stays text', () => {
  it.each(['hello', '', ' ', '/o/', '/s', '/shrug', '/ poll a | b | c', 'a /poll x | y | z', '/pollx Q | a | b', '/', '/ ', '/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])('%j → null', (input) => {
    // Act
    const r = parseCommand(input, 'streamer');
    // Assert
    expect(r).toBeNull();
  });

  it('"//text" sends "/text" as a message, for viewers and the streamer', () => {
    // Act
    const s = ok('//poll is a command', 'streamer');
    const v = ok('//o/', 'viewer');
    // Assert
    expect(s).toEqual({ id: 'say', text: '/poll is a command' });
    expect(v).toEqual({ id: 'say', text: '/o/' });
  });

  it('a non-string input is not a command', () => {
    // Act
    const r = parseCommand(42 as unknown as string, 'streamer');
    // Assert
    expect(r).toBeNull();
  });
});

describe('parseCommand: viewers', () => {
  it('a viewer has /help (/ajuda, /?), and nothing else', () => {
    // Act
    const help = [ok('/help', 'viewer'), ok('/ajuda', 'viewer'), ok('/?', 'viewer')];
    // Assert
    expect(help.map((c) => c.id)).toEqual(['help', 'help', 'help']);
  });

  it.each(['/poll Q | a | b', '/enquete Q | a | b', '/clear', '/limpar', '/mute Ana', '/palpite', '/fixar oi'])('a viewer typing %s is told only the streamer can (never sent)', (input) => {
    // Act
    const r = parseCommand(input, 'viewer');
    // Assert
    expect(r).toMatchObject({ ok: false, code: 'chat.cmd.err.streamerOnly' });
  });
});

describe('parseCommand: polls and predictions', () => {
  it.each([
    ['/poll 30s Q? | a | b', 30],
    ['/poll 2m Q? | a | b', 120],
    ['/poll 2min Q? | a | b', 120],
    ['/enquete 1m30s Q? | a | b', 90],
    ['/poll 10M Q? | a | b', 600],
    ['/poll 15s Q? | a | b', 15],
  ])('%s takes %i s', (input, seconds) => {
    // Act
    const cmd = ok(input);
    // Assert
    expect(cmd).toMatchObject({ id: 'poll', question: 'Q?', options: ['a', 'b'], seconds });
  });

  it('a bare number is part of the question, not a time', () => {
    // Act
    const cmd = ok('/poll 2024 was good? | yes | no');
    // Assert
    expect(cmd).toEqual({ id: 'poll', question: '2024 was good?', options: ['yes', 'no'], seconds: CHAT_POLL_SECONDS_DEFAULT });
  });

  it('a time with nothing after it is the question', () => {
    // Act
    const r = parseCommand('/poll 2m | a | b', 'streamer');
    // Assert
    expect(r).toEqual({ ok: true, cmd: { id: 'poll', question: '2m', options: ['a', 'b'], seconds: CHAT_POLL_SECONDS_DEFAULT } });
  });

  it('options split on "|", or on ";" when there is no "|"; spaces trimmed and empty options dropped', () => {
    // Act
    const a = ok('/palpite  Who wins?  ;  Ana ; ; Bia ;Caio ');
    const b = ok('/prediction Who wins? | Ana; Bia | Caio');
    // Assert
    expect(a).toEqual({ id: 'prediction', question: 'Who wins?', options: ['Ana', 'Bia', 'Caio'], seconds: CHAT_POLL_SECONDS_DEFAULT });
    expect(b).toEqual({ id: 'prediction', question: 'Who wins?', options: ['Ana; Bia', 'Caio'], seconds: CHAT_POLL_SECONDS_DEFAULT });
  });

  it('alone, /poll and /palpite open the form', () => {
    // Act
    const a = ok('/poll');
    const b = ok('/palpite   ');
    // Assert
    expect(a).toEqual({ id: 'poll', form: true });
    expect(b).toEqual({ id: 'prediction', form: true });
  });

  it.each([
    ['/poll Q? | only one', 'chat.cmd.err.options'],
    ['/poll Q? | 1 | 2 | 3 | 4 | 5 | 6', 'chat.cmd.err.options'],
    ['/poll 5s Q? | a | b', 'chat.cmd.err.duration'],
    ['/poll 11m Q? | a | b', 'chat.cmd.err.duration'],
    ['/poll just a question', 'chat.cmd.err.usage'],
    ['/poll | a | b', 'chat.cmd.err.usage'],
  ])('%s → %s', (input, code) => {
    // Act
    const r = parseCommand(input, 'streamer');
    // Assert
    expect(r).toMatchObject({ ok: false, code });
  });

  it('a usage error names the usage text of that command (translated by the caller)', () => {
    // Act
    const r = parseCommand('/palpite sem opções', 'streamer');
    // Assert
    expect(r).toEqual({ ok: false, id: 'prediction', code: 'chat.cmd.err.usage', params: { usageKey: 'chat.cmd.prediction.usage' } });
  });

  it.each([
    ['/answer 2', 1],
    ['/resposta 1', 0],
    ['/RESPOSTA 5', 4],
  ])('%s → option %i (people count from 1)', (input, option) => {
    // Act
    const cmd = ok(input);
    // Assert
    expect(cmd).toEqual({ id: 'answer', option });
  });

  it.each(['/answer', '/answer 0', '/answer 6', '/answer two', '/answer 1 2'])('%s is refused with the range', (input) => {
    // Act
    const r = parseCommand(input, 'streamer');
    // Assert
    expect(r).toMatchObject({ ok: false, code: 'chat.cmd.err.answer', params: { max: 5 } });
  });
});

describe('parseCommand: moderation', () => {
  it('pin with text, and alone', () => {
    // Act
    const a = ok('/pin  Welcome everyone! ');
    const b = ok('/fixar');
    // Assert
    expect(a).toEqual({ id: 'pin', text: 'Welcome everyone!' });
    expect(b).toEqual({ id: 'pin' });
  });

  it.each([
    ['/slow 10', 10],
    ['/lento 30s', 30],
    ['/slow 2m', 120],
    ['/slow off', 0],
    ['/lento desligar', 0],
    ['/lento DESLIGADO', 0],
    ['/slow 0', 0],
    ['/slow 300', 300],
  ])('%s → %i s', (input, seconds) => {
    // Act
    const cmd = ok(input);
    // Assert
    expect(cmd).toEqual({ id: 'slow', seconds });
  });

  it.each(['/slow 301', '/slow 6m', '/slow fast', '/slow'])('%s is refused', (input) => {
    // Act
    const r = parseCommand(input, 'streamer');
    // Assert
    expect(r).toMatchObject({ ok: false });
  });

  it.each([
    ['/mute Ana', 'Ana', COMMAND_MUTE_DEFAULT_MIN],
    ['/mute @Ana 5', 'Ana', 5],
    ['/silenciar Ana Maria 60', 'Ana Maria', 60],
    ['/mute Ana Maria', 'Ana Maria', COMMAND_MUTE_DEFAULT_MIN],
    ['/mute Ana 1h', 'Ana', 60],
    ['/mute Ana live', 'Ana', null],
    ['/silenciar Ana ate-o-fim', 'Ana', null],
    ['/silenciar Ana até-o-fim', 'Ana', null],
    ['/mute Ana#K3QF 10', 'Ana#K3QF', 10],
    ['/mute 10', '10', COMMAND_MUTE_DEFAULT_MIN],
  ])('%s → %s for %s minutes', (input, name, minutes) => {
    // Act
    const cmd = ok(input);
    // Assert
    expect(cmd).toEqual({ id: 'mute', name, minutes });
  });

  it.each(['/mute', '/mute Ana 2000', '/mute Ana 30s'])('%s is refused', (input) => {
    // Act
    const r = parseCommand(input, 'streamer');
    // Assert
    expect(r).toMatchObject({ ok: false });
  });

  it('unmute takes the whole rest as the name', () => {
    // Act
    const cmd = ok('/dessilenciar @Ana Maria');
    // Assert
    expect(cmd).toEqual({ id: 'unmute', name: 'Ana Maria' });
  });

  it.each([
    ['/protect off', 'off'],
    ['/protect slow', 'slow'],
    ['/protect lockdown', 'lockdown'],
    ['/proteger desligado', 'off'],
    ['/proteger lento', 'slow'],
    ['/proteger BLOQUEIO', 'lockdown'],
  ])('%s → %s', (input, mode) => {
    // Act
    const cmd = ok(input);
    // Assert
    expect(cmd).toEqual({ id: 'protect', mode });
  });

  it('protect without a known mode shows the usage', () => {
    // Act
    const r = parseCommand('/protect maybe', 'streamer');
    // Assert
    expect(r).toMatchObject({ ok: false, code: 'chat.cmd.err.usage', params: { usageKey: 'chat.cmd.protect.usage' } });
  });
});

describe('durations, suggestions and names', () => {
  it.each([
    ['30s', null, 30],
    ['2m', null, 120],
    ['1m30s', null, 90],
    ['90', 1, 90],
    ['90', null, null],
    ['2x', 1, null],
    ['', 1, null],
    ['m', 1, null],
    ['1m30', 1, null],
    ['999999s', 1, null],
  ] as const)('%j (bare unit %s) → %s', (word, bare, out) => {
    // Act
    const s = parseCommandDuration(word, bare);
    // Assert
    expect(s).toBe(out);
  });

  it('suggestions match names in both languages; viewers are offered /help only', () => {
    // Act
    const en = suggestCommands('p', 'streamer').map((c) => c.id);
    const pt = suggestCommands('en', 'streamer').map((c) => c.id);
    const viewer = suggestCommands('', 'viewer').map((c) => c.id);
    // Assert
    expect(en).toEqual(['poll', 'prediction', 'pin', 'protect']);
    expect(pt).toEqual(['poll', 'end']);
    expect(viewer).toEqual(['help']);
  });

  it('commandNames shows the language of the panel first', () => {
    // Arrange
    const poll = CHAT_COMMANDS.find((c) => c.id === 'poll')!;
    // Act
    const en = commandNames(poll, 'en');
    const pt = commandNames(poll, 'pt-BR');
    // Assert
    expect(en).toEqual({ main: 'poll', other: 'enquete' });
    expect(pt).toEqual({ main: 'enquete', other: 'poll' });
  });
});

describe('parseCommand properties (P17)', () => {
  it('is total: any text, for viewers and the streamer, returns null or a result and never throws', () => {
    // Assert
    fc.assert(
      fc.property(fc.oneof(anyUnicode, hostile, fc.string()), fc.boolean(), (s, viewer) => {
        const input = `/${s}`;
        const r = parseCommand(input, viewer ? 'viewer' : 'streamer');
        return r === null || typeof r.ok === 'boolean';
      }),
      params,
    );
  });

  it('a generated poll command reads back as what it was made from', () => {
    // Arrange
    const word = fc.stringMatching(/^[A-Za-z0-9?!]{1,12}$/);
    // Assert
    fc.assert(
      fc.property(word, fc.uniqueArray(word, { minLength: 2, maxLength: 5 }), fc.integer({ min: 1, max: 10 }), fc.constantFrom('poll', 'enquete', 'prediction', 'palpite'), (q, options, minutes, name) => {
        const r = parseCommand(`/${name} ${minutes}m ${q} | ${options.join(' | ')}`, 'streamer');
        expect(r).toEqual({ ok: true, cmd: { id: name === 'poll' || name === 'enquete' ? 'poll' : 'prediction', question: q, options, seconds: minutes * 60 } });
      }),
      params,
    );
  });

  it('is linear: 50 KB of separators, spaces or digits parse at once', () => {
    // Arrange
    const big = ['|'.repeat(50_000), ' '.repeat(50_000), '1'.repeat(50_000), 'a|'.repeat(25_000), ' ;'.repeat(25_000)];
    const start = performance.now();
    // Act
    for (const b of big) for (const n of ['/poll ', '/mute ', '/slow ', '/answer ', '/protect ', '/']) parseCommand(n + b, 'streamer');
    // Assert
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
