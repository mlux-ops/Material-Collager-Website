import ts from "typescript";
import { execFileSync } from "node:child_process";
import path from "node:path";
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const files = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "*.ts"], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
const baselineSources = new Map(files.map((file) => [path.resolve(file).toLowerCase(), execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8" })]));
function diagnostics(baseline) {
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (filename, language, ...rest) => {
    const source = baseline && baselineSources.get(path.resolve(filename).toLowerCase());
    return typeof source === "string" ? ts.createSourceFile(filename, source, language) : getSourceFile(filename, language, ...rest);
  };
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => `${d.file?.fileName}:${d.code}:${ts.flattenDiagnosticMessageText(d.messageText, " ")}`).sort();
}
const baseline = diagnostics(true);
const current = diagnostics(false);
console.log(JSON.stringify({ baselineErrors: baseline.length, currentErrors: current.length, identical: JSON.stringify(baseline) === JSON.stringify(current) }));
if (JSON.stringify(baseline) !== JSON.stringify(current)) process.exitCode = 1;
