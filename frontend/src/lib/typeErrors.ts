// For tests: what the type check makes of the app with a change made to api/types.ts.
import ts from "typescript";

/**
 * The type check's errors in each of `files`, under src/, with `edit` made to api/types.ts first, as a change to the
 * API would make it there.
 */
export function typeErrors(files: string[], edit?: (types: string) => string): Record<string, string[]> {
  const root = decodeURI(new URL(import.meta.url).pathname).replace(/src\/lib\/[^/]+$/, "");
  const options = ts.getParsedCommandLineOfConfigFile(`${root}tsconfig.app.json`, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => {},
  })!.options;
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile;
  const types = `${root}src/api/types.ts`;
  host.getSourceFile = (name, language, ...rest) => {
    if (name !== types || edit === undefined) return read(name, language, ...rest);
    const before = ts.sys.readFile(name)!;
    const after = edit(before);
    if (after === before) throw new Error("The edit changes nothing in api/types.ts");
    return ts.createSourceFile(name, after, language);
  };
  const paths = files.map((file) => `${root}src/${file}`);
  const program = ts.createProgram(paths, options, host);
  return Object.fromEntries(
    files.map((file, i) => [
      file,
      program
        .getSemanticDiagnostics(program.getSourceFile(paths[i]))
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")),
    ]),
  );
}

/** The edit that adds `value` to the union `type`, as the API adding one would add it. */
export function withValue(type: string, value: string): (types: string) => string {
  return (types) => types.replace(`export type ${type} = `, `export type ${type} = "${value}" | `);
}
