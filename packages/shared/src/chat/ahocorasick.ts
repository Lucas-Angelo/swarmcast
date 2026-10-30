/**
 * Aho–Corasick automaton over UTF-16 code units: does a text contain any of the patterns?
 * O(text length) per test, built once whenever the blocked words change. No user regex anywhere.
 */
export class AhoCorasick {
  private readonly next: Array<Map<number, number>> = [new Map()];
  private readonly fail: number[] = [0];
  private readonly out: boolean[] = [false];

  constructor(patterns: Iterable<string>) {
    for (const p of patterns) {
      if (!p) continue;
      let s = 0;
      for (let i = 0; i < p.length; i++) {
        const c = p.charCodeAt(i);
        let n = this.next[s]!.get(c);
        if (n === undefined) {
          n = this.next.length;
          this.next.push(new Map());
          this.fail.push(0);
          this.out.push(false);
          this.next[s]!.set(c, n);
        }
        s = n;
      }
      this.out[s] = true;
    }
    // Breadth-first failure links.
    const queue: number[] = [];
    for (const n of this.next[0]!.values()) queue.push(n);
    for (let qi = 0; qi < queue.length; qi++) {
      const s = queue[qi]!;
      for (const [c, n] of this.next[s]!) {
        let f = this.fail[s]!;
        while (f !== 0 && !this.next[f]!.has(c)) f = this.fail[f]!;
        const g = this.next[f]!.get(c);
        this.fail[n] = g !== undefined && g !== n ? g : 0;
        if (this.out[this.fail[n]!]) this.out[n] = true;
        queue.push(n);
      }
    }
  }

  get empty(): boolean {
    return this.next[0]!.size === 0;
  }

  /** True when `text` contains at least one pattern. */
  test(text: string): boolean {
    let s = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      while (s !== 0 && !this.next[s]!.has(c)) s = this.fail[s]!;
      s = this.next[s]!.get(c) ?? 0;
      if (this.out[s]) return true;
    }
    return false;
  }
}
