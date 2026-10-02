// For tests: what the type check makes of the app with a value added to one of the unions in api/types.ts.
import ts from "typescript";

/**
 * The type check's errors in each of `files`, under src/, with `added.value` put in the union `added.type`, as the API
 * adding a value would put it there.
 */
export function typeErrors(files: string[], added?: { type: string; value: string }): Record<string, string[]> {
  const root = decodeURI(new URL(import.meta.url).pathname).replace(/src\/lib\/[^/]+$/, "");
  const options = ts.getParsedCommandLineOfConfigFile(`${root}tsconfig.app.json`, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => {},
  })!.options;
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile;
  const types = `${root}src/api/types.ts`;
  host.getSourceFile = (name, language, ...rest) => {
    if (name !== types || added === undefined) return read(name, language, ...rest);
    const before = ts.sys.readFile(name)!;
    const declaration = `export type ${added.type} = `;
    if (!before.includes(declaration)) throw new Error(`No union ${added.type} in api/types.ts`);
    return ts.createSourceFile(name, before.replace(declaration, `${declaration}"${added.value}" | `), language);
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
