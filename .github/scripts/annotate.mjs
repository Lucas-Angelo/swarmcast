// GitHub Actions annotations for the scripts in .github/scripts: a workflow command
// (::error title=<title>::<message>) with the characters the runner reads escaped.

const escapeData = (s) => String(s).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const escapeProperty = (s) => escapeData(s).replaceAll(':', '%3A').replaceAll(',', '%2C');

/** Prints an annotation: level is error, warning or notice. */
export function annotate(level, title, message) {
  console.log(`::${level} title=${escapeProperty(title)}::${escapeData(message)}`);
}
