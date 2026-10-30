export interface JunitCase {
  /** The classname: a section, a scenario (default: the suite). */
  group?: string;
  name: string;
  /** 'fail' → <failure>, 'skip' → <skipped>, 'pass' → a plain case; anything else throws. */
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
  seconds?: number;
}

/** The JUnit XML document of `cases`, one testsuite named `suite`. */
export function junitXml(suite: string, cases: readonly JunitCase[]): string;

/** Writes junitXml(suite, cases) to `file`, creating its folder. */
export function writeJunit(file: string, suite: string, cases: readonly JunitCase[]): void;
