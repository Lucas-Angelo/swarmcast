export interface JunitCase {
  /** The classname: a section, a scenario (default: the suite). */
  group?: string;
  name: string;
  /** 'fail' → <failure>, 'skip' → <skipped>, 'warn' → passed with a system-out note, else passed. */
  status: string;
  detail?: string;
  seconds?: number;
}

/** The JUnit XML document of `cases`, one testsuite named `suite`. */
export function junitXml(suite: string, cases: readonly JunitCase[]): string;

/** Writes junitXml(suite, cases) to `file`, creating its folder. */
export function writeJunit(file: string, suite: string, cases: readonly JunitCase[]): void;
