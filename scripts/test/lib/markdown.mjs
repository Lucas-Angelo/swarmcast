// Text for a cell of a Markdown table (GitHub step summaries of the test suites).

/**
 * Backslashes first, then pipes, are escaped and line breaks become spaces, so any text stays
 * in its cell: a detail ending in "\" can no longer turn the next "|" into a literal one.
 * @param {string} text
 * @returns {string}
 */
export function mdCell(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
